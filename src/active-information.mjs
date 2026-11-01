const EVENT_LIMIT = 4;
const RUN_LIMIT = 128;
const STABLE_SESSION = /^agent:main:shadow:(inbox|(?:conversation|task|workstream):[A-Za-z0-9_-]{1,128})$/;

function sessionKind(sessionKey) {
  return typeof sessionKey === 'string' && STABLE_SESSION.test(sessionKey)
    ? sessionKey.split(':')[3] : null;
}

function identifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(value);
}

/**
 * Read-only notice projection, with no schema initialization or evidence/body reads.
 * Returns null without an active Shadow binding; otherwise returns
 * {sessionKey, binding:{id,sessionKey,sessionKind,taskId,status}, events:[{seq,kind}],
 *  latestSeq, leaseOwner, leaseConflict}. Events are the newest four due pending rows.
 * A conflicting live lease suppresses notification rather than selecting an owner.
 * Task-card terminal status is checked by the caller's authoritative Workboard read.
 */
export function readActiveInformation(database, { sessionKey, now = Date.now() } = {}) {
  const kind = sessionKind(sessionKey);
  if (!kind) return null;
  const timestamp = new Date(now).toISOString();
  const binding = database.prepare(`
    SELECT id, session_key AS sessionKey, session_kind AS sessionKind, task_id AS taskId, status
    FROM conversation_bindings
    WHERE session_key=? AND session_kind=? AND status='active'
    ORDER BY generation DESC, last_event_at DESC, id LIMIT 1
  `).get(sessionKey, kind);
  if (!binding || (kind === 'task' && !binding.taskId)) return null;
  const events = database.prepare(`
    SELECT seq, kind FROM context_changes
    WHERE session_key=? AND status='pending'
      AND julianday(COALESCE(not_before, created_at))<=julianday(?)
    ORDER BY seq DESC LIMIT ?
  `).all(sessionKey, timestamp, EVENT_LIMIT).map(row => ({ ...row }));
  const leases = database.prepare(`
    SELECT DISTINCT lease_owner AS owner FROM context_changes
    WHERE session_key=? AND status='leased' AND lease_owner IS NOT NULL AND lease_owner<>''
      AND julianday(lease_until)>julianday(?)
    ORDER BY owner LIMIT 2
  `).all(sessionKey, timestamp);
  return {
    sessionKey, binding: { ...binding }, events, latestSeq: events[0]?.seq ?? null,
    leaseOwner: leases.length === 1 ? leases[0].owner : null,
    leaseConflict: leases.length > 1,
  };
}

function notice(snapshot, sessionKey, leaseOwner) {
  const packet = JSON.stringify({ sessionKey, leaseOwner, limit: EVENT_LIMIT, maxBytes: 16384 });
  const next = snapshot.binding.sessionKind === 'task'
    ? 'For task input, reconcile the current task and record shadow_task_checkpoint before its guarded ACK.'
    : 'For source input, record shadow_information_dispatch for the actual delivered page before its guarded ACK. For curator input, use the existing knowledge review flow.';
  return `Pending Shadow information (latest change ${snapshot.latestSeq}). In this same session and native run, call shadow_attention_packet with ${packet}. ${next} Read only the bounded packet now; remaining pages stay durable. Reuse this lease owner. This notice contains no evidence and grants no new permission. Queued is not read, reviewed, acted on, or adopted; only subsequent tool receipts establish those outcomes.`;
}

/**
 * SDK-free after_tool_call helper. Adapters may all be asynchronous:
 * read({sessionKey}) -> readActiveInformation projection (or null for terminal tasks);
 * resolveActiveSession(sessionKey) -> active native session ID or null;
 * queue(sessionId, text, {queueIdentity}) -> {accepted:boolean} (or a boolean).
 * Resolve/queue are called only when a notice exists, permitting lazy SDK imports.
 * afterTool(event, {sessionKey,runId,sessionId?}) uses trusted runtime context, never event args.
 * A captured native sessionId must match resolution; this cannot guard run replacement
 * under the same native sessionId or cancel an adapter already entered.
 * clear({sessionKey,runId}) is the agent_end cleanup. No polling, starts, ACKs or SDK imports.
 * Accepted notices advance a per-run latest-sequence high-water mark, not consumption.
 * Up to 128 runs are retained (idle LRU eviction); queueIdentity remains stable after
 * eviction/recreation so the queue adapter can deduplicate. Clear on agent_end normally.
 * Optional onReceipt(summary) observes queue attempts, always with adopted:false.
 */
export function createActiveInformationNotifier({ read, resolveActiveSession, queue, logger, onReceipt } = {}) {
  for (const [name, fn] of Object.entries({ read, resolveActiveSession, queue })) {
    if (typeof fn !== 'function') throw new TypeError(`${name} must be a function`);
  }
  const runs = new Map();
  const keyOf = ctx => sessionKind(ctx?.sessionKey) && identifier(ctx?.runId)
    ? JSON.stringify([ctx.sessionKey, ctx.runId]) : null;
  const result = (status, extra = {}) => ({ status, accepted: false, adopted: false, ...extra });
  const warn = stage => {
    try { logger?.warn?.('Active information notice unavailable; durable input remains pending.', { stage }); }
    catch { /* Observability must not change delivery or retry state. */ }
  };

  async function notify(state, ctx, key) {
    let stage = 'read';
    try {
      const snapshot = await read({ sessionKey: ctx.sessionKey });
      if (runs.get(key) !== state) return result('cleared');
      if (!snapshot || snapshot.sessionKey !== ctx.sessionKey || snapshot.binding?.sessionKey !== ctx.sessionKey
        || snapshot.binding?.status !== 'active' || snapshot.binding?.sessionKind !== sessionKind(ctx.sessionKey)
        || snapshot.leaseConflict || !Array.isArray(snapshot.events) || !snapshot.events.length
        || snapshot.events.length > EVENT_LIMIT || !Number.isSafeInteger(snapshot.latestSeq) || snapshot.latestSeq < 1
        || snapshot.latestSeq !== Math.max(...snapshot.events.map(event => event.seq))
        || snapshot.events.some(event => !Number.isSafeInteger(event.seq) || event.seq < 1)
        || (snapshot.binding.sessionKind === 'task' && !snapshot.binding.taskId)) return result('no_notice');
      if (snapshot.latestSeq <= state.latestSeq) return result('duplicate');
      const leaseOwner = snapshot.leaseOwner ?? `active-information:${encodeURIComponent(ctx.runId)}`;
      if (!identifier(leaseOwner)) return result('no_notice');
      const queueIdentity = `shadow-active-information:${encodeURIComponent(ctx.sessionKey)}:${encodeURIComponent(ctx.runId)}:${snapshot.latestSeq}`;
      stage = 'resolve';
      const sessionId = await resolveActiveSession(ctx.sessionKey);
      if (runs.get(key) !== state) return result('cleared');
      if (!identifier(sessionId) || (ctx.sessionId && ctx.sessionId !== sessionId)) return result('no_active_run');
      stage = 'queue';
      const receipt = await queue(sessionId, notice(snapshot, ctx.sessionKey, leaseOwner), { queueIdentity });
      const accepted = receipt === true || receipt?.accepted === true;
      if (accepted && runs.get(key) === state) state.latestSeq = snapshot.latestSeq;
      const summary = result(accepted ? 'queued' : 'not_accepted', {
        accepted, sessionKey: ctx.sessionKey, runId: ctx.runId, sessionId,
        latestSeq: snapshot.latestSeq, sequences: snapshot.events.map(event => event.seq), queueIdentity, leaseOwner,
      });
      if (onReceipt) {
        try { await onReceipt({ ...summary, sequences: [...summary.sequences] }); }
        catch { warn('receipt'); }
      }
      return summary;
    } catch {
      warn(stage);
      return result('error', { stage });
    }
  }

  return {
    async afterTool(_event, ctx) {
      const key = keyOf(ctx);
      if (!key) return result('ignored');
      let state = runs.get(key);
      if (state?.pending) return state.pending;
      if (!state) {
        if (runs.size >= RUN_LIMIT) {
          const idle = [...runs].find(([, entry]) => !entry.pending);
          if (!idle) return result('capacity');
          runs.delete(idle[0]);
        }
        state = { latestSeq: 0, pending: null };
      }
      runs.delete(key);
      runs.set(key, state);
      // Capture runtime identity before yielding; concurrent tool hooks share one attempt.
      const identity = { sessionKey: ctx.sessionKey, runId: ctx.runId, sessionId: ctx.sessionId };
      const pending = Promise.resolve().then(() => notify(state, identity, key));
      state.pending = pending;
      try { return await pending; }
      finally { if (state.pending === pending) state.pending = null; }
    },
    clear(ctx) {
      const key = keyOf(ctx);
      return key ? runs.delete(key) : false;
    },
  };
}
