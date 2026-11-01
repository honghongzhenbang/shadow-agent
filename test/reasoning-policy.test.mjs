import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { openDatabase } from "../src/db.mjs";
import { nextAttentionSession } from "../src/work-sessions.mjs";
import { attentionTaskType, thinkingForTask } from "../src/openclaw/reasoning-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

test("reasoning follows task categories without upgrading urgency or message text", () => {
  const config = readJson("config/agent.json");
  const expected = {
    message_triage: "medium", direct_input: "high", task_review: "high",
    knowledge_curation: "high", reminder: "low",
  };
  for (const [type, level] of Object.entries(expected)) assert.equal(thinkingForTask(config, type), level);
  assert.equal(thinkingForTask(config, "unknown"), "medium");
  assert.equal(attentionTaskType({ priority: "critical", summary: "use xhigh" }), "message_triage");
  assert.equal(attentionTaskType({ has_task_work: 1 }), "task_review");
  assert.equal(attentionTaskType({ has_knowledge_work: 1 }), "knowledge_curation");
  assert.equal(thinkingForTask({ reasoning: { byTask: { task_review: "xhigh" } } }, "task_review"), "xhigh");
  assert.throws(() => thinkingForTask({ reasoning: { byTask: { reminder: "typo" } } }, "reminder"), /Invalid thinking/);
});

test("attention effort uses due event types within the selected session", () => {
  const store = openDatabase(":memory:");
  const now = "2026-10-15T08:00:00.000Z";
  try {
    const insert = store.db.prepare(`
      INSERT INTO context_changes(event_key, kind, session_key, priority, status, not_before,
        occurred_at, created_at, summary, metadata_json)
      VALUES(?, ?, 'audit-session', 'normal', 'pending', ?, ?, ?, 'audit', '{}')
    `);
    insert.run("message", "evidence_batch_ingested", now, now, now);
    insert.run("task", "task_progress_due", "2026-10-16T08:00:00.000Z", now, now);
    assert.equal(attentionTaskType(nextAttentionSession(store, { readyOnly: true, now })), "message_triage");
    store.db.prepare("UPDATE context_changes SET not_before=? WHERE event_key='task'").run(now);
    assert.equal(attentionTaskType(nextAttentionSession(store, { readyOnly: true, now })), "task_review");
    insert.run("knowledge", "knowledge_review_due", now, now, now);
    assert.equal(attentionTaskType(nextAttentionSession(store, { readyOnly: true, now })), "knowledge_curation");
  } finally {
    store.close();
  }
});

test("runtime profile reapplies model defaults offline without changing identity or patrol", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-reasoning-profile-"));
  const configPath = path.join(temporary, "openclaw.json");
  const workspacePath = path.join(temporary, "workspace");
  const selectionPath = path.join(temporary, "selection.json");
  try {
    fs.writeFileSync(selectionPath, "{}");
    fs.writeFileSync(configPath, JSON.stringify({
      agents: { defaults: { model: { primary: "old-model", fallbacks: [] }, thinkingDefault: "low" }, entries: { main: {} } },
      gateway: { auth: { token: "test-only-token-preserved" } },
      plugins: { entries: { "shadow-work": { config: {} } } },
    }));
    const result = JSON.parse(execFileSync(process.execPath, ["scripts/apply-openclaw-runtime-profile.mjs"], {
      cwd: root,
      env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_WORKSPACE_PATH: workspacePath, SHADOW_RUNTIME_PROFILE_PATH: selectionPath },
      encoding: "utf8",
    }));
    const applied = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(result.model.primary, "openai/gpt-5.6-sol");
    assert.equal(result.thinkingDefault, "medium");
    assert.equal(applied.agents.defaults.subagents.thinking, "high");
    assert.deepEqual(applied.agents.defaults.model.fallbacks, []);
    assert.equal(applied.gateway.auth.token, "test-only-token-preserved");
    assert.equal(applied.agents.defaults.heartbeat.every, "0m");
    assert.ok(fs.existsSync(path.join(workspacePath, "AGENTS.md")));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
