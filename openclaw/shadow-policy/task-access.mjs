import { DatabaseSync } from "node:sqlite";
import { sessionRole } from "./policy.mjs";
import { readUserProfile } from "../../src/user-profile-view.mjs";

const readTools = new Set([
  "workboard_read", "workboard_list", "workboard_search", "workboard_attachment_read",
  "workboard_boards", "workboard_stats", "workboard_runs", "workboard_notify_list", "workboard_notify_events",
]);
const controlTools = new Set(["shadow_task_checkpoint", "shadow_context_ack", "shadow_condition_resolve"]);
// Explicit card lifecycle APIs, not board/subscription IDs or evidence append APIs.
const lifecycleTools = new Set([
  "workboard_move", "workboard_update", "workboard_specify", "workboard_decompose",
  "workboard_promote", "workboard_reassign", "workboard_reclaim", "workboard_claim",
  "workboard_heartbeat", "workboard_release", "workboard_complete", "workboard_block",
  "workboard_unblock", "workboard_protocol_violation",
]);
const futureWorkTools = new Set([
  "sessions_send", "sessions_spawn", "shadow_condition_watch", "shadow_outbound_draft_create",
  "shadow_reminder_create", "shadow_reminder_update",
]);

// Keep the task predicate identical to context_changes_task_seq_idx's expression.
export const TASK_CLOSURE_SQL = `
  SELECT 1 FROM context_changes
  WHERE json_extract(metadata_json,'$.taskId')=? AND kind='human_agent_operation'
    AND json_extract(metadata_json,'$.actor')='user' AND json_extract(metadata_json,'$.source')='pet-ui'
    AND ((json_extract(metadata_json,'$.action')='confirm_done' AND json_extract(metadata_json,'$.closure.outcome')='done')
      OR (json_extract(metadata_json,'$.action')='terminate_task' AND json_extract(metadata_json,'$.closure.outcome')='cancelled'))
  LIMIT 1`;

function closedTaskForAction(name, params, ownerTaskId, ctx, lookup) {
  let target;
  if (lifecycleTools.has(name)) target = params.id ?? params.taskId;
  else if (name === "workboard_create") target = params.createdByCardId;
  else if (name === "workboard_link") target = params.childId;
  else if (name === "shadow_task_checkpoint") {
    // Evidence-only checkpoints remain available, but cannot install a next trigger or plan.
    if (params.continuation == null && params.progressPlan == null) return;
    target = params.taskId;
  } else if (name === "shadow_condition_resolve") {
    if (params.disposition !== "continue") return;
    target = params.watchId ? lookup.taskForWatch?.(params.watchId) : undefined;
  } else if (futureWorkTools.has(name)) {
    if (name === "shadow_reminder_update") {
      target = params.reminderId ? lookup.taskForReminder?.(params.reminderId) : undefined;
    } else if (name !== "sessions_send" && name !== "sessions_spawn") target = params.taskId;
  } else return;

  const ids = [ownerTaskId, target];
  if (futureWorkTools.has(name)) {
    if (!ownerTaskId) ids.push(lookup.taskForExecution?.(ctx?.sessionKey));
    if ((name === "shadow_condition_watch" || name === "shadow_outbound_draft_create") && params.sessionKey) {
      ids.push(lookup.taskForSession?.(params.sessionKey));
    }
  }
  return [...new Set(ids.filter(id => typeof id === "string").map(id => id.trim()).filter(Boolean))]
    .find(id => lookup.isTaskClosed?.(id));
}

function readOne(file, query, ...args) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=2000");
    return db.prepare(query).get(...args);
  } finally { db.close(); }
}

export function checkTaskAccess(event, ctx, lookup) {
  const name = event.toolName;
  const params = event.params ?? {};
  if (name === "shadow_information_dispatch" && sessionRole(ctx) !== "controller") {
    return { block: true, blockReason: "Only the input controller routes source evidence; curators return taskImpacts and workers return results." };
  }
  if (readTools.has(name)) return;
  if (name === "codex_session_send" || name === "codex_session_interrupt") {
    return { block: true, blockReason: "User-owned Codex supervision is read-only; use the recorded task execution route for managed workers." };
  }
  const mutation = name?.startsWith("workboard_") || controlTools.has(name);
  if (!mutation && !futureWorkTools.has(name)) return;
  const deny = (reason) => ({ block: true, blockReason: reason });
  const role = sessionRole(ctx);
  if (role === "curator" && name === "shadow_context_ack") {
    return lookup.ownsChanges?.(ctx.sessionKey, params)
      ? undefined
      : deny("Knowledge maintenance may acknowledge only its own leased evidence changes.");
  }
  if (role !== "controller" && mutation) {
    return deny("Return evidence to the owning controller; this executor/curator does not own task lifecycle.");
  }
  if (name === "workboard_create" && String(ctx.sessionKey).startsWith("agent:main:shadow:")
      && ctx.sessionKey !== "agent:main:shadow:user" && !String(ctx.sessionKey).includes(":shadow:task:")
      && lookup.profileReady && !lookup.profileReady()) {
    return deny("User basics are incomplete or conflicted. Continue explicit user tasks through the direct-input session; do not infer outside-message task ownership. Ask only missing profile information.");
  }
  // Check exact targets before the source-controller fast path, including queued human closure.
  const taskSession = String(ctx?.sessionKey ?? "").includes(":shadow:task:");
  const taskId = taskSession ? lookup.taskForSession(ctx.sessionKey) : undefined;
  if (taskSession && !taskId) return deny("Task controller binding is missing; repair the binding without requesting generic user authorization.");
  const closedTask = closedTaskForAction(name, params, taskId, ctx, lookup);
  if (closedTask) return deny(`Task ${closedTask} is terminal or explicitly closed by the user; do not reopen, restart, or schedule further work. Retain evidence through reads, owner comments, acknowledgement, or an evidence-only checkpoint.`);
  // User/inbox/conversation sessions can route work; only task sessions have a fixed card.
  if (!taskSession) {
    if (name === "sessions_send") return deny("Execution continuation requires the owning task controller and its recorded execution binding.");
    return;
  }
  if (name === "sessions_send") {
    const target = params.sessionKey;
    if (!target || !lookup.isCurrentExecution(taskId, target)) {
      return deny("Session visibility is read access, not control authority. Continue only the current card's recorded execution session.");
    }
  } else {
    const requested = params.taskId ?? params.id;
    if (requested && requested !== taskId) return deny("This task controller cannot modify another task card; return a linked finding to its owner.");
  }
}

export function createTaskAccessHook(config) {
  const lookup = {
    profileReady: () => {
      const db = new DatabaseSync(config.databasePath, { readOnly: true });
      try { return readUserProfile(db).autonomousOwnershipReady; } finally { db.close(); }
    },
    taskForSession: (key) => readOne(config.databasePath,
      "SELECT task_id FROM conversation_bindings WHERE session_key=? AND session_kind='task' AND status='active'", key)?.task_id,
    taskForExecution: (key) => key ? readOne(config.workboardDatabasePath,
      "SELECT id FROM workboard_cards WHERE COALESCE(execution_session_key,session_key)=?", key)?.id : undefined,
    taskForWatch: (id) => readOne(config.databasePath,
      "SELECT task_id FROM condition_watches WHERE id=?", id)?.task_id,
    taskForReminder: (id) => readOne(config.databasePath,
      "SELECT task_id FROM reminders WHERE id=?", id)?.task_id,
    isTaskClosed: (id) => {
      // The accepted local decision is effective even before Workboard/outbox synchronization.
      const closure = readOne(config.databasePath, TASK_CLOSURE_SQL, id);
      if (closure) return true;
      return Boolean(readOne(config.workboardDatabasePath,
        "SELECT id FROM workboard_cards WHERE id=? AND (status IN ('done','cancelled') OR archived_at IS NOT NULL)", id));
    },
    isCurrentExecution: (id, key) => Boolean(readOne(config.workboardDatabasePath,
      `SELECT id FROM workboard_cards WHERE id=? AND archived_at IS NULL
       AND status NOT IN ('done','cancelled') AND COALESCE(execution_session_key,session_key)=?`, id, key)),
    ownsChanges: (key, { sequences, leaseOwner = "openclaw-main" }) => {
      if (!Array.isArray(sequences) || !sequences.length || sequences.length > 20
        || !sequences.every(seq => Number.isInteger(seq) && seq > 0)) return false;
      const unique = [...new Set(sequences)];
      const found = readOne(config.databasePath,
        `SELECT COUNT(*) AS count FROM context_changes
         WHERE session_key=? AND status='leased' AND lease_owner=?
         AND seq IN (${unique.map(() => "?").join(",")})`, key, leaseOwner, ...unique);
      return found?.count === unique.length;
    },
  };
  return (event, ctx) => {
    try { return checkTaskAccess(event, ctx, lookup); }
    catch { return { block: true, blockReason: "Task binding lookup failed; retain the action and repair infrastructure before retrying." }; }
  };
}
