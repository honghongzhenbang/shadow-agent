import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/db.mjs";
import { emitContextChange } from "../src/context-graph.mjs";
import { taskConversationPage } from "../src/pet-conversations.mjs";
import { reviewMetadata } from "./task-progress-fixture.mjs";

const sdk = "data:text/javascript,export function defineToolPlugin(value){return Object.assign(value,{register(){}})}";
const core = "data:text/javascript,export async function delegateCompactionToRuntime(){throw new Error('No runtime in N1 tests')}";
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "openclaw/plugin-sdk/tool-plugin") return { url: sdk, shortCircuit: true };
  if (specifier === "openclaw/plugin-sdk/core") return { url: core, shortCircuit: true };
  return nextResolve(specifier, context);
} });
let recordTaskCheckpoint, acknowledgeChanges;
try { ({ recordTaskCheckpoint, acknowledgeChanges } = await import("../openclaw/shadow-work/src/index.js")); }
finally { hook.deregister(); }

test("actual checkpoint writer and acknowledgement feed N1 without a new state protocol", () => {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "n1-writer-"));
  const config = { databasePath: path.join(root, "context.sqlite"), workboardDatabasePath: path.join(root, "workboard.sqlite") };
  const store = openDatabase(config.databasePath);
  const workboard = new DatabaseSync(config.workboardDatabasePath);
  try {
    workboard.exec(`CREATE TABLE workboard_cards(id TEXT PRIMARY KEY, title TEXT, status TEXT, archived_at INTEGER,
      execution_status TEXT, execution_session_key TEXT, execution_run_id TEXT, automation_json TEXT);
      INSERT INTO workboard_cards VALUES('writer', 'Writer fixture', 'todo', NULL, NULL, NULL, NULL, '{}');`);
    const graphBefore = store.db.prepare("SELECT COUNT(*) AS n FROM graph_facts").get().n;
    const evidenceBefore = store.db.prepare("SELECT COUNT(*) AS n FROM evidence").get().n;
    const sequences = [];
    for (let index = 0; index < 11; index++) {
      const row = emitContextChange(store.db, { eventKey: `writer-review:${index}`, kind: "task_progress_due",
        sessionKey: "task:writer", summary: `Review ${index}`, metadata: { taskId: "writer", trigger: "bounded_progress_audit" } });
      store.db.prepare("UPDATE context_changes SET status='leased',lease_owner='n1-writer' WHERE seq=?").run(row.seq);
      const { revision, updatedAt, ...plan } = reviewMetadata("writer", index).taskCheckpoint.progressPlan;
      const checkpoint = recordTaskCheckpoint(store.db, config, { taskId: "writer", changeSeq: row.seq,
        leaseOwner: "n1-writer", expectedCheckpointRevision: index, expectedBindingRevision: 1,
        expectedExecution: { runId: null, sessionKey: null },
        resultState: index === 10 ? "progressed" : "unchanged", resultSummary: `Different recorded wording ${index}`,
        ...(index === 0 ? { progressPlan: { expectedRevision: 0, ...plan } } : {}),
        continuation: { kind: "internal_review", summary: "Read the same build receipt",
          nextReviewAt: new Date(Date.now() + 3600_000 + index * 60_000).toISOString() } });
      assert.equal(checkpoint.applied, true);
      assert.equal(Object.hasOwn(checkpoint, "presentationState"), false);
      acknowledgeChanges(store.db, { sequences: [row.seq], leaseOwner: "n1-writer", disposition: "processed" }, config);
      sequences.push(row.seq);
    }
    const page = taskConversationPage(store, { id: "writer" });
    assert.equal(page.messages.length, 2);
    assert.equal(page.messages[0].aggregation.count, 10);
    assert.deepEqual(page.messages[0].aggregation.sequences, sequences.slice(0, 10));
    assert.equal(page.messages[1].text, "Different recorded wording 10");
    assert.equal(taskConversationPage(store, { id: "writer" }, { view: "audit", sequences }).audit.length, 11);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM graph_facts").get().n, graphBefore);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM evidence").get().n, evidenceBefore);
  } finally {
    workboard.close(); store.close();
    assert.equal(path.dirname(fs.realpathSync(root)), parent);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
