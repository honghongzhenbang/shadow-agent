import { loadOpenClawGatewaySettings, OpenClawGatewayClient } from "./openclaw/gateway-client.mjs";
import { ACTIVE_TASK_STATUSES, executionIdentity, sameExecution, executionBindingGuard } from "../openclaw/shadow-work/src/task-checkpoint-guard.mjs";

function cardFromRead(result) {
  return result?.output?.details?.card ?? result?.card ?? null;
}

function operationMarker(operationId) {
  return `[shadow-operation:${operationId}]`;
}

function cardContainsExactProof(card, note, label) {
  return Array.isArray(card?.metadata?.proof)
    && card.metadata.proof.some(proof => proof?.status === "passed"
      && proof.label === label && proof.note === note.trim());
}

function cardContainsExactComment(card, body) {
  return Array.isArray(card?.metadata?.comments)
    && card.metadata.comments.some(comment => comment?.body === body.trim());
}

function cardIsArchived(card) {
  return Boolean(card?.archived || card?.archivedAt || card?.metadata?.archivedAt);
}

async function readCard(client, cardId) {
  const card = cardFromRead(await client.invokeTool("workboard_read", { id: cardId }));
  if (!card) throw new Error(`Workboard card not found: ${cardId}`);
  return card;
}

export async function applyWorkboardOperation(client, payload) {
  const operationId = String(payload.operationId ?? "").trim();
  const cardId = String(payload.cardId ?? payload.taskId ?? "").trim();
  if (!operationId) throw new Error("Workboard operation id is required.");
  if (!cardId) throw new Error("Workboard card id is required.");
  const marker = operationMarker(operationId);
  let card = await readCard(client, cardId);
  const effect = String(payload.effect ?? "task_instruction_comment");

  if (effect === "task_instruction_comment") {
    const expectedComment = `${payload.comment ?? "用户向 Agent 补充了任务指令。"}\n\n${marker}`;
    if (!cardContainsExactComment(card, expectedComment)) {
      const comment = await client.invokeTool("workboard_comment", {
        id: cardId,
        body: expectedComment,
      });
      if (!comment?.ok) throw new Error(comment?.error?.message || "Workboard comment failed.");
      card = await readCard(client, cardId);
      if (!cardContainsExactComment(card, expectedComment)) throw new Error("Workboard comment was not retained on the card.");
    }
    return { cardId, effect, status: card.status, marker, idempotent: true };
  }

  if (effect === "confirm_done" || effect === "terminate_task") {
    const outcome = effect === 'confirm_done' ? 'done' : 'cancelled';
    const closure = payload.closure;
    if (effect === 'terminate_task' && closure?.outcome !== 'cancelled') throw new Error('Explicit termination decision is required.');
    if (closure && closure.outcome !== outcome) throw new Error('Closure outcome does not match operation.');
    const terminationBody = `用户终止任务（不代表目标完成）：\n${payload.note || '不再执行此任务。'}\n\n${marker}`;
    const proofNote = `${payload.note || "用户在 Shadow Agent 界面确认该事项已经完成。"}\n\n${marker}`;
    const ownDecision = effect === 'terminate_task' ? cardContainsExactComment(card, terminationBody)
      : cardContainsExactProof(card, proofNote, '人工确认');
    if ((cardIsArchived(card) || !ACTIVE_TASK_STATUSES.has(card.status))
        && !(ownDecision && (effect === 'terminate_task' ? cardIsArchived(card) && card.status !== 'done'
          : card.status === 'done' && !cardIsArchived(card)))) {
      throw new Error('Cannot change the outcome of a terminal task.');
    }
    if (effect === 'terminate_task') {
      const body = terminationBody;
      if (!cardContainsExactComment(card, body)) {
        const comment = await client.invokeTool('workboard_comment', { id: cardId, body });
        if (!comment?.ok) throw new Error(comment?.error?.message || 'Task termination comment failed.');
        card = await readCard(client, cardId);
        if (!cardContainsExactComment(card, body)) throw new Error('Task termination comment was not retained.');
      }
    } else {
      const expectedProofLabel = "人工确认";
      if (!cardContainsExactProof(card, proofNote, expectedProofLabel)) {
        const proof = await client.invokeTool("workboard_proof", {
          id: cardId,
          status: "passed",
          label: expectedProofLabel,
          note: proofNote,
        });
        if (!proof?.ok) throw new Error(proof?.error?.message || "Workboard proof failed.");
        card = await readCard(client, cardId);
        if (!cardContainsExactProof(card, proofNote, expectedProofLabel)) throw new Error("Workboard proof was not retained on the card.");
      }
    }
    if (effect === 'terminate_task' && card.status === 'done') throw new Error('Task completed during termination; outcome not overwritten.');
    if (effect === 'confirm_done' && cardIsArchived(card)) throw new Error('Task archived during completion; outcome not overwritten.');
    if (effect === 'terminate_task' && !cardIsArchived(card)) {
      await client.request('workboard.cards.archive', { id: cardId, archived: true });
      card = await readCard(client, cardId);
      if (!cardIsArchived(card)) throw new Error('Terminated task was not archived.');
    } else if (effect === 'confirm_done' && card.status !== "done") {
      const moved = await client.request("workboard.cards.move", { id: cardId, status: "done" });
      card = moved?.card ?? await readCard(client, cardId);
      if (card.status !== "done") throw new Error("Workboard card did not reach done.");
    }
    return { cardId, effect, status: outcome, marker, idempotent: true,
      ...(closure ? { closure: { ...closure, operationId } } : {}) };
  }

  if (effect === "archive_misclassified") {
    const commentMarker = `${marker}:comment`;
    const proofMarker = `${marker}:proof`;
    const expectedComment = `${payload.comment || "用户确认该事项不属于本人结果责任，归档误分类任务。"}\n\n${commentMarker}`;
    if (!cardContainsExactComment(card, expectedComment)) {
      const comment = await client.invokeTool("workboard_comment", {
        id: cardId,
        body: expectedComment,
      });
      if (!comment?.ok) throw new Error(comment?.error?.message || "Workboard correction comment failed.");
      card = await readCard(client, cardId);
      if (!cardContainsExactComment(card, expectedComment)) throw new Error("Workboard comment was not retained on the card.");
    }
    const expectedProofNote = `${payload.note || "已由用户确认：该事项属于他人工作，不应由 Shadow Agent 作为用户任务跟进。"}\n\n${proofMarker}`;
    const expectedProofLabel = "职责归属纠正";
    if (!cardContainsExactProof(card, expectedProofNote, expectedProofLabel)) {
      const proof = await client.invokeTool("workboard_proof", {
        id: cardId,
        status: "passed",
        label: expectedProofLabel,
        note: expectedProofNote,
      });
      if (!proof?.ok) throw new Error(proof?.error?.message || "Workboard correction proof failed.");
      card = await readCard(client, cardId);
      if (!cardContainsExactProof(card, expectedProofNote, expectedProofLabel)) throw new Error("Workboard proof was not retained on the card.");
    }
    if (!cardIsArchived(card)) {
      const archived = await client.request("workboard.cards.archive", { id: cardId, archived: true });
      card = archived?.card ?? await readCard(client, cardId);
      if (!cardIsArchived(card)) throw new Error("Workboard card was not archived.");
    }
    return { cardId, effect, status: card.status, archived: true, marker, idempotent: true };
  }

  throw new Error(`Unknown Workboard operation effect: ${effect}`);
}

export async function bindWorkboardExecution(client, payload, { database } = {}) {
  const cardId = String(payload.taskId ?? payload.cardId ?? "").trim();
  const runId = String(payload.runId ?? "").trim();
  const sessionKey = String(payload.sessionKey ?? "").trim();
  const model = String(payload.model ?? "").trim();
  if (!cardId || !runId || !sessionKey || !model) {
    throw new Error("Workboard execution binding requires taskId, runId, sessionKey, and model.");
  }
  const card = await readCard(client, cardId);
  const skip = (reason) => ({ cardId, runId, sessionKey, status: card.status, idempotent: true, skipped: true, reason });
  if (!ACTIVE_TASK_STATUSES.has(card.status) || cardIsArchived(card)) return skip("terminal");
  const current = executionIdentity(card);
  if (sameExecution(current, { runId, sessionKey })) {
    return { cardId, runId, sessionKey, status: card.status, idempotent: true };
  }
  const guardReason = executionBindingGuard(database, { ...payload, taskId: cardId });
  if (guardReason) return skip(guardReason);
  if (!sameExecution(current, payload.expectedExecution)) return skip("execution_changed");
  const now = Date.now();
  const parsedStartedAt = Date.parse(String(payload.startedAt ?? ""));
  const startedAt = Number.isFinite(parsedStartedAt) ? parsedStartedAt : now;
  const executionStatus = card.status === "blocked"
    ? "blocked"
    : card.status === "review"
      ? "review"
      : "running";
  const response = await client.request("workboard.cards.update", {
    id: cardId,
    patch: {
      // Execution bookkeeping must not move a human-controlled business card.
      sessionKey,
      runId,
      execution: {
        id: `shadow-codex:${runId}`,
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: executionStatus,
        model,
        sessionKey,
        runId,
        startedAt,
        updatedAt: now,
      },
    },
  });
  const updated = response?.card ?? await readCard(client, cardId);
  if ((updated.execution?.runId ?? updated.runId) !== runId
    || (updated.execution?.sessionKey ?? updated.sessionKey) !== sessionKey) {
    throw new Error("Workboard execution binding was not persisted.");
  }
  return { cardId, runId, sessionKey, status: updated.status, idempotent: true };
}

export async function applyWorkboardOperationThroughGateway(projectRoot, payload) {
  const client = new OpenClawGatewayClient({
    ...loadOpenClawGatewaySettings(projectRoot),
    autoReconnect: false,
  });
  try {
    await client.connect();
    return await applyWorkboardOperation(client, payload);
  } finally {
    client.stop();
  }
}

export async function bindWorkboardExecutionThroughGateway(projectRoot, payload, options = {}) {
  const client = new OpenClawGatewayClient({
    ...loadOpenClawGatewaySettings(projectRoot),
    autoReconnect: false,
  });
  try {
    await client.connect();
    return await bindWorkboardExecution(client, payload, options);
  } finally {
    client.stop();
  }
}

export async function listWorkboardCardsThroughGateway(projectRoot) {
  const client = new OpenClawGatewayClient({
    ...loadOpenClawGatewaySettings(projectRoot),
    autoReconnect: false,
  });
  try {
    await client.connect();
    const result = await client.request("workboard.cards.list", {});
    return Array.isArray(result?.cards) ? result.cards : [];
  } finally {
    client.stop();
  }
}
