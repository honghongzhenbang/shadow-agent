import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { buildPolicyPrompt, assertPolicyApplied, sessionRole } from "../openclaw/shadow-policy/policy.mjs";
import { checkTaskAccess, createTaskAccessHook, TASK_CLOSURE_SQL } from "../openclaw/shadow-policy/task-access.mjs";
import { patchPolicyBoundary } from "../scripts/apply-shadow-policy-boundary.mjs";

const config = {
  rulesPath: path.resolve("openclaw/workspace-template/AGENTS.md"),
  collaborationPath: path.resolve("openclaw/workspace-template/COLLABORATION.md"),
};
const task = { sessionKey: "agent:main:shadow:task:a" };
const full = { plugins: { entries: { "shadow-policy": { enabled: true, config: { ...config, required: true } } } } };

test("owned prompt replaces personality without copying task history or forcing Workshop", () => {
  const prompt = buildPolicyPrompt(config, task);
  assert.match(prompt, /not OpenClaw/);
  assert.match(prompt, /Workshop is optional/);
  assert.match(prompt, /host-side helper/);
  assert.match(prompt, /Shadow Agent Operating Rules/);
  assert.ok(prompt.length <= 20000);
  assert.doesNotMatch(prompt, /sole OpenClaw controller/);
});

test("shipped bootstrap is generic and does not preload the developer's business profile", () => {
  for (const file of ["AGENTS.md", "RUNTIME_AGENTS.md", "COLLABORATION.md", "TOOLS.md", "HEARTBEAT.md"]) {
    const source = fs.readFileSync(path.resolve("openclaw/workspace-template", file), "utf8");
    assert.doesNotMatch(source, /ExampleVision|ExampleUser|示例人员19|示例公司|机器人焊接软件|C\+\+\/Qt/i);
  }
  assert.match(fs.readFileSync(config.collaborationPath, "utf8"), /私有知识库检索/);
});

test("host-derived roles keep engineers and curators out of task control", () => {
  for (const key of ["agent:main:dashboard:a", "agent:main:subagent:b"]) {
    assert.equal(sessionRole({ sessionKey: key }), "engineer");
    assert.doesNotMatch(buildPolicyPrompt(config, { sessionKey: key }), /# Shadow Agent Operating Rules/);
  }
  assert.equal(sessionRole({ sessionKey: "agent:main:shadow:workstream:k" }), "curator");
  assert.ok(buildPolicyPrompt(config, { sessionKey: "agent:main:subagent:b" }).length < 4000);
});

test("required prompt fails closed after missing, failed or overriding hooks", () => {
  assert.doesNotThrow(() => assertPolicyApplied(full, task, buildPolicyPrompt(config, task)));
  for (const actual of [undefined, "", "OpenClaw fallback", buildPolicyPrompt(config, { sessionKey: "agent:main:subagent:b" })]) {
    assert.throws(() => assertPolicyApplied(full, task, actual), { code: "SHADOW_POLICY_NOT_APPLIED" });
  }
  assert.doesNotThrow(() => assertPolicyApplied({}, task, undefined));
  assert.throws(() => assertPolicyApplied({
    plugins: { entries: { "shadow-policy": { ...full.plugins.entries["shadow-policy"], enabled: false } } },
  }, task, buildPolicyPrompt(config, task)));
});

const lookup = {
  taskForSession: () => "card-a",
  isCurrentExecution: (id, key) => id === "card-a" && key === "agent:main:dashboard:old",
  ownsChanges: (key, params) => key === "agent:main:shadow:workstream:k"
    && params.leaseOwner === "curator-lease" && params.sequences?.length === 1 && params.sequences[0] === 1,
};
test("same-agent reads do not grant cross-card writes or sends", () => {
  assert.equal(checkTaskAccess({ toolName: "workboard_read", params: { id: "card-b" } }, task, lookup), undefined);
  assert.equal(checkTaskAccess({ toolName: "sessions_history", params: { sessionKey: "other" } }, task, lookup), undefined);
  assert.equal(checkTaskAccess({ toolName: "workboard_comment", params: { id: "card-b" } }, task, lookup).block, true);
  assert.equal(checkTaskAccess({ toolName: "workboard_comment", params: { id: "card-a" } }, task, lookup), undefined);
  for (const params of [{ sessionKey: "other" }, { label: "old" }]) {
    assert.equal(checkTaskAccess({ toolName: "sessions_send", params }, task, lookup).block, true);
  }
  assert.equal(checkTaskAccess({ toolName: "sessions_send", params: { sessionKey: "agent:main:dashboard:old" } }, task, lookup), undefined);
});

test("workers cannot promote their own evidence to task decisions", () => {
  const worker = { sessionKey: "agent:main:subagent:a" };
  assert.equal(checkTaskAccess({ toolName: "shadow_task_checkpoint", params: { taskId: "card-a" } }, worker, lookup).block, true);
  assert.equal(checkTaskAccess({ toolName: "workboard_create", params: {} }, worker, lookup).block, true);
  assert.equal(checkTaskAccess({ toolName: "workboard_attachment_read", params: { id: "card-a" } }, worker, lookup), undefined);
  assert.equal(checkTaskAccess({ toolName: "codex_session_send", params: {} }, task, lookup).block, true);
  assert.equal(checkTaskAccess({ toolName: "read", params: { path: "authorized-skill" } }, worker, lookup), undefined);
});

test("curators can acknowledge their own delta without controlling business tasks", () => {
  const curator = { sessionKey: "agent:main:shadow:workstream:k" };
  const owned = { toolName: "shadow_context_ack", params: { sequences: [1], leaseOwner: "curator-lease" } };
  assert.equal(checkTaskAccess(owned, curator, lookup), undefined);
  assert.equal(checkTaskAccess({ ...owned, params: { ...owned.params, sequences: [2] } }, curator, lookup).block, true);
  assert.equal(checkTaskAccess({ toolName: "shadow_task_checkpoint", params: { taskId: "card-a" } }, curator, lookup).block, true);
  assert.equal(checkTaskAccess(owned, { sessionKey: "agent:main:subagent:a" }, lookup).block, true);
});

test("curator delta ownership is checked against persisted session and lease", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-policy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "context.sqlite");
  const db = new DatabaseSync(databasePath);
  const sessionKey = "agent:main:shadow:workstream:k";
  db.exec("CREATE TABLE context_changes(seq INTEGER PRIMARY KEY, session_key TEXT, status TEXT, lease_owner TEXT)");
  const insert = db.prepare("INSERT INTO context_changes VALUES (?, ?, ?, ?)");
  insert.run(1, sessionKey, "leased", "lease-k");
  insert.run(2, "agent:main:shadow:task:a", "leased", "lease-k");
  insert.run(3, sessionKey, "processed", "lease-k");
  db.close();
  const hook = createTaskAccessHook({ databasePath });
  const invoke = (sequences, leaseOwner = "lease-k") => hook({
    toolName: "shadow_context_ack", params: { sequences, leaseOwner },
  }, { sessionKey });
  assert.equal(invoke([1]), undefined);
  for (const sequences of [[1, 2], [3], [], ["1"], [99]]) assert.equal(invoke(sequences).block, true);
  assert.equal(invoke([1], "wrong").block, true);
});

function terminalAccessFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-terminal-access-"));
  const databasePath = path.join(directory, "context.sqlite");
  const workboardDatabasePath = path.join(directory, "workboard.sqlite");
  const db = new DatabaseSync(databasePath);
  const workboard = new DatabaseSync(workboardDatabasePath);
  t.after(() => {
    db.close();
    workboard.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  db.exec(`
    CREATE TABLE conversation_bindings(session_key TEXT PRIMARY KEY, task_id TEXT, session_kind TEXT, status TEXT);
    CREATE TABLE context_changes(seq INTEGER PRIMARY KEY, kind TEXT, session_key TEXT, status TEXT,
      lease_owner TEXT, metadata_json TEXT NOT NULL DEFAULT '{}');
    CREATE INDEX context_changes_task_seq_idx ON context_changes(json_extract(metadata_json, '$.taskId'), seq);
    CREATE TABLE condition_watches(id TEXT PRIMARY KEY, task_id TEXT);
    CREATE TABLE reminders(id TEXT PRIMARY KEY, task_id TEXT);
  `);
  workboard.exec(`CREATE TABLE workboard_cards(id TEXT PRIMARY KEY, status TEXT, archived_at INTEGER,
    execution_session_key TEXT, session_key TEXT)`);
  for (const id of ["a", "b"]) {
    db.prepare("INSERT INTO conversation_bindings VALUES (?, ?, 'task', 'active')")
      .run(`agent:main:shadow:task:${id}`, `card-${id}`);
    db.prepare("INSERT INTO condition_watches VALUES (?, ?)").run(`watch-${id}`, `card-${id}`);
    db.prepare("INSERT INTO reminders VALUES (?, ?)").run(`reminder-${id}`, `card-${id}`);
    workboard.prepare("INSERT INTO workboard_cards VALUES (?, 'running', NULL, ?, ?)")
      .run(`card-${id}`, `agent:main:subagent:${id}`, `legacy-${id}`);
  }
  const hook = createTaskAccessHook({ databasePath, workboardDatabasePath });
  const invoke = (toolName, params = {}, sessionKey = task.sessionKey) => hook({ toolName, params }, { sessionKey });
  const close = (overrides = {}, kind = "human_agent_operation", status = "pending") => {
    const metadata = { taskId: "card-a", actor: "user", source: "pet-ui", action: "confirm_done",
      closure: { outcome: "done", note: "Accepted closure" }, appliedStatus: "queued", ...overrides };
    return db.prepare("INSERT INTO context_changes(kind, session_key, status, metadata_json) VALUES (?, ?, ?, ?)")
      .run(kind, task.sessionKey, status, JSON.stringify(metadata));
  };
  return { db, workboard, invoke, close };
}

const lifecycleCalls = [
  ["workboard_move", { status: "running" }],
  ["workboard_update", { status: "todo", archived: false }],
  ["workboard_specify", {}], ["workboard_decompose", { children: [] }],
  ["workboard_promote", { force: true }], ["workboard_reassign", { status: "ready", resetFailures: true }],
  ["workboard_reclaim", { status: "todo" }], ["workboard_claim", {}],
  ["workboard_heartbeat", {}], ["workboard_release", { status: "todo" }],
  ["workboard_complete", { status: "review" }], ["workboard_block", {}],
  ["workboard_unblock", {}], ["workboard_protocol_violation", {}],
];
const sourceSession = "agent:main:shadow:user";

test("production closure SQL searches the existing task expression index without a table scan", t => {
  const f = terminalAccessFixture(t);
  f.close();
  for (const taskId of ["card-a", "card-missing"]) {
    const details = f.db.prepare(`EXPLAIN QUERY PLAN ${TASK_CLOSURE_SQL}`).all(taskId)
      .map(row => row.detail).join("\n");
    assert.match(details, /SEARCH context_changes USING INDEX context_changes_task_seq_idx \(<expr>=\?\)/);
    assert.doesNotMatch(details, /SCAN context_changes/);
  }
});

test("task expression index rejects malformed JSON inserts and updates", t => {
  const f = terminalAccessFixture(t);
  f.close();
  const before = f.db.prepare("SELECT * FROM context_changes").all();
  assert.throws(() => f.db.prepare("INSERT INTO context_changes(kind, metadata_json) VALUES ('human_agent_operation', ?)")
    .run("not JSON"), /malformed JSON/);
  assert.throws(() => f.db.prepare("UPDATE context_changes SET metadata_json=? WHERE seq=1")
    .run("not JSON"), /malformed JSON/);
  assert.deepEqual(f.db.prepare("SELECT * FROM context_changes").all(), before);
  assert.equal(f.invoke("workboard_move", { id: "card-a", status: "running" })?.block, true);
});

test("malformed JSON lookup fails closed through the existing error guard", t => {
  const f = terminalAccessFixture(t);
  // Fault injection only: the real index otherwise rejects this write.
  f.db.exec("DROP INDEX context_changes_task_seq_idx");
  f.db.prepare("INSERT INTO context_changes(kind, metadata_json) VALUES ('human_agent_operation', ?)")
    .run("not JSON");
  assert.throws(() => f.db.prepare(TASK_CLOSURE_SQL).get("card-a"), /malformed JSON/);
  for (const sessionKey of [task.sessionKey, sourceSession]) {
    const result = f.invoke("workboard_move", { id: "card-a", status: "running" }, sessionKey);
    assert.equal(result?.block, true);
    assert.match(result.blockReason, /lookup failed/);
  }
});

test("native terminal cards reject late lifecycle changes from owners and source controllers", t => {
  const f = terminalAccessFixture(t);
  // An archive can retain a nonterminal status; even a zero timestamp is an archive marker.
  for (const [status, archivedAt] of [["done", null], ["cancelled", null], ["running", 0]]) {
    f.workboard.prepare("UPDATE workboard_cards SET status=?, archived_at=? WHERE id='card-a'").run(status, archivedAt);
    for (const session of [task.sessionKey, sourceSession, "agent:main:shadow:conversation:outside"]) {
      for (const [toolName, params] of lifecycleCalls) {
        assert.match(f.invoke(toolName, { id: "card-a", ...params }, session)?.blockReason ?? "",
          /terminal or explicitly closed/, `${toolName}: ${status} / ${session}`);
      }
    }
    for (const [toolName, params] of lifecycleCalls) {
      assert.equal(f.invoke(toolName, { id: "card-b", ...params }, sourceSession), undefined, toolName);
    }
    assert.equal(f.invoke("sessions_send", { sessionKey: "agent:main:subagent:a" })?.block, true);
    assert.equal(f.invoke("sessions_spawn", { task: "Retry" })?.block, true);
    for (const toolName of ["shadow_condition_watch", "shadow_outbound_draft_create"]) {
      assert.equal(f.invoke(toolName, { taskId: "card-a" }, sourceSession)?.block, true);
    }
    assert.equal(f.invoke("workboard_move", { id: "  card-a  ", status: "todo" }, sourceSession)?.block, true);
    assert.equal(f.invoke("workboard_link", { parentId: "card-b", childId: "card-a" }, sourceSession)?.block, true);
    assert.equal(f.invoke("workboard_link", { parentId: "card-a", childId: "card-b" }, sourceSession), undefined);
  }
});

test("accepted local closure fences immediately and survives ACK, failed sync, and later non-closure results", t => {
  const f = terminalAccessFixture(t);
  for (const [action, outcome] of [["confirm_done", "done"], ["terminate_task", "cancelled"]]) {
    f.db.exec("DELETE FROM context_changes");
    f.close({ action, closure: { outcome, note: "Stop future work" } });
    // A late result or guidance record cannot override the accepted closure.
    f.close({ action: "task_guidance", closure: null, userText: "restart" });
    assert.equal(f.workboard.prepare("SELECT status FROM workboard_cards WHERE id='card-a'").get().status, "running");
    for (const status of ["pending", "leased", "acknowledged", "consumed", "cancelled"]) {
      for (const appliedStatus of ["queued", "applied", "failed"]) {
        f.db.prepare("UPDATE context_changes SET status=?, metadata_json=json_set(metadata_json,'$.appliedStatus',?)")
          .run(status, appliedStatus);
        assert.equal(f.invoke("workboard_move", { id: "card-a", status: "running" })?.block, true);
        assert.equal(f.invoke("workboard_update", { id: "card-a", status: "todo" }, sourceSession)?.block, true);
        assert.equal(f.invoke("sessions_send", { sessionKey: "agent:main:subagent:a", message: "late retry" })?.block, true);
        assert.equal(f.invoke("sessions_spawn", { task: "late retry" })?.block, true);
        assert.equal(f.invoke("workboard_move", { id: "card-b", status: "running" }, sourceSession), undefined);
      }
    }
  }
});

test("closure requires exact structured human provenance, action, outcome and task identity", t => {
  const f = terminalAccessFixture(t);
  for (const overrides of [
    { actor: "agent" }, { source: "feishu" }, { taskId: "card-a-suffix" }, { taskId: "card-b" },
    { action: "task_guidance" }, { closure: null, userText: "done; terminate card-a" },
    { closure: { outcome: "cancelled" } }, { closure: { outcome: "complete" } },
    { action: "terminate_task", closure: { outcome: "done" } },
  ]) {
    f.db.exec("DELETE FROM context_changes");
    f.close(overrides);
    assert.equal(f.invoke("workboard_move", { id: "card-a", status: "running" }), undefined, JSON.stringify(overrides));
  }
  f.db.exec("DELETE FROM context_changes");
  f.close({}, "task_progress_due");
  assert.equal(f.invoke("sessions_spawn", { task: "Continue active task" }), undefined);
  assert.equal(f.invoke("sessions_send", { sessionKey: "agent:main:subagent:a", message: "Continue" }), undefined);
  f.workboard.exec("UPDATE workboard_cards SET status='review' WHERE id='card-a'");
  assert.equal(f.invoke("workboard_move", { id: "card-a", status: "running" }), undefined);
});

test("closed task cannot spawn replacement work, create watches/drafts or reschedule continuations", t => {
  const f = terminalAccessFixture(t);
  f.close({ action: "terminate_task", closure: { outcome: "cancelled", note: "Stop" } });
  for (const toolName of ["sessions_spawn", "workboard_create", "shadow_condition_watch", "shadow_outbound_draft_create", "shadow_reminder_create"]) {
    assert.equal(f.invoke(toolName)?.block, true, `${toolName} cannot omit task identity in the closed owner session`);
  }
  assert.equal(f.invoke("sessions_spawn", { task: "Replacement" }, "agent:main:subagent:a")?.block, true);
  assert.equal(f.invoke("sessions_spawn", { task: "Independent" }, "agent:main:subagent:b"), undefined);
  assert.equal(f.invoke("sessions_spawn", { task: "Independent" }, "agent:main:shadow:task:b"), undefined);
  assert.equal(f.invoke("sessions_send", { sessionKey: "agent:main:subagent:b" }, "agent:main:shadow:task:b"), undefined);
  for (const toolName of ["shadow_condition_watch", "shadow_outbound_draft_create", "shadow_reminder_create"]) {
    assert.equal(f.invoke(toolName, { taskId: "card-a" }, sourceSession)?.block, true, toolName);
    assert.equal(f.invoke(toolName, { taskId: " card-a " }, sourceSession)?.block, true, `${toolName} normalizes taskId`);
    assert.equal(f.invoke(toolName, { taskId: "card-b" }, sourceSession), undefined, toolName);
    assert.equal(f.invoke(toolName, {}, sourceSession), undefined, `${toolName} without task scope is unrelated`);
  }
  for (const toolName of ["shadow_condition_watch", "shadow_outbound_draft_create"]) {
    assert.equal(f.invoke(toolName, { sessionKey: task.sessionKey }, sourceSession)?.block, true);
  }
  assert.equal(f.invoke("shadow_condition_resolve", { watchId: "watch-a", disposition: "continue" }, sourceSession)?.block, true);
  assert.equal(f.invoke("shadow_condition_resolve", { watchId: "watch-b", disposition: "continue" }, sourceSession), undefined);
  assert.equal(f.invoke("shadow_reminder_update", { reminderId: "reminder-a", dueAt: "2099-01-01T00:00:00Z" }, sourceSession)?.block, true);
  assert.equal(f.invoke("shadow_reminder_update", { reminderId: "reminder-b" }, sourceSession), undefined);
  assert.equal(f.invoke("workboard_create", { createdByCardId: "card-a" }, sourceSession)?.block, true);
  assert.equal(f.invoke("workboard_create", { title: "Independent task", parents: ["card-a"] }, sourceSession), undefined);
  for (const extra of [{ continuation: { kind: "codex_run" } }, { continuation: { kind: "internal_review" } }, { progressPlan: {} }]) {
    assert.equal(f.invoke("shadow_task_checkpoint", { taskId: "card-a", ...extra })?.block, true);
  }
});

test("closure retains reads, owner evidence/checkpoint/ACK, cleanup and curator knowledge maintenance", t => {
  const f = terminalAccessFixture(t);
  f.close();
  for (const [toolName, params] of [
    ["workboard_read", { id: "card-a" }], ["workboard_attachment_read", { id: "attachment-a" }],
    ["sessions_history", { sessionKey: "agent:main:subagent:a" }], ["shadow_evidence_search", {}],
    ["shadow_condition_list", {}], ["shadow_outbound_draft_list", {}],
    ["workboard_comment", { id: "card-a", body: "Late result retained" }],
    ["workboard_proof", { id: "card-a", status: "passed" }],
    ["shadow_task_checkpoint", { taskId: "card-a", resultSummary: "Late evidence", continuation: null }],
    ["shadow_context_ack", { sequences: [1] }],
    ["shadow_condition_resolve", { watchId: "watch-a", disposition: "cancelled" }],
    ["shadow_reminder_cancel", { reminderId: "reminder-a" }],
  ]) assert.equal(f.invoke(toolName, params), undefined, toolName);
  assert.equal(f.invoke("workboard_comment", { id: "card-b" })?.block, true, "owner boundary is unchanged");
  assert.equal(f.invoke("shadow_task_checkpoint", { taskId: "card-a" }, "agent:main:subagent:a")?.block, true);
  const curator = "agent:main:shadow:workstream:k";
  f.db.prepare("INSERT INTO context_changes(seq, session_key, status, lease_owner) VALUES (2, ?, 'leased', 'curator')").run(curator);
  for (const toolName of ["shadow_context_annotate", "shadow_context_propose", "shadow_context_revise", "shadow_context_enrichment"]) {
    assert.equal(f.invoke(toolName, { taskId: "card-a" }, curator), undefined, toolName);
  }
  assert.equal(f.invoke("shadow_context_ack", { sequences: [2], leaseOwner: "curator" }, curator), undefined);
  assert.equal(f.invoke("shadow_context_ack", { sequences: [1], leaseOwner: "curator" }, curator)?.block, true);
});

test("fence uses read-only lookups and does not treat board or subscription IDs as card IDs", t => {
  const f = terminalAccessFixture(t);
  f.close();
  const snapshot = () => ({
    changes: f.db.prepare("SELECT * FROM context_changes").all(),
    bindings: f.db.prepare("SELECT * FROM conversation_bindings").all(),
    watches: f.db.prepare("SELECT * FROM condition_watches").all(),
    reminders: f.db.prepare("SELECT * FROM reminders").all(),
    cards: f.workboard.prepare("SELECT * FROM workboard_cards").all(),
  });
  const before = snapshot();
  for (let index = 0; index < 3; index += 1) {
    assert.equal(f.invoke("workboard_move", { id: "card-a", status: "running" }, sourceSession)?.block, true);
    assert.equal(f.invoke("sessions_spawn", { task: "Late restart" })?.block, true);
    assert.equal(f.invoke("shadow_condition_watch", { taskId: "card-a" }, sourceSession)?.block, true);
    assert.equal(f.invoke("workboard_board_create", { id: "card-a" }, sourceSession), undefined);
    assert.equal(f.invoke("workboard_notify_unsubscribe", { id: "card-a" }, sourceSession), undefined);
  }
  assert.deepEqual(snapshot(), before);
});

test("task fence fails closed on infrastructure failure without blocking evidence reads or ACK", t => {
  const f = terminalAccessFixture(t);
  f.db.exec("DROP TABLE context_changes");
  assert.match(f.invoke("workboard_move", { id: "card-a", status: "running" }, sourceSession)?.blockReason ?? "",
    /lookup failed/);
  assert.equal(f.invoke("workboard_read", { id: "card-a" }), undefined);
  assert.equal(f.invoke("shadow_context_ack", { sequences: [1] }), undefined);
});

test("managed host guard covers actual Codex and embedded/API layouts and is idempotent", () => {
  const dist = path.resolve("tools/openclaw-runtime/node_modules/openclaw/dist");
  const fixtures = [
    ["codex", /^run-attempt-.*\.js$/, "const buildPromptFromCurrentInputs = async () =>"],
    ["embedded", /^attempt-prompt-helpers-.*\.js$/, "async function resolvePromptBuildHookResult(params)"],
  ];
  for (const [kind, pattern, anchor] of fixtures) {
    const file = fs.readdirSync(dist).find(name => pattern.test(name) && fs.readFileSync(path.join(dist, name), "utf8").includes(anchor));
    assert.ok(file, `installed ${kind} layout`);
    const source = fs.readFileSync(path.join(dist, file), "utf8");
    const patched = patchPolicyBoundary(source, kind, "file:///policy.mjs");
    assert.match(patched, /assertPolicyApplied\(params\.config/);
    assert.equal(patchPolicyBoundary(patched, kind, "file:///policy.mjs"), patched);
    assert.match(patchPolicyBoundary(patched, kind, "file:///moved/policy.mjs"), /moved\/policy/);
    const damaged = patched.replace(/assertPolicyApplied\(params\.config[^\n]+/, "");
    assert.throws(() => patchPolicyBoundary(damaged, kind, "file:///policy.mjs"), /Invalid managed policy guard/);
  }
  assert.throws(() => patchPolicyBoundary("unrecognized runtime", "codex", "file:///policy.mjs"));
});

test("actual patched Codex prompt builder refuses a failed hook before handing input to the model", async () => {
  const dist = path.resolve("tools/openclaw-runtime/node_modules/openclaw/dist");
  const file = fs.readdirSync(dist).find(name => /^run-attempt-.*\.js$/.test(name)
    && fs.readFileSync(path.join(dist, name), "utf8").includes("const buildPromptFromCurrentInputs = async () =>"));
  const source = patchPolicyBoundary(fs.readFileSync(path.join(dist, file), "utf8"), "codex", "file:///policy.mjs");
  const start = source.indexOf("const buildPromptFromCurrentInputs = async () =>");
  const end = source.indexOf("\n\tconst resolveShiftedPromptInputRange", start);
  const factory = new Function("resolveAgentHarnessBeforePromptBuildResult", "assertPolicyApplied",
    "params", "hookContext", "promptState", "historyState", "prependCurrentInboundContext",
    `${source.slice(start, end)}\nreturn buildPromptFromCurrentInputs;`);
  const build = (result) => factory(async () => result, assertPolicyApplied,
    { config: full, hostCapabilities: { assertActive() {} } }, task,
    { promptText: "bounded current request" }, { messages: [] }, text => text);
  await assert.rejects(build({ developerInstructions: "framework fallback after hook error" }),
    { code: "SHADOW_POLICY_NOT_APPLIED" });
  assert.equal((await build({ developerInstructions: buildPolicyPrompt(config, task) })()).developerInstructions,
    buildPolicyPrompt(config, task));
});
