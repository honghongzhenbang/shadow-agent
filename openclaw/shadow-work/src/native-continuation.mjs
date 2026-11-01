import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ACTIVE_TASK_STATUSES, checkpointRequestHash, checkpointVersion, sameExecution } from './task-checkpoint-guard.mjs';
import { readNativeSessionId } from './native-session-store.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier = value => typeof value === 'string' && value.length > 0;
const read = (db, key) => {
  const value = db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
  return value ? JSON.parse(value) : null;
};
const put = (db, key, value) => db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)')
  .run(key, JSON.stringify(value), new Date().toISOString());
const callKey = identity => `native-send:${digest([identity.sessionKey, identity.runId, identity.toolCallId])}`;
const runKey = (taskId, runId) => `native-send-run:${digest([taskId, runId])}`;

export function nativeSendIdentity(event, ctx) {
  if (event?.toolName !== 'sessions_send' || !identifier(ctx?.sessionKey)
    || !identifier(ctx?.runId) || event.runId !== ctx.runId || !identifier(event.toolCallId)
    || ctx.toolCallId !== event.toolCallId) return null;
  return { sessionKey: ctx.sessionKey, runId: ctx.runId, toolCallId: event.toolCallId };
}

// Only read exact native run starts. A dispatch ID or a terminal answer is not
// enough to establish the child incarnation or the model actually used.
export function readNativeRunStart(filename, runId, sessionKey) {
  if (!identifier(filename) || !fs.existsSync(filename)) return null;
  let db;
  try {
    db = new DatabaseSync(filename, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
    const rows = db.prepare(`SELECT session_id, seq, event_json FROM trajectory_runtime_events
      WHERE run_id=? AND json_extract(event_json,'$.sessionKey')=?
        AND json_extract(event_json,'$.type')='session.started' ORDER BY seq LIMIT 2`).all(runId, sessionKey);
    if (rows.length !== 1) return null;
    const row = rows[0], event = JSON.parse(row.event_json);
    if (!identifier(row.session_id) || row.session_id !== event.sessionId || event.runId !== runId
      || !identifier(event.provider) || !identifier(event.modelId) || !Number.isFinite(Date.parse(event.ts))) return null;
    return { runId, sessionKey, sessionId: row.session_id, seq: row.seq,
      model: `${event.provider}/${event.modelId}`, startedAt: event.ts };
  } catch { return null; }
  finally { db?.close(); }
}

export function captureNativeSendBefore(db, card, event, identity, nativeDatabasePath) {
  const params = event.params;
  if (!identity || !card || card.archived_at || !ACTIVE_TASK_STATUSES.has(card.status)
    || !identifier(card.execution_run_id) || !identifier(card.execution_session_key)
    || params?.sessionKey !== card.execution_session_key || !(params.timeoutSeconds > 0)
    || !Number.isFinite(params.timeoutSeconds)) return { captured: false };
  const owner = db.prepare('SELECT * FROM conversation_bindings WHERE session_key=?').get(identity.sessionKey);
  const attention = db.prepare('SELECT * FROM work_task_attention WHERE card_id=?').get(card.id);
  if (owner?.status !== 'active' || owner.session_kind !== 'task' || owner.task_id !== card.id
    || attention?.owner_session_key !== identity.sessionKey) return { captured: false };
  const original = readNativeRunStart(nativeDatabasePath, card.execution_run_id, card.execution_session_key);
  const key = callKey(identity), paramsHash = checkpointRequestHash(params);
  const previous = read(db, key);
  if (previous) {
    if (previous.paramsHash !== paramsHash || previous.taskId !== card.id) throw new Error('Native send call identity was reused');
    return { captured: true, duplicate: true };
  }
  put(db, key, { taskId: card.id, identity, paramsHash, version: checkpointVersion(attention, card),
    nativeDatabasePath, original, capturedAt: new Date().toISOString() });
  return { captured: true };
}

export function captureNativeSendAfter(db, event, identity) {
  if (!identity) return { captured: false };
  const key = callKey(identity), before = read(db, key);
  if (!before || before.paramsHash !== checkpointRequestHash(event.params)) return { captured: false, reason: 'unpaired_call' };
  const details = event.result?.details;
  // Positive-wait accepted/ok are direct-dispatch branches in the native sender.
  // Zero-wait steering, fallback, errors, and sentBeforeError are not this proof.
  const eligible = !event.error && !event.result?.isError && !details?.error && !details?.sentBeforeError
    && ['accepted', 'ok'].includes(details?.status) && identifier(details?.runId)
    && details.runId !== before.version.execution.runId && details.sessionKey === before.version.execution.sessionKey;
  const outcome = { eligible, status: details?.status ?? 'error', runId: details?.runId ?? null,
    sessionKey: details?.sessionKey ?? null };
  if (before.outcome) {
    if (JSON.stringify(before.outcome) !== JSON.stringify(outcome)) throw new Error('Native send receipt changed after observation');
    return { captured: true, eligible, duplicate: true };
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    if (eligible) {
      const index = runKey(before.taskId, details.runId), old = read(db, index);
      if (old && old.callKey !== key) throw new Error('Native run has conflicting send receipts');
      if (!old) put(db, index, { callKey: key });
    }
    db.prepare('UPDATE settings SET value=?,updated_at=? WHERE key=?')
      .run(JSON.stringify({ ...before, outcome }), new Date().toISOString(), key);
    db.exec('COMMIT');
    return { captured: true, eligible };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function trustedNativeContinuation(db, card, version, input, runtimeContext) {
  const next = input.continuation;
  if (next?.kind === 'codex_run') {
    const pending = db.prepare(`SELECT payload_json FROM controller_outbox
      WHERE action_type='bind_workboard_execution' AND status IN ('pending','retry','processing')
        AND json_extract(payload_json,'$.taskId')=? AND json_extract(payload_json,'$.checkpointRevision')=?`).all(card.id, version.checkpointRevision);
    for (const row of pending) {
      const payload = JSON.parse(row.payload_json);
      const checkpoint = read(db, payload.checkpointKey)?.checkpoint;
      if (checkpoint?.nativeContinuation && sameExecution(payload.expectedExecution, version.execution)) {
        throw new Error('Native continuation binding is still pending. Wait for its existing outbox result and refresh focus; do not resend or overwrite it with the old execution.');
      }
    }
  }
  if (next?.kind !== 'codex_run' || !card.execution_run_id
    || [card.execution_run_id, card.execution_session_key].includes(next.referenceId)) return null;
  const deny = () => { throw new Error('Trusted same-child native continuation receipt is not ready or no longer current. Read execution progress and refresh the checkpoint; do not resend solely for this error.'); };
  if (!runtimeContext?.sessionKey || runtimeContext.sessionKey !== version.ownerSessionKey) return deny();
  const index = read(db, runKey(card.id, next.referenceId));
  const receipt = index && read(db, index.callKey);
  if (!receipt?.outcome?.eligible || receipt.consumedBy || receipt.taskId !== card.id
    || receipt.identity.sessionKey !== version.ownerSessionKey
    || receipt.version.checkpointRevision !== version.checkpointRevision
    || receipt.version.bindingRevision !== version.bindingRevision
    || !sameExecution(receipt.version.execution, version.execution)
    || receipt.outcome.runId !== next.referenceId
    || next.sessionKey !== card.execution_session_key
    || receipt.outcome.sessionKey !== next.sessionKey) return deny();
  const native = readNativeRunStart(receipt.nativeDatabasePath, next.referenceId, next.sessionKey);
  const original = receipt.original ?? readNativeRunStart(receipt.nativeDatabasePath,
    receipt.version.execution.runId, receipt.version.execution.sessionKey);
  if (!native || !original || native.sessionId !== original.sessionId
    || readNativeSessionId(receipt.nativeDatabasePath, next.sessionKey) !== native.sessionId
    || Date.parse(native.startedAt) < Date.parse(receipt.capturedAt)
    || (next.model && next.model !== native.model)) return deny();
  return { key: index.callKey, original, native,
    callerRunId: receipt.identity.runId, toolCallId: receipt.identity.toolCallId };
}

export function consumeNativeContinuation(db, proof, checkpointKey) {
  const receipt = read(db, proof.key);
  if (!receipt || receipt.consumedBy) throw new Error('Native continuation receipt was already consumed');
  db.prepare('UPDATE settings SET value=?,updated_at=? WHERE key=?')
    .run(JSON.stringify({ ...receipt, consumedBy: checkpointKey }), new Date().toISOString(), proof.key);
}

// This host-only observer is not a model tool. The worker serializes both hooks
// and checkpoints; missing hooks never trigger a resend or a Workboard write.
export function createNativeSendObserver({ call, resolveNativeDatabase, logger }) {
  const warn = () => logger?.warn?.('Native continuation receipt unavailable; execution was not rebound.');
  return {
    async before(event, ctx) {
      const identity = nativeSendIdentity(event, ctx);
      if (!identity || !identifier(event.params?.sessionKey) || !(event.params.timeoutSeconds > 0)) return;
      const params = structuredClone(event.params);
      try {
        const nativeDatabasePath = await resolveNativeDatabase(params.sessionKey);
        await call('nativeSendBefore', { event: { params }, identity, nativeDatabasePath });
      } catch { warn(); }
    },
    async after(event, ctx) {
      const identity = nativeSendIdentity(event, ctx);
      if (!identity) return;
      // Do not persist the message/reply; only pairing hashes and native identity.
      const value = structuredClone({ params: event.params, result: { isError: event.result?.isError,
        details: event.result?.details }, error: event.error });
      try { await call('nativeSendAfter', { event: value, identity }); }
      catch { warn(); }
    },
  };
}
