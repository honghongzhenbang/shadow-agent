import { createHash } from "node:crypto";
import { applyKnowledgeBundle, currentFactTrust } from "../../../src/graph-model.mjs";
import { getInformationTaskTargets } from "../../../src/information-delivery.mjs";

const CHECKPOINT_TRANSPORT_METADATA = [
  "checkpointApplied", "checkpointChangeSeq", "expectedCheckpointRevision",
  "expectedBindingRevision", "expectedExecution", "ownerSessionKey",
];

function hash(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

function redactSecrets(value) {
  let text = String(value ?? "");
  const patterns = [
    [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]"],
    [/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_OPENAI_KEY]"],
    [/(app[_-]?secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|api[_-]?key)([\"'\s:=]+)([^\s,}\"]+)/gi, "$1$2[REDACTED]"],
    [/([?&](?:token|access_token|refresh_token|code)=)[^&#\s]+/gi, "$1[REDACTED]"],
  ];
  for (const [pattern, replacement] of patterns) text = text.replace(pattern, replacement);
  return text;
}

function clamp(value, minimum = 0, maximum = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.max(minimum, Math.min(maximum, number));
}


function ensureCurrentGraph(database) {
  const version = database.prepare("SELECT value FROM settings WHERE key='contextGraph:schemaVersion'").get()?.value
    ?? database.prepare("SELECT value FROM settings WHERE key='contextGraph:version'").get()?.value;
  if (version !== "epistemic-context-v4") {
    throw new Error(`Shadow context database must be initialized as epistemic-context-v4 before graph proposals are enabled; found ${version ?? "unknown"}`);
  }
  const required = ["graph_entity_types", "graph_relation_types", "graph_evidence_assessments", "graph_derivations"];
  for (const table of required) {
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
      throw new Error("Shadow context database must be initialized as epistemic-context-v4 before graph proposals are enabled");
    }
  }
}


function resolveEntity(database, reference) {
  const row = database.prepare("SELECT id FROM graph_entities WHERE id=? OR canonical_key=?").get(reference, reference);
  if (!row) throw new Error(`Unknown graph entity: ${reference}`);
  return row.id;
}


export function proposeKnowledge(database, input) {
  ensureCurrentGraph(database);
  const createdBy = String(input.createdBy ?? "openclaw-main").trim();
  const result = applyKnowledgeBundle(database, {
    createdBy,
    entities: input.entities ?? [],
    facts: (input.facts ?? []).map((item) => ({
      ...item,
      subject: item.subjectCanonicalKey,
      objectEntity: item.objectCanonicalKey,
      assertionMode: item.derivationFactIds?.length ? "derived" : "inferred",
      confidence: clamp(Math.min(0.85, item.confidence ?? 0.65)),
      rationale: item.rationale ?? input.rationale ?? "",
      metadata: { ...(item.metadata ?? {}), rationale: item.rationale ?? input.rationale ?? "" },
      evidenceAssessments: [...new Set(item.sourceEvidenceIds ?? [])].map((evidenceId) => ({
        ...item.evidenceProfile,
        evidenceId,
      })),
    })),
  });
  return {
    createdBy,
    entities: result.entities,
    facts: result.facts.map((fact) => ({
      id: fact.id,
      predicate: database.prepare("SELECT predicate FROM graph_facts WHERE id=?").get(fact.id).predicate,
      strongestEvidenceLevel: database.prepare("SELECT COALESCE(MAX(level), 0) value FROM graph_evidence_assessments WHERE fact_id=?").get(fact.id).value,
      status: fact.epistemicStatus,
      supersession: fact.supersession,
    })),
  };
}

export function leaseKnowledgeEnrichment(database, input = {}) {
  ensureCurrentGraph(database);
  const evidenceIds = [...new Set((input.evidenceIds ?? []).map(String).filter(Boolean))].slice(0, 5);
  const limit = Math.max(evidenceIds.length, Math.max(1, Math.min(5, Number(input.limit ?? 2) || 2)));
  const leaseOwner = String(input.leaseOwner ?? "openclaw-main");
  const leaseSeconds = Math.max(60, Math.min(3600, Number(input.leaseSeconds ?? 900) || 900));
  const now = new Date();
  const nowText = now.toISOString();
  const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`
      UPDATE graph_enrichment_queue SET status='pending', lease_owner=NULL, lease_until=NULL
      WHERE status='leased' AND lease_until<?
    `).run(nowText);
    if (evidenceIds.length) {
      const placeholders = evidenceIds.map(() => "?").join(",");
      database.prepare(`
        UPDATE graph_enrichment_queue SET status='pending', priority=MAX(priority, 90),
          reason='on-demand-knowledge-enrichment', queued_at=?,
          metadata_json=json_set(
            CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
            '$.governanceTier', 'active_review', '$.promotedAt', ?
          )
        WHERE evidence_id IN (${placeholders}) AND status='cold'
      `).run(nowText, nowText, ...evidenceIds);
      const found = database.prepare(`
        SELECT evidence_id FROM graph_enrichment_queue
        WHERE evidence_id IN (${placeholders}) AND status='pending'
      `).all(...evidenceIds).map((row) => row.evidence_id);
      const missing = evidenceIds.filter((evidenceId) => !found.includes(evidenceId));
      if (missing.length) throw new Error(`Knowledge episodes are not available for review: ${missing.join(", ")}`);
    }
    const rows = database.prepare(`
      SELECT queue.evidence_id, queue.priority, queue.reason, queue.attempts,
        evidence.kind, evidence.title, evidence.content, evidence.occurred_at,
        evidence.collected_at, evidence.project_key, evidence.thread_id,
        evidence.source_locator, evidence.metadata_json AS evidence_metadata_json,
        annotation.summary AS provisional_summary,
        annotation.keywords_json, annotation.retrieval_cues_json, annotation.scope_json
      FROM graph_enrichment_queue queue
      JOIN evidence ON evidence.id=queue.evidence_id
      LEFT JOIN graph_episode_annotations annotation ON annotation.evidence_id=queue.evidence_id
      WHERE queue.status='pending'
        ${evidenceIds.length ? `AND queue.evidence_id IN (${evidenceIds.map(() => "?").join(",")})` : ""}
      ORDER BY queue.priority DESC, queue.queued_at, queue.evidence_id
      LIMIT ?
    `).all(...evidenceIds, limit);
    const update = database.prepare(`
      UPDATE graph_enrichment_queue SET status='leased', lease_owner=?, lease_until=?, attempts=attempts+1
      WHERE evidence_id=? AND status='pending'
    `);
    for (const row of rows) {
      update.run(leaseOwner, leaseUntil, row.evidence_id);
      row.content = String(row.content ?? "").slice(0, 16000);
      row.keywords = JSON.parse(row.keywords_json || "[]");
      row.retrievalCues = JSON.parse(row.retrieval_cues_json || "[]");
      row.scope = JSON.parse(row.scope_json || "{}");
      row.metadata = parseJson(row.evidence_metadata_json, {});
      delete row.keywords_json;
      delete row.retrieval_cues_json;
      delete row.scope_json;
      delete row.evidence_metadata_json;
    }
    database.exec("COMMIT");
    return { leaseOwner, leaseUntil, requestedEvidenceIds: evidenceIds, count: rows.length, episodes: rows };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function refreshEpisodeSearch(database, evidenceId) {
  const row = database.prepare("SELECT rowid, * FROM graph_episode_annotations WHERE evidence_id=?").get(evidenceId);
  database.prepare("DELETE FROM graph_episode_fts WHERE rowid=?").run(row.rowid);
  database.prepare(`
    INSERT INTO graph_episode_fts(rowid, evidence_id, title, summary, keywords, retrieval_cues)
    VALUES(?, ?, ?, ?, ?, ?)
  `).run(
    row.rowid,
    row.evidence_id,
    row.title,
    row.summary,
    JSON.parse(row.keywords_json || "[]").join(" "),
    JSON.parse(row.retrieval_cues_json || "[]").join(" "),
  );
}

function queueKnowledgeReviewChange(database, input) {
  const now = input.now ?? new Date().toISOString();
  database.prepare(`
    INSERT INTO context_changes(
      event_key, coalesce_key, kind, evidence_id, project_key, session_key,
      priority, status, not_before, occurred_at, created_at, summary, metadata_json
    ) VALUES(?, NULL, ?, ?, ?, NULL, ?, 'pending', ?, ?, ?, ?, ?)
    ON CONFLICT(event_key) DO NOTHING
  `).run(
    input.eventKey,
    input.kind,
    input.evidenceId,
    input.projectKey ?? null,
    input.priority ?? "high",
    now,
    input.occurredAt ?? now,
    now,
    String(input.summary ?? "知识证据等待语义维护").slice(0, 1200),
    stable({
      evidenceIds: [input.evidenceId],
      governanceTier: "active_review",
      requiredAction: "lease_exact_evidence_compare_existing_knowledge_and_complete_graph_review",
      curationRoute: "knowledge-curation",
      ...(input.metadata ?? {}),
    }),
  );
  return database.prepare("SELECT seq, event_key, kind, status FROM context_changes WHERE event_key=?").get(input.eventKey);
}

export function captureKnowledge(database, input, options = {}) {
  ensureCurrentGraph(database);
  const ownsTransaction = options.transaction !== false;
  const rawTitle = String(input.title ?? "").trim();
  const rawContent = String(input.content ?? "").trim();
  const rawSummary = String(input.summary ?? "").trim();
  const title = redactSecrets(rawTitle);
  const content = redactSecrets(rawContent);
  const summary = redactSecrets(rawSummary);
  const keywords = [...new Set((input.keywords ?? []).map((value) => redactSecrets(String(value).trim())).filter(Boolean))].slice(0, 80);
  const retrievalCues = [...new Set((input.retrievalCues ?? []).map((value) => redactSecrets(String(value).trim())).filter(Boolean))].slice(0, 40);
  if (!title || !content || !summary) throw new Error("Manual knowledge requires title, content, and summary");
  if (keywords.length < 3 || retrievalCues.length < 2) {
    throw new Error("Manual knowledge requires at least three keywords and two retrieval cues");
  }

  const sourceType = String(input.sourceType ?? "note").trim().toLowerCase();
  if (!["dialogue", "note", "file", "link"].includes(sourceType)) throw new Error(`Unsupported manual knowledge sourceType: ${sourceType}`);
  const now = new Date().toISOString();
  const evidenceKind = String(options.evidenceKind ?? "manual_knowledge");
  const evidenceRole = String(options.evidenceRole ?? "user");
  const sourceKey = String(options.sourceKey ?? `manual-knowledge:${sourceType}`);
  const sourceKind = String(options.sourceKind ?? "manual");
  const sourceUri = String(options.sourceUri ?? `shadow://manual-knowledge/${sourceType}`);
  const queuePriority = Math.max(1, Math.min(100, Number(options.queuePriority ?? 100)));
  const queueReason = String(options.queueReason ?? "manual-capture-semantic-review");
  const sourceId = hash(`source:${sourceKey}`).slice(0, 32);
  const rawSourceLocator = String(input.sourceLocator ?? sourceUri);
  const sourceLocator = redactSecrets(rawSourceLocator).slice(0, 4000);
  const externalId = input.externalId ? String(input.externalId).slice(0, 1000) : null;
  const fingerprint = hash(stable({ sourceKey, sourceLocator, externalId, content }));
  const evidenceId = hash(`evidence:${fingerprint}`).slice(0, 32);
  const existingEvidence = database.prepare("SELECT id,title,project_key FROM evidence WHERE fingerprint=?").get(fingerprint);
  const contentHash = hash(content);
  const generatedBy = String(input.generatedBy ?? "openclaw-main").slice(0, 120);
  const normalizedScope = { ...(input.scope ?? {}) };
  if (input.projectKey && !normalizedScope.projectKey) normalizedScope.projectKey = input.projectKey;
  const secretRedactionApplied = rawTitle !== title
    || rawContent !== content
    || rawSummary !== summary
    || rawSourceLocator !== sourceLocator;

  if (ownsTransaction) database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`
      INSERT INTO sources(
        id, source_key, kind, uri, cursor_bytes, size_bytes, mtime_ms,
        status, last_error, last_seen_at, last_collected_at, metadata_json
      ) VALUES(?, ?, ?, ?, 0, 0, 0, 'ready', NULL, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        uri=excluded.uri, status='ready', last_error=NULL,
        last_seen_at=excluded.last_seen_at, last_collected_at=excluded.last_collected_at
    `).run(sourceId, sourceKey, sourceKind, sourceUri, now, now, stable({ sourceType, evidenceKind }));

    database.prepare(`
      INSERT INTO evidence(
        id, fingerprint, source_id, kind, occurred_at, collected_at,
        project_key, thread_id, role, title, content, source_locator,
        external_id, metadata_json
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET
        title=excluded.title, occurred_at=COALESCE(evidence.occurred_at, excluded.occurred_at),
        project_key=COALESCE(excluded.project_key, evidence.project_key),
        thread_id=COALESCE(excluded.thread_id, evidence.thread_id),
        metadata_json=excluded.metadata_json
    `).run(
      evidenceId,
      fingerprint,
      sourceId,
      evidenceKind,
      input.occurredAt ?? now,
      now,
      input.projectKey ?? null,
      input.threadId ?? null,
      evidenceRole,
      title.slice(0, 2000),
      content,
      sourceLocator,
      externalId,
      stable({
        sourceType,
        explicitUserKnowledge: options.explicitUserKnowledge ?? evidenceKind === "manual_knowledge",
        secretRedactionApplied,
        ...(input.metadata ?? {}),
      }),
    );

    const stored = database.prepare("SELECT id FROM evidence WHERE fingerprint=?").get(fingerprint);
    database.prepare(`
      INSERT INTO graph_episode_annotations(
        evidence_id, title, summary, keywords_json, retrieval_cues_json, scope_json,
        salience, status, content_hash, annotation_version, generated_by,
        generated_at, updated_at, metadata_json
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 'ready', ?, 1, ?, ?, ?, ?)
      ON CONFLICT(evidence_id) DO UPDATE SET
        title=excluded.title, summary=excluded.summary,
        keywords_json=excluded.keywords_json, retrieval_cues_json=excluded.retrieval_cues_json,
        scope_json=excluded.scope_json, salience=excluded.salience, status='ready',
        content_hash=excluded.content_hash, annotation_version=excluded.annotation_version,
        generated_by=excluded.generated_by, generated_at=excluded.generated_at,
        updated_at=excluded.updated_at, metadata_json=excluded.metadata_json
      WHERE graph_episode_annotations.content_hash<>excluded.content_hash
    `).run(
      stored.id,
      title.slice(0, 2000),
      summary.slice(0, 8000),
      stable(keywords),
      stable(retrievalCues),
      stable(normalizedScope),
      clamp(input.salience ?? 0.8),
      contentHash,
      generatedBy,
      now,
      now,
      stable({
        sourceType,
        decisions: input.decisions ?? [],
        openQuestions: input.openQuestions ?? [],
        graphReview: {
          status: "pending",
          rationale: options.pendingRationale ?? "知识证据已可检索，等待专用维护会话查重并判断是否需要更新长期实体和关系。",
        },
      }),
    );
    // Source header corrections must not reset the curator's semantic review.
    if (existingEvidence) {
      const titleChanged = existingEvidence.title !== title.slice(0, 2000);
      const projectChanged = input.projectKey != null && input.projectKey !== existingEvidence.project_key;
      if (titleChanged || projectChanged) {
        database.prepare(`UPDATE graph_episode_annotations SET
          title=CASE WHEN ? THEN ? ELSE title END,
          scope_json=CASE WHEN ? THEN json_set(scope_json, '$.projectKey', ?) ELSE scope_json END,
          updated_at=? WHERE evidence_id=?`).run(
          Number(titleChanged), title.slice(0, 2000), Number(projectChanged), input.projectKey ?? null, now, stored.id,
        );
      }
    }
    refreshEpisodeSearch(database, stored.id);
    database.prepare(`
      INSERT INTO graph_enrichment_queue(
        evidence_id, content_hash, priority, reason, status, queued_at,
        completed_at, extractor_version, metadata_json
      ) VALUES(?, ?, ?, ?, 'pending', ?, NULL, 1, ?)
      ON CONFLICT(evidence_id) DO UPDATE SET
        content_hash=excluded.content_hash,
        reason=CASE
          WHEN graph_enrichment_queue.content_hash<>excluded.content_hash
            THEN excluded.reason
          ELSE graph_enrichment_queue.reason
        END,
        status=CASE
          WHEN graph_enrichment_queue.content_hash<>excluded.content_hash
            THEN 'pending'
          ELSE graph_enrichment_queue.status
        END,
        queued_at=CASE
          WHEN graph_enrichment_queue.content_hash<>excluded.content_hash
            THEN excluded.queued_at
          ELSE graph_enrichment_queue.queued_at
        END,
        completed_at=CASE
          WHEN graph_enrichment_queue.content_hash<>excluded.content_hash
            THEN NULL
          ELSE graph_enrichment_queue.completed_at
        END,
        lease_owner=CASE
          WHEN graph_enrichment_queue.content_hash<>excluded.content_hash
            THEN NULL
          ELSE graph_enrichment_queue.lease_owner
        END,
        lease_until=CASE
          WHEN graph_enrichment_queue.content_hash<>excluded.content_hash
            THEN NULL
          ELSE graph_enrichment_queue.lease_until
        END,
        last_error=CASE
          WHEN graph_enrichment_queue.content_hash<>excluded.content_hash
            THEN NULL
          ELSE graph_enrichment_queue.last_error
        END,
        extractor_version=excluded.extractor_version
    `).run(stored.id, contentHash, queuePriority, queueReason, now, stable({ curationRoute: "knowledge-curation" }));
    const queueStatus = database.prepare("SELECT status FROM graph_enrichment_queue WHERE evidence_id=?").get(stored.id)?.status;
    const reviewEvent = queueStatus === "pending" ? queueKnowledgeReviewChange(database, {
      eventKey: options.reviewEventKey ?? `knowledge-governance-review:${stored.id}`,
      kind: options.reviewChangeKind ?? "knowledge_review_due",
      evidenceId: stored.id,
      projectKey: input.projectKey,
      occurredAt: input.occurredAt,
      now,
      summary: options.reviewSummary ?? `知识证据等待语义维护：${title.slice(0, 500)}`,
      metadata: {
        evidenceKind,
        sourceType,
        reviewMode: options.reviewMode ?? "manual-input",
      },
    }) : null;
    if (ownsTransaction) database.exec("COMMIT");
    return {
      evidenceId: stored.id,
      inserted: !existingEvidence,
      sourceType,
      status: "ready",
      graphReviewStatus: queueStatus,
      semanticReviewRequired: queueStatus === "pending",
      reviewEvent,
      nextAction: queueStatus === "pending" ? {
        tool: "shadow_context_enrichment",
        arguments: { evidenceIds: [stored.id], limit: 1 },
        then: "shadow_context_annotate",
      } : null,
      secretRedactionApplied,
      keywordCount: keywords.length,
      retrievalCueCount: retrievalCues.length,
    };
  } catch (error) {
    if (ownsTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

export function captureResolutionKnowledgeDelta(database, input, options = {}) {
  ensureCurrentGraph(database);
  const idempotencyKey = String(input.idempotencyKey ?? "").trim().slice(0, 1000);
  if (!idempotencyKey) throw new Error("Resolution knowledge delta requires idempotencyKey");
  const question = String(input.question ?? "").trim();
  const resolutionSummary = String(input.resolutionSummary ?? "").trim();
  const durableCandidates = [...new Set((input.durableCandidates ?? []).map((item) => String(item).trim()).filter(Boolean))].slice(0, 40);
  const decisions = [...new Set((input.decisions ?? []).map((item) => String(item).trim()).filter(Boolean))].slice(0, 30);
  const unknowns = [...new Set((input.unknowns ?? []).map((item) => String(item).trim()).filter(Boolean))].slice(0, 30);
  if (!question || !resolutionSummary) throw new Error("Resolution knowledge delta requires question and resolutionSummary");
  if (!durableCandidates.length && !decisions.length) throw new Error("Resolution knowledge delta requires at least one durable candidate or decision");
  const externalId = `resolution-delta:${idempotencyKey}`;
  const sourceEvidenceIds = [...new Set((input.sourceEvidenceIds ?? []).map(String).filter(Boolean))].slice(0, 100);
  if (sourceEvidenceIds.length) {
    const placeholders = sourceEvidenceIds.map(() => "?").join(",");
    const found = database.prepare(`SELECT id, kind, metadata_json FROM evidence WHERE id IN (${placeholders})`).all(...sourceEvidenceIds);
    if (found.length !== sourceEvidenceIds.length) throw new Error("Resolution knowledge delta references unknown source evidence");
    const recursiveSource = found.find((item) => {
      if (item.kind !== "shadow_agent_task_result") return false;
      try { return Boolean(JSON.parse(item.metadata_json || "{}").knowledgeDelta?.idempotencyKey); } catch { return false; }
    });
    if (recursiveSource) {
      throw new Error("A knowledge delta cannot summarize another knowledge delta; curator sessions must use enrichment, propose, annotate, and acknowledge");
    }
  }
  const sourceLocators = [...new Set((input.sourceLocators ?? []).map((item) => String(item).trim()).filter(Boolean))].slice(0, 100);
  const content = stable({ question, resolutionSummary, durableCandidates, decisions, unknowns, sourceEvidenceIds, sourceLocators });
  // Checkpoint transport may change on retry without changing the learning candidate.
  const request = { ...input };
  if (input.metadata) {
    const metadata = { ...input.metadata };
    for (const field of CHECKPOINT_TRANSPORT_METADATA) delete metadata[field];
    if (Object.keys(metadata).length) request.metadata = metadata;
    else delete request.metadata;
  }
  const requestHash = hash(stable(request));
  const now = new Date().toISOString();
  const ownTransaction = options.transaction !== false;
  if (ownTransaction) database.exec("BEGIN IMMEDIATE");
  try {
    const existing = database.prepare("SELECT id, metadata_json FROM evidence WHERE kind='shadow_agent_task_result' AND external_id=?").get(externalId);
    if (existing) {
      const existingMetadata = parseJson(existing.metadata_json);
      const previousHash = existingMetadata.knowledgeDelta?.requestHash;
      if (previousHash !== requestHash) {
        // Older receipts hashed transport fields. Restore only their saved transport
        // values to verify that exact legacy hash; never substitute learning content.
        const legacyMetadata = { ...request.metadata };
        for (const field of CHECKPOINT_TRANSPORT_METADATA) {
          if (field !== "checkpointApplied" && Object.hasOwn(existingMetadata, field)) {
            legacyMetadata[field] = existingMetadata[field];
          }
        }
        if (hash(stable({ ...request, metadata: legacyMetadata })) !== previousHash) {
          throw new Error("Resolution knowledge delta idempotencyKey was already used for a different request");
        }
      }
      const result = { evidenceId: existing.id, inserted: false,
        reviewEvent: database.prepare("SELECT seq, event_key, kind, status FROM context_changes WHERE event_key=?")
          .get(`knowledge-delta-review:${existing.id}`) ?? null };
      if (ownTransaction) database.exec("COMMIT");
      return result;
    }
    const baselineFactIds = sourceEvidenceIds.length ? database.prepare(`
      SELECT DISTINCT fact_id FROM graph_evidence_assessments
      WHERE evidence_id IN (${sourceEvidenceIds.map(() => "?").join(",")}) ORDER BY fact_id
    `).all(...sourceEvidenceIds).map((row) => row.fact_id) : [];
    const reviewBaseline = Object.fromEntries(baselineFactIds.map((id) => [id, hash(stable(reviewedFactState(database, id, now)))]));
    const captured = captureKnowledge(database, {
      sourceType: "note",
      title: input.title ?? `问题解决知识差量：${question.slice(0, 200)}`,
      content,
      summary: resolutionSummary,
      keywords: input.keywords,
      retrievalCues: input.retrievalCues,
      sourceLocator: input.sourceLocator ?? `shadow://knowledge-delta/${encodeURIComponent(idempotencyKey)}`,
      externalId,
      occurredAt: input.resolvedAt ?? now,
      projectKey: input.projectKey,
      threadId: input.sessionKey,
      scope: input.scope,
      decisions,
      openQuestions: unknowns,
      generatedBy: input.generatedBy ?? "openclaw-main",
      metadata: {
        ...(input.metadata ?? {}),
        knowledgeDelta: {
          idempotencyKey,
          requestHash,
          sourceEvidenceIds,
          sourceLocators,
          reviewBaseline,
          requiresExistingKnowledgeComparison: true,
        },
      },
    }, {
      transaction: false,
      evidenceKind: "shadow_agent_task_result",
      evidenceRole: "assistant",
      explicitUserKnowledge: false,
      sourceKey: "shadow-agent:knowledge-delta",
      sourceKind: "shadow_agent",
      sourceUri: "shadow://knowledge-delta",
      queueReason: "resolution-knowledge-delta",
      queuePriority: 95,
      reviewChangeKind: "knowledge_delta_due",
      reviewEventKey: `knowledge-delta-review:${hash(`pending:${idempotencyKey}`).slice(0, 32)}`,
      reviewMode: "resolved-task-delta",
      reviewSummary: `问题解决后等待知识差量维护：${question.slice(0, 500)}`,
    });
    const provisionalEventKey = `knowledge-delta-review:${hash(`pending:${idempotencyKey}`).slice(0, 32)}`;
    const desiredEventKey = `knowledge-delta-review:${captured.evidenceId}`;
    database.prepare("UPDATE context_changes SET event_key=? WHERE event_key=? AND evidence_id=?")
      .run(desiredEventKey, provisionalEventKey, captured.evidenceId);
    const reviewEvent = database.prepare("SELECT seq, event_key, kind, status FROM context_changes WHERE event_key=?").get(desiredEventKey);
    const link = database.prepare(`
      INSERT OR IGNORE INTO evidence_links(parent_evidence_id, child_evidence_id, relation, created_at)
      VALUES(?, ?, 'summarizes', ?)
    `);
    for (const sourceEvidenceId of sourceEvidenceIds) link.run(captured.evidenceId, sourceEvidenceId, now);
    if (ownTransaction) database.exec("COMMIT");
    return { ...captured, reviewEvent, sourceEvidenceCount: sourceEvidenceIds.length };
  } catch (error) {
    if (ownTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

export function captureKnowledgeEpisode(database, input, options = {}) {
  const action = String(input.action ?? "remember").trim() || "remember";
  const actionLabel = String(input.actionLabel ?? action).trim() || "人工录入";
  const targetType = String(input.targetType ?? "knowledge").trim() || "knowledge";
  const targetId = String(input.targetId ?? "").trim().slice(0, 1000);
  const targetLabel = String(input.targetLabel ?? targetType).trim() || targetType;
  const content = String(input.content ?? input.text ?? "").trim();
  const title = String(input.title ?? `用户${actionLabel}：${targetLabel}`).trim();
  const provisional = String(input.summary ?? `用户通过“${actionLabel}”提供了与“${targetLabel}”有关的人工信息，等待语义复核判断其中的一次性要求、职责、偏好或其他长期知识。`).trim();
  const summary = provisional.length >= 20 ? provisional : `${provisional}，等待后续语义复核和范围判断。`;
  const keywords = [...new Set([
    ...(input.keywords ?? []),
    "人工知识",
    "用户反馈",
    actionLabel,
    targetType,
    targetLabel,
  ].map((value) => String(value).trim().slice(0, 200)).filter(Boolean))].slice(0, 80);
  const retrievalCues = [...new Set([
    ...(input.retrievalCues ?? []),
    `用户对“${targetLabel}”给出了什么明确要求或反馈？`,
    `这条人工信息反映了哪些一次性要求、职责、偏好或职责边界？`,
  ].map((value) => String(value).trim().slice(0, 500)).filter(Boolean))].slice(0, 40);
  const humanFeedback = {
    ...(input.metadata?.humanFeedback ?? {}),
    action,
    actionLabel,
    targetType,
    targetId: targetId || null,
    targetLabel,
    explicitUserInput: true,
    source: String(input.feedbackSource ?? "manual").slice(0, 120),
  };
  return captureKnowledge(database, {
    ...input,
    sourceType: input.sourceType ?? "dialogue",
    title,
    content,
    summary,
    keywords,
    retrievalCues,
    salience: input.salience ?? 0.9,
    sourceLocator: input.sourceLocator ?? `shadow://knowledge-episode/${targetType}/${targetId || action}`,
    generatedBy: input.generatedBy ?? "shadow-human-feedback",
    metadata: {
      ...(input.metadata ?? {}),
      humanFeedback,
    },
  }, options);
}

function factIdsSupportedByEvidence(database, evidenceIds) {
  if (!evidenceIds.length) return [];
  const placeholders = evidenceIds.map(() => "?").join(",");
  return database.prepare(`
    SELECT DISTINCT fact_id FROM graph_evidence_assessments
    WHERE evidence_id IN (${placeholders}) AND stance='supports'
    UNION
    SELECT DISTINCT fact_id FROM graph_fact_evidence
    WHERE evidence_id IN (${placeholders})
  `).all(...evidenceIds, ...evidenceIds).map((row) => row.fact_id);
}

function factHasCurrentSupport(database, factId, now) {
  return Boolean(database.prepare(`
    SELECT 1
    FROM graph_evidence_assessments assessment
    WHERE assessment.fact_id=? AND assessment.stance='supports'
      AND (assessment.valid_until IS NULL OR assessment.valid_until>?)
      AND NOT EXISTS (
        SELECT 1 FROM evidence_links replacement
        WHERE replacement.child_evidence_id=assessment.evidence_id
          AND replacement.relation='supersedes'
      )
    UNION ALL
    SELECT 1
    FROM graph_fact_evidence legacy
    WHERE legacy.fact_id=?
      AND NOT EXISTS (
        SELECT 1 FROM graph_evidence_assessments assessment
        WHERE assessment.fact_id=legacy.fact_id AND assessment.evidence_id=legacy.evidence_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM evidence_links replacement
        WHERE replacement.child_evidence_id=legacy.evidence_id
          AND replacement.relation='supersedes'
      )
    LIMIT 1
  `).get(factId, now, factId));
}

function dependentFactIds(database, seedFactIds) {
  const seen = new Set(seedFactIds);
  const queue = [...seedFactIds];
  for (let index = 0; index < queue.length; index += 1) {
    const rows = database.prepare(`
      SELECT derivation.conclusion_fact_id AS fact_id
      FROM graph_derivation_inputs input
      JOIN graph_derivations derivation ON derivation.id=input.derivation_id
      WHERE input.input_fact_id=?
    `).all(queue[index]);
    for (const row of rows) {
      if (seen.has(row.fact_id)) continue;
      seen.add(row.fact_id);
      queue.push(row.fact_id);
    }
  }
  return [...seen];
}

export function reviseKnowledge(database, input) {
  ensureCurrentGraph(database);
  const supersedesEvidenceIds = [...new Set((input.supersedesEvidenceIds ?? []).map(String).filter(Boolean))];
  if (!supersedesEvidenceIds.length) throw new Error("Manual revision requires at least one supersedesEvidenceId");
  const revisionReason = redactSecrets(String(input.revisionReason ?? "").trim()).slice(0, 4000);
  if (revisionReason.length < 3) throw new Error("Manual revision requires revisionReason");
  const oldRows = database.prepare(`
    SELECT id, title, source_locator FROM evidence
    WHERE id IN (${supersedesEvidenceIds.map(() => "?").join(",")})
  `).all(...supersedesEvidenceIds);
  if (oldRows.length !== supersedesEvidenceIds.length) throw new Error("Manual revision references unknown evidence");

  const now = new Date().toISOString();
  const generatedBy = String(input.generatedBy ?? "openclaw-main").slice(0, 120);
  database.exec("BEGIN IMMEDIATE");
  try {
    const captured = captureKnowledge(database, {
      ...input,
      metadata: {
        ...(input.metadata ?? {}),
        manualRevision: true,
        revisionReason,
        supersedesEvidenceIds,
      },
    }, { transaction: false });
    if (supersedesEvidenceIds.includes(captured.evidenceId)) {
      throw new Error("A revision must append new evidence instead of superseding itself");
    }

    const link = database.prepare(`
      INSERT OR IGNORE INTO evidence_links(parent_evidence_id, child_evidence_id, relation, created_at)
      VALUES(?, ?, 'supersedes', ?)
    `);
    const updateAnnotation = database.prepare(`
      UPDATE graph_episode_annotations SET status='superseded', updated_at=?, metadata_json=?
      WHERE evidence_id=?
    `);
    for (const old of oldRows) {
      link.run(captured.evidenceId, old.id, now);
      database.prepare(`UPDATE context_changes SET status='acknowledged', acknowledged_at=?,
        ack_note='superseded feedback; review replacement evidence', lease_owner=NULL, lease_until=NULL
        WHERE evidence_id=? AND kind='task_progress_due' AND status IN ('pending','leased')
          AND json_extract(metadata_json, '$.reason')='knowledge_feedback_reviewed'`)
        .run(now, old.id);
      const annotation = database.prepare("SELECT metadata_json FROM graph_episode_annotations WHERE evidence_id=?").get(old.id);
      if (annotation) {
        const metadata = parseJson(annotation.metadata_json);
        updateAnnotation.run(now, stable({
          ...metadata,
          revision: {
            rationale: revisionReason,
            supersededByEvidenceId: captured.evidenceId,
            supersededAt: now,
            revisedBy: generatedBy,
          },
        }), old.id);
      }
    }
    database.prepare(`
      UPDATE graph_evidence_assessments SET valid_until=?
      WHERE evidence_id IN (${supersedesEvidenceIds.map(() => "?").join(",")})
        AND (valid_until IS NULL OR valid_until>?)
    `).run(now, ...supersedesEvidenceIds, now);

    const directlyAffected = factIdsSupportedByEvidence(database, supersedesEvidenceIds)
      .filter((factId) => !factHasCurrentSupport(database, factId, now));
    const reviewCandidates = dependentFactIds(database, directlyAffected);
    const markedNeedsReviewFactIds = [];
    for (const factId of reviewCandidates) {
      const fact = database.prepare("SELECT epistemic_status, metadata_json FROM graph_facts WHERE id=? AND status='active'").get(factId);
      if (!fact || ["refuted", "disputed"].includes(fact.epistemic_status)) continue;
      const metadata = parseJson(fact.metadata_json);
      database.prepare(`
        UPDATE graph_facts SET epistemic_status='proposed', updated_at=?, metadata_json=? WHERE id=?
      `).run(now, stable({
        ...metadata,
        manualRevision: {
          status: "pending_review",
          previousEpistemicStatus: fact.epistemic_status,
          revisionEvidenceId: captured.evidenceId,
          supersededEvidenceIds: supersedesEvidenceIds,
          reason: revisionReason,
          requestedBy: generatedBy,
          requestedAt: now,
        },
      }), factId);
      markedNeedsReviewFactIds.push(factId);
    }

    database.exec("COMMIT");
    return {
      revisionEvidenceId: captured.evidenceId,
      inserted: captured.inserted,
      supersedesEvidenceIds,
      revisionReason,
      reviewStatus: "pending",
      affectedFactIds: reviewCandidates,
      markedNeedsReviewFactIds,
      source: {
        evidenceId: captured.evidenceId,
        sourceType: captured.sourceType,
        sourceLocator: String(input.sourceLocator ?? `shadow://manual-knowledge/${input.sourceType ?? "note"}`),
      },
      audit: {
        action: "append_revision_and_supersede",
        actor: generatedBy,
        occurredAt: now,
        immutableEvidence: true,
      },
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function reviewedFactState(database, factId, now) {
  const fact = database.prepare(`SELECT id, subject_entity_id, predicate, object_entity_id, object_value,
    scope_key, status, assertion_mode, confidence, valid_from, valid_to, supersedes_fact_id
    FROM graph_facts WHERE id=?`).get(factId);
  if (!fact) throw new Error(`Graph review references an unknown factId: ${factId}`);
  const assessments = database.prepare(`SELECT evidence_id, stance, level, basis, directness, method,
    environment, outcome, confidence, scope_json, valid_until,
    EXISTS(SELECT 1 FROM evidence_links link WHERE link.child_evidence_id=assessment.evidence_id
      AND link.relation='supersedes' AND link.created_at<=?) AS superseded
    FROM graph_evidence_assessments assessment WHERE fact_id=?`).all(now, factId)
    .map(({ scope_json, ...row }) => ({ ...row, scope: parseJson(scope_json),
      effective: !row.superseded && (!row.valid_until || Date.parse(row.valid_until) > Date.parse(now)) }));
  // Assessment row IDs and prose can change on retries; source identity and meaning cannot.
  return { ...fact, effective: (!fact.valid_from || Date.parse(fact.valid_from) <= Date.parse(now))
      && (!fact.valid_to || Date.parse(fact.valid_to) > Date.parse(now)),
    trust: currentFactTrust(database, factId, { asOf: now }),
    assessments: [...new Set(assessments.map(stable))].sort().map((value) => JSON.parse(value)) };
}

function activeTaskBinding(database, taskId) {
  return database.prepare(`SELECT session_key FROM conversation_bindings
    WHERE task_id=? AND session_kind='task' AND status='active'
    ORDER BY last_event_at DESC, id LIMIT 1`).get(taskId);
}

export function hasActiveTaskBinding(database, taskId) {
  return Boolean(activeTaskBinding(database, taskId));
}

function validateTaskImpacts(database, impacts = []) {
  if (!Array.isArray(impacts) || impacts.length > 20) throw new Error("taskImpacts must contain at most 20 task impacts");
  const seen = new Set();
  return impacts.map((impact) => {
    if (!impact || typeof impact.taskId !== "string" || !impact.taskId.trim() || impact.taskId.length > 1000
      || typeof impact.reason !== "string" || impact.reason.trim().length < 3 || impact.reason.length > 2000) {
      throw new Error("taskImpacts requires a taskId (1-1000 characters) and reason (3-2000 characters)");
    }
    const taskId = impact.taskId.trim();
    if (seen.has(taskId)) throw new Error(`Duplicate taskImpacts taskId: ${taskId}`);
    seen.add(taskId);
    if (!activeTaskBinding(database, taskId)) throw new Error(`taskImpacts requires an existing active task session binding: ${taskId}`);
    return { taskId, reason: impact.reason.trim() };
  });
}

function queueReviewedFeedbackForTasks(database, evidence, review, taskImpacts, now, isTaskActive) {
  const metadata = parseJson(evidence.metadata_json);
  const sourceEvidenceIds = metadata.knowledgeDelta?.sourceEvidenceIds ?? [];
  // Revision links preserve relevance, not the old instruction's authority.
  const lineageIds = database.prepare(`
    WITH RECURSIVE lineage(id) AS (
      SELECT value FROM json_each(?) UNION
      SELECT link.child_evidence_id FROM evidence_links link
      JOIN lineage ON link.parent_evidence_id=lineage.id WHERE link.relation='supersedes'
    )
    SELECT id FROM lineage
  `).all(stable([evidence.id, ...sourceEvidenceIds])).map((row) => row.id);
  const targets = database.prepare(`
    SELECT DISTINCT CASE json_extract(e.metadata_json, '$.humanFeedback.targetType')
      WHEN 'workboard_task' THEN json_extract(e.metadata_json, '$.humanFeedback.targetId')
      WHEN 'outbound_message' THEN draft.task_id END AS task_id
    FROM evidence e
    LEFT JOIN outbound_message_drafts draft
      ON json_extract(e.metadata_json, '$.humanFeedback.targetType')='outbound_message'
      AND draft.id=json_extract(e.metadata_json, '$.humanFeedback.targetId')
    WHERE e.id IN (SELECT value FROM json_each(?))
      AND json_extract(e.metadata_json, '$.humanFeedback.explicitUserInput')=1
      AND json_extract(e.metadata_json, '$.knowledgeDelta') IS NULL
    ORDER BY task_id
  `).all(stable(lineageIds));
  // Use persisted purposeful deliveries, including acknowledged ones, not project membership.
  const routed = database.prepare(`SELECT DISTINCT json_extract(change.metadata_json, '$.taskId') AS task_id
    FROM context_changes change WHERE json_valid(change.metadata_json)
      AND json_extract(change.metadata_json, '$.taskId') IS NOT NULL
      AND change.kind IN ('task_progress_due', 'human_agent_operation')
      AND json_extract(change.metadata_json, '$.informationDelivery') IS NULL
      AND COALESCE(json_extract(change.metadata_json, '$.reason'), '')<>'knowledge_feedback_reviewed'
      AND (change.evidence_id IN (SELECT value FROM json_each(?)) OR EXISTS(
        SELECT 1 FROM json_each(change.metadata_json, '$.evidenceIds') linked
        WHERE linked.value IN (SELECT value FROM json_each(?))))
  `).all(stable(lineageIds), stable(lineageIds));
  const explicit = new Map(taskImpacts.map((impact) => [impact.taskId, impact.reason]));
  const taskIds = new Set([...targets, ...routed].map((row) => row.task_id).filter(Boolean));
  for (const target of getInformationTaskTargets(database, lineageIds)) taskIds.add(target.taskId);
  if (metadata.knowledgeDelta && metadata.taskId) taskIds.add(metadata.taskId);
  for (const taskId of explicit.keys()) taskIds.add(taskId);
  const { reviewHash, reviewVersion, reviewIdentity } = review;
  const changes = [];
  for (const taskId of [...taskIds].sort()) {
    const binding = activeTaskBinding(database, taskId);
    if (!binding) continue;
    if (isTaskActive) {
      const active = isTaskActive(taskId);
      if (typeof active !== "boolean") throw new Error("isTaskActive must synchronously return a boolean");
      if (!active) continue;
    }
    const previous = database.prepare(`
      SELECT seq, event_key, kind, status, session_key, metadata_json FROM context_changes
      WHERE json_extract(metadata_json, '$.taskId')=?
        AND (evidence_id=? OR json_extract(metadata_json, '$.reviewIdentity')=?)
        AND kind='task_progress_due' AND json_extract(metadata_json, '$.reason')='knowledge_feedback_reviewed'
      ORDER BY seq DESC LIMIT 1
    `).get(taskId, evidence.id, reviewIdentity);
    const previousMetadata = parseJson(previous?.metadata_json);
    if (previous && previousMetadata.reviewHash === reviewHash && previousMetadata.reviewIdentity === reviewIdentity) {
      const { metadata_json, ...change } = previous;
      changes.push(change);
      continue;
    }
    const humanFeedback = targets.some((row) => row.task_id === taskId) && !metadata.knowledgeDelta;
    if (!review.materialChange && !previous && !explicit.has(taskId) && !humanFeedback) continue;
    // A -> B -> A is a new decision, unlike a consecutive A -> A retry.
    const eventKey = `knowledge-feedback-reviewed:${reviewIdentity}:${taskId}:${reviewVersion}:${reviewHash}`;
    database.prepare(`
    INSERT INTO context_changes(
      event_key, coalesce_key, kind, evidence_id, project_key, session_key,
      priority, status, not_before, occurred_at, created_at, summary, metadata_json
    ) VALUES(?, NULL, 'task_progress_due', ?, ?, ?, 'high', 'pending', ?, ?, ?, ?, ?)
    ON CONFLICT(event_key) DO NOTHING
    `).run(eventKey, evidence.id, evidence.project_key, binding.session_key, now, now, now,
    `任务相关知识已复核：${String(evidence.title ?? evidence.id).slice(0, 500)}`,
    stable({ taskId, reason: "knowledge_feedback_reviewed", evidenceIds: [...new Set([evidence.id, ...sourceEvidenceIds])],
      sourceEvidenceIds, sourceOccurredAt: evidence.occurred_at, reviewHash, reviewVersion, reviewIdentity, graphReview: review,
      impactReason: explicit.get(taskId) ?? "Reviewed knowledge changed for an existing source-linked task.",
      requiredAction: "reassess_original_task_against_feedback_and_current_evidence",
      grantsAuthorization: false, mayReopenTask: false }));
    changes.push(database.prepare("SELECT seq, event_key, kind, status, session_key FROM context_changes WHERE event_key=?").get(eventKey));
  }
  return changes;
}

// isTaskActive is an optional synchronous, authoritative task-liveness check for every target.
export function completeKnowledgeAnnotation(database, input, { isTaskActive } = {}) {
  ensureCurrentGraph(database);
  if (isTaskActive !== undefined && typeof isTaskActive !== "function") throw new Error("isTaskActive must be a function");
  database.exec("BEGIN IMMEDIATE");
  try {
    const leaseOwner = String(input.leaseOwner ?? "openclaw-main");
    const queue = database.prepare("SELECT * FROM graph_enrichment_queue WHERE evidence_id=?").get(input.evidenceId);
    if (!queue) throw new Error(`Knowledge episode is not queued: ${input.evidenceId}`);
    if (queue.status === "leased" && queue.lease_owner !== leaseOwner) throw new Error(`Knowledge episode is leased by ${queue.lease_owner}`);
    const evidence = database.prepare("SELECT * FROM evidence WHERE id=?").get(input.evidenceId);
    if (!evidence) throw new Error(`Unknown evidence: ${input.evidenceId}`);
    const replacement = database.prepare(`SELECT parent_evidence_id FROM evidence_links
      WHERE child_evidence_id=? AND relation='supersedes' LIMIT 1`).get(evidence.id);
    if (replacement) throw new Error(`Knowledge episode was superseded by ${replacement.parent_evidence_id}; review the replacement evidence instead`);
    if (hash(evidence.content ?? "") !== queue.content_hash) throw new Error("Evidence changed after it was queued; requeue before annotating");
    const existingAnnotation = database.prepare(`
      SELECT scope_json, salience, metadata_json
      FROM graph_episode_annotations WHERE evidence_id=?
    `).get(input.evidenceId);
    const existingAnnotationMetadata = parseJson(existingAnnotation?.metadata_json, {});
    const annotationScope = { ...(input.scope ?? parseJson(existingAnnotation?.scope_json, {})) };
    if (evidence.project_key && !annotationScope.projectKey) annotationScope.projectKey = evidence.project_key;
    const graphReview = input.graphReview ?? {};
    let reviewStatus = String(graphReview.status ?? "");
    let reviewOutcome = graphReview.outcome == null ? null : String(graphReview.outcome);
    let reviewRationale = String(graphReview.rationale ?? "").trim();
    if (!["completed", "needs_input"].includes(reviewStatus)) {
      throw new Error("graphReview.status must be completed or needs_input");
    }
    if (reviewStatus === "completed" && !["facts_recorded", "no_durable_facts"].includes(reviewOutcome)) {
      throw new Error("completed graph review requires facts_recorded or no_durable_facts outcome");
    }
    if (reviewStatus === "needs_input" && reviewOutcome !== null) {
      throw new Error("needs_input graph review cannot have a completed outcome");
    }
    if (reviewRationale.length < 3) throw new Error("graphReview.rationale is required");
    const unresolvedRevisions = database.prepare(`
      SELECT DISTINCT f.id, f.metadata_json FROM graph_facts f
      JOIN graph_evidence_assessments a ON a.fact_id=f.id WHERE a.evidence_id=?
        AND json_valid(f.metadata_json) AND json_extract(f.metadata_json, '$.supersessionReview.status')='needs_input'
    `).all(evidence.id).map((row) => ({ factId: row.id, ...parseJson(row.metadata_json).supersessionReview }));
    if (reviewStatus === "completed" && unresolvedRevisions.length) {
      reviewStatus = "needs_input";
      reviewOutcome = null;
      reviewRationale = `Unresolved knowledge revision: ${unresolvedRevisions.map((row) => `${row.factId}: ${row.problems.join(', ')}`).join('; ')}. ${reviewRationale}`;
    }
    const readFactIds = (value, field) => {
      if (!Array.isArray(value) || value.length > 100
        || value.some((id) => typeof id !== "string" || !id.trim() || id.length > 1000)) {
        throw new Error(`${field} must be an array of at most 100 nonempty fact IDs`);
      }
      return [...new Set(value)].sort();
    };
    const factIds = readFactIds(graphReview.factIds ?? [], "graphReview.factIds");
    const alreadyRepresentedFactIds = readFactIds(graphReview.alreadyRepresentedFactIds ?? [], "graphReview.alreadyRepresentedFactIds");
    const delta = parseJson(evidence.metadata_json).knowledgeDelta;
    if (alreadyRepresentedFactIds.length) {
      if (evidence.kind !== "shadow_agent_task_result" || !delta?.sourceEvidenceIds?.length || !delta.idempotencyKey) {
        throw new Error("alreadyRepresentedFactIds requires a knowledge delta with primary sourceEvidenceIds");
      }
      if (alreadyRepresentedFactIds.some((id) => factIds.includes(id))) {
        throw new Error("alreadyRepresentedFactIds must not overlap direct graphReview.factIds");
      }
      const supported = database.prepare(`SELECT COUNT(DISTINCT assessment.fact_id) AS count
        FROM graph_evidence_assessments assessment JOIN evidence source ON source.id=assessment.evidence_id
        WHERE assessment.fact_id IN (SELECT value FROM json_each(?))
          AND assessment.evidence_id IN (SELECT value FROM json_each(?)) AND assessment.stance='supports'
          AND (assessment.valid_until IS NULL OR julianday(assessment.valid_until)>julianday(?))
          AND json_extract(source.metadata_json, '$.knowledgeDelta') IS NULL
          AND NOT EXISTS(SELECT 1 FROM evidence_links link
            WHERE link.child_evidence_id=assessment.evidence_id AND link.relation='supersedes')
      `).get(stable(alreadyRepresentedFactIds), stable(delta.sourceEvidenceIds), new Date().toISOString()).count;
      if (supported !== alreadyRepresentedFactIds.length) {
        throw new Error("Every already represented fact must have current support from the delta's primary sourceEvidenceIds");
      }
    }
    if (reviewOutcome === "facts_recorded") {
      if (!factIds.length && !alreadyRepresentedFactIds.length) throw new Error("facts_recorded graph review requires at least one factId or alreadyRepresentedFactId");
    }
    if (factIds.length) {
      const placeholders = factIds.map(() => "?").join(",");
      const missing = database.prepare(`SELECT COUNT(*) AS count FROM graph_facts WHERE id IN (${placeholders})`).get(...factIds).count;
      if (missing !== factIds.length) throw new Error("facts_recorded graph review references an unknown factId");
      const supported = database.prepare(`
        SELECT COUNT(DISTINCT fact_id) AS count
        FROM graph_evidence_assessments
        WHERE evidence_id=? AND fact_id IN (${placeholders})
      `).get(evidence.id, ...factIds).count;
      if (supported !== factIds.length) {
        throw new Error("every recorded fact must have an evidence assessment from this knowledge episode");
      }
    }
    const now = new Date().toISOString();
    const taskImpacts = validateTaskImpacts(database, input.taskImpacts);
    const reviewedFactIds = [...new Set([...factIds, ...alreadyRepresentedFactIds])].sort();
    const facts = reviewedFactIds.map((id) => reviewedFactState(database, id, now));
    const reviewIdentity = hash(stable({
      sourceEvidenceIds: [...new Set(delta?.sourceEvidenceIds?.length ? delta.sourceEvidenceIds : [evidence.id])].sort(),
      factIds: reviewedFactIds,
    }));
    const reviewHash = hash(stable({ status: reviewStatus, outcome: reviewOutcome, facts }));
    // Equivalent candidates share the latest reviewed state, not their task-summary wording.
    // Bound each indexed branch before sorting, even when an identity has many old candidates.
    const latestAnnotation = database.prepare(`SELECT metadata_json FROM (
      SELECT evidence_id, updated_at, metadata_json,
        CAST(json_extract(metadata_json, '$.graphReview.reviewVersion') AS INTEGER) AS review_version
      FROM graph_episode_annotations WHERE evidence_id=?
      UNION ALL
      SELECT * FROM (
        SELECT evidence_id, updated_at, metadata_json,
          CAST(json_extract(metadata_json, '$.graphReview.reviewVersion') AS INTEGER) AS review_version
        FROM graph_episode_annotations
        WHERE json_extract(metadata_json, '$.graphReview.reviewIdentity')=?
        ORDER BY review_version DESC, updated_at DESC, evidence_id LIMIT 1
      )
    ) ORDER BY review_version DESC, updated_at DESC, evidence_id LIMIT 1`).get(evidence.id, reviewIdentity);
    const previousReview = parseJson(latestAnnotation?.metadata_json).graphReview ?? {};
    const unchanged = previousReview.reviewIdentity === reviewIdentity && previousReview.reviewHash === reviewHash;
    const reviewVersion = unchanged ? previousReview.reviewVersion : (Number(previousReview.reviewVersion) || 0) + 1;
    const initialMaterialChange = reviewStatus === "needs_input" || (delta
      ? facts.some((fact) => (factIds.includes(fact.id) || delta.reviewBaseline?.[fact.id])
        && delta.reviewBaseline?.[fact.id] !== hash(stable(fact))) : facts.length > 0);
    const localReview = existingAnnotationMetadata.graphReview ?? {};
    const localUnchanged = localReview.reviewIdentity === reviewIdentity && localReview.reviewHash === reviewHash;
    const materialChange = unchanged ? (localUnchanged ? Boolean(localReview.materialChange) : initialMaterialChange)
      : Boolean(previousReview.reviewHash) || initialMaterialChange;
    const reviewed = {
      status: reviewStatus, outcome: reviewOutcome, rationale: reviewRationale, factIds, alreadyRepresentedFactIds,
      contentHash: queue.content_hash, reviewHash, reviewVersion, reviewIdentity, materialChange,
      summary: String(input.summary ?? "").slice(0, 8000),
    };
    database.prepare(`
      INSERT INTO graph_episode_annotations(
        evidence_id, title, summary, keywords_json, retrieval_cues_json, scope_json,
        salience, status, review_status, review_outcome, content_hash, annotation_version, generated_by,
        generated_at, updated_at, metadata_json
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(evidence_id) DO UPDATE SET
        title=excluded.title, summary=excluded.summary,
        keywords_json=excluded.keywords_json, retrieval_cues_json=excluded.retrieval_cues_json,
        scope_json=excluded.scope_json, salience=excluded.salience, status='ready',
        review_status=excluded.review_status, review_outcome=excluded.review_outcome,
        content_hash=excluded.content_hash, annotation_version=excluded.annotation_version,
        generated_by=excluded.generated_by, generated_at=excluded.generated_at,
        updated_at=excluded.updated_at, metadata_json=excluded.metadata_json
    `).run(
      evidence.id,
      String(input.title ?? evidence.title ?? evidence.kind).slice(0, 2000),
      String(input.summary ?? "").slice(0, 8000),
      stable([...new Set(input.keywords ?? [])].slice(0, 80)),
      stable([...new Set(input.retrievalCues ?? [])].slice(0, 40)),
      stable(annotationScope),
      clamp(input.salience ?? existingAnnotation?.salience ?? 0.5),
      reviewStatus,
      reviewOutcome,
      queue.content_hash,
      String(input.generatedBy ?? leaseOwner).slice(0, 120),
      now,
      now,
      stable({
        ...existingAnnotationMetadata,
        decisions: input.decisions ?? existingAnnotationMetadata.decisions ?? [],
        openQuestions: input.openQuestions ?? existingAnnotationMetadata.openQuestions ?? [],
        taskImpacts,
        graphReview: {
          ...reviewed,
          reviewedBy: String(input.generatedBy ?? leaseOwner).slice(0, 120),
          reviewedAt: now,
        },
      }),
    );
    refreshEpisodeSearch(database, evidence.id);
    const queueStatus = reviewStatus === "needs_input" ? "review_needed" : "completed";
    database.prepare(`
      UPDATE graph_enrichment_queue SET status=?, completed_at=?,
        lease_owner=NULL, lease_until=NULL, last_error=NULL,
        metadata_json=? WHERE evidence_id=?
    `).run(
      queueStatus,
      queueStatus === "completed" ? now : null,
      stable({ ...parseJson(queue.metadata_json), graphReviewStatus: reviewStatus, graphReviewOutcome: reviewOutcome,
        graphReviewRationale: reviewRationale, unresolvedRevisions }),
      evidence.id,
    );
    const taskReviewChanges = queueReviewedFeedbackForTasks(database, evidence, reviewed, taskImpacts, now, isTaskActive);
    database.exec("COMMIT");
    return {
      evidenceId: evidence.id,
      status: "ready",
      graphReviewStatus: reviewStatus,
      graphReviewOutcome: reviewOutcome,
      queueStatus,
      linkedFactCount: reviewedFactIds.length,
      alreadyRepresentedFactCount: alreadyRepresentedFactIds.length,
      reviewHash,
      reviewVersion,
      keywordCount: input.keywords?.length ?? 0,
      retrievalCueCount: input.retrievalCues?.length ?? 0,
      unresolvedRevisions,
      taskReviewChanges,
      nextAction: unresolvedRevisions.length ? "Inspect target claim and scope; retry the revision with corrected evidence or retain an explicit conflict. Revision is not complete." : null,
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function evidenceFactor(level) {
  return [0.45, 0.55, 0.70, 0.82, 0.92, 1][Math.max(0, Math.min(5, Number(level) || 0))];
}

export function traceImpact(database, input) {
  ensureCurrentGraph(database);
  const seeds = [...new Set((input.seedEntityIds ?? []).map((value) => resolveEntity(database, value)))];
  if (!seeds.length) throw new Error("At least one seedEntityId is required");
  const maxDepth = Math.max(1, Math.min(6, Number(input.maxDepth ?? 3) || 3));
  const minConfidence = clamp(input.minConfidence ?? 0.1);
  let frontier = seeds.map((id) => ({ entityId: id, confidence: 1, path: [], visited: new Set([id]) }));
  const best = new Map(seeds.map((id) => [id, 1]));
  const impacts = [];
  const unmodeled = new Map();
  for (let depth = 0; depth < maxDepth && frontier.length; depth += 1) {
    const next = [];
    for (const state of frontier) {
      const now = new Date().toISOString();
      const rows = database.prepare(`
        SELECT f.*, r.forward_impact_weight, r.reverse_impact_weight, r.max_impact_hops,
          support.level AS evidence_level
        FROM graph_facts f JOIN graph_relation_types r ON r.predicate=f.predicate
        JOIN graph_evidence_assessments support ON support.id=(
          SELECT assessment.id FROM graph_evidence_assessments assessment
          LEFT JOIN graph_episode_annotations annotation ON annotation.evidence_id=assessment.evidence_id
          WHERE assessment.fact_id=f.id AND assessment.stance='supports'
            AND (assessment.valid_until IS NULL OR assessment.valid_until>?)
            AND NOT EXISTS (
              SELECT 1 FROM evidence_links replacement
              WHERE replacement.child_evidence_id=assessment.evidence_id
                AND replacement.relation='supersedes'
            )
            AND COALESCE(annotation.review_status, 'evidence_assessed')
              IN ('completed', 'evidence_assessed')
          ORDER BY assessment.level DESC, assessment.assessed_at DESC LIMIT 1
        )
        WHERE f.status='active'
          AND (f.valid_to IS NULL OR f.valid_to>?)
          AND COALESCE(f.epistemic_status, 'asserted') IN ('supported', 'asserted')
          AND (f.subject_entity_id=? OR f.object_entity_id=?)
      `).all(now, now, state.entityId, state.entityId);
      for (const row of rows) {
        const directions = [];
        if (row.subject_entity_id === state.entityId && row.object_entity_id && row.forward_impact_weight > 0) {
          directions.push({ target: row.object_entity_id, direction: "forward", weight: row.forward_impact_weight });
        }
        if (row.object_entity_id === state.entityId && row.reverse_impact_weight > 0) {
          directions.push({ target: row.subject_entity_id, direction: "reverse", weight: row.reverse_impact_weight });
        }
        if (!directions.length && row.object_entity_id) {
          const candidateEntityId = row.subject_entity_id === state.entityId ? row.object_entity_id : row.subject_entity_id;
          unmodeled.set(`${row.id}:${state.entityId}:${candidateEntityId}`, {
            factId: row.id,
            predicate: row.predicate,
            fromEntityId: state.entityId,
            candidateEntityId,
            reason: "Relation is stored but has no deterministic impact rule; Codex should inspect its context.",
          });
        }
        for (const direction of directions) {
          if (state.visited.has(direction.target)) continue;
          if (row.max_impact_hops > 0 && depth + 1 > row.max_impact_hops) continue;
          const confidence = state.confidence * clamp(row.confidence) * clamp(direction.weight) * evidenceFactor(row.evidence_level);
          if (confidence < minConfidence) continue;
          const step = {
            factId: row.id,
            predicate: row.predicate,
            direction: direction.direction,
            fromEntityId: state.entityId,
            toEntityId: direction.target,
            evidenceLevel: Number(row.evidence_level),
            confidence,
          };
          const path = [...state.path, step];
          const entity = database.prepare("SELECT id, canonical_key, type, name, summary FROM graph_entities WHERE id=?").get(direction.target);
          impacts.push({ impactedEntity: entity, confidence, path });
          if (confidence > (best.get(direction.target) ?? 0)) {
            best.set(direction.target, confidence);
            next.push({ entityId: direction.target, confidence, path, visited: new Set([...state.visited, direction.target]) });
          }
        }
      }
    }
    frontier = next;
  }
  return {
    seeds,
    maxDepth,
    minConfidence,
    unmodeledEdges: [...unmodeled.values()],
    impacts: impacts.sort((a, b) => b.confidence - a.confidence || a.path.length - b.path.length),
  };
}
