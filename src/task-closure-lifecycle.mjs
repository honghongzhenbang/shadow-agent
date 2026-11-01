// Closing a task retires its future work, not its evidence or knowledge review.
export function retireClosedTaskWork(store, taskId, operationId) {
  const db = store.db, now = new Date().toISOString();
  db.prepare(`UPDATE work_task_attention SET
    continuation_kind=NULL, continuation_reference_id=NULL, continuation_summary=NULL,
    continuation_user_action_json=NULL, continuation_change_seq=NULL, continuation_recorded_at=NULL,
    continuation_evidence_ids_json='[]', next_review_at=NULL,
    checkpoint_revision=checkpoint_revision+1, updated_at=?
    WHERE card_id=? AND (continuation_kind IS NOT NULL OR next_review_at IS NOT NULL)`).run(now, taskId);
  db.prepare(`UPDATE condition_watches SET status='cancelled', updated_at=?,
    last_error='Task explicitly closed by user.' WHERE task_id=? AND status IN ('active','candidate','timed_out')`).run(now, taskId);
  db.prepare(`UPDATE context_changes SET status='cancelled', lease_owner=NULL, lease_until=NULL,
    ack_note='Task closed; pending progress retired without claiming semantic review.'
    WHERE kind='task_progress_due' AND status IN ('pending','leased')
      AND json_extract(metadata_json,'$.taskId')=?`).run(taskId);
  db.prepare(`UPDATE controller_outbox SET status='cancelled', next_attempt_at=NULL, updated_at=?
    WHERE status IN ('pending','retry','processing') AND (
      (action_type='bind_workboard_execution' AND json_extract(payload_json,'$.taskId')=?) OR
      (action_type='wake_condition' AND json_extract(payload_json,'$.watchId') IN
        (SELECT id FROM condition_watches WHERE task_id=?)))`).run(now, taskId, taskId);
  db.prepare(`UPDATE outbound_message_drafts SET status='cancelled', cancelled_at=?, updated_at=?,
    last_error=? WHERE task_id=? AND status NOT IN ('sending','sent','cancelled','failed')`)
    .run(now, now, `Task closed: ${operationId}`, taskId);
  db.prepare(`UPDATE controller_outbox SET status='cancelled', next_attempt_at=NULL, updated_at=?
    WHERE action_type='send_feishu_message' AND status IN ('pending','retry','processing')
      AND json_extract(payload_json,'$.draftId') IN
        (SELECT id FROM outbound_message_drafts WHERE task_id=? AND status='cancelled')`).run(now, taskId);
  for (const reminder of db.prepare(`SELECT * FROM reminders WHERE task_id=?
    AND status NOT IN ('acknowledged','cancelled','snoozed')`).all(taskId)) {
    store.cancelReminderRecord(reminder.id);
    store.cancelReminderControllerActions(reminder.id, { exceptTypes: ['remove_reminder_cron'] });
    if (reminder.cron_job_id) store.enqueueControllerAction({
      idempotencyKey: `task-close:${operationId}:remove-cron:${reminder.id}`,
      actionType: 'remove_reminder_cron', payload: { reminderId: reminder.id, cronJobId: reminder.cron_job_id, reason: 'task_closed' },
    });
  }
}

export function enqueueClosedTaskStop(store, result) {
  const decision = result.closure;
  if (!decision) return;
  retireClosedTaskWork(store, result.cardId, decision.operationId);
  const targets = [];
  for (const [role, value] of [['execution', decision.execution], ['owner', decision.ownerExecution], ['pending_execution', decision.pendingExecution]]) {
    if (value && (value.runId || value.sessionKey)) targets.push({ ...value, role });
  }
  if (!targets.length) return decision.stopUncertainty
    ? { status: 'unconfirmed', targets: [], error: decision.stopUncertainty }
    : { status: 'not_running', targets: [] };
  store.enqueueControllerAction({
    idempotencyKey: `${decision.operationId}:stop_task_execution:${result.cardId}`,
    actionType: 'stop_task_execution',
    payload: { cardId: result.cardId, operationId: decision.operationId, outcome: decision.outcome, targets },
  });
  return { status: 'pending', targets };
}

export function recordTaskExecutionStop(store, payload, result) {
  const row = store.db.prepare('SELECT metadata_json FROM context_changes WHERE event_key=?').get(`agent-operation:${payload.operationId}`);
  if (!row) throw new Error('Task closure operation missing.');
  const metadata = JSON.parse(row.metadata_json);
  if (metadata.taskId !== payload.cardId || !metadata.closure) throw new Error('Task closure identity mismatch.');
  const uncertainty = metadata.effectResult?.closure?.stopUncertainty;
  if (uncertainty) result = { ...result, status: result.status === 'pending' ? 'pending' : 'unconfirmed',
    error: [result.error, uncertainty].filter(Boolean).join(' ') };
  store.db.prepare('UPDATE context_changes SET metadata_json=? WHERE event_key=?')
    .run(JSON.stringify({ ...metadata, executionStop: { ...result, updatedAt: new Date().toISOString() } }), `agent-operation:${payload.operationId}`);
}

export function assertTaskStopRequest(store, payload) {
  const row = store.db.prepare('SELECT metadata_json FROM context_changes WHERE event_key=?').get(`agent-operation:${payload.operationId}`);
  const metadata = row ? JSON.parse(row.metadata_json) : {};
  const closure = metadata.effectResult?.closure;
  if (metadata.taskId !== payload.cardId || metadata.appliedStatus !== 'applied'
    || !closure || closure.operationId !== payload.operationId || closure.outcome !== payload.outcome) {
    throw new Error('Stop request is not backed by an applied task closure.');
  }
  const expected = [];
  for (const [role, value] of [['execution', closure.execution], ['owner', closure.ownerExecution], ['pending_execution', closure.pendingExecution]]) {
    if (value && (value.runId || value.sessionKey)) expected.push({ sessionKey: value.sessionKey, runId: value.runId, role });
  }
  const actual = (payload.targets ?? []).map(({ sessionKey, runId, role }) => ({ sessionKey, runId, role }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Stop execution identity differs from the closure receipt.');
}
