import { randomUUID } from 'node:crypto';
import { recordAgentOperation, resolveTaskOwnerSession } from './agent-operations.mjs';
import { ACTIVE_TASK_STATUSES } from './task-handling.mjs';
import { pendingOpenClawTurn } from './openclaw/cli.mjs';
import { executionIdentity, executionBindingGuard, sameExecution } from '../openclaw/shadow-work/src/task-checkpoint-guard.mjs';

const parse = text => { try { return JSON.parse(text || '{}'); } catch { return {}; } };

function captureExecutionStopContext(store, card, owner) {
  const execution = executionIdentity(card);
  const attention = store.db.prepare('SELECT * FROM work_task_attention WHERE card_id=?').get(card.id);
  const bindings = store.db.prepare(`SELECT payload_json FROM controller_outbox
    WHERE action_type='bind_workboard_execution' AND status IN ('pending','retry','processing')
      AND json_extract(payload_json,'$.taskId')=?`).all(card.id).map(row => parse(row.payload_json));
  // A started child may still be waiting for its existing checkpoint/outbox binding to reach Workboard.
  const verified = bindings.find(payload => {
    if (payload.ownerSessionKey !== owner.sessionKey || !payload.runId || !payload.sessionKey
      || !sameExecution(payload.expectedExecution, execution)) return false;
    try { return executionBindingGuard(store.db, payload) === null; }
    catch { return false; } // An unreadable receipt cannot authorize stopping a different execution.
  });
  const pendingExecution = verified ? { runId: verified.runId, sessionKey: verified.sessionKey } : null;
  const incomplete = !execution.runId || !execution.sessionKey;
  const activeWithoutIdentity = incomplete && ['starting', 'queued', 'running'].includes(card.execution?.status ?? card.execution_status);
  const unboundContinuation = attention?.continuation_kind === 'codex_run' && !pendingExecution
    && (incomplete || ![execution.runId, execution.sessionKey].includes(attention.continuation_reference_id));
  const stopUncertainty = activeWithoutIdentity && !pendingExecution || unboundContinuation || bindings.length > 0 && !verified
    ? '存在活动或待绑定执行，但未取得完整可信的停止标识；不能确认全部执行已停止。' : null;
  return { execution, pendingExecution, stopUncertainty };
}

export function taskClosureView(database, taskId) {
  const row = database.prepare(`SELECT metadata_json FROM context_changes
    WHERE kind='human_agent_operation' AND json_extract(metadata_json,'$.taskId')=?
      AND json_extract(metadata_json,'$.closure') IS NOT NULL ORDER BY seq DESC LIMIT 1`).get(taskId);
  if (!row) return {};
  const metadata = parse(row.metadata_json);
  return {
    closure: { ...metadata.closure, operationId: metadata.operationId,
      status: metadata.appliedStatus === 'applied' ? 'applied' : 'queued' },
    executionStop: metadata.executionStop ?? { status: 'pending' },
  };
}

export function recordTaskClosure(store, card, input = {}) {
  const outcome = input.outcome;
  if (!['done', 'cancelled'].includes(outcome)) throw new Error('请选择完成或终止任务。');
  if (input.note != null && typeof input.note !== 'string') throw new Error('结束说明必须是文本。');
  const note = (input.note ?? '').trim();
  if (note.length > 4000) throw new Error('结束说明不能超过 4000 字。');
  const operationId = input.operationId ?? randomUUID();
  if (typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw new Error('无效的操作编号。');
  const existing = store.db.prepare('SELECT metadata_json FROM context_changes WHERE event_key=?')
    .get(`agent-operation:${operationId}`);
  if (existing) {
    const metadata = parse(existing.metadata_json);
    if (metadata.taskId !== card.id || metadata.closure?.outcome !== outcome || metadata.closure?.note !== note) {
      throw new Error('该操作编号已用于其他结束请求。');
    }
  } else {
    if (!ACTIVE_TASK_STATUSES.has(card.status) || card.archivedAt || card.metadata?.archivedAt) {
      throw new Error('任务已经结束，不能再次完成或终止。');
    }
    if (taskClosureView(store.db, card.id).closure) throw new Error('此任务已有结束请求，请等待同步或查看处理结果。');
  }
  const completed = outcome === 'done';
  const action = completed ? 'confirm_done' : 'terminate_task';
  const label = completed ? '确认任务完成' : '终止任务';
  const defaultNote = completed ? '用户确认该事项实际已经完成。' : '用户决定不再执行此任务；这不表示目标已完成。';
  const owner = resolveTaskOwnerSession(store, card, { projectKey: input.projectKey });
  const executionContext = captureExecutionStopContext(store, card, owner);
  const turn = pendingOpenClawTurn(store, owner.sessionKey);
  const ownerExecution = turn ? { sessionKey: owner.sessionKey, runId: turn.runId ?? null } : null;
  return recordAgentOperation(store, {
    operationId, action, actor: 'user', source: 'pet-ui', targetType: 'workboard_task',
    targetId: card.id, taskId: card.id, card, owner, projectKey: input.projectKey, baseStatus: card.status,
    desiredEffect: completed ? 'set_task_done' : 'set_task_cancelled',
    summary: `用户${label}：${card.title}`,
    metadata: { closure: { outcome, note } },
    knowledge: {
      action, actionLabel: label, targetType: 'workboard_task', targetId: card.id, targetLabel: card.title,
      title: `用户${label}：${card.title}`,
      content: [`任务：${card.title}`, `确认前状态：${card.status}`, defaultNote,
        note ? `用户${completed ? '完成' : '终止'}说明：\n${note}` : ''].filter(Boolean).join('\n\n'),
      scope: { project: input.projectKey, taskId: card.id }, keywords: [label, input.projectKey].filter(Boolean),
      retrievalCues: [`用户为何${completed ? '确认完成' : '终止'}“${card.title}”？`],
    },
    workboardEffect: { cardId: card.id, effect: action, note: note || defaultNote,
      closure: { outcome, note, ownerExecution, ...executionContext, operationId } },
  });
}
