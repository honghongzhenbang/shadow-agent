import { randomUUID } from "node:crypto";

import { captureKnowledgeEpisode } from "../openclaw/shadow-work/src/epistemic.js";
import { emitContextChange } from "./context-graph.mjs";
import { bindWorkSession } from "./work-sessions.mjs";
import { resolveTaskOwnerSession } from "./task-owner.mjs";
import { nowIso, stableJson } from "./utils.mjs";
import { enqueueClosedTaskStop } from './task-closure-lifecycle.mjs';

export { resolveTaskOwnerSession } from "./task-owner.mjs";

function parseJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

function unique(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}


export function enqueueAgentAttention(store, input) {
  return store.enqueueControllerAction({
    idempotencyKey: `schedule-attention:${input.operationId}`,
    actionType: "schedule_attention",
    payload: {
      operationId: input.operationId,
      sessionKey: input.sessionKey,
      reason: input.reason ?? "agent-operation",
      count: Number(input.count ?? 1),
    },
  });
}

function resolveOperationOwner(store, input, occurredAt) {
  if (input.sessionKey) {
    const binding = store.workSessionByKey(input.sessionKey);
    if (binding?.status === "active") {
      return {
        sessionKey: binding.session_key,
        binding,
        projectKey: input.projectKey ?? null,
        bindingReason: "explicit_session",
      };
    }
  }
  if (input.conversationKey) {
    const binding = bindWorkSession(store, {
      kind: "conversation",
      provider: "feishu",
      routeKey: input.conversationKey,
      eventAt: occurredAt,
      metadata: { conversationKey: input.conversationKey, source: "agent-operation-router" },
    });
    return {
      sessionKey: binding.session_key,
      binding,
      projectKey: input.projectKey ?? null,
      bindingReason: "source_conversation",
    };
  }
  const binding = bindWorkSession(store, {
    kind: "inbox",
    provider: "shadow",
    routeKey: "inbox",
    eventAt: occurredAt,
    metadata: { projectCandidate: input.projectKey ?? null, source: "agent-operation-router" },
  });
  return {
    sessionKey: binding.session_key,
    binding,
    projectKey: input.projectKey ?? null,
    bindingReason: input.projectKey ? "project_scope_inbox" : "inbox_fallback",
  };
}

export function recordAgentOperation(store, input) {
  const operationId = String(input.operationId ?? randomUUID());
  const causationId = String(input.causationId ?? operationId);
  const occurredAt = input.occurredAt ?? nowIso();
  const owner = input.owner ?? (input.card
    ? resolveTaskOwnerSession(store, input.card, input)
    : resolveOperationOwner(store, input, occurredAt));
  const eventKey = `agent-operation:${operationId}`;
  const existing = store.db.prepare("SELECT * FROM context_changes WHERE event_key=?").get(eventKey);
  if (existing) {
    const action = store.db.prepare("SELECT * FROM controller_outbox WHERE idempotency_key LIKE ? ORDER BY created_at LIMIT 1")
      .get(`${operationId}:%`);
    return { operationId, causationId, owner, change: existing, action, duplicate: true };
  }

  return store.transaction(() => {
    const knowledge = input.knowledge ? captureKnowledgeEpisode(store.db, {
      ...input.knowledge,
      externalId: input.knowledge.externalId ?? `agent-operation:${operationId}`,
      projectKey: input.knowledge.projectKey ?? owner.projectKey ?? input.projectKey,
      threadId: input.knowledge.threadId ?? owner.sessionKey,
      scope: {
        ...(input.knowledge.scope ?? {}),
        sessionKey: owner.sessionKey,
      },
      metadata: {
        ...(input.knowledge.metadata ?? {}),
        operation: { operationId, causationId },
      },
    }, { transaction: false }) : null;
    const metadata = {
      operationId,
      causationId,
      actor: input.actor ?? "user",
      source: input.source ?? "pet-ui",
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      taskId: input.taskId ?? (input.targetType === "workboard_task" ? input.targetId : null),
      desiredEffect: input.desiredEffect,
      baseStatus: input.baseStatus ?? null,
      appliedStatus: "queued",
      bindingReason: owner.bindingReason,
      evidenceIds: unique([knowledge?.evidenceId, ...(input.evidenceIds ?? [])]),
      ...(input.metadata ?? {}),
    };
    emitContextChange(store.db, {
      eventKey,
      kind: input.kind ?? "human_agent_operation",
      evidenceId: knowledge?.evidenceId ?? input.evidenceId ?? null,
      projectKey: owner.projectKey ?? input.projectKey ?? null,
      sessionKey: owner.sessionKey,
      priority: input.priority ?? "high",
      notBefore: input.notBefore ?? occurredAt,
      occurredAt,
      summary: input.summary ?? `用户提交操作：${input.action}`,
      metadata,
    });
    const effectType = input.workboardEffect ? "apply_workboard_operation" : "schedule_attention";
    const target = String(input.targetId ?? owner.sessionKey);
    const action = store.enqueueControllerAction({
      idempotencyKey: `${operationId}:${effectType}:${target}`,
      actionType: effectType,
      payload: input.workboardEffect ? {
        operationId,
        causationId,
        sessionKey: owner.sessionKey,
        ...input.workboardEffect,
      } : {
        operationId,
        sessionKey: owner.sessionKey,
        reason: input.action ?? "agent-operation",
        count: 1,
      },
    });
    if (input.taskId ?? (input.targetType === "workboard_task" ? input.targetId : null)) {
      store.db.prepare(`
        UPDATE work_task_attention
        SET last_operation_id=?, last_operation_at=?, updated_by='agent-operation', updated_at=?
        WHERE card_id=?
      `).run(operationId, occurredAt, occurredAt, input.taskId ?? input.targetId);
    }
    return {
      operationId,
      causationId,
      owner,
      knowledge,
      change: store.db.prepare("SELECT * FROM context_changes WHERE event_key=?").get(eventKey),
      action,
      duplicate: false,
    };
  });
}

export function markAgentOperationApplied(store, operationId, result = {}) {
  const eventKey = `agent-operation:${operationId}`;
  const row = store.db.prepare("SELECT metadata_json FROM context_changes WHERE event_key=?").get(eventKey);
  if (!row) return null;
  const metadata = parseJson(row.metadata_json, {});
  if (result.closure && metadata.appliedStatus !== 'applied') metadata.executionStop = enqueueClosedTaskStop(store, result);
  store.db.prepare("UPDATE context_changes SET metadata_json=? WHERE event_key=?")
    .run(stableJson({ ...metadata, appliedStatus: "applied", appliedAt: nowIso(), effectResult: result }), eventKey);
  return store.db.prepare("SELECT * FROM context_changes WHERE event_key=?").get(eventKey);
}

export function markAgentOperationEffectApplied(store, operation, result = {}) {
  return store.transaction(() => {
    if (operation.action?.id) store.finishControllerAction(operation.action.id, { status: "completed" });
    markAgentOperationApplied(store, operation.operationId, result);
    return enqueueAgentAttention(store, {
      operationId: operation.operationId,
      sessionKey: operation.owner.sessionKey,
      reason: "agent-operation-applied",
    });
  });
}
