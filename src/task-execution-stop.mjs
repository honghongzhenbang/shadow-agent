import { loadOpenClawGatewaySettings, OpenClawGatewayClient } from './openclaw/gateway-client.mjs';
import { executionIdentity, sameExecution } from '../openclaw/shadow-work/src/task-checkpoint-guard.mjs';

const ROLES = new Set(['owner', 'execution', 'pending_execution']);
const ACTIVE_RUN_STATES = new Set(['starting', 'queued', 'running']);
const cleanString = value => typeof value === 'string' && value.length > 0 && value === value.trim();
const emptyIdentity = value => value.runId === null && value.sessionKey === null;
const EXPLANATIONS = {
  invalid_stop_identity: '缺少可信的执行标识，未发送停止请求。',
  card_identity_unconfirmed: '无法确认原任务，未继续停止执行。',
  closure_state_changed: '任务的关闭状态已改变，未继续停止执行。',
  closure_marker_unconfirmed: '无法确认本次关闭操作的原生记录，未继续停止执行。',
  execution_binding_changed: '任务绑定的执行已改变，未继续停止执行。',
  execution_binding_conflict: '任务中的执行标识不一致，未继续停止执行。',
  execution_identity_missing: '任务可能仍在运行，但缺少精确执行标识，未发送停止请求。',
  abort_identity_unconfirmed: '停止请求已发送，但返回的执行标识无法确认。',
  observation_identity_mismatch: '原生观察返回了其他执行标识，无法确认目标执行的状态。',
  native_cleanup_proof_unavailable: '停止请求已发送，但底层尚未提供执行清理完成回执。',
};

function agentIdFor(sessionKey) {
  return /^agent:([a-z0-9][a-z0-9_-]*):\S+$/.exec(sessionKey)?.[1] ?? null;
}

function freezeRequest(payload) {
  if (!payload || !cleanString(payload.cardId)
    || typeof payload.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.operationId)
    || !['done', 'cancelled'].includes(payload.outcome) || !Array.isArray(payload.targets)) return null;
  const roles = new Set();
  const targets = [];
  for (const target of payload.targets) {
    if (!target || !ROLES.has(target.role) || roles.has(target.role)
      || !cleanString(target.runId) || !cleanString(target.sessionKey) || !agentIdFor(target.sessionKey)) return null;
    roles.add(target.role);
    targets.push(Object.freeze({ role: target.role, sessionKey: target.sessionKey, runId: target.runId }));
  }
  return Object.freeze({ cardId: payload.cardId, operationId: payload.operationId,
    outcome: payload.outcome, targets: Object.freeze(targets) });
}

function hasMarker(text, marker) {
  return typeof text === 'string' && text.split(/\r?\n/).some(line => line.trim() === marker);
}

function closureGuard(card, request) {
  if (!card || card.id !== request.cardId) return 'card_identity_unconfirmed';
  const archived = Boolean(card.archived || card.archivedAt || card.metadata?.archivedAt);
  if (request.outcome === 'done' ? card.status !== 'done' : !archived || card.status === 'done') {
    return 'closure_state_changed';
  }
  const marker = `[shadow-operation:${request.operationId}]`;
  const entries = request.outcome === 'done' ? card.metadata?.proof : card.metadata?.comments;
  const retained = Array.isArray(entries) && entries.some(entry => request.outcome === 'done'
    ? entry?.status === 'passed' && hasMarker(entry.note, marker)
    : hasMarker(entry?.body, marker));
  if (!retained) return 'closure_marker_unconfirmed';

  const current = executionIdentity(card);
  const target = request.targets.find(item => item.role === 'execution');
  if (target ? !sameExecution(current, target) : !emptyIdentity(current)) return 'execution_binding_changed';
  // Native cards can expose both top-level and nested execution aliases. Conflicts are not proof.
  for (const [field, snake] of [['runId', 'execution_run_id'], ['sessionKey', 'execution_session_key']]) {
    for (const value of [card[field], card[snake], card.execution?.[field]]) {
      if (value != null && value !== current[field]) return 'execution_binding_conflict';
    }
  }
  if (!target && ACTIVE_RUN_STATES.has(card.execution?.status ?? card.execution_status)) {
    return 'execution_identity_missing';
  }
  return null;
}

async function readCard(client, cardId) {
  const result = await client.invokeTool('workboard_read', { id: cardId });
  if (result?.ok === false || result?.isError) {
    const error = new Error(result.error?.message ?? 'Native Workboard read failed.');
    error.rpcCode = result.error?.code ?? null;
    throw error;
  }
  return result?.output?.details?.card ?? result?.card ?? null;
}

function unconfirmed(request, reason, results = []) {
  return { status: 'unconfirmed', error: EXPLANATIONS[reason], errorCode: reason,
    targets: (request?.targets ?? []).map((target, index) => ({
    ...results[index], ...target, status: 'unconfirmed', reason,
  })) };
}

function waitObservation(value) {
  if (!value || typeof value !== 'object') return null;
  const observation = { source: 'agent.wait' };
  for (const key of ['status', 'runId', 'runKnown', 'livenessState', 'stopReason', 'startedAt', 'endedAt',
    'pendingError', 'yielded', 'timeoutPhase', 'providerStarted']) {
    if (value[key] != null && !['string', 'number', 'boolean'].includes(typeof value[key])) return null;
    if (['string', 'number', 'boolean'].includes(typeof value[key])) observation[key] = value[key];
  }
  return observation;
}

function naturalTerminal(observation, target) {
  return observation?.runId === target.runId && observation.runKnown !== false
    && ['ok', 'error'].includes(observation.status)
    && Number.isFinite(observation.endedAt) && observation.endedAt > 0 && observation.endedAt <= Date.now()
    && (observation.startedAt == null || Number.isFinite(observation.startedAt)
      && observation.startedAt <= observation.endedAt)
    && observation.pendingError !== true && observation.yielded !== true && observation.timeoutPhase == null
    && (observation.stopReason == null || observation.stopReason === 'error')
    && (observation.livenessState == null || ['completed', 'failed'].includes(observation.livenessState));
}

function stillActive(observation, target) {
  if (observation?.runId !== target.runId || observation.runKnown === false || observation.endedAt != null
    || observation.stopReason != null) return false;
  return observation.status === 'pending' && (ACTIVE_RUN_STATES.has(observation.livenessState)
    || observation.timeoutPhase === 'queue' && observation.providerStarted === false)
    || observation.status === 'timeout' && observation.runKnown === true;
}

async function observeRun(client, target, timeoutMs) {
  return waitObservation(await client.request('agent.wait', { runId: target.runId, timeoutMs }, 5000));
}

// The caller must validate the durable operation, owner receipt and pending execution binding receipt.
// Native metadata drops arbitrary closure fields; only retained markers and bindings are read here.
export async function stopTaskExecutions(client, payload) {
  const request = freezeRequest(payload);
  if (!request) return unconfirmed(null, 'invalid_stop_identity');
  let card = await readCard(client, request.cardId);
  let reason = closureGuard(card, request);
  if (reason) return unconfirmed(request, reason);
  if (!request.targets.length) return { status: 'not_running', targets: [], reason: 'no_frozen_executions' };

  const results = [];
  const observed = new Map();
  for (const target of request.targets) {
    if (results.length) card = await readCard(client, request.cardId);
    reason = closureGuard(card, request);
    if (reason) return unconfirmed(request, reason, results);
    const key = JSON.stringify([target.sessionKey, target.runId]);
    if (observed.has(key)) {
      results.push({ ...observed.get(key), ...target });
      continue;
    }
    // Read cached ordinary completion before abort can replace it with a synthetic RPC timeout.
    const before = await observeRun(client, target, 0);
    card = await readCard(client, request.cardId);
    reason = closureGuard(card, request);
    if (reason) return unconfirmed(request, reason, results);
    if (before?.runId != null && before.runId !== target.runId) {
      const result = { ...target, status: 'unconfirmed', reason: 'observation_identity_mismatch', observation: before };
      results.push(result);
      observed.set(key, result);
      continue;
    }
    if (naturalTerminal(before, target)) {
      // This proves no new abort is needed, not that cancellation cleanup succeeded.
      const result = { ...target, status: 'not_running', reason: 'natural_terminal_before_stop', observation: before };
      results.push(result);
      observed.set(key, result);
      continue;
    }
    const abort = await client.request('sessions.abort', {
      key: target.sessionKey, agentId: agentIdFor(target.sessionKey), runId: target.runId,
    });
    const result = { ...target, status: 'unconfirmed', reason: 'native_cleanup_proof_unavailable',
      beforeObservation: before,
      abort: { status: abort?.status ?? null, abortedRunId: abort?.abortedRunId ?? null } };
    const validAck = abort?.ok === true && (abort.status === 'aborted' && abort.abortedRunId === target.runId
      || abort.status === 'no-active-run' && abort.abortedRunId === null);
    if (!validAck) result.reason = 'abort_identity_unconfirmed';
    else {
      const observation = await observeRun(client, target, 1000);
      result.observation = observation;
      if (observation?.runId != null && observation.runId !== target.runId) result.reason = 'observation_identity_mismatch';
      else if (stillActive(observation, target)) {
        result.status = 'pending';
        result.reason = 'run_still_active';
      }
      // Abort ACKs, inactive session projections and even terminal wait receipts do not
      // expose successful native cleanup. In particular, timeout/stopReason=rpc is synthetic.
    }
    results.push(result);
    card = await readCard(client, request.cardId);
    reason = closureGuard(card, request);
    if (reason) return unconfirmed(request, reason, results);
    observed.set(key, result);
  }
  if (results.some(result => result.status === 'pending')) {
    return { status: 'pending', targets: results, error: '停止请求已发送，部分执行仍在运行或排队，等待复查。' };
  }
  const uncertain = results.filter(result => result.status === 'unconfirmed');
  return uncertain.length ? { status: 'unconfirmed', targets: results,
    error: [...new Set(uncertain.map(result => EXPLANATIONS[result.reason]))].join(' ') }
    : { status: 'not_running', targets: results };
}

export async function stopTaskExecutionsThroughGateway(projectRoot, payload) {
  const request = freezeRequest(payload);
  if (!request) return unconfirmed(null, 'invalid_stop_identity');
  const client = new OpenClawGatewayClient({
    ...loadOpenClawGatewaySettings(projectRoot), autoReconnect: false,
    scopes: ['operator.read', 'operator.write', 'operator.admin'],
  });
  try {
    await client.connect();
    return await stopTaskExecutions(client, request);
  } finally {
    client.stop();
  }
}
