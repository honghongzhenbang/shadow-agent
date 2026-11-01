import { createHash } from "node:crypto";
import { readNativeSessionId } from "./native-session-store.mjs";

export const CHECKPOINT_RUNTIME_CONTEXT = "__shadowCheckpointRuntimeContext";

function identityError(message) {
  return Object.assign(new Error(message), { code: "SHADOW_CHECKPOINT_IDENTITY_MISMATCH" });
}

export function checkpointRuntimeInput(input, context) {
  const sessionKey = typeof context?.sessionKey === "string" ? context.sessionKey.trim() : "";
  if (!sessionKey) throw identityError("Task checkpoint requires a trusted runtime sessionKey.");
  for (const field of ["ownerSessionKey", "sessionKey"]) {
    if (input[field] != null && input[field] !== sessionKey) {
      throw identityError(`Task checkpoint ${field} does not match the trusted runtime session.`);
    }
  }
  // This reserved envelope is overwritten at the factory boundary, never accepted from the model.
  return { ...input, ownerSessionKey: sessionKey, [CHECKPOINT_RUNTIME_CONTEXT]: { sessionKey } };
}

export function assertCheckpointRuntimeIdentity(database, taskId, attention, input, change, context) {
  const sessionKey = context?.sessionKey;
  if (!sessionKey || input.ownerSessionKey !== sessionKey) {
    throw identityError("Task checkpoint owner does not match the trusted runtime session.");
  }
  const binding = database.prepare("SELECT * FROM conversation_bindings WHERE session_key=?").get(sessionKey);
  if (!binding || binding.session_kind !== "task" || binding.status !== "active" || binding.task_id !== taskId) {
    throw identityError("Trusted runtime session is not actively bound to this task.");
  }
  if (attention?.owner_session_key !== sessionKey) {
    throw identityError("Trusted runtime session is not the current task owner.");
  }
  if (change && change.session_key !== sessionKey) {
    throw identityError("Leased change does not belong to the trusted runtime session.");
  }
}

export function checkpointRequestHash(input) {
  const canonical = JSON.stringify(input, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
      : value);
  return createHash("sha256").update(canonical).digest("hex");
}

export const ACTIVE_TASK_STATUSES = new Set(["triage", "backlog", "todo", "scheduled", "ready", "running", "review", "blocked"]);

export function executionIdentity(card) {
  return {
    runId: card?.execution?.runId ?? card?.execution_run_id ?? card?.runId ?? null,
    sessionKey: card?.execution?.sessionKey ?? card?.execution_session_key ?? card?.sessionKey ?? null,
  };
}

export function sameExecution(left, right) {
  return left?.runId === right?.runId && left?.sessionKey === right?.sessionKey;
}

export function continuationExecution(continuation, observed = {}) {
  const sessionKey = continuation?.sessionKey ?? observed.sessionKey ?? null;
  const reference = continuation?.referenceId;
  const runId = reference && reference !== sessionKey
    ? reference
    : sessionKey === observed.sessionKey ? observed.runId : null;
  return { runId: runId ?? null, sessionKey };
}

export function checkpointVersion(attention, card) {
  return {
    checkpointRevision: Number(attention?.checkpoint_revision ?? 0),
    bindingRevision: Number(attention?.binding_revision ?? 1),
    ownerSessionKey: attention?.owner_session_key ?? null,
    execution: executionIdentity(card),
  };
}

export function checkpointWriteGuard(database, taskId, version, input, change) {
  const sessionKey = input.ownerSessionKey ?? change?.session_key ?? null;
  let inactiveSession = false;
  for (const key of new Set([sessionKey, change?.session_key].filter(Boolean))) {
    const binding = database.prepare("SELECT * FROM conversation_bindings WHERE session_key=?").get(key);
    if (binding?.session_kind === "task" && binding.task_id !== taskId) {
      throw new Error("Task checkpoint session is bound to a different task.");
    }
    if (binding && (binding.session_kind !== "task" || binding.status !== "active")) {
      inactiveSession = true;
    }
  }
  if (sessionKey && change?.session_key && sessionKey !== change.session_key) {
    throw new Error("Task checkpoint session does not match the leased change.");
  }
  if (inactiveSession) return "inactive_task_session";
  if (version.ownerSessionKey && sessionKey !== version.ownerSessionKey) return "task_owner_changed";
  if (input.expectedBindingRevision !== version.bindingRevision) return "binding_revision_changed";
  if (input.expectedCheckpointRevision !== version.checkpointRevision) return "checkpoint_revision_changed";
  if (!sameExecution(input.expectedExecution, version.execution)) return "execution_changed";
  return null;
}

// The outbox can already be claimed when another checkpoint supersedes it.
export function executionBindingGuard(database, payload) {
  if (payload.checkpointRevision == null) return "unversioned_binding";
  if (!database) return "checkpoint_store_unavailable";
  const attention = database.prepare("SELECT * FROM work_task_attention WHERE card_id=?").get(payload.taskId);
  if (!attention || attention.checkpoint_revision !== payload.checkpointRevision
    || attention.binding_revision !== payload.bindingRevision
    || (attention.owner_session_key ?? null) !== (payload.ownerSessionKey ?? null)
    || attention.continuation_kind !== "codex_run") return "superseded_checkpoint";
  if (payload.ownerSessionKey) {
    const owner = database.prepare("SELECT * FROM conversation_bindings WHERE session_key=?").get(payload.ownerSessionKey);
    if (!owner || owner.session_kind !== "task" || owner.task_id !== payload.taskId || owner.status !== "active") {
      return "inactive_task_session";
    }
  }
  const receipt = database.prepare("SELECT value FROM settings WHERE key=?").get(payload.checkpointKey)?.value;
  const checkpoint = receipt ? JSON.parse(receipt).checkpoint : null;
  const { runId } = continuationExecution(checkpoint?.continuation, checkpoint?.execution);
  if (!checkpoint?.applied || checkpoint.taskId !== payload.taskId
    || checkpoint.checkpointRevision !== payload.checkpointRevision
    || runId !== payload.runId
    || attention.continuation_reference_id !== checkpoint.continuation?.referenceId
    || checkpoint.continuation?.sessionKey !== payload.sessionKey
    || checkpoint.continuation?.model !== payload.model
    || !sameExecution(checkpoint.execution, payload.expectedExecution)) return "checkpoint_identity_mismatch";
  if (checkpoint.nativeContinuation) {
    const proof = checkpoint.nativeContinuation;
    const stored = database.prepare('SELECT value FROM settings WHERE key=?').get(proof.receiptKey)?.value;
    const send = stored ? JSON.parse(stored) : null;
    if (!send || send.consumedBy !== payload.checkpointKey || send.taskId !== payload.taskId
      || send.outcome?.runId !== payload.runId || send.outcome?.sessionKey !== payload.sessionKey
      || readNativeSessionId(send.nativeDatabasePath, payload.sessionKey) !== proof.native?.sessionId) {
      return "native_continuation_retired";
    }
  }
  return null;
}
