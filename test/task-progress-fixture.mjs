import { emitContextChange } from "../src/context-graph.mjs";

export function reviewMetadata(taskId, index) {
  return {
    taskId, trigger: "bounded_progress_audit", requestedAt: new Date(Date.UTC(2026, 9, 22, 0, index)).toISOString(),
    taskCheckpoint: {
      taskId, resultState: "unchanged", resultSummary: `Review wording ${index}`,
      recordedAt: new Date(Date.UTC(2026, 9, 22, 0, index)).toISOString(),
      checkpointRevision: index + 1, bindingRevision: 1, ownerSessionKey: `task:${taskId}`,
      execution: { runId: null, sessionKey: null },
      progressPlan: { revision: 1, updatedAt: "2026-10-21T00:00:00.000Z", outcome: "Verify build",
        successCriteria: "Build receipt passes", authorizedScope: "Read build receipt only", approach: "Inspect the stored build receipt",
        nextAction: "Read build-1 receipt", stopCondition: "Receipt passes or a new failure arrives", whyNow: "Review is due" },
      evidenceIds: ["evidence-b", "evidence-a"], applied: true, terminal: false, reason: null, cardStatus: "todo",
      continuation: { kind: "internal_review", summary: "Read the build-1 receipt again", referenceId: null,
        sessionKey: null, model: null, userAction: null,
        nextReviewAt: new Date(Date.UTC(2026, 9, 22, 1, index)).toISOString() },
    },
  };
}

export function addReview(store, taskId, index, edit = () => {}, { kind = "task_progress_due", status = "acknowledged" } = {}) {
  const metadata = reviewMetadata(taskId, index);
  const row = emitContextChange(store.db, { eventKey: `${taskId}:review:${index}`, kind,
    occurredAt: metadata.requestedAt, summary: `Audit receipt ${index}`, metadata: { taskId } });
  metadata.taskCheckpoint.changeSeq = row.seq;
  edit(metadata);
  store.db.prepare("UPDATE context_changes SET metadata_json=?,status=? WHERE seq=?")
    .run(JSON.stringify(metadata), status, row.seq);
  return row.seq;
}
