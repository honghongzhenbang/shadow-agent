import { emitContextChange } from './context-graph.mjs';
import { parse, operationRows } from './operation-delivery-view.mjs';

// Called inside the same transaction that records the final outbox failure.
export function recordOperationDeliveryFailure(db, actionId) {
  const row = db.prepare('SELECT * FROM controller_outbox WHERE id=?').get(actionId);
  if (!row || row.status !== 'failed' || row.action_type !== 'apply_workboard_operation') return null;
  const payload = parse(row.payload_json);
  const taskId = payload.cardId ?? payload.taskId;
  const rows = operationRows(db, taskId, payload.operationId);
  if (!rows || rows.action.id !== actionId) return null;
  const owner = db.prepare(`SELECT a.owner_session_key FROM work_task_attention a
    JOIN conversation_bindings b ON b.session_key=a.owner_session_key
    WHERE a.card_id=? AND b.task_id=? AND b.session_kind='task' AND b.status='active'`).get(taskId, taskId);
  if (!owner?.owner_session_key) return null;
  return emitContextChange(db, {
    eventKey: `operation-delivery-failed:${actionId}`, kind: 'task_progress_due',
    evidenceId: rows.change.evidence_id, projectKey: rows.change.project_key,
    sessionKey: owner.owner_session_key, occurredAt: row.updated_at, notBefore: row.updated_at, priority: 'high',
    summary: '任务卡同步最终失败；原输入仍保留，请结合实际回执判断后续处理。',
    metadata: { operationId: payload.operationId, causationId: rows.metadata.causationId,
      taskId, targetId: taskId, targetType: 'workboard_task', actor: 'system', source: 'controller-outbox',
      action: 'review_operation_delivery', reason: 'workboard_operation_failed',
      failedActionId: actionId, evidenceIds: rows.metadata.evidenceIds ?? [], grantsAuthorization: false },
  });
}
