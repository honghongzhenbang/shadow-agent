
export function parse(text) { try { return JSON.parse(text ?? '{}'); } catch { return {}; } }

export function operationRows(db, taskId, operationId) {
  if (!taskId || !operationId) return null;
  const change = db.prepare('SELECT * FROM context_changes WHERE event_key=?').get(`agent-operation:${operationId}`);
  const metadata = parse(change?.metadata_json);
  if (!change || metadata.taskId !== taskId || metadata.operationId !== operationId) return null;
  const action = db.prepare("SELECT * FROM controller_outbox WHERE idempotency_key=? AND action_type='apply_workboard_operation'")
    .get(`${operationId}:apply_workboard_operation:${taskId}`);
  const payload = parse(action?.payload_json);
  if (!action || payload.operationId !== operationId || (payload.cardId ?? payload.taskId) !== taskId) return null;
  return { change, metadata, action, payload };
}

// A projection of the existing action, not a second mutable receipt or business state.
export function readOperationDelivery(db, taskId, operationId) {
  const rows = operationRows(db, taskId, operationId);
  if (!rows) return null;
  const { action, payload } = rows;
  return { operationId, actionId: action.id, taskId, effect: payload.effect,
    status: action.status, attempts: action.attempts, error: action.last_error?.slice(0, 1200) ?? null,
    updatedAt: action.updated_at, nextAttemptAt: action.next_attempt_at };
}

export function operationDeliveryActions(db, taskId) {
  const rows = db.prepare(`SELECT event_key, metadata_json, occurred_at, created_at FROM context_changes
    WHERE kind='human_agent_operation' AND json_extract(metadata_json,'$.taskId')=? ORDER BY seq DESC LIMIT 20`).all(taskId);
  return rows.flatMap(row => {
    const operationId = parse(row.metadata_json).operationId;
    const receipt = readOperationDelivery(db, taskId, operationId);
    if (!receipt) return [];
    return [{ id: `delivery:${receipt.actionId}`, action_type: 'workboard_operation_delivery',
      risk_level: 'local-write', status: receipt.status,
      started_at: row.occurred_at || row.created_at, completed_at: receipt.updatedAt,
      command_summary: '任务卡同步', result: deliveryLabel(receipt), error: receipt.error,
      metadata: { source: 'controller-outbox', operationDelivery: receipt, trace: [] } }];
  });
}

export function deliveryLabel(receipt) {
  const labels = { pending: '任务卡同步待处理', processing: '正在同步任务卡', retry: '任务卡同步失败，等待重试',
    failed: '任务卡同步失败', completed: '任务卡已同步', cancelled: '任务卡同步已取消' };
  return `${labels[receipt.status] ?? `任务卡同步：${receipt.status}`}${receipt.error ? `：${receipt.error}` : ''}`;
}
