import { appendChangeEvidence, COMPLETE_EVIDENCE_POLICY } from './context-delivery.mjs';
import { stableWorkSessionKey } from './work-sessions.mjs';
import { nowIso, sha256, stableJson } from './utils.mjs';

const DELIVERED_KINDS = new Set(['knowledge_review_due', 'knowledge_delta_due', 'task_progress_due']);
const KNOWLEDGE_SESSION = stableWorkSessionKey('workstream', 'shadow', 'knowledge-curation');

/** Explicit, writable-only initialization; never called by either read API. */
export function ensureInformationDeliverySchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS information_dispatches (
      id TEXT PRIMARY KEY,
      source_change_seq INTEGER NOT NULL REFERENCES context_changes(seq),
      source_event_key TEXT NOT NULL,
      session_key TEXT NOT NULL,
      request_json TEXT NOT NULL,
      evidence_revisions_json TEXT NOT NULL,
      source_page_json TEXT NOT NULL,
      delivery_keys_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS information_dispatch_source_idx
      ON information_dispatches(source_change_seq);
    CREATE TABLE IF NOT EXISTS information_deliveries (
      delivery_key TEXT PRIMARY KEY,
      dispatch_id TEXT NOT NULL REFERENCES information_dispatches(id),
      evidence_id TEXT NOT NULL REFERENCES evidence(id),
      content_hash TEXT NOT NULL,
      session_key TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK(purpose IN ('knowledge_review_due','task_progress_due')),
      task_id TEXT,
      reason TEXT NOT NULL,
      change_seq INTEGER NOT NULL REFERENCES context_changes(seq),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS information_delivery_evidence_idx
      ON information_deliveries(evidence_id, purpose);
    CREATE INDEX IF NOT EXISTS information_delivery_change_idx
      ON information_deliveries(change_seq);
  `);
}

function hasSchema(database) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='information_dispatches'").get());
}

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a nonempty string`);
  return value;
}

function sortedIds(values) {
  if (!Array.isArray(values)) throw new Error('evidenceIds must be an array');
  return [...new Set(values.map(value => requiredText(value, 'evidenceId')))].sort();
}

function normalizeInput(input) {
  if (!input || !Number.isSafeInteger(input.sourceChangeSeq) || input.sourceChangeSeq <= 0) {
    throw new Error('sourceChangeSeq must be a positive safe integer');
  }
  requiredText(input.sessionKey, 'sessionKey');
  requiredText(input.leaseOwner, 'leaseOwner');
  requiredText(input.rationale, 'rationale');
  if (typeof input.knowledge !== 'boolean') throw new Error('knowledge must be a boolean');
  if (!Array.isArray(input.tasks)) throw new Error('tasks must be an array');
  const tasks = new Map();
  for (const task of input.tasks) {
    const taskId = requiredText(task?.taskId, 'taskId');
    const reason = requiredText(task.reason, 'task reason');
    if (tasks.has(taskId) && tasks.get(taskId) !== reason) throw new Error(`Conflicting reasons for task ${taskId}`);
    tasks.set(taskId, reason);
  }
  const request = {
    sourceChangeSeq: input.sourceChangeSeq, sessionKey: input.sessionKey,
    evidenceIds: sortedIds(input.evidenceIds), knowledge: input.knowledge,
    tasks: [...tasks.keys()].sort().map(taskId => ({ taskId, reason: tasks.get(taskId) })),
    rationale: input.rationale,
  };
  if (!request.evidenceIds.length && (request.knowledge || request.tasks.length)) {
    throw new Error('A recipient requires at least one evidenceId');
  }
  return request;
}

function sourceMembership(database, source) {
  const rows = database.prepare('SELECT evidence_id FROM context_change_evidence WHERE change_seq=? ORDER BY evidence_id').all(source.seq);
  const metadata = JSON.parse(source.metadata_json);
  // Complete-delivery metadata is only a capped preview, never the membership authority.
  if (rows.length || metadata.deliveryPolicy === COMPLETE_EVIDENCE_POLICY) return rows.map(row => row.evidence_id);
  // Legacy batches predate the authoritative membership table. Their metadata can
  // retain IDs after the corresponding evidence was compacted, so only surviving
  // rows can participate in dispatch/ACK coverage.
  const exists = database.prepare('SELECT 1 FROM evidence WHERE id=?');
  return sortedIds([...(metadata.evidenceIds ?? []), ...(source.evidence_id ? [source.evidence_id] : [])])
    .filter(evidenceId => exists.get(evidenceId));
}

function evidenceRevisions(database, source, ids) {
  const members = new Set(sourceMembership(database, source));
  const read = database.prepare('SELECT id, source_id, content FROM evidence WHERE id=?');
  return ids.map(evidenceId => {
    if (!members.has(evidenceId)) throw new Error(`Evidence is not bound to source change: ${evidenceId}`);
    const evidence = read.get(evidenceId);
    if (!evidence) throw new Error(`Unknown evidence: ${evidenceId}`);
    return { evidenceId, sourceId: evidence.source_id, contentHash: sha256(evidence.content) };
  });
}

function sourcePage(database, source) {
  return database.prepare(`SELECT evidence_id AS evidenceId, start_offset AS start,
    end_offset AS end, total_length AS total FROM context_change_delivery
    WHERE change_seq=? AND lease_owner=? ORDER BY evidence_id`).all(source.seq, source.lease_owner);
}

function deliveryKey(revision, recipient) {
  return sha256(stableJson([revision.sourceId, revision.evidenceId, revision.contentHash,
    recipient.sessionKey, recipient.purpose, recipient.taskId]));
}

function readReceipt(database, receipt, replayed) {
  const deliveries = new Map();
  const read = database.prepare(`SELECT d.*, c.status, c.metadata_json FROM information_deliveries d
    JOIN context_changes c ON c.seq=d.change_seq WHERE d.delivery_key=?`);
  for (const key of JSON.parse(receipt.delivery_keys_json)) {
    const row = read.get(key);
    if (!row) throw new Error('Incomplete persisted information dispatch');
    if (!deliveries.has(row.change_seq)) {
      const metadata = JSON.parse(row.metadata_json);
      deliveries.set(row.change_seq, {
        changeSeq: row.change_seq, sessionKey: row.session_key, purpose: row.purpose,
        taskId: row.task_id, evidenceIds: [], status: row.status,
        ...(metadata.deliveryDisposition === 'already_satisfied'
          ? { satisfied: true, reviewProofs: metadata.reviewProofs } : {}),
      });
    }
    deliveries.get(row.change_seq).evidenceIds.push(row.evidence_id);
  }
  return {
    dispatchId: receipt.id, ...JSON.parse(receipt.request_json), replayed,
    deliveries: [...deliveries.values()].sort((a, b) => a.changeSeq - b.changeSeq)
      .map(row => ({ ...row, evidenceIds: row.evidenceIds.sort(),
        ...(row.satisfied ? { reviewProofs: row.reviewProofs.filter(proof => row.evidenceIds.includes(proof.evidenceId)) } : {}) })),
  };
}

function knowledgeQueuePlan(database, revisions) {
  return revisions.map(revision => {
    const queue = database.prepare('SELECT * FROM graph_enrichment_queue WHERE evidence_id=?').get(revision.evidenceId);
    const annotation = database.prepare('SELECT * FROM graph_episode_annotations WHERE evidence_id=?').get(revision.evidenceId);
    if (queue && queue.content_hash !== revision.contentHash) {
      throw new Error(`Knowledge queue revision mismatch: ${revision.evidenceId}`);
    }
    const reviewed = annotation?.content_hash === revision.contentHash
      && (annotation.review_status === 'completed' || annotation.status === 'superseded');
    const proof = reviewed ? {
      evidenceId: revision.evidenceId, contentHash: revision.contentHash, table: 'graph_episode_annotations',
      status: annotation.status === 'superseded' ? 'superseded' : annotation.review_status,
      annotationVersion: annotation.annotation_version, updatedAt: annotation.updated_at,
    } : queue && ['completed', 'superseded'].includes(queue.status) ? {
      evidenceId: revision.evidenceId, contentHash: revision.contentHash, table: 'graph_enrichment_queue',
      status: queue.status, completedAt: queue.completed_at,
    } : null;
    return { ...revision, insert: !queue, proof,
      status: reviewed ? (annotation.status === 'superseded' ? 'superseded' : 'completed') : 'pending',
      completedAt: reviewed && annotation.status !== 'superseded' ? annotation.updated_at : null,
      promote: queue?.status === 'cold' && !queue.lease_owner && !queue.lease_until && !reviewed };
  });
}

/**
 * Dispatch one explicit evidence page. database is openDatabase(...).db.
 * input: {sourceChangeSeq, sessionKey, leaseOwner, evidenceIds, knowledge,
 *         tasks: [{taskId, reason}], rationale, now?}. now is an ISO timestamp.
 * sessionKey and now must come from the trusted caller, not model/source metadata.
 * Lazily initializes the two tables inside a savepoint; supports an outer transaction.
 * Exact normalized successful replays need no current lease. Other decisions require
 * the source's active lease. Returned deliveries are independent context_changes;
 * already delivered evidence/revision/recipient/purpose tuples reuse their events.
 * A currently read source page is recorded in the decision, not recipient cursors.
 * With a complete-delivery read page, selected IDs must be a subset of that page.
 * Without a read page, selected IDs denote whole evidence. Return shape:
 * {dispatchId, ...normalizedInput, replayed, deliveries: [{changeSeq, sessionKey,
 * purpose, taskId, evidenceIds, status, satisfied?, reviewProofs?}]}.
 * Same-content completed knowledge uses acknowledged proof receipts, not pending
 * review events or new read cursors. Mixed batches partition pending/satisfied IDs.
 * leaseOwner/now are not replay identity.
 * options.prepareTaskTargets(tasks) is an optional synchronous trusted callback.
 * It receives normalized {taskId, reason} copies only for a new authorized request,
 * after exact replay lookup and before recipient lookup, inside this savepoint.
 * Its task-owner preparation rolls back with any later failure; it must not write cards.
 * Does not ACK the source, update tasks, clone evidence, or write facts/annotations. Task learning
 * remains captureResolutionKnowledgeDelta, not recursive dispatch of delivery events.
 * This is transport dedup, not semantic-impact dedup: a later page can reveal a new
 * impact on the same task, but changed reason/rationale alone does not re-wake an
 * acknowledged delivery. This API has no impact-revision identity; meaningful new
 * candidates/corrections belong to the existing knowledge-delta/review workflow.
 */
export function dispatchInformation(database, input, { prepareTaskTargets } = {}) {
  if (prepareTaskTargets !== undefined && typeof prepareTaskTargets !== 'function') {
    throw new Error('prepareTaskTargets must be a function');
  }
  const request = normalizeInput(input);
  const timestamp = input.now ?? nowIso();
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) throw new Error('Invalid now timestamp');
  const now = new Date(timestamp).toISOString();
  database.exec('SAVEPOINT information_dispatch');
  try {
    ensureInformationDeliverySchema(database);
    const source = database.prepare('SELECT * FROM context_changes WHERE seq=?').get(request.sourceChangeSeq);
    if (!source) throw new Error('Unknown source change');
    if (source.session_key !== request.sessionKey) throw new Error('Source change is not owned by this session');
    if (DELIVERED_KINDS.has(source.kind) || JSON.parse(source.metadata_json).informationDelivery
      || database.prepare('SELECT 1 FROM information_deliveries WHERE change_seq=?').get(source.seq)) {
      throw new Error('Delivered events cannot be dispatched again');
    }
    const revisions = evidenceRevisions(database, source, request.evidenceIds);
    if (!revisions.length && sourceMembership(database, source).length) throw new Error('Select evidenceIds for this source');
    const selected = new Set(request.evidenceIds);
    const readPage = sourcePage(database, source);
    if (JSON.parse(source.metadata_json).deliveryPolicy === COMPLETE_EVIDENCE_POLICY && readPage.length
      && request.evidenceIds.some(id => !readPage.some(row => row.evidenceId === id))) {
      throw new Error('Selected evidenceIds must belong to the current source page');
    }
    const currentPage = readPage.filter(row => selected.has(row.evidenceId));
    const requestJson = stableJson(request), revisionsJson = stableJson(revisions);
    const pageJson = stableJson(currentPage);
    const dispatchId = sha256(stableJson([source.event_key, request, revisions, currentPage]));
    // Once ACK removed the page, an identical request still retrieves its durable receipt.
    const previous = currentPage.length
      ? database.prepare('SELECT * FROM information_dispatches WHERE id=?').get(dispatchId)
      : database.prepare(`SELECT * FROM information_dispatches WHERE source_change_seq=?
          AND source_event_key=? AND session_key=? AND request_json=? AND evidence_revisions_json=?
          ORDER BY created_at DESC,id LIMIT 1`).get(source.seq, source.event_key, request.sessionKey, requestJson, revisionsJson);
    if (previous) {
      const result = readReceipt(database, previous, true);
      database.exec('RELEASE SAVEPOINT information_dispatch');
      return result;
    }
    if (source.status !== 'leased' || source.lease_owner !== input.leaseOwner
      || !Number.isFinite(Date.parse(source.lease_until)) || Date.parse(source.lease_until) <= Date.parse(now)) {
      throw new Error('Source change requires an active lease owned by leaseOwner');
    }

    if (prepareTaskTargets) {
      const prepared = prepareTaskTargets(request.tasks.map(task => ({ ...task })));
      if (prepared && typeof prepared.then === 'function') throw new Error('prepareTaskTargets must be synchronous');
    }
    const recipients = [];
    let knowledgeBinding;
    if (request.knowledge) {
      knowledgeBinding = database.prepare("SELECT * FROM conversation_bindings WHERE provider='shadow' AND conversation_key='knowledge-curation'").get();
      if (knowledgeBinding && (knowledgeBinding.status !== 'active' || knowledgeBinding.session_kind !== 'workstream')) {
        throw new Error('Knowledge-curation session is not active');
      }
      recipients.push({ sessionKey: knowledgeBinding?.session_key ?? KNOWLEDGE_SESSION,
        purpose: 'knowledge_review_due', taskId: null, reason: request.rationale });
    }
    const findTask = database.prepare(`SELECT session_key FROM conversation_bindings
      WHERE task_id=? AND session_kind='task' AND status='active' ORDER BY last_event_at DESC, id LIMIT 1`);
    for (const task of request.tasks) {
      const binding = findTask.get(task.taskId);
      if (!binding) throw new Error(`No active bound task session: ${task.taskId}`);
      recipients.push({ ...task, sessionKey: binding.session_key, purpose: 'task_progress_due' });
    }
    const queuePlan = request.knowledge ? knowledgeQueuePlan(database, revisions) : [];
    const reviewProofs = new Map(queuePlan.filter(item => item.proof).map(item => [item.evidenceId, item.proof]));
    const deliveryKeys = [];
    const findDelivery = database.prepare('SELECT 1 FROM information_deliveries WHERE delivery_key=?');
    const plans = recipients.flatMap(recipient => {
      const fresh = revisions.filter(revision => {
        const key = deliveryKey(revision, recipient);
        deliveryKeys.push(key);
        return !findDelivery.get(key);
      });
      if (recipient.purpose !== 'knowledge_review_due') return [{ ...recipient, fresh }];
      return [false, true].map(satisfied => ({ ...recipient, satisfied,
        fresh: fresh.filter(revision => reviewProofs.has(revision.evidenceId) === satisfied) }));
    });

    // All source, evidence, lease and recipient checks precede publishing anything.
    database.prepare(`INSERT INTO information_dispatches
      (id,source_change_seq,source_event_key,session_key,request_json,evidence_revisions_json,source_page_json,delivery_keys_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(dispatchId, source.seq, source.event_key, request.sessionKey,
      requestJson, revisionsJson, pageJson, stableJson(deliveryKeys.sort()), now);
    if (request.knowledge && !knowledgeBinding) {
      database.prepare(`INSERT INTO conversation_bindings
        (id,provider,conversation_key,session_key,session_kind,status,created_at,last_event_at,metadata_json)
        VALUES(?,'shadow','knowledge-curation',?,'workstream','active',?,?,?)`)
        .run(sha256('work-session:shadow:knowledge-curation').slice(0, 32), KNOWLEDGE_SESSION, now, now,
          stableJson({ projectKey: 'knowledge-curation', routingReason: 'dedicated-knowledge-curation' }));
    }
    for (const item of queuePlan) {
      if (item.insert) database.prepare(`INSERT INTO graph_enrichment_queue
        (evidence_id,content_hash,reason,status,queued_at,completed_at,metadata_json) VALUES(?,?,?,?,?,?,?)`)
        .run(item.evidenceId, item.contentHash, 'information_dispatch', item.status, now,
          item.completedAt, stableJson({ curationRoute: 'knowledge-curation' }));
      if (item.promote) database.prepare("UPDATE graph_enrichment_queue SET status='pending',reason='information_dispatch',queued_at=? WHERE evidence_id=?")
        .run(now, item.evidenceId);
    }
    for (const recipient of plans) {
      if (!recipient.fresh.length) continue;
      const eventKey = `information-delivery:${sha256(stableJson([dispatchId, recipient.sessionKey, recipient.purpose, recipient.taskId,
        recipient.satisfied ? 'already_satisfied' : 'pending']))}`;
      const ids = recipient.fresh.map(item => item.evidenceId);
      const satisfied = Boolean(recipient.satisfied);
      const result = database.prepare(`INSERT INTO context_changes
        (event_key,kind,evidence_id,project_key,session_key,priority,status,not_before,occurred_at,created_at,
          summary,metadata_json,acknowledged_at,ack_note)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(eventKey, recipient.purpose, ids[0], source.project_key,
        recipient.sessionKey, source.priority, satisfied ? 'acknowledged' : 'pending', now, source.occurred_at, now,
        satisfied ? 'Knowledge delivery satisfied by existing review.'
          : recipient.purpose === 'knowledge_review_due' ? 'Review dispatched source evidence.' : 'Reassess task against dispatched source evidence.',
        stableJson({ informationDelivery: true, sourceChangeSeq: source.seq, sourceEventKey: source.event_key,
          dispatchId, evidenceIds: ids, evidenceRevisions: recipient.fresh,
          deliveryPolicy: satisfied ? undefined : COMPLETE_EVIDENCE_POLICY, taskId: recipient.taskId,
          ...(satisfied ? { deliveryDisposition: 'already_satisfied', reviewProofs: ids.map(id => reviewProofs.get(id)) } : {}),
          reason: 'information_dispatch', impactReason: recipient.reason, grantsAuthorization: false }),
        satisfied ? now : null, satisfied ? 'Satisfied by existing review; no new review scheduled.' : null);
      const changeSeq = Number(result.lastInsertRowid);
      if (!satisfied) appendChangeEvidence(database, changeSeq, ids);
      for (const revision of recipient.fresh) {
        const key = deliveryKey(revision, recipient);
        database.prepare(`INSERT INTO information_deliveries
          (delivery_key,dispatch_id,evidence_id,content_hash,session_key,purpose,task_id,reason,change_seq,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(key, dispatchId, revision.evidenceId, revision.contentHash,
          recipient.sessionKey, recipient.purpose, recipient.taskId, recipient.reason, changeSeq, now);
      }
    }
    const result = readReceipt(database, database.prepare('SELECT * FROM information_dispatches WHERE id=?').get(dispatchId), false);
    database.exec('RELEASE SAVEPOINT information_dispatch');
    return result;
  } catch (error) {
    database.exec('ROLLBACK TO SAVEPOINT information_dispatch');
    database.exec('RELEASE SAVEPOINT information_dispatch');
    throw error;
  }
}

/**
 * Read-only ACK guard. Explicit evidenceIds must all have a durable decision for
 * this source and current revision (including deliberate no-consumer decisions).
 * Omit IDs to check the current delivered page, or all source members if unread.
 * Checks source body ranges as well as IDs; later pages/arrivals are not implicitly
 * covered. This does not ACK/read evidence or replace the caller's lease checks.
 * The caller must check this guard inside the same transaction as its source ACK.
 */
export function hasInformationDispatch(database, changeSeq, evidenceIds) {
  if (!hasSchema(database)) return false;
  const source = database.prepare('SELECT * FROM context_changes WHERE seq=?').get(changeSeq);
  if (!source) return false;
  const page = sourcePage(database, source);
  const ids = sortedIds(evidenceIds ?? (page.length ? page.map(row => row.evidenceId) : sourceMembership(database, source)));
  let revisions;
  try { revisions = evidenceRevisions(database, source, ids); } catch { return false; }
  const decisions = database.prepare(`SELECT evidence_revisions_json,source_page_json FROM information_dispatches
    WHERE source_change_seq=? AND source_event_key=? AND session_key=?`).all(changeSeq, source.event_key, source.session_key);
  if (!decisions.length) return false;
  if (!ids.length) return !sourceMembership(database, source).length;
  const covered = new Map();
  for (const decision of decisions) {
    const ranges = JSON.parse(decision.source_page_json);
    for (const revision of JSON.parse(decision.evidence_revisions_json)) {
      const key = stableJson(revision), range = ranges.find(row => row.evidenceId === revision.evidenceId);
      if (!covered.has(key)) covered.set(key, []);
      covered.get(key).push(range ?? { start: 0, end: Infinity });
    }
  }
  return revisions.every(revision => {
    const required = page.find(row => row.evidenceId === revision.evidenceId)
      ?? { start: 0, end: database.prepare('SELECT content FROM evidence WHERE id=?').get(revision.evidenceId).content.length };
    const ranges = covered.get(stableJson(revision));
    if (!ranges?.length) return false;
    let end = required.start;
    for (const range of ranges.sort((a, b) => a.start - b.start)) {
      if (range.start > end) break;
      end = Math.max(end, range.end);
      if (end >= required.end) return true;
    }
    return false;
  });
}

/**
 * Read-only curator relevance lookup, not authorization. Returns one row per active
 * bound task/session: {taskId, sessionKey, evidenceIds, reasons, deliveryChangeSeqs}.
 * Accepts an evidence ID or array; only current content revisions are returned.
 */
export function getInformationTaskTargets(database, evidenceIds) {
  const ids = sortedIds(typeof evidenceIds === 'string' ? [evidenceIds] : evidenceIds);
  if (!hasSchema(database) || !ids.length) return [];
  const targets = new Map();
  const read = database.prepare(`SELECT d.*, e.content FROM information_deliveries d
    JOIN evidence e ON e.id=d.evidence_id WHERE d.evidence_id=? AND d.purpose='task_progress_due'
    AND EXISTS (SELECT 1 FROM conversation_bindings b WHERE b.task_id=d.task_id
      AND b.session_key=d.session_key AND b.session_kind='task' AND b.status='active')
    ORDER BY d.task_id,d.session_key,d.change_seq`);
  for (const id of ids) for (const row of read.all(id)) {
    if (row.content_hash !== sha256(row.content)) continue;
    const key = stableJson([row.task_id, row.session_key]);
    if (!targets.has(key)) targets.set(key, { taskId: row.task_id, sessionKey: row.session_key,
      evidenceIds: new Set(), reasons: new Set(), deliveryChangeSeqs: new Set() });
    const target = targets.get(key);
    target.evidenceIds.add(id); target.reasons.add(row.reason); target.deliveryChangeSeqs.add(row.change_seq);
  }
  return [...targets.values()].sort((a, b) => a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : a.sessionKey.localeCompare(b.sessionKey))
    .map(target => ({ ...target, evidenceIds: [...target.evidenceIds].sort(), reasons: [...target.reasons].sort(),
      deliveryChangeSeqs: [...target.deliveryChangeSeqs].sort((a, b) => a - b) }));
}
