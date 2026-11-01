import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { assessFactEvidence, assertGraphFact, upsertGraphEntity } from "../../../src/graph-model.mjs";
import { emitContextChange } from "../../../src/context-graph.mjs";
import { captureKnowledge, completeKnowledgeAnnotation, leaseKnowledgeEnrichment } from "./epistemic.js";
import { resolveCognitiveRoute } from "./routing.js";
import { openV4TestDatabase } from "./test-fixture.mjs";
import { resolveTaskOwnerSession } from "../../../src/agent-operations.mjs";
import { DatabaseWorkerClient } from "./database-worker-client.js";
import { CHECKPOINT_RUNTIME_CONTEXT } from "./task-checkpoint-guard.mjs";
import { createTaskAccessHook } from "../../shadow-policy/task-access.mjs";
import { routePendingContextChanges } from "../../../src/work-sessions.mjs";
import { confirmUserBasics, previewUserBasics } from "../../../src/user-profile.mjs";

const pluginSdkUrl = "data:text/javascript,export function defineToolPlugin(value){return Object.assign(value,{register(api){for(const item of value.tools((definition)=>definition)){api.registerTool(item)}}})}";
const pluginCoreUrl = "data:text/javascript,export async function delegateCompactionToRuntime(params){return {ok:true,compacted:false,reason:'test-runtime-delegate',params}}";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "openclaw/plugin-sdk/tool-plugin") return { url: pluginSdkUrl, shortCircuit: true };
    if (specifier === "openclaw/plugin-sdk/core") return { url: pluginCoreUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const {
  acknowledgeChanges,
  attentionPacket,
  conversationWindow,
  contextStatus,
  default: plugin,
  primaryEvidenceSearch,
  queryContext,
  recordTaskCheckpoint,
  updateWorkFocus,
  workFocus,
} = await import("./index.js");

function removeDatabase(databasePath) {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${databasePath}${suffix}`, { force: true });
}

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function checkpointVersionInput(expectedCheckpointRevision = 0) {
  return { expectedCheckpointRevision, expectedBindingRevision: 1, expectedExecution: { runId: null, sessionKey: null } };
}

test("curator completes the registered knowledge tool chain and ACKs only its own leased batch", async (t) => {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, "shadow-curator-ack-")));
  const config = { databasePath: path.join(root, "context.sqlite"), reuseConnections: false,
    workboardDatabasePath: path.join(root, "absent-workboard.sqlite") };
  const store = openV4TestDatabase(config.databasePath);
  t.after(() => {
    store.close();
    assert.equal(path.dirname(fs.realpathSync(root)), tempRoot);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const captured = captureKnowledge(store.db, {
    sourceType: "dialogue", title: "Fixture one-time observation",
    content: "The isolated demonstration ended. This is a one-time observation, not a lasting responsibility.",
    summary: "The demonstration ended; retain its evidence without inventing durable knowledge.",
    keywords: ["fixture", "demonstration", "completion"],
    retrievalCues: ["When did the demonstration end?", "What was observed?"],
  });
  routePendingContextChanges(store);
  store.db.prepare("UPDATE context_changes SET not_before=? WHERE evidence_id=?")
    .run("2020-01-01T00:00:00.000Z", captured.evidenceId);
  const change = store.db.prepare("SELECT * FROM context_changes WHERE evidence_id=?").get(captured.evidenceId);
  const ctx = { sessionKey: change.session_key };
  const leaseOwner = "isolated-curator-lease";

  const moduleUrl = new URL("./index.js?curator-ack-sdk", import.meta.url).href;
  const sdkUrl = new URL("../../../tools/openclaw-runtime/node_modules/openclaw/dist/plugin-sdk/tool-plugin.js", import.meta.url).href;
  const sdkHook = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL === moduleUrl && specifier === "openclaw/plugin-sdk/tool-plugin") {
      return { url: sdkUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  } });
  let runtimeModule;
  try { runtimeModule = await import(moduleUrl); }
  finally { sdkHook.deregister(); }
  const tools = new Map();
  runtimeModule.registerShadowTools({ pluginConfig: config, registerTool: tool => tools.set(tool.name, tool) });
  const guard = createTaskAccessHook(config);
  const call = async (toolName, params) => {
    const access = guard({ toolName, params }, ctx);
    assert.equal(access?.block, undefined, access?.blockReason);
    const result = await tools.get(toolName).execute("curator-chain", params);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content.find(item => item.type === "text").text);
  };
  const packet = await call("shadow_attention_packet", { sessionKey: ctx.sessionKey, leaseOwner, limit: 1, maxBytes: 8192 });
  assert.equal(packet.changes[0].seq, change.seq);
  const enrichment = await call("shadow_context_enrichment", { evidenceIds: [captured.evidenceId], leaseOwner });
  assert.equal(enrichment.episodes[0].evidence_id, captured.evidenceId);
  await call("shadow_context_annotate", {
    evidenceId: captured.evidenceId, leaseOwner,
    summary: "The isolated demonstration ended; this observation does not establish a durable fact.",
    keywords: ["fixture", "demonstration", "completion"],
    retrievalCues: ["When did the demonstration end?", "What was observed?"],
    graphReview: { status: "completed", outcome: "no_durable_facts", rationale: "One-time observation only." },
  });
  const ack = { sequences: [change.seq], leaseOwner, disposition: "processed", note: "Knowledge review completed." };
  assert.equal(guard({ toolName: "shadow_context_ack", params: { ...ack, leaseOwner: "wrong" } }, ctx).block, true);
  assert.equal(guard({ toolName: "shadow_context_ack", params: ack }, { sessionKey: "agent:main:shadow:workstream:other" }).block, true);
  for (const toolName of ["workboard_update", "workboard_create", "shadow_task_checkpoint"]) {
    assert.equal(guard({ toolName, params: { taskId: "unrelated" } }, ctx).block, true);
  }
  assert.equal((await call("shadow_context_ack", ack)).updated, 1);
  assert.equal(store.db.prepare("SELECT status FROM context_changes WHERE seq=?").get(change.seq).status, "acknowledged");
  assert.equal(guard({ toolName: "shadow_context_ack", params: ack }, ctx).block, true);
  assert.equal(fs.existsSync(config.workboardDatabasePath), false);
});

test("real SDK checkpoint factory authenticates runtime identity across the worker boundary", async (t) => {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, "shadow-runtime-identity-")));
  const config = { databasePath: path.join(root, "shadow.sqlite"),
    workboardDatabasePath: path.join(root, "workboard.sqlite"), reuseConnections: false };
  const store = openV4TestDatabase(config.databasePath);
  const board = new DatabaseSync(config.workboardDatabasePath);
  t.after(() => {
    board.close();
    store.close();
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), tempRoot);
    assert.ok(path.basename(resolved).startsWith("shadow-runtime-identity-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  board.exec(`CREATE TABLE workboard_cards(id TEXT PRIMARY KEY, title TEXT, status TEXT, archived_at INTEGER,
    execution_status TEXT, execution_session_key TEXT, execution_run_id TEXT, automation_json TEXT);
    INSERT INTO workboard_cards VALUES('task-a','Task A','running',NULL,NULL,NULL,NULL,'{}');
    INSERT INTO workboard_cards VALUES('task-b','Task B','running',NULL,NULL,NULL,NULL,'{}');`);
  const ownerA = resolveTaskOwnerSession(store, { id: "task-a", title: "Task A" }).sessionKey;
  const ownerB = resolveTaskOwnerSession(store, { id: "task-b", title: "Task B" }).sessionKey;
  const source = store.upsertSource({ sourceKey: "runtime-identity", kind: "test", uri: "test://runtime-identity" });
  const evidence = store.addEvidence({ sourceId: source.id, kind: "project_document", title: "Observed output",
    content: "Local isolated evidence.", sourceLocator: "test://runtime-identity/result" });

  // Use the installed SDK's native registration/result wrapping, not the suite's metadata-only stub.
  const moduleUrl = new URL("./index.js?trusted-checkpoint-runtime", import.meta.url).href;
  const sdkUrl = new URL("../../../tools/openclaw-runtime/node_modules/openclaw/dist/plugin-sdk/tool-plugin.js", import.meta.url).href;
  const sdkHook = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL === moduleUrl && specifier === "openclaw/plugin-sdk/tool-plugin") {
      return { url: sdkUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  } });
  let runtimeModule;
  try { runtimeModule = await import(moduleUrl); }
  finally { sdkHook.deregister(); }
  const workerTools = new Map();
  runtimeModule.registerShadowTools({ pluginConfig: config, registerTool: tool => workerTools.set(tool.name, tool) });
  const registrations = new Map();
  runtimeModule.default.register({
    pluginConfig: config,
    registerTool: (definition, options) => registrations.set(options?.name ?? definition.name, { definition, options }),
    registerContextEngine: () => {},
  });
  const registration = registrations.get("shadow_task_checkpoint");
  assert.equal(typeof registration.definition, "function");
  assert.equal(registration.options.name, "shadow_task_checkpoint");
  assert.equal(typeof registrations.get("shadow_context_focus").definition, "object");
  const factory = registration.definition;
  let dispatched = 0;
  let beforeExecute = () => {};
  t.mock.method(DatabaseWorkerClient.prototype, "call", async (operation, params) => {
    dispatched += 1;
    const messageParams = structuredClone(params);
    beforeExecute();
    return workerTools.get(operation).execute("isolated-worker-call", messageParams);
  });
  const request = (taskId, overrides = {}) => {
    const focus = workFocus(store.db, config, { taskId });
    return { taskId, expectedCheckpointRevision: focus.checkpointRevision, expectedBindingRevision: focus.bindingRevision,
      expectedExecution: focus.execution, resultState: "progressed", resultSummary: "Checked isolated execution evidence.",
      evidenceIds: [evidence.id],
      learning: { durableCandidates: ["The isolated output is repeatable."],
        keywords: ["isolated", "output", "scope"], retrievalCues: ["What was observed?", "What remains unverified?"] },
      continuation: { kind: "internal_review", summary: "Review the remaining isolated evidence.",
        nextReviewAt: new Date(Date.now() + 3600000).toISOString() },
      ...overrides };
  };
  const snapshot = () => Object.fromEntries(["work_task_attention", "evidence", "evidence_links", "context_changes",
    "controller_outbox", "settings"].map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const invoke = (context, input) => factory(context).execute("runtime-call", input);
  const cases = [
    ["spoofed owner argument", { sessionKey: ownerA }, request("task-b", { ownerSessionKey: ownerB })],
    ["spoofed top-level session argument", { sessionKey: ownerA }, request("task-a", { sessionKey: ownerB })],
    ["spoofed private envelope", { sessionKey: ownerA }, request("task-b", { [CHECKPOINT_RUNTIME_CONTEXT]: { sessionKey: ownerB } })],
    ["missing runtime ctx with claimed identity", {}, request("task-a", { ownerSessionKey: ownerA,
      [CHECKPOINT_RUNTIME_CONTEXT]: { sessionKey: ownerA } })],
    ["child without a task binding", { sessionKey: "agent:main:subagent:isolated-child" }, request("task-a")],
  ];
  for (const [name, context, input] of cases) {
    await t.test(name, async () => {
      const before = snapshot();
      await assert.rejects(invoke(context, input), { code: "SHADOW_CHECKPOINT_IDENTITY_MISMATCH" });
      assert.deepEqual(snapshot(), before);
    });
  }
  assert.equal(dispatched, 2);

  let inputA;
  await t.test("owner comes from captured ctx; model envelope cannot replace it", async () => {
    const context = { sessionKey: ownerA };
    const tool = factory(context);
    context.sessionKey = ownerB;
    assert.equal(Object.hasOwn(tool.parameters.properties, CHECKPOINT_RUNTIME_CONTEXT), false);
    const focus = (await registrations.get("shadow_context_focus").definition.execute("focus-read", { taskId: "task-a" })).details;
    assert.equal(focus.checkpointRevision, 0);
    assert.equal(focus.bindingRevision, 1);
    assert.equal(focus.ownerSessionKey, ownerA);
    assert.deepEqual(focus.execution, { runId: null, sessionKey: null });
    inputA = request("task-a", { idempotencyKey: "runtime-owned-checkpoint",
      [CHECKPOINT_RUNTIME_CONTEXT]: { sessionKey: ownerB } });
    const result = (await tool.execute("runtime-call", inputA)).details;
    assert.equal(result.applied, true);
    assert.equal(result.ownerSessionKey, ownerA);
    assert.equal(result.learning.inserted, true);
    const before = snapshot();
    assert.equal((await invoke({ sessionKey: ownerA }, inputA)).details.replayed, true);
    assert.deepEqual(snapshot(), before);
    await assert.rejects(invoke({ sessionKey: ownerB }, inputA), { code: "SHADOW_CHECKPOINT_IDENTITY_MISMATCH" });
    assert.deepEqual(snapshot(), before);
  });

  await t.test("worker rechecks ownership and active binding after dispatch", async () => {
    let expected;
    beforeExecute = () => {
      store.db.prepare("UPDATE work_task_attention SET owner_session_key=? WHERE card_id='task-a'").run(ownerB);
      expected = snapshot();
    };
    await assert.rejects(invoke({ sessionKey: ownerA }, request("task-a")), /not the current task owner/);
    assert.deepEqual(snapshot(), expected);
    store.db.prepare("UPDATE work_task_attention SET owner_session_key=? WHERE card_id='task-a'").run(ownerA);
    beforeExecute = () => {
      store.db.prepare("UPDATE conversation_bindings SET status='retired' WHERE session_key=?").run(ownerA);
      expected = snapshot();
    };
    await assert.rejects(invoke({ sessionKey: ownerA }, request("task-a")), /not actively bound/);
    assert.deepEqual(snapshot(), expected);
    store.db.prepare("UPDATE conversation_bindings SET status='active' WHERE session_key=?").run(ownerA);
    beforeExecute = () => {};
  });

  await t.test("leased change session cannot be borrowed from another task", async () => {
    emitContextChange(store.db, { eventKey: "borrowed-runtime-change", kind: "task_progress_due",
      sessionKey: ownerB, summary: "Other session's leased event.", metadata: { taskId: "task-a" } });
    const seq = store.db.prepare("SELECT seq FROM context_changes WHERE event_key='borrowed-runtime-change'").get().seq;
    store.db.prepare("UPDATE context_changes SET status='leased', lease_owner='runtime-test' WHERE seq=?").run(seq);
    const before = snapshot();
    await assert.rejects(invoke({ sessionKey: ownerA }, request("task-a", {
      changeSeq: seq, leaseOwner: "runtime-test",
    })), /Leased change does not belong/);
    assert.deepEqual(snapshot(), before);
  });

  await t.test("terminal cleanup and evidence-only paths still require the real task owner", async () => {
    await invoke({ sessionKey: ownerB }, request("task-b", { continuation: {
      kind: "codex_run", referenceId: "child-run-b", sessionKey: "agent:main:subagent:child-b",
      model: "fixture/model", summary: "Observe the owned child execution.",
    } }));
    board.prepare("UPDATE workboard_cards SET status='done' WHERE id='task-b'").run();
    const before = snapshot();
    await assert.rejects(invoke({ sessionKey: ownerA }, request("task-b", {
      expectedCheckpointRevision: undefined,
    })), { code: "SHADOW_CHECKPOINT_IDENTITY_MISMATCH" });
    assert.deepEqual(snapshot(), before);
    const closed = (await invoke({ sessionKey: ownerB }, request("task-b", {
      resultSummary: "Late evidence after the human completed the task.",
    }))).details;
    assert.equal(closed.terminal, true);
    assert.equal(closed.learning.inserted, true);
    assert.equal(closed.continuation, null);
  });
});

test("task plan, checkpoint and reusable learning commit atomically and survive reopen", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-task-plan-"));
  const databasePath = path.join(root, "shadow.sqlite");
  const workboardPath = path.join(root, "workboard.sqlite");
  let store = openV4TestDatabase(databasePath);
  const board = new DatabaseSync(workboardPath);
  const config = { databasePath, workboardDatabasePath: workboardPath };
  try {
    board.exec(`CREATE TABLE workboard_cards(id TEXT PRIMARY KEY, title TEXT, status TEXT, archived_at INTEGER,
      execution_status TEXT, execution_session_key TEXT, execution_run_id TEXT, automation_json TEXT);
      INSERT INTO workboard_cards VALUES('research','Improve a proven workflow','running',NULL,NULL,NULL,NULL,'{}');`);
    const source = store.upsertSource({ sourceKey: "experiment", kind: "test", uri: "test://experiment" });
    const evidence = store.addEvidence({ sourceId: source.id, kind: "project_document", title: "Observed result", content: "Experiment passed", sourceLocator: "test://experiment/result" });
    const plan = { expectedRevision: 0, outcome: "Improve this workflow", successCriteria: "Repeatable local result",
      authorizedScope: "Local tests only", approach: "Compare the measured alternatives", nextAction: "Test the remaining assumption",
      stopCondition: "Stop on accepted evidence", whyNow: "Removes a recurring manual step" };
    const input = { ...checkpointVersionInput(), taskId: "research", resultState: "progressed", resultSummary: "Observed a repeatable improvement",
      evidenceIds: [evidence.id], progressPlan: plan, learning: { durableCandidates: ["The measured workflow reduced manual checks"],
        keywords: ["workflow", "manual checks", "experiment"], retrievalCues: ["How to reduce checks", "What did the experiment prove"] },
      continuation: { kind: "internal_review", summary: "Review the next measurement", nextReviewAt: new Date(Date.now() + 3600000).toISOString() } };
    const first = recordTaskCheckpoint(store.db, config, input);
    assert.equal(first.progressPlan.revision, 1);
    assert.equal(first.learning.inserted, true);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM graph_facts").get().n, 0);
    const retry = recordTaskCheckpoint(store.db, config, { ...input, progressPlan: undefined });
    assert.equal(retry.learning.evidenceId, first.learning.evidenceId);
    assert.equal(retry.learning.inserted, false);
    assert.equal(recordTaskCheckpoint(store.db, config, input).replayed, true);
    const before = store.db.prepare("SELECT COUNT(*) AS n FROM evidence").get().n;
    store.db.exec("CREATE TRIGGER reject_test_checkpoint BEFORE UPDATE ON work_task_attention BEGIN SELECT RAISE(ABORT,'test-storage-failure'); END");
    assert.throws(() => recordTaskCheckpoint(store.db, config, { ...input, ...checkpointVersionInput(1), progressPlan: { ...plan, expectedRevision: 1 }, resultSummary: "A distinct result must roll back with its checkpoint" }), /test-storage-failure/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM evidence").get().n, before);
    store.db.exec("DROP TRIGGER reject_test_checkpoint");
    assert.throws(() => recordTaskCheckpoint(store.db, config, { ...input, progressPlan: undefined, evidenceIds: [] }), /primary source evidence/);
    store.close(); store = openV4TestDatabase(databasePath);
    const focus = workFocus(store.db, config, { taskId: "research" });
    assert.equal(focus.progressPlan.revision, 1);
    assert.equal(focus.checkpointRevision, 1);
    assert.equal(focus.bindingRevision, 1);
    assert.deepEqual(focus.execution, { runId: null, sessionKey: null });
    assert.equal(focus.progressPlan.nextAction, plan.nextAction);
    assert.equal(focus.status, "running");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM context_changes WHERE kind='knowledge_delta_due'").get().n, 1);
    store.db.prepare("INSERT INTO work_task_attention(card_id,progress_plan_json,updated_by,updated_at) VALUES('unrelated',?,'test',?)")
      .run(JSON.stringify({ ...first.progressPlan, outcome: "UNRELATED_PLAN_DO_NOT_INJECT" }), new Date().toISOString());
    emitContextChange(store.db, { eventKey: "plan-resume", kind: "task_progress_due", sessionKey: "agent:main:plan-test",
      summary: "Resume existing plan", metadata: { taskId: "research" } });
    const packet = attentionPacket(store.db, { ...config, workboardDatabasePath: path.join(root, "absent.sqlite") },
      { sessionKey: "agent:main:plan-test", leaseOwner: "plan-test", maxBytes: 8192 });
    assert.equal(packet.changes[0].taskProgress.plan.revision, 1);
    assert.equal(packet.changes[0].taskProgress.plan.approach, undefined);
    assert.ok(serializedBytes(packet) <= 8192);
    assert.equal(JSON.stringify(packet).includes("UNRELATED_PLAN_DO_NOT_INJECT"), false);
  } finally { board.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

function seedBoundedQueryFixture(store) {
  const keyKnowledge = captureKnowledge(store.db, {
    sourceType: "dialogue",
    title: "通信协议工作的稳定归类规则",
    content: `用户确认通信协议重构属于激光跟踪软件。${"这是直接确认的长期规则。".repeat(400)}`,
    summary: `关键知识：通信协议重构归入激光跟踪软件。${"用于日报和任务分类。".repeat(400)}`,
    keywords: ["通信协议重构", "激光跟踪软件", "工作归类"],
    retrievalCues: ["通信协议重构属于哪个项目", "如何归类机器人通信工作"],
    scope: { domain: "work-classification", language: "zh-CN" },
    salience: 1,
    generatedBy: "query-test",
  });

  const distractorEvidenceIds = [];
  for (let index = 0; index < 10; index += 1) {
    const capture = captureKnowledge(store.db, {
      sourceType: "note",
      title: `通信协议重构背景材料 ${index}`,
      content: `通信协议重构背景材料 ${index}。${"低优先级重复背景。".repeat(500)}`,
      summary: `背景卡 ${index}：通信协议重构的低优先级补充。${"非关键背景。".repeat(500)}`,
      keywords: ["通信协议重构", "背景材料", `样本${index}`],
      retrievalCues: ["通信协议重构有哪些背景", `背景样本 ${index} 是什么`],
      salience: 0.1,
      generatedBy: "query-test",
    });
    distractorEvidenceIds.push(capture.evidenceId);
  }

  const software = upsertGraphEntity(store.db, {
    canonicalKey: "software:examplevision",
    type: "SoftwareProduct",
    name: "激光跟踪软件",
    summary: `负责激光跟踪、机器人通信和焊缝处理。${"实体补充说明。".repeat(300)}`,
    aliases: ["ExampleVision", "通信协议重构"],
  });
  const responsibility = upsertGraphEntity(store.db, {
    canonicalKey: "responsibility:robot-communication",
    type: "Responsibility",
    name: "机器人通信职责",
    summary: "包含 TCP 报文、心跳、握手和机器人接入。",
  });
  const fact = assertGraphFact(store.db, {
    subject: software.id,
    predicate: "HAS_RESPONSIBILITY",
    objectEntity: responsibility.id,
    confidence: 0.98,
    createdBy: "query-test",
  });
  assessFactEvidence(store.db, {
    factId: fact.id,
    evidenceId: keyKnowledge.evidenceId,
    stance: "supports",
    basis: "user_statement",
    directness: "direct",
    method: "document_record",
    environment: "local",
    outcome: "observed",
    confidence: 0.95,
    assessedBy: "query-test",
  });
  leaseKnowledgeEnrichment(store.db, { limit: 1, leaseOwner: "query-test" });
  completeKnowledgeAnnotation(store.db, {
    evidenceId: keyKnowledge.evidenceId,
    leaseOwner: "query-test",
    generatedBy: "query-test",
    title: "通信协议工作的稳定归类规则",
    summary: "关键知识：通信协议重构归入激光跟踪软件，用于日报和任务分类。",
    keywords: ["通信协议重构", "激光跟踪软件", "工作归类"],
    retrievalCues: ["通信协议重构属于哪个项目", "如何归类机器人通信工作"],
    graphReview: {
      status: "completed",
      outcome: "facts_recorded",
      rationale: "已建立并评价激光跟踪软件的机器人通信职责事实。",
      factIds: [fact.id],
    },
  });
  const link = store.db.prepare(`
    INSERT OR IGNORE INTO graph_entity_evidence(entity_id, evidence_id, relation, observed_at)
    VALUES(?, ?, 'supported_by', ?)
  `);
  link.run(software.id, keyKnowledge.evidenceId, new Date().toISOString());
  link.run(responsibility.id, keyKnowledge.evidenceId, new Date().toISOString());

  const source = store.upsertSource({
    sourceKey: "query-test-documents",
    kind: "test",
    uri: "test://query-documents",
  });
  for (let index = 0; index < 12; index += 1) {
    const evidence = store.addEvidence({
      sourceId: source.id,
      kind: "project_document",
      title: `通信协议重构原始记录 ${index}`,
      content: `记录 ${index}：通信协议重构的原始细节。${"这是一段很长的原始材料。".repeat(600)}`,
      sourceLocator: `test://query-documents/${index}`,
      externalId: `raw-${index}`,
    });
    link.run(software.id, evidence.id, new Date().toISOString());
  }
  return { distractorEvidenceIds, factId: fact.id, keyEvidenceId: keyKnowledge.evidenceId, softwareId: software.id };
}

test("Shadow Context plugin exposes the current cognitive routing contract", async () => {
  const manifest = await import("../openclaw.plugin.json", { with: { type: "json" } });
  assert.deepEqual(manifest.default.contracts.trustedToolPolicies, []);
  // The manifest declares a tool set; display order is not an access contract.
  assert.deepEqual([...manifest.default.contracts.tools].sort(), [
    "shadow_attention_packet",
    "shadow_conversation_window",
    "shadow_context_status",
    "shadow_context_focus",
    "shadow_context_focus_update",
    "shadow_context_changes",
    "shadow_information_dispatch",
    "shadow_task_checkpoint",
    "shadow_context_ack",
    "shadow_context_resolve",
    "shadow_context_query",
    "shadow_evidence_search",
    "shadow_context_entity",
    "shadow_context_impact",
    "shadow_context_capture",
    "shadow_knowledge_delta_capture",
    "shadow_context_revise",
    "shadow_context_enrichment",
    "shadow_context_annotate",
    "shadow_context_vocabulary",
    "shadow_context_propose",
    "shadow_outbound_draft_create",
    "shadow_outbound_draft_list",
    "shadow_reminder_create",
    "shadow_reminder_list",
    "shadow_reminder_update",
    "shadow_reminder_cancel",
    "shadow_condition_watch",
    "shadow_condition_list",
    "shadow_condition_resolve",
  ].sort());
  assert.equal(manifest.default.configSchema.properties.reuseConnections.default, true);

  const tools = Object.fromEntries(plugin.tools((definition) => definition).map((definition) => [definition.name, definition]));
  for (const toolName of ["shadow_context_capture", "shadow_knowledge_delta_capture"]) {
    const scope = tools[toolName].parameters.properties.scope;
    assert.equal(scope.additionalProperties, false);
    assert.ok(scope.properties.repository);
    assert.ok(scope.properties.topic);
    assert.ok(scope.properties.projectKey);
  }
});

test("primary evidence search is source-bounded, filterable, and byte-bounded", () => {
  const databasePath = path.join(os.tmpdir(), `shadow-primary-evidence-${process.pid}-${Date.now()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  try {
    const source = store.upsertSource({ sourceKey: "primary-search", kind: "feishu", uri: "feishu://primary-search" });
    const primary = store.addEvidence({
      sourceId: source.id,
      kind: "feishu_message",
      occurredAt: "2026-08-20T10:46:00.000Z",
      title: "华沿适配沟通",
      content: `${"无关前缀。".repeat(500)}示例人员18发送华沿功能适配与测试报告。${"直接消息内容。".repeat(500)}`,
      sourceLocator: "feishu://message/primary",
      externalId: "primary",
      metadata: { conversationKey: "im:huayan", senderName: "示例人员18", sentBySelf: false },
    });
    store.addEvidence({
      sourceId: source.id,
      kind: "codex_thread_digest",
      occurredAt: "2026-08-21T00:00:00.000Z",
      title: "生成摘要",
      content: "示例人员19负责华沿功能适配与测试报告。",
      sourceLocator: "shadow-agent://digest/noise",
      externalId: "noise",
    });

    const result = primaryEvidenceSearch(store.db, {
      query: "整理 华沿 适配 能力 测试 报告",
      conversationKey: "im:huayan",
      limit: 5,
      maxBytes: 4096,
    });
    assert.deepEqual(result.matches.map((item) => item.evidenceId), [primary.id]);
    assert.equal(result.matches[0].senderName, "示例人员18");
    assert.match(result.matches[0].content, /示例人员18发送华沿功能适配与测试报告/);
    assert.equal(result.matches[0].source.provider, "feishu");
    assert.equal(result.matches[0].source.sourceFamily, "collaboration");
    assert.equal(result.matches[0].source.eventKind, "message");
    assert.equal(result.matches[0].source.streamId, "im:huayan");
    assert.equal(result.matches.some((item) => item.kind === "codex_thread_digest"), false);
    assert.ok(serializedBytes(result) <= result.maxBytes);

    const byId = primaryEvidenceSearch(store.db, { evidenceIds: [primary.id], maxBytes: 4096 });
    assert.equal(byId.matches[0].sourceLocator, "feishu://message/primary");
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

test("primary evidence snippets retain separated Unicode matches within the byte budget", () => {
  const databasePath = path.join(os.tmpdir(), `shadow-primary-windows-${process.pid}-${Date.now()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  try {
    const source = store.upsertSource({ sourceKey: "snippet-windows", kind: "test", uri: "test://snippet-windows" });
    for (const [index, padding] of ["context ", "无关背景。", "😀背景🛰️"].entries()) {
      const body = `${padding.repeat(100)}AlphaAnchor ${padding.repeat(150)}BetaAnchor ${padding.repeat(150)}GammaAnchor ${padding.repeat(100)}`;
      const evidence = store.addEvidence({ sourceId: source.id, kind: "feishu_message", title: `window-${index}`,
        content: body, sourceLocator: `test://snippet/${index}`, externalId: `window-${index}`,
        metadata: { conversationKey: `snippet-${index}` } });
      const result = primaryEvidenceSearch(store.db, { query: "AlphaAnchor BetaAnchor GammaAnchor", conversationKey: `snippet-${index}`, maxBytes: 4096 });
      assert.equal(result.matches[0]?.evidenceId, evidence.id);
      const snippet = result.matches[0].content;
      for (const term of ["AlphaAnchor", "BetaAnchor", "GammaAnchor"]) assert.ok(snippet.includes(term), `${index}: missing ${term}`);
      assert.ok(Buffer.byteLength(snippet) <= 1800);
      assert.ok(serializedBytes(result) <= result.maxBytes);
      assert.ok(!snippet.includes("\uFFFD"), "UTF-8 windows must not split a character");
      assert.ok(snippet.isWellFormed());
    }
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

test("primary evidence snippets keep short sources whole and merge overlapping windows", () => {
  const databasePath = path.join(os.tmpdir(), `shadow-primary-overlap-${process.pid}-${Date.now()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  try {
    const source = store.upsertSource({ sourceKey: "snippet-overlap", kind: "test", uri: "test://snippet-overlap" });
    for (const [index, body] of ["前文。AlphaAnchor BetaAnchor GammaAnchor。后文。",
      `AlphaAnchor${"中".repeat(575)}BetaAnchor GammaAnchor`,
      `${"背景。".repeat(600)}AlphaAnchor BetaAnchor GammaAnchor${"后文。".repeat(600)}`].entries()) {
      store.addEvidence({ sourceId: source.id, kind: "feishu_message", title: `overlap-${index}`, content: body,
        sourceLocator: `test://overlap/${index}`, externalId: `overlap-${index}`, metadata: { conversationKey: `overlap-${index}` } });
      const snippet = primaryEvidenceSearch(store.db, { query: "AlphaAnchor BetaAnchor GammaAnchor", conversationKey: `overlap-${index}` }).matches[0].content;
      if (Buffer.byteLength(body) <= 1800) assert.equal(snippet, body);
      for (const term of ["AlphaAnchor", "BetaAnchor", "GammaAnchor"]) assert.equal(snippet.split(term).length - 1, 1);
      assert.ok(Buffer.byteLength(snippet) <= 1800);
    }
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

test("primary title-only and exact reads keep Unicode prefix fallback well formed", () => {
  const databasePath = path.join(os.tmpdir(), `shadow-primary-prefix-${process.pid}-${Date.now()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  try {
    const source = store.upsertSource({ sourceKey: "snippet-prefix", kind: "test", uri: "test://snippet-prefix" });
    for (let index = 0; index < 4; index += 1) {
      const body = `${"x".repeat(index)}${"😀".repeat(600)}`;
      const evidence = store.addEvidence({ sourceId: source.id, kind: "feishu_message", title: `prefixAnchor${index}`, content: body,
        sourceLocator: `test://prefix/${index}`, externalId: `prefix-${index}` });
      for (const lookup of [{ query: `prefixAnchor${index}` }, { evidenceIds: [evidence.id] }]) {
        const snippet = primaryEvidenceSearch(store.db, lookup).matches[0].content;
        assert.ok(snippet.isWellFormed(), `${index}: prefix cannot split a surrogate pair`);
        assert.ok(Buffer.byteLength(snippet) <= 1800);
        assert.ok(body.startsWith(snippet.split("\n...[truncated]")[0]));
      }
    }
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

test("primary snippet reserves complete selected terms before surrounding context", () => {
  const databasePath = path.join(os.tmpdir(), `shadow-primary-long-term-${process.pid}-${Date.now()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  try {
    const source = store.upsertSource({ sourceKey: "snippet-long-term", kind: "test", uri: "test://snippet-long-term" });
    const term = "Q".repeat(400);
    const body = `A${" ".repeat(999)}${term}${" ".repeat(999)}B`;
    store.addEvidence({ sourceId: source.id, kind: "feishu_message", title: "long term", content: body,
      sourceLocator: "test://long-term", externalId: "long-term" });
    const snippet = primaryEvidenceSearch(store.db, { query: `A ${term} B` }).matches[0].content;
    for (const token of ["A", term, "B"]) assert.ok(snippet.includes(token));
    assert.ok(Buffer.byteLength(snippet) <= 1800);
    assert.ok(snippet.startsWith("A") && snippet.endsWith("B"));
    assert.equal(snippet.split("\n--- matched context ---\n").length, 3);
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

test("long evidence is redacted before both matched and exact-read windows", () => {
  const databasePath = path.join(os.tmpdir(), `shadow-primary-window-secret-${process.pid}-${Date.now()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  try {
    const source = store.upsertSource({ sourceKey: "window-secret", kind: "test", uri: "test://window-secret" });
    const secret = "synthetic-token-123456789";
    const body = `${"前文。".repeat(250)}probeAnchor access_token=${secret} ${"后文。".repeat(250)}`;
    const evidence = store.addEvidence({ sourceId: source.id, kind: "feishu_message", title: "secret window", content: body,
      sourceLocator: "test://window-secret", externalId: "window-secret" });
    for (const args of [{ query: "probeAnchor" }, { evidenceIds: [evidence.id] }, { externalId: "window-secret" }]) {
      const result = primaryEvidenceSearch(store.db, args);
      assert.equal(result.matches[0].evidenceId, evidence.id);
      assert.ok(!JSON.stringify(result).includes(secret));
      assert.ok(result.matches[0].content.isWellFormed());
      assert.ok(Buffer.byteLength(result.matches[0].content) <= 1800);
      if (args.query) assert.match(result.matches[0].content, /probeAnchor access_token=\[REDACTED\]/);
    }
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

test("primary evidence search recalls unspaced Chinese and escapes LIKE wildcards", () => {
  const databasePath = path.join(os.tmpdir(), `shadow-primary-cjk-${process.pid}-${Date.now()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  try {
    const source = store.upsertSource({ sourceKey: "primary-cjk", kind: "test", uri: "test://primary-cjk" });
    const target = store.addEvidence({
      sourceId: source.id,
      kind: "feishu_message",
      occurredAt: "2026-08-20T10:46:00.000Z",
      title: "华沿测试进展",
      content: "示例人员18发送《华沿功能适配与测试报告》，等待补充量化指标。",
      sourceLocator: "feishu://message/cjk-target",
      externalId: "cjk-target",
    });
    store.addEvidence({
      sourceId: source.id,
      kind: "feishu_message",
      occurredAt: "2026-08-21T10:46:00.000Z",
      title: "普通测试进展",
      content: "其他人员完成一般能力测试。",
      sourceLocator: "feishu://message/cjk-noise",
      externalId: "cjk-noise",
    });

    const result = primaryEvidenceSearch(store.db, {
      query: "整理华沿适配能力测试报告",
      limit: 5,
      maxBytes: 4096,
    });
    assert.equal(result.matches[0]?.evidenceId, target.id);
    assert.equal(primaryEvidenceSearch(store.db, { query: "%", maxBytes: 4096 }).matches.length, 0);
    assert.equal(primaryEvidenceSearch(store.db, { query: "_", maxBytes: 4096 }).matches.length, 0);
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

test("primary evidence search redacts secrets and covers Codex operational evidence", () => {
  const databasePath = path.join(os.tmpdir(), `shadow-primary-secrets-${process.pid}-${Date.now()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  try {
    const source = store.upsertSource({ sourceKey: "primary-secrets", kind: "test", uri: "test://primary-secrets" });
    const toolCall = store.addEvidence({
      sourceId: source.id,
      kind: "codex_tool_call",
      occurredAt: "2026-08-20T10:46:00.000Z",
      title: "git push with credential",
      content: "git push https://example.invalid/repo?access_token=secret-token-123456",
      sourceLocator: "codex://tool?token=source-secret-123456",
      externalId: "secret-tool-call",
    });
    store.addEvidence({
      sourceId: source.id,
      kind: "codex_session_meta",
      occurredAt: "2026-08-20T10:45:00.000Z",
      title: "session metadata",
      content: "cwd=X:\\ExampleProjects\\sdagent",
      sourceLocator: "codex://session/meta",
      externalId: "session-meta",
    });

    const result = primaryEvidenceSearch(store.db, {
      query: "git push",
      sourceKinds: ["codex_tool_call", "codex_session_meta"],
      maxBytes: 4096,
    });
    assert.equal(result.matches[0]?.evidenceId, toolCall.id);
    assert.match(result.matches[0].content, /\[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(result), /secret-token-123456|source-secret-123456/);
    assert.match(result.guidance, /untrusted data/i);
    assert.equal(primaryEvidenceSearch(store.db, { query: "git push", maxBytes: 4096 }).matches.length, 0);
    const byExternalId = primaryEvidenceSearch(store.db, {
      externalId: "secret-tool-call",
      sourceKinds: ["codex_tool_call"],
      maxBytes: 4096,
    });
    assert.equal(byExternalId.matches[0]?.evidenceId, toolCall.id);
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

for (const kind of ["codex_tool_call", "codex_tool_output", "codex_tool_result", "codex_thread_digest",
  "codex_memory_document", "import_document", "future_custom_kind"]) {
  test(`primary exact identity reads ${kind} without an implicit kind whitelist`, () => {
    const store = openV4TestDatabase(":memory:");
    try {
      const source = store.upsertSource({ sourceKey: "exact-kind", kind: "test", uri: "test://exact-kind" });
      const evidence = store.addEvidence({ sourceId: source.id, kind, title: "identityprobe",
        content: "identityprobe https://example.invalid/?access_token=identity-secret-123456",
        sourceLocator: "test://exact-kind?token=locator-secret-123456", externalId: "exact-kind-record" });
      const changesBefore = store.db.prepare("SELECT total_changes() AS n").get().n;
      for (const identity of [{ evidenceIds: [evidence.id] }, { externalId: "exact-kind-record" }]) {
        const result = primaryEvidenceSearch(store.db, { ...identity, query: "unmatched" });
        assert.deepEqual(result.matches.map(row => row.evidenceId), [evidence.id]);
        assert.equal(result.matches[0].kind, kind);
        assert.equal(result.filters.sourceKinds, null);
        assert.match(result.matches[0].content, /\[REDACTED\]/);
        assert.doesNotMatch(JSON.stringify(result), /identity-secret-123456|locator-secret-123456/);
        assert.match(result.guidance, /untrusted data/);
        assert.ok(serializedBytes(result) <= result.maxBytes);
      }
      const missing = primaryEvidenceSearch(store.db, { evidenceIds: ["a".repeat(32)] });
      assert.deepEqual(missing.matches, []);
      assert.equal(missing.filters.sourceKinds, null);
      for (const query of ["identityprobe", "absentword identityprobe"]) {
        const discovered = primaryEvidenceSearch(store.db, { query });
        assert.deepEqual(discovered.matches, []);
        assert.ok(Array.isArray(discovered.filters.sourceKinds));
        assert.equal(discovered.filters.sourceKinds.includes(kind), false);
      }
      assert.equal(store.db.prepare("SELECT total_changes() AS n").get().n, changesBefore);
    } finally { store.close(); }
  });
}

test("primary exact identity keeps explicit filters and evidenceIds precedence", () => {
  const store = openV4TestDatabase(":memory:");
  try {
    const source = store.upsertSource({ sourceKey: "exact-scope", kind: "codex_rollout", uri: "test://exact-scope" });
    const evidence = store.addEvidence({ sourceId: source.id, kind: "codex_tool_output",
      title: "identityscope", content: "identityscope", externalId: "scope-log", projectKey: "scope-project",
      threadId: "scope-thread", occurredAt: "2026-01-02T00:00:00.000Z", sourceLocator: "test://exact-scope/log",
      metadata: { conversationKey: "scope-conversation" } });
    const other = store.addEvidence({ sourceId: source.id, kind: "codex_user_message",
      title: "other identity", content: "other identity", externalId: "other-record", sourceLocator: "test://exact-scope/other" });
    const scope = { sourceKinds: ["codex_tool_output"], projectKey: "scope-project", threadId: "scope-thread",
      conversationKey: "scope-conversation", providers: ["codex"], sourceFamilies: ["execution"], eventKinds: ["tool_result"],
      after: "2026-01-01T00:00:00.000Z", before: "2026-01-03T00:00:00.000Z" };
    const changesBefore = store.db.prepare("SELECT total_changes() AS n").get().n;
    for (const identity of [{ evidenceIds: [evidence.id] }, { externalId: "scope-log" }]) {
      const matched = primaryEvidenceSearch(store.db, { ...identity, ...scope });
      assert.deepEqual(matched.matches.map(row => row.evidenceId), [evidence.id]);
      assert.deepEqual(matched.filters, scope);
      const { sourceKinds, ...withoutKind } = scope;
      assert.deepEqual(primaryEvidenceSearch(store.db, { ...identity, ...withoutKind }).matches.map(row => row.evidenceId), [evidence.id]);
      for (const wrong of [
        { sourceKinds: ["codex_user_message"] }, { projectKey: "other-project" }, { threadId: "other-thread" },
        { conversationKey: "other-conversation" }, { providers: ["feishu"] }, { sourceFamilies: ["collaboration"] },
        { eventKinds: ["user_intent"] }, { after: "2026-01-03T00:00:00.000Z" }, { before: "2026-01-01T00:00:00.000Z" },
      ]) {
        const result = primaryEvidenceSearch(store.db, { ...identity, ...wrong });
        assert.deepEqual(result.matches, [], JSON.stringify({ identity, wrong }));
        assert.deepEqual(result.filters.sourceKinds, wrong.sourceKinds ?? null);
      }
      assert.throws(() => primaryEvidenceSearch(store.db, { ...identity, sourceKinds: ["future_custom_kind"] }),
        /Unsupported primary evidence kind/);
    }
    for (const evidenceIds of [[evidence.id], ["a".repeat(32)]]) {
      const result = primaryEvidenceSearch(store.db, { evidenceIds, externalId: "other-record", query: "other identity" });
      assert.deepEqual(result.matches.map(row => row.evidenceId), evidenceIds[0] === evidence.id ? [evidence.id] : []);
      assert.equal(result.matches.some(row => row.evidenceId === other.id), false);
    }
    assert.deepEqual(primaryEvidenceSearch(store.db, { externalId: "absent-record", query: "other identity" }).matches, []);
    assert.equal(store.db.prepare("SELECT total_changes() AS n").get().n, changesBefore);
  } finally { store.close(); }
});

test("primary discovery excludes control roles before ranking but retains exact audit reads", () => {
  const databasePath = path.join(os.tmpdir(), `shadow-primary-control-${process.pid}-${Date.now()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  try {
    const source = store.upsertSource({ sourceKey: "control-search", kind: "test", uri: "test://control-search" });
    const definitions = [
      { kind: "codex_agent_message", role: "system", externalId: "control-system" },
      { kind: "codex_agent_message", role: "developer", externalId: "control-developer" },
      { kind: "codex_agent_message", role: "assistant", externalId: "answer" },
      { kind: "codex_agent_message", role: null, externalId: "legacy-answer" },
      { kind: "codex_user_message", role: "user", externalId: "request" },
      { kind: "feishu_message", role: "developer", externalId: "collaborator-role" },
      { kind: "codex_tool_output", role: null, externalId: "tool" },
    ];
    const rows = definitions.map((definition, index) => store.addEvidence({
      sourceId: source.id, ...definition, title: "controlprobe", content: "controlprobe result",
      occurredAt: `2026-10-22T00:00:0${8 - index}.000Z`, sourceLocator: `test://control-search/${index}`,
    }));
    const controls = rows.slice(0, 2).map(row => row.id);
    const changesBefore = store.db.prepare("SELECT total_changes() AS value").get().value;
    // First query uses FTS; the second falls back to literal OR matching.
    for (const query of ["controlprobe", "missingtoken controlprobe"]) {
      const result = primaryEvidenceSearch(store.db, { query, maxBytes: 32768 });
      assert.deepEqual(new Set(result.matches.map(row => row.evidenceId)), new Set(rows.slice(2, 6).map(row => row.id)));
      const explicit = primaryEvidenceSearch(store.db, {
        query, sourceKinds: ["codex_agent_message"], maxBytes: 32768,
      });
      assert.deepEqual(new Set(explicit.matches.map(row => row.evidenceId)), new Set(rows.slice(2, 4).map(row => row.id)));
      const first = primaryEvidenceSearch(store.db, { query, limit: 1 });
      assert.equal(first.matches.length, 1);
      assert.equal(controls.includes(first.matches[0].evidenceId), false);
    }
    const tool = primaryEvidenceSearch(store.db, { query: "controlprobe", sourceKinds: ["codex_tool_output"] });
    assert.equal(tool.matches[0].evidenceId, rows[6].id);
    const byId = primaryEvidenceSearch(store.db, { evidenceIds: controls, query: "unmatched", maxBytes: 8192 });
    assert.deepEqual(new Set(byId.matches.map(row => row.evidenceId)), new Set(controls));
    const byExternal = primaryEvidenceSearch(store.db, { externalId: "control-developer" });
    assert.equal(byExternal.matches[0].role, "developer");
    assert.match(byExternal.guidance, /untrusted data/);
    assert.equal(store.db.prepare("SELECT total_changes() AS value").get().value, changesBefore);
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

test("primary evidence search applies exact scope and remains read only", () => {
  const databasePath = path.join(os.tmpdir(), `shadow-primary-scope-${process.pid}-${Date.now()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  try {
    const source = store.upsertSource({ sourceKey: "primary-scope", kind: "test", uri: "test://primary-scope" });
    const inScope = store.addEvidence({
      sourceId: source.id,
      kind: "feishu_message",
      occurredAt: "2026-08-20T10:46:00.000Z",
      title: "范围内消息",
      content: "机器人突然断联，根因仍在分析。",
      sourceLocator: "feishu://message/in-scope",
      externalId: "in-scope",
      projectKey: "incident-project",
      metadata: { conversationKey: "im:incident-a" },
    });
    store.addEvidence({
      sourceId: source.id,
      kind: "feishu_message",
      occurredAt: "2026-08-22T10:46:00.000Z",
      title: "范围外消息",
      content: "机器人突然断联，已经定位其他原因。",
      sourceLocator: "feishu://message/out-of-scope",
      externalId: "out-of-scope",
      projectKey: "other-project",
      metadata: { conversationKey: "im:incident-b" },
    });
    const changesBefore = store.db.prepare("SELECT total_changes() AS value").get().value;
    const result = primaryEvidenceSearch(store.db, {
      query: "机器人突然断联",
      projectKey: "incident-project",
      conversationKey: "im:incident-a",
      after: "2026-08-20T00:00:00.000Z",
      before: "2026-08-21T00:00:00.000Z",
      maxBytes: 4096,
    });
    const changesAfter = store.db.prepare("SELECT total_changes() AS value").get().value;
    assert.deepEqual(result.matches.map((item) => item.evidenceId), [inScope.id]);
    assert.equal(changesAfter, changesBefore);
    assert.ok(store.db.prepare("PRAGMA index_list(evidence)").all()
      .some((item) => item.name === "evidence_kind_external_id_idx"));
    assert.throws(() => primaryEvidenceSearch(store.db, {
      query: "断联",
      after: "2026-08-22T00:00:00.000Z",
      before: "2026-08-21T00:00:00.000Z",
    }), /after must be earlier/);
    assert.throws(() => primaryEvidenceSearch(store.db, {
      query: "断联",
      sourceKinds: ["codex_thread_digest"],
    }), /Unsupported primary evidence kind/);
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

test("conversation window is exact, chronological, bounded, and read only", () => {
  const databasePath = path.join(os.tmpdir(), `shadow-conversation-window-${process.pid}-${Date.now()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  try {
    const source = store.upsertSource({ sourceKey: "conversation-window", kind: "feishu", uri: "feishu://conversation-window" });
    const addMessage = ({ conversationKey, messageId, occurredAt, content }) => store.addEvidence({
      sourceId: source.id,
      kind: "feishu_message",
      externalId: messageId,
      occurredAt,
      title: `message ${messageId}`,
      content,
      sourceLocator: `feishu://conversation/${conversationKey}/message/${messageId}`,
      metadata: {
        conversationKey,
        senderType: "user",
        senderName: "测试人员",
        sentBySelf: messageId === "m2",
        mentionsSelf: messageId === "m3",
        ownershipSignal: messageId === "m3" ? "mention_self" : null,
        replyToMessageId: messageId === "m3" ? "m2" : null,
        replyToSelf: messageId === "m3",
      },
    });
    addMessage({ conversationKey: "p2p:target", messageId: "m1", occurredAt: "2026-08-29T01:00:00.000Z", content: "第一条" });
    addMessage({ conversationKey: "p2p:target", messageId: "m2", occurredAt: "2026-08-29T02:00:00.000Z", content: "第二条" });
    addMessage({ conversationKey: "p2p:target", messageId: "m3", occurredAt: "2026-08-29T03:00:00.000Z", content: "第三条" });
    addMessage({ conversationKey: "p2p:other", messageId: "noise", occurredAt: "2026-08-29T02:30:00.000Z", content: "不得串入" });

    const result = conversationWindow(store.db, { conversationKey: "p2p:target", limit: 2, maxBytes: 4096 });
    assert.equal(result.provider, "feishu");
    assert.equal(result.sourceFamily, "collaboration");
    assert.equal(result.streamId, "p2p:target");
    assert.deepEqual(result.messages.map((message) => message.messageId), ["m2", "m3"]);
    assert.equal(result.messages.some((message) => message.content.includes("不得串入")), false);
    assert.equal(result.truncated, true);
    assert.ok(serializedBytes(result) <= result.maxBytes);

    const historical = conversationWindow(store.db, {
      conversationKey: "p2p:target",
      after: "2026-08-29T01:30:00.000Z",
      before: "2026-08-29T02:30:00.000Z",
      limit: 10,
    });
    assert.deepEqual(historical.messages.map((message) => message.messageId), ["m2"]);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM evidence").get().count, 4);
    assert.throws(() => conversationWindow(store.db, {
      provider: "codex",
      streamId: "thread-domain",
    }), /does not support Collaboration windows/);
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

test("primary evidence search filters canonical domains without mixing provider payloads", () => {
  const databasePath = path.join(os.tmpdir(), `shadow-primary-domains-${process.pid}-${Date.now()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  try {
    const collaborationSource = store.upsertSource({ sourceKey: "domain-search-feishu", kind: "feishu", uri: "feishu://domains" });
    const executionSource = store.upsertSource({ sourceKey: "domain-search-codex", kind: "codex_rollout", uri: "codex://domains" });
    const collaboration = store.addEvidence({
      sourceId: collaborationSource.id,
      kind: "feishu_message",
      title: "相同关键词",
      content: "核对接口边界",
      sourceLocator: "feishu://message/domain",
      externalId: "domain-message",
      metadata: { conversationKey: "im:domain" },
    });
    const execution = store.addEvidence({
      sourceId: executionSource.id,
      kind: "codex_user_message",
      title: "相同关键词",
      content: "核对接口边界",
      sourceLocator: "codex://thread/domain",
      threadId: "thread-domain",
    });
    const collaborationResult = primaryEvidenceSearch(store.db, {
      query: "核对接口边界",
      sourceFamilies: ["collaboration"],
      providers: ["feishu"],
      eventKinds: ["message"],
      maxBytes: 4096,
    });
    assert.deepEqual(collaborationResult.matches.map((item) => item.evidenceId), [collaboration.id]);
    const executionResult = primaryEvidenceSearch(store.db, {
      query: "核对接口边界",
      sourceFamilies: ["execution"],
      providers: ["codex"],
      eventKinds: ["user_intent"],
      maxBytes: 4096,
    });
    assert.deepEqual(executionResult.matches.map((item) => item.evidenceId), [execution.id]);
    assert.throws(() => primaryEvidenceSearch(store.db, {
      query: "接口",
      sourceFamilies: ["social"],
    }), /Unsupported source family/);
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

test("direct Git evidence requires an explicit lookup outside normalized scope", () => {
  const databasePath = path.join(os.tmpdir(), `shadow-git-scope-${process.pid}-${Date.now()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  try {
    const source = store.upsertSource({ sourceKey: "git-scope-project", kind: "project_root", uri: "test://repo" });
    const sha = "b".repeat(40);
    const evidence = store.addEvidence({ sourceId: source.id, kind: "git_commit", externalId: sha,
      title: "Fixture commit", content: JSON.stringify({ commit: sha, subject: "Fixture commit" }),
      sourceLocator: `test://repo#commit=${sha}`, projectKey: "fixture-project",
      occurredAt: "2026-01-02T00:00:00.000Z" });
    const before = store.db.prepare("SELECT total_changes() AS n").get().n;
    for (const identity of [{ query: sha }, { externalId: sha }, { evidenceIds: [evidence.id] }]) {
      const params = { ...identity, sourceKinds: ["git_commit"], projectKey: "fixture-project" };
      const result = primaryEvidenceSearch(store.db, params);
      assert.deepEqual(result.matches.map(item => item.evidenceId), [evidence.id]);
      assert.equal(result.matches[0].source, null);
      for (const scope of [
        { sourceFamilies: ["execution"] }, { sourceFamilies: ["collaboration"] },
        { providers: ["codex"] }, { eventKinds: ["tool_result"] },
        { projectKey: "different-project" }, { after: "2026-01-03T00:00:00Z" },
        { before: "2026-01-01T00:00:00Z" },
      ]) assert.deepEqual(primaryEvidenceSearch(store.db, { ...params, ...scope }).matches, [], JSON.stringify(scope));
    }
    assert.equal(store.db.prepare("SELECT total_changes() AS n").get().n, before);
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

test("outbound tools can only create and inspect HITL drafts", async () => {
  const databasePath = path.join(os.tmpdir(), `shadow-outbound-tools-${process.pid}-${Date.now()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  const tools = Object.fromEntries(plugin.tools((definition) => definition).map((definition) => [definition.name, definition]));
  const config = { databasePath, reuseConnections: false };
  try {
    await assert.rejects(() => tools.shadow_outbound_draft_create.execute({
      messageKind: "question",
      recipientName: "测试同事",
      recipientOpenId: "ou_test",
      content: "这个问题没有任务目标。",
      reason: "验证责任边界",
      contextSummary: "主动追问必须属于一张已有任务卡。",
    }, config), /bound to a Workboard taskId/);
    const created = await tools.shadow_outbound_draft_create.execute({
      messageKind: "question",
      recipientName: "测试同事",
      recipientOpenId: "ou_test",
      content: "请确认接口边界。",
      reason: "缺少直接证据",
      contextSummary: "接口文档与当前实现边界不一致，需要向维护人确认。",
      sessionKey: "agent:main:shadow:test",
      taskId: "task-interface-boundary",
    }, config);
    assert.equal(created.draft.status, "pending_confirmation");
    assert.equal(created.draft.metadata.hitlRequired, true);
    assert.equal(created.draft.reviewContext.summary, "接口文档与当前实现边界不一致，需要向维护人确认。");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM controller_outbox WHERE action_type='send_feishu_message'").get().count, 0);
    const listed = await tools.shadow_outbound_draft_list.execute({ limit: 10 }, config);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].recipient_name, "测试同事");
    assert.equal(tools.shadow_outbound_approve, undefined);
    assert.equal(tools.shadow_outbound_send, undefined);
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

test("cognitive routing remembers where to look and whom to ask without sending", () => {
  const databasePath = path.join(os.tmpdir(), `shadow-routing-${process.pid}-${Date.now()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  try {
    const source = store.upsertSource({ sourceKey: "routing-test", kind: "test", uri: "test://routing" });
    const evidence = store.addEvidence({
      sourceId: source.id,
      kind: "manual_knowledge",
      title: "相机时间戳维护入口",
      content: "相机时间戳由相机仓库维护，接口问题可询问相机负责人。",
      sourceLocator: "test://routing/camera-timestamp",
    });
    const topic = upsertGraphEntity(store.db, {
      canonicalKey: "topic:camera-image-timestamp",
      type: "KnowledgeTopic",
      name: "相机图像时间戳",
      summary: "图像时间戳传播和外部接口影响。",
    });
    const code = upsertGraphEntity(store.db, {
      canonicalKey: "code:D:/projects/at_camera",
      type: "CodeLocation",
      name: "at_camera 源码",
      metadata: { path: "D:/projects/at_camera" },
    });
    const owner = upsertGraphEntity(store.db, {
      canonicalKey: "person:camera-owner",
      type: "Person",
      name: "相机负责人",
    });
    const channel = upsertGraphEntity(store.db, {
      canonicalKey: "feishu:open_id:camera-owner",
      type: "CommunicationChannel",
      name: "相机负责人飞书",
      metadata: { locator: "open_id:test-camera-owner", conversationKey: "feishu:chat:test-camera" },
    });
    for (const input of [
      { subject: topic.id, predicate: "IMPLEMENTED_IN", objectEntity: code.id },
      { subject: owner.id, predicate: "EXPERT_IN", objectEntity: topic.id },
      { subject: owner.id, predicate: "CONTACT_VIA", objectEntity: channel.id },
    ]) {
      const fact = assertGraphFact(store.db, { ...input, confidence: 0.98, createdBy: "routing-test" });
      assessFactEvidence(store.db, {
        factId: fact.id,
        evidenceId: evidence.id,
        stance: "supports",
        basis: "user_statement",
        directness: "direct",
        method: "document_record",
        environment: "local",
        outcome: "observed",
        confidence: 0.95,
        assessedBy: "routing-test",
      });
    }

    const route = resolveCognitiveRoute(store.db, {
      query: "相机图像时间戳影响谁负责",
      sessionKey: "agent:main:shadow:test-routing",
      maxBytes: 8192,
    });
    assert.equal(route.outcome, "retrievable");
    assert.equal(route.retrievable[0].locator, "D:/projects/at_camera");
    assert.equal(route.askable[0].name, "相机负责人");
    assert.equal(route.askable[0].requiresAuthorization, "send_external_message");
    assert.equal(route.askable[0].contact.locator, "open_id:test-camera-owner");
    assert.equal(route.askable[0].afterAuthorizedSend.action, "create_condition_watch_from_send_receipt");
    assert.deepEqual(route.askable[0].afterAuthorizedSend.selector.conversationKeys, ["feishu:chat:test-camera"]);
    assert.equal(route.askable[0].afterAuthorizedSend.requiresBindingAfterSend, true);
    assert.ok(route.bytes <= 8192);
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

test("cognitive routing rejects substring-only false familiarity", () => {
  const databasePath = path.join(os.tmpdir(), `shadow-routing-relevance-${process.pid}-${Date.now()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  try {
    captureKnowledge(store.db, {
      sourceType: "note",
      title: "V431 生产版本总结与测试安排",
      content: "准备 V431 生产版本并安排验证。",
      summary: "V431 近期修复、新增功能和生产测试安排。",
      keywords: ["V431", "生产版本", "测试安排"],
      retrievalCues: ["V431 版本如何安排", "生产版本测试计划是什么"],
      generatedBy: "routing-relevance-test",
    });
    const route = resolveCognitiveRoute(store.db, {
      query: "deliberately unknown V4 smoke topic route",
      sessionKey: "agent:main:shadow:test-routing-relevance",
      maxBytes: 8192,
    });
    assert.equal(route.outcome, "unresolved_with_next_step");
    assert.deepEqual(route.known, []);
    assert.deepEqual(route.retrievable, []);
    assert.deepEqual(route.askable, []);
    assert.equal(route.steps[0].action, "discover_route");
    assert.equal(route.nonBlockingFallback.action, "update_workboard_and_continue");
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

test("cognitive routing prioritizes structured responsibility over crowded same-name history", () => {
  const databasePath = path.join(os.tmpdir(), `shadow-routing-crowded-${process.pid}-${Date.now()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  try {
    const source = store.upsertSource({ sourceKey: "routing-crowded", kind: "test", uri: "test://routing-crowded" });
    const evidence = store.addEvidence({
      sourceId: source.id,
      kind: "manual_knowledge",
      title: "通信标定职责",
      content: "示例人员19负责通信标定。",
      sourceLocator: "test://routing-crowded/profile",
      externalId: "routing-crowded-profile",
    });
    for (let index = 0; index < 40; index += 1) {
      upsertGraphEntity(store.db, {
        canonicalKey: `message:crowded-${index}`,
        type: "Message",
        name: "通信标定",
        metadata: { presentationPriority: 1 },
      });
    }
    const topic = upsertGraphEntity(store.db, {
      canonicalKey: "topic:communication-calibration",
      type: "KnowledgeTopic",
      name: "通信标定",
      metadata: { presentationPriority: 90 },
    });
    const owner = upsertGraphEntity(store.db, {
      canonicalKey: "person:test-owner",
      type: "Person",
      name: "示例人员19",
      metadata: { presentationPriority: 90 },
    });
    const fact = assertGraphFact(store.db, {
      subject: owner.id,
      predicate: "RESPONSIBLE_FOR",
      objectEntity: topic.id,
      confidence: 0.98,
      epistemicStatus: "supported",
      createdBy: "routing-crowded-test",
    });
    assessFactEvidence(store.db, {
      factId: fact.id,
      evidenceId: evidence.id,
      stance: "supports",
      basis: "user_statement",
      directness: "direct",
      method: "document_record",
      environment: "local",
      outcome: "observed",
      confidence: 0.98,
      assessedBy: "routing-crowded-test",
    });

    const route = resolveCognitiveRoute(store.db, { query: "通信标定找谁", maxBytes: 8192 });
    assert.equal(route.outcome, "askable");
    assert.equal(route.askable[0].name, "示例人员19");
    assert.ok(route.bytes <= 8192);
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

test("resolve and query separate verified, pending, expired, refuted, and disputed knowledge", () => {
  const databasePath = path.join(os.tmpdir(), `shadow-trusted-query-${process.pid}-${Date.now()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  try {
    const source = store.upsertSource({ sourceKey: "trusted-query", kind: "test", uri: "test://trusted-query" });
    const evidence = store.addEvidence({
      sourceId: source.id,
      kind: "project_document",
      title: "知识可信状态原始记录",
      content: "用于验证事实有效期、证据有效期和争议隔离。",
      sourceLocator: "test://trusted-query/source",
    });
    const topic = upsertGraphEntity(store.db, {
      canonicalKey: "topic:trusted-query",
      type: "KnowledgeTopic",
      name: "知识可信状态",
      summary: "验证事实、待复核和冲突知识的分层查询。",
    });
    const addFact = (label, options = {}) => {
      const fact = assertGraphFact(store.db, {
        subject: topic.id,
        predicate: "HAS_STATUS",
        objectValue: label,
        confidence: 0.95,
        validTo: options.validTo,
        createdBy: "trusted-query-test",
      });
      if (options.epistemicStatus !== "refuted") assessFactEvidence(store.db, {
        factId: fact.id,
        evidenceId: evidence.id,
        stance: "supports",
        method: "document_record",
        environment: "local",
        confidence: 0.95,
        validUntil: options.validUntil,
        assessedBy: "trusted-query-test",
      });
      if (["disputed", "refuted"].includes(options.epistemicStatus)) {
        const contradiction = store.addEvidence({
          sourceId: source.id, kind: "project_document", title: `Contradiction: ${label}`,
          content: `Direct observation contradicts ${label}.`, sourceLocator: `test://trusted-query/contradiction/${label}`,
        });
        assessFactEvidence(store.db, {
          factId: fact.id, evidenceId: contradiction.id, stance: "contradicts",
          method: "document_record", environment: "local", confidence: 0.95,
          assessedBy: "trusted-query-test",
        });
      }
      return fact.id;
    };
    const verifiedId = addFact("verified");
    const evidenceExpiredId = addFact("expired-evidence", { validUntil: "2020-01-01T00:00:00.000Z" });
    const factExpiredId = addFact("expired-fact", { validTo: "2020-01-01T00:00:00.000Z" });
    const disputedId = addFact("disputed", { epistemicStatus: "disputed" });
    const refutedId = addFact("refuted", { epistemicStatus: "refuted" });
    const pending = captureKnowledge(store.db, {
      sourceType: "note",
      title: "知识可信状态待复核补充",
      content: "这条补充只是一张等待复核的召回卡，不能作为已验证事实。",
      summary: "知识可信状态存在一条待复核材料，当前不可作为确定结论。",
      keywords: ["知识可信状态", "待复核", "证据契约"],
      retrievalCues: ["知识可信状态有哪些待复核材料", "什么内容不能视为事实"],
      generatedBy: "trusted-query-test",
    });

    const route = resolveCognitiveRoute(store.db, { query: "知识可信状态", maxBytes: 16_384 });
    assert.deepEqual(route.verifiedFacts.map((item) => item.id), [verifiedId]);
    assert.deepEqual(route.known.map((item) => item.id), [verifiedId]);
    assert.ok(route.reviewPending.some((item) => item.evidenceId === pending.evidenceId));
    assert.ok(route.reviewPending.some((item) => item.id === evidenceExpiredId));
    assert.deepEqual(route.conflicts.map((item) => item.id), [disputedId]);
    assert.ok(route.reviewPending.every((item) => ["pending", "needs_followup", "pending_fact_review"].includes(item.reviewStatus)));
    assert.ok(route.conflicts.every((item) => item.reviewStatus === "disputed"));
    assert.ok(route.verifiedFacts.every((item) => item.evidence?.id && item.source?.locator && item.reviewStatus));
    assert.ok(!JSON.stringify(route).includes(factExpiredId));
    assert.ok(!JSON.stringify(route).includes(refutedId));

    const queried = queryContext(store.db, { query: "知识可信状态", depth: 1, maxBytes: 65_536 });
    assert.ok(queried.verifiedFacts.some((item) => item.id === verifiedId));
    assert.ok(queried.reviewPending.some((item) => item.evidence_id === pending.evidenceId));
    assert.ok(queried.reviewPending.some((item) => item.id === evidenceExpiredId));
    assert.ok(queried.conflicts.some((item) => item.id === disputedId));
    assert.ok(queried.conflicts.every((item) => item.reviewStatus === "disputed"));
    assert.ok(queried.verifiedFacts.every((item) => item.evidence?.id && item.source?.locator && item.reviewStatus));
    assert.ok(!JSON.stringify(queried).includes(factExpiredId));
    assert.ok(!JSON.stringify(queried).includes(refutedId));
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

test("attention packet leases one compact change without dumping the whole Workboard", () => {
  const databasePath = path.join(os.tmpdir(), `shadow-attention-${process.pid}-${Date.now()}.sqlite`);
  const workboardPath = path.join(os.tmpdir(), `shadow-attention-board-${process.pid}-${Date.now()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  const workboard = new DatabaseSync(workboardPath);
  try {
    workboard.exec(`
      CREATE TABLE workboard_cards (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT, status TEXT NOT NULL,
        priority TEXT NOT NULL, updated_at INTEGER NOT NULL, automation_json TEXT,
        archived_at INTEGER
      );
    `);
    const now = Date.now();
    workboard.prepare(`INSERT INTO workboard_cards VALUES(?, ?, ?, ?, ?, ?, ?, NULL)`).run(
      "related", "修复机器人 TCP 心跳", "激光跟踪通信", "todo", "high", now, JSON.stringify({ projectKey: "examplevision" }),
    );
    workboard.prepare(`INSERT INTO workboard_cards VALUES(?, ?, ?, ?, ?, ?, ?, NULL)`).run(
      "noise", "整理其他部门展会物料", "与本人无关", "todo", "normal", now, "{}",
    );
    workboard.prepare(`INSERT INTO workboard_cards VALUES(?, ?, ?, ?, ?, ?, ?, NULL)`).run(
      "direct", "标题没有任何文本相似度", "只由用户操作明确指定", "todo", "normal", now, "{}",
    );
    const source = store.upsertSource({ sourceKey: "attention-test", kind: "test", uri: "test://attention" });
    const evidence = store.addEvidence({
      sourceId: source.id, kind: "feishu_message", title: "机器人通信讨论",
      content: "请继续核对激光跟踪软件 TCP 心跳。", projectKey: "examplevision",
      sourceLocator: "test://attention/message",
    });
    store.db.prepare(`
      INSERT INTO context_changes(
        event_key, kind, evidence_id, project_key, priority, status, created_at,
        summary, metadata_json, session_key, not_before
      ) VALUES('attention-change', 'evidence_batch_ingested', ?, 'examplevision', 'normal', 'pending', ?, ?, ?, ?, ?)
    `).run(
      evidence.id,
      new Date().toISOString(),
      "新增机器人通信会话",
      JSON.stringify({
        evidenceIds: [evidence.id],
        operationId: "operation-direct",
        targetType: "workboard_task",
        targetId: "direct",
        taskId: "direct",
        desiredEffect: "interpret_task_instruction",
      }),
      "agent:main:shadow:test-session",
      new Date(0).toISOString(),
    );
    const packet = attentionPacket(store.db, { databasePath, workboardDatabasePath: workboardPath }, {
      sessionKey: "agent:main:shadow:test-session",
      maxBytes: 8192,
    });
    assert.equal(packet.count, 1);
    assert.equal(packet.changes[0].evidence[0].id, evidence.id);
    assert.deepEqual(packet.relatedCards.map((card) => card.id), ["direct", "related"]);
    assert.equal(packet.relatedCards[0].relationStatus, "explicit_task");
    assert.equal(packet.relatedCards[0].candidateOnly, false);
    assert.equal(packet.relatedCards[1].relationStatus, "unconfirmed");
    assert.equal(packet.relatedCards[1].candidateOnly, true);
    assert.equal(packet.changes[0].metadata.operationId, "operation-direct");
    assert.match(packet.guidance, /not an exhaustive search or ownership proof/);
    assert.match(packet.guidance, /empty shortlist does not prove no card exists/);
    assert.match(packet.guidance, /bounded shadow_context_focus radar/);
    assert.ok(packet.bytes <= 8192);
    store.bindWorkSession({ provider: "shadow-task", routeKey: "direct", kind: "task", taskId: "direct",
      sessionKey: "agent:main:shadow:task:test" });
    store.db.prepare("UPDATE context_changes SET status='pending', session_key=?, lease_owner=NULL, lease_until=NULL WHERE event_key='attention-change'")
      .run("agent:main:shadow:task:test");
    const isolated = attentionPacket(store.db, { databasePath, workboardDatabasePath: workboardPath }, {
      sessionKey: "agent:main:shadow:task:test", maxBytes: 8192,
    });
    assert.deepEqual(isolated.relatedCards.map((card) => card.id), ["direct"]);
    assert.equal(isolated.relatedCards[0].candidateOnly, false);
  } finally {
    workboard.close();
    store.close();
    removeDatabase(databasePath);
    removeDatabase(workboardPath);
  }
});

test("attention packet enforces change, evidence, and byte budgets", () => {
  const databasePath = path.join(os.tmpdir(), `shadow-attention-budget-${process.pid}-${Date.now()}.sqlite`);
  const missingWorkboardPath = path.join(os.tmpdir(), `shadow-attention-budget-board-${process.pid}-${Date.now()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  try {
    const source = store.upsertSource({ sourceKey: "attention-budget-test", kind: "test", uri: "test://attention-budget" });
    const evidenceIds = Array.from({ length: 15 }, (_, index) => store.addEvidence({
      sourceId: source.id,
      kind: "feishu_message",
      title: `短证据 ${index}`,
      content: `这是第 ${index} 条用于验证自动注意力预算的短证据。`,
      sourceLocator: `test://attention-budget/${index}`,
    }).id);
    const insert = store.db.prepare(`
      INSERT INTO context_changes(
        event_key, kind, priority, status, created_at, summary, metadata_json, session_key, not_before
      ) VALUES(?, 'evidence_batch_ingested', 'normal', 'pending', ?, ?, ?, ?, ?)
    `);
    for (let index = 0; index < 6; index += 1) {
      insert.run(
        `attention-budget-change-${index}`,
        new Date(Date.now() + index).toISOString(),
        `第 ${index} 个待分析变化`,
        JSON.stringify({ evidenceIds }),
        "agent:main:shadow:budget-session",
        new Date(0).toISOString(),
      );
    }

    const packet = attentionPacket(store.db, {
      databasePath,
      workboardDatabasePath: missingWorkboardPath,
    }, {
      sessionKey: "agent:main:shadow:budget-session",
      limit: 20,
      maxBytes: 65_536,
    });
    assert.equal(packet.count, 4);
    assert.ok(packet.changes.every((change) => change.evidence.length <= 12));
    assert.equal(packet.changes[0].evidence.length, 12);
    assert.equal(packet.relatedCards.length, 0);
    assert.ok(Buffer.byteLength(JSON.stringify(packet), "utf8") <= 16_384);
  } finally {
    store.close();
    removeDatabase(databasePath);
    removeDatabase(missingWorkboardPath);
  }
});

test("reminder and condition tools persist intents without creating a second task store", async () => {
  const databasePath = path.join(os.tmpdir(), `shadow-runtime-intents-${process.pid}-${Date.now()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  const tools = Object.fromEntries(plugin.tools((definition) => definition).map((definition) => [definition.name, definition]));
  const config = { databasePath, reuseConnections: false };
  try {
    const reminder = await tools.shadow_reminder_create.execute({
      title: "测试提醒",
      dueAt: new Date(Date.now() + 60_000).toISOString(),
      explicit: true,
    }, config);
    assert.equal(reminder.inserted, true);
    assert.equal(reminder.reminder.status, "pending_schedule");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM controller_outbox WHERE action_type='schedule_reminder'").get().value, 1);
    await assert.rejects(() => tools.shadow_reminder_create.execute({
      title: "内部复查不应通知用户",
      dueAt: new Date(Date.now() + 90_000).toISOString(),
      taskId: "task-internal-review",
      explicit: false,
    }, config), /Internal task reviews must use work_task_attention/);

    const reminderSource = store.upsertSource({ sourceKey: "reminder-source", kind: "test", uri: "test://reminder-source" });
    const reminderEvidence = store.addEvidence({
      sourceId: reminderSource.id,
      kind: "import_document",
      title: "明确截止时间",
      content: "用户需要在明确时间前提交材料。",
      sourceLocator: "test://reminder-source/deadline",
    });
    const inferredDueAt = new Date(Date.now() + 150_000).toISOString();
    const inferred = await tools.shadow_reminder_create.execute({
      title: "提交材料",
      dueAt: inferredDueAt,
      taskId: "task-inferred-deadline",
      explicit: false,
      owner: "当前用户",
      sourceBasis: "来源文档明确给出提交时间",
      evidenceIds: [reminderEvidence.id],
    }, config);
    const duplicate = await tools.shadow_reminder_create.execute({
      title: "换标题也不重复提醒",
      dueAt: inferredDueAt,
      taskId: "task-inferred-deadline",
      explicit: true,
      idempotencyKey: "model-changed-key",
    }, config);
    assert.equal(inferred.inserted, true);
    assert.equal(duplicate.inserted, false);
    assert.equal(duplicate.reminder.id, inferred.reminder.id);
    const updatedReminder = await tools.shadow_reminder_update.execute({
      reminderId: reminder.reminder.id,
      title: "更新后的测试提醒",
      dueAt: new Date(Date.now() + 120_000).toISOString(),
    }, config);
    assert.equal(updatedReminder.status, "pending_schedule");
    assert.equal(updatedReminder.revision, 2);
    assert.equal(updatedReminder.title, "更新后的测试提醒");
    const cancelledReminder = await tools.shadow_reminder_cancel.execute({
      reminderId: reminder.reminder.id,
    }, config);
    assert.equal(cancelledReminder.status, "cancelled");
    assert.equal(cancelledReminder.revision, 3);
    assert.equal(store.db.prepare(`
      SELECT COUNT(*) AS value FROM controller_outbox
      WHERE idempotency_key LIKE ? AND action_type='schedule_reminder'
        AND status IN ('pending','retry','leased')
    `).get(`schedule-reminder:${reminder.reminder.id}:%`).value, 0);

    await assert.rejects(() => tools.shadow_condition_watch.execute({
      title: "空筛选",
      conditionText: "不能匹配所有内容",
      selector: { kinds: [] },
    }, config), /non-empty/);

    const watch = await tools.shadow_condition_watch.execute({
      title: "等待飞书任务更新",
      conditionText: "任务 task-1 出现新的状态变化",
      selector: { kinds: ["feishu_task"], externalIds: ["task-1"] },
      timeoutAt: new Date(Date.now() + 120_000).toISOString(),
      taskId: "task-1",
      sessionKey: "agent:main:test-condition",
    }, config);
    assert.equal(watch.inserted, true);
    assert.equal(
      watch.watch.baseline_evidence_rowid,
      store.db.prepare("SELECT MAX(rowid) AS value FROM evidence").get().value,
    );
    assert.equal((await tools.shadow_condition_list.execute({}, config))[0].id, watch.watch.id);
    const resolved = await tools.shadow_condition_resolve.execute({
      watchId: watch.watch.id,
      disposition: "continue",
      note: "候选信息不足，继续执行内部核查",
      nextTimeoutAt: new Date(Date.now() + 180_000).toISOString(),
      continuation: {
        kind: "internal_action",
        summary: "读取任务详情和关联代码，核对尚未满足的验收条件",
      },
    }, config);
    assert.equal(resolved.status, "active");
    assert.equal(resolved.continuation.kind, "internal_action");

    const source = store.upsertSource({ sourceKey: "condition-candidate", kind: "test", uri: "test://condition" });
    const candidate = store.addEvidence({
      sourceId: source.id,
      kind: "feishu_task",
      externalId: "task-1",
      title: "测试同事回复",
      content: "当前接口不支持取消，需要改走重新提交。",
      sourceLocator: "test://condition/reply",
      metadata: { senderName: "测试同事", senderOpenId: "ou_colleague", sentBySelf: false, mentionsSelf: true },
    });
    store.db.prepare("UPDATE condition_watches SET status='candidate', timeout_at=? WHERE id=?")
      .run(new Date(Date.now() - 1000).toISOString(), watch.watch.id);
    store.db.prepare("UPDATE condition_watches SET candidate_evidence_ids_json=? WHERE id=?")
      .run(JSON.stringify([candidate.id]), watch.watch.id);
    const listedCandidate = (await tools.shadow_condition_list.execute({}, config))[0];
    assert.equal(listedCandidate.candidateEvidence[0].content, "当前接口不支持取消，需要改走重新提交。");
    assert.equal(listedCandidate.candidateEvidence[0].senderOpenId, "ou_colleague");
    await assert.rejects(() => tools.shadow_condition_resolve.execute({
      watchId: watch.watch.id,
      disposition: "continue",
      note: "只写继续等待不构成推进",
    }, config), /structured continuation/);
    const continued = await tools.shadow_condition_resolve.execute({
      watchId: watch.watch.id,
      disposition: "continue",
      note: "回复排除了取消方案，等待重新提交结果",
      continuation: {
        kind: "passive_wait",
        summary: "等待对方完成重新提交并回传结果",
        nextReviewAt: new Date(Date.now() + 240_000).toISOString(),
      },
    }, config);
    assert.equal(continued.continuation.kind, "passive_wait");
    assert.equal(continued.reviewHistory.length, 2);
    assert.deepEqual(continued.reviewHistory.at(-1).candidateEvidenceIds, [candidate.id]);
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

test("plugin schemas advertise the optional Workboard attention source", () => {
  assert.equal(plugin.configSchema.properties.workboardDatabasePath.type, "string");
  assert.equal(plugin.configSchema.properties.reuseConnections.default, true);
  const names = plugin.tools((definition) => definition).map((definition) => definition.name);
  assert.ok(names.includes("shadow_context_focus"));
  assert.ok(names.includes("shadow_context_focus_update"));
  assert.ok(names.includes("shadow_context_revise"));
  const revise = plugin.tools((definition) => definition).find((definition) => definition.name === "shadow_context_revise");
  assert.ok(revise.parameters.required.includes("supersedesEvidenceIds"));
  assert.ok(revise.parameters.required.includes("revisionReason"));
});

test("work focus ranks explicit near deadlines ahead of undated queue age", () => {
  const databasePath = path.join(os.tmpdir(), `shadow-focus-${process.pid}-${Date.now()}.sqlite`);
  const workboardPath = path.join(os.tmpdir(), `shadow-workboard-${process.pid}-${Date.now()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  const workboard = new DatabaseSync(workboardPath);
  try {
    workboard.exec(`
      CREATE TABLE workboard_cards (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL, title TEXT NOT NULL, notes TEXT,
        status TEXT NOT NULL, priority TEXT NOT NULL, agent_id TEXT, session_key TEXT,
        run_id TEXT, task_id TEXT, source_url TEXT, position REAL NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, automation_json TEXT,
        archived_at INTEGER
      );
      CREATE TABLE workboard_card_labels (
        card_id TEXT NOT NULL, ordinal INTEGER NOT NULL, label TEXT NOT NULL,
        PRIMARY KEY(card_id, ordinal)
      );
      CREATE TABLE workboard_card_links (
        id TEXT PRIMARY KEY, card_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        type TEXT NOT NULL, target_card_id TEXT, title TEXT, url TEXT, created_at INTEGER NOT NULL
      );
    `);
    const now = Date.parse("2026-08-12T01:00:00.000Z");
    const insert = workboard.prepare(`
      INSERT INTO workboard_cards(
        id, board_id, title, notes, status, priority, position,
        created_at, updated_at, automation_json, archived_at
      ) VALUES(?, 'shadow-work', ?, '', 'todo', ?, 0, ?, ?, '{}', NULL)
    `);
    insert.run("old", "很早创建但没有截止时间的普通任务", "normal", now - 30 * 86_400_000, now - 20 * 86_400_000);
    insert.run("urgent", "高优先级但没有截止时间的任务", "urgent", now - 86_400_000, now - 3_600_000);
    insert.run("due", "临近交付的激光跟踪测试", "normal", now - 86_400_000, now - 3_600_000);

    const captured = captureKnowledge(store.db, {
      sourceType: "dialogue",
      title: "长期工作职责",
      content: "用户长期负责激光跟踪软件开发、测试、机器人通信和工作汇报。",
      summary: "工作核心是激光跟踪软件及相关测试交付。",
      keywords: ["激光跟踪软件", "机器人通信", "测试交付"],
      retrievalCues: ["用户长期负责什么", "哪些任务属于核心工作"],
      generatedBy: "focus-test",
    });
    const basics = { name: "示例用户", role: "开发", team: "测试团队", responsibilities: ["激光跟踪软件开发与测试"],
      exclusions: ["暂无排除项"], firstObjective: "按期完成测试交付" };
    confirmUserBasics(store, basics, previewUserBasics(basics).confirmation);
    assert.throws(() => updateWorkFocus(store.db, { summary: "independent text" }), /retired/);
    updateWorkFocus(store.db, {
      taskAttention: [{ cardId: "due", deadlineAt: "2026-08-12T20:00:00+08:00", importance: 80 }],
      generatedBy: "focus-test",
    });
    const result = workFocus(store.db, { databasePath, workboardDatabasePath: workboardPath }, {
      limit: 3,
      now: "2026-08-12T01:00:00.000Z",
    });
    assert.equal(typeof result.profile.sourceRevision, "string");
    assert.equal(result.profileNeedsRefresh, false);
    const revision = result.profile.sourceRevision;
    assert.equal(result.radar.cards[0].id, "due");
    assert.match(result.radar.cards[0].reasons.join(" "), /小时内到期/);
    assert.equal(result.radar.cards.find((card) => card.id === "old").deadlineAt, null);

    const laterSource = store.upsertSource({ sourceKey: "focus-later-log", kind: "test", uri: "test://focus-later-log" });
    store.addEvidence({
      sourceId: laterSource.id,
      kind: "tool_output",
      title: "普通构建日志",
      content: "普通增量证据不应强制重写长期工作简况。",
      sourceLocator: "test://focus-later-log/1",
      externalId: "later-log-1",
      collectedAt: "2026-08-12T02:00:00.000Z",
    });
    const afterOrdinaryEvidence = workFocus(store.db, { databasePath, workboardDatabasePath: workboardPath }, {
      limit: 3,
      now: "2026-08-12T02:00:00.000Z",
    });
    assert.equal(afterOrdinaryEvidence.profileNeedsRefresh, false);
    assert.equal(afterOrdinaryEvidence.profile.sourceRevision, revision);
  } finally {
    workboard.close();
    store.close();
    removeDatabase(databasePath);
    removeDatabase(workboardPath);
  }
});

test("annotate schema requires the semantic graph review contract", () => {
  const annotate = plugin.tools((definition) => definition)
    .find((definition) => definition.name === "shadow_context_annotate");
  assert.ok(annotate.parameters.required.includes("graphReview"));
  assert.deepEqual(annotate.parameters.properties.graphReview.required, ["status", "rationale"]);
  assert.deepEqual(annotate.parameters.properties.graphReview.properties.status.enum, [
    "completed",
    "needs_input",
  ]);
  assert.deepEqual(annotate.parameters.properties.graphReview.properties.outcome.enum, [
    "facts_recorded",
    "no_durable_facts",
    null,
  ]);
  assert.equal(annotate.parameters.properties.graphReview.properties.factIds.uniqueItems, true);
});

test("propose schema leaves the entity-or-value check to the execution layer", () => {
  const propose = plugin.tools((definition) => definition)
    .find((definition) => definition.name === "shadow_context_propose");
  const factSchema = propose.parameters.properties.facts.items;
  assert.equal(factSchema.anyOf, undefined);
  assert.match(factSchema.properties.objectCanonicalKey.description, /execution layer rejects/);
  assert.match(factSchema.properties.objectValue.description, /execution layer rejects/);
  assert.match(factSchema.properties.sourceEvidenceIds.description, /not named evidenceIds/);
  assert.ok(factSchema.properties.evidenceProfile.properties.method.enum.includes("static_analysis"));
  assert.equal(factSchema.properties.evidenceProfile.properties.scope.properties.repository.type, "string");
});

test("manual capture, revision, and annotation share the same open knowledge scope", () => {
  const tools = plugin.tools((definition) => definition);
  for (const name of ["shadow_context_capture", "shadow_context_revise", "shadow_context_annotate"]) {
    const definition = tools.find((candidate) => candidate.name === name);
    assert.equal(definition.parameters.properties.scope.additionalProperties, false);
    assert.equal(definition.parameters.properties.scope.properties.projectKey.type, "string");
    assert.equal(definition.parameters.properties.scope.properties.repository.type, "string");
    assert.equal(definition.parameters.properties.scope.properties.topic.type, "string");
  }
});

test("manual knowledge capture stores a ready card pending semantic review", () => {
  const databasePath = path.join(os.tmpdir(), `shadow-context-capture-${process.pid}-${Date.now()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  try {
    const input = {
      sourceType: "dialogue",
      title: "人工确认的维护规则",
      content: "用户明确说明：通信协议重构属于激光跟踪软件。",
      summary: "通信协议重构在工作归类时应归入激光跟踪软件。",
      keywords: ["通信协议", "激光跟踪软件", "工作归类"],
      retrievalCues: ["通信协议重构归到哪个项目", "日报应该如何分类通信工作"],
      scope: { domain: "daily-report" },
      generatedBy: "test",
    };
    const first = captureKnowledge(store.db, input);
    const second = captureKnowledge(store.db, input);
    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
    assert.equal(first.graphReviewStatus, "pending");
    assert.equal(store.db.prepare("SELECT kind FROM evidence WHERE id=?").get(first.evidenceId).kind, "manual_knowledge");
    const annotation = store.db.prepare("SELECT status, keywords_json, retrieval_cues_json, metadata_json FROM graph_episode_annotations WHERE evidence_id=?").get(first.evidenceId);
    assert.equal(annotation.status, "ready");
    assert.equal(JSON.parse(annotation.keywords_json).length, 3);
    assert.equal(JSON.parse(annotation.retrieval_cues_json).length, 2);
    assert.equal(JSON.parse(annotation.metadata_json).graphReview.status, "pending");
    assert.equal(store.db.prepare("SELECT status FROM graph_enrichment_queue WHERE evidence_id=?").get(first.evidenceId).status, "pending");
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

test("Chinese query preserves semantic knowledge under 8KB and keeps 64KB queries compact", () => {
  const databasePath = path.join(os.tmpdir(), `shadow-context-query-${process.pid}-${Date.now()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  try {
    const fixture = seedBoundedQueryFixture(store);
    const small = queryContext(store.db, {
      query: "通信协议重构",
      depth: 1,
      maxBytes: 8_192,
    });
    assert.ok(small.bytes <= 8_192);
    assert.equal(small.bytes, serializedBytes(small));
    assert.equal(small.maxBytes, 8_192);
    assert.equal(small.selected.total,
      Object.entries(small.selected).filter(([key]) => key !== "total").reduce((sum, [, count]) => sum + count, 0));
    assert.equal(small.dropped.total,
      Object.entries(small.dropped).filter(([key]) => key !== "total").reduce((sum, [, count]) => sum + count, 0));
    assert.ok(small.items.some((item) => item.type === "knowledge_unit"
      && item.value.evidence_id === fixture.keyEvidenceId
      && item.value.summary.includes("通信协议重构归入激光跟踪软件")));
    assert.ok(small.items.some((item) => item.type === "entity" && item.value.id === fixture.softwareId));
    assert.ok(small.items.some((item) => item.type === "fact" && item.value.id === fixture.factId));
    assert.ok(small.items.some((item) => item.type === "evidence_assessment"
      && item.value.fact_id === fixture.factId));
    assert.ok(small.dropped.review_pending > 0);
    assert.ok(small.reviewPending.every((item) => item.reviewStatus === "pending"));

    const normal = queryContext(store.db, {
      query: "通信协议重构",
      depth: 1,
      maxBytes: 65_536,
    });
    assert.ok(normal.bytes < 32_768, `expected a compact query, got ${normal.bytes} bytes`);
    assert.equal(normal.bytes, serializedBytes(normal));
    assert.ok(normal.selected.evidence <= 3);
    const rawEvidence = normal.items.filter((item) => item.type === "evidence");
    assert.ok(rawEvidence.length > 0);
    assert.ok(rawEvidence.every((item) => Buffer.byteLength(item.value.content, "utf8") <= 640));
    assert.ok(rawEvidence.some((item) => item.value.content.includes("通信协议重构")));

    const startedAt = performance.now();
    queryContext(store.db, { query: "通信协议重构", depth: 1, maxBytes: 8_192 });
    assert.ok(performance.now() - startedAt < 5_000, "bounded context query exceeded the 5s regression budget");
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

test("status reports review-needed queue and ready-card graph review counts", () => {
  const databasePath = path.join(os.tmpdir(), `shadow-context-status-${process.pid}-${Date.now()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  try {
    const fixture = seedBoundedQueryFixture(store);
    store.db.prepare("UPDATE graph_episode_annotations SET review_status='completed', review_outcome='facts_recorded' WHERE evidence_id=?")
      .run(fixture.keyEvidenceId);
    store.db.prepare("UPDATE graph_episode_annotations SET review_status='completed', review_outcome='no_durable_facts' WHERE evidence_id=?")
      .run(fixture.distractorEvidenceIds[0]);
    store.db.prepare("UPDATE graph_enrichment_queue SET status='review_needed' WHERE evidence_id=?")
      .run(fixture.distractorEvidenceIds[1]);

    const status = contextStatus(store.db);
    assert.equal(status.enrichmentReviewNeededCount, 1);
    assert.equal(status.graphReviewReadyCounts.facts_recorded, 1);
    assert.equal(status.graphReviewReadyCounts.no_durable_facts, 1);
    assert.equal(status.graphReviewReadyCounts.pending, 9);
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

test("active task changes and condition outcomes require one result checkpoint before acknowledgement", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-task-checkpoint-"));
  const databasePath = path.join(root, "shadow.sqlite");
  const workboardPath = path.join(root, "workboard.sqlite");
  const store = openV4TestDatabase(databasePath);
  const workboard = new DatabaseSync(workboardPath);
  const config = { databasePath, workboardDatabasePath: workboardPath };
  try {
    workboard.exec(`
      CREATE TABLE workboard_cards(
        id TEXT PRIMARY KEY, title TEXT, status TEXT, archived_at INTEGER,
        execution_status TEXT, execution_session_key TEXT,
        execution_run_id TEXT, automation_json TEXT
      );
      INSERT INTO workboard_cards VALUES(
        'task-active', '核对构建结果', 'running', NULL,
        NULL, NULL, NULL, '{}'
      );
      INSERT INTO workboard_cards VALUES(
        'task-codex', '执行代码修复', 'ready', NULL,
        NULL, NULL, NULL, '{}'
      );
      INSERT INTO workboard_cards VALUES(
        'task-done', '已完成任务', 'done', NULL,
        NULL, NULL, NULL, '{}'
      );
    `);
    emitContextChange(store.db, {
      eventKey: "checkpoint-active",
      kind: "task_progress_due",
      sessionKey: "agent:main:shadow:test",
      summary: "活动任务到达结果复查时间",
      metadata: { taskId: "task-active" },
    });
    const activeChange = store.db.prepare("SELECT seq FROM context_changes WHERE event_key='checkpoint-active'").get();
    store.db.prepare("UPDATE context_changes SET status='leased', lease_owner='checkpoint-test' WHERE seq=?")
      .run(activeChange.seq);

    assert.throws(() => acknowledgeChanges(store.db, {
      sequences: [activeChange.seq],
      leaseOwner: "checkpoint-test",
      disposition: "processed",
      note: "已检查",
    }, config), /requires shadow_task_checkpoint/);
    assert.throws(() => recordTaskCheckpoint(store.db, config, {
      ...checkpointVersionInput(),
      taskId: "task-active",
      changeSeq: activeChange.seq,
      leaseOwner: "checkpoint-test",
      resultState: "unchanged",
      resultSummary: "构建结果尚未生成",
    }), /requires a structured continuation/);

    const nextReviewAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const checkpoint = recordTaskCheckpoint(store.db, config, {
      ...checkpointVersionInput(),
      taskId: "task-active",
      changeSeq: activeChange.seq,
      leaseOwner: "checkpoint-test",
      resultState: "unchanged",
      resultSummary: "已核对构建记录，当前没有新的成功产物",
      continuation: {
        kind: "internal_review",
        summary: "一小时后复查同一构建记录",
        nextReviewAt,
      },
    });
    assert.equal(checkpoint.continuation.kind, "internal_review");
    const acknowledged = acknowledgeChanges(store.db, {
      sequences: [activeChange.seq],
      leaseOwner: "checkpoint-test",
      disposition: "processed",
      note: "已核对结果并留下复查触发",
    }, config);
    assert.equal(acknowledged.updated, 1);
    const attention = store.db.prepare("SELECT * FROM work_task_attention WHERE card_id='task-active'").get();
    assert.equal(attention.continuation_kind, "internal_review");
    assert.equal(attention.continuation_change_seq, activeChange.seq);
    assert.equal(attention.last_result_state, "unchanged");
    assert.match(attention.last_result_summary, /没有新的成功产物/);

    const condition = store.createConditionWatch({
      idempotencyKey: "task-condition-checkpoint",
      title: "等待构建确认",
      conditionText: "收到构建结果",
      selector: { kinds: ["feishu_message"], conversationKeys: ["im:test"] },
      taskId: "task-active",
      sessionKey: "agent:main:shadow:test",
      timeoutAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    const candidateAt = new Date().toISOString();
    store.db.prepare("UPDATE condition_watches SET status='candidate', candidate_at=?, updated_at=? WHERE id=?")
      .run(candidateAt, candidateAt, condition.id);
    store.db.prepare(`
      UPDATE work_task_attention
      SET last_result_checked_at='1970-01-01T00:00:00.000Z',
        continuation_recorded_at='1970-01-01T00:00:00.000Z'
      WHERE card_id='task-active'
    `).run();
    const tools = Object.fromEntries(plugin.tools((definition) => definition).map((definition) => [definition.name, definition]));
    await assert.rejects(() => tools.shadow_condition_resolve.execute({
      watchId: condition.id,
      disposition: "satisfied",
      note: "收到构建结果",
    }, { ...config, reuseConnections: false }), /fresh shadow_task_checkpoint/);
    recordTaskCheckpoint(store.db, config, {
      ...checkpointVersionInput(1),
      taskId: "task-active",
      resultState: "progressed",
      resultSummary: "回复确认构建已结束，但尚未完成人工验收",
      continuation: {
        kind: "condition_watch",
        summary: "错误地继续引用即将关闭的同一条件",
        referenceId: condition.id,
      },
    });
    await assert.rejects(() => tools.shadow_condition_resolve.execute({
      watchId: condition.id,
      disposition: "satisfied",
      note: "收到构建结果",
    }, { ...config, reuseConnections: false }), /same closing watch/);
    assert.throws(() => recordTaskCheckpoint(store.db, config, {
      ...checkpointVersionInput(2),
      taskId: "task-active",
      resultState: "progressed",
      resultSummary: "回复确认构建已结束，下一步等待人工验收",
      continuation: {
        kind: "requires_user",
        summary: "请用户确认构建产物是否满足实际验收要求",
      },
    }), /structured userAction/);
    recordTaskCheckpoint(store.db, config, {
      ...checkpointVersionInput(2),
      taskId: "task-active",
      resultState: "progressed",
      resultSummary: "回复确认构建已结束，下一步等待人工验收",
      continuation: {
        kind: "requires_user",
        summary: "请用户确认构建产物是否满足实际验收要求",
        userAction: {
          reason: "real_world_confirmation",
          request: "确认构建产物是否满足实际验收要求",
        },
      },
    });
    const resolvedCondition = await tools.shadow_condition_resolve.execute({
      watchId: condition.id,
      disposition: "satisfied",
      note: "构建条件已满足，原任务转入人工验收",
    }, { ...config, reuseConnections: false });
    assert.equal(resolvedCondition.status, "completed");
    assert.equal(resolvedCondition.reviewHistory.at(-1).taskCheckpoint.continuation.kind, "requires_user");
    assert.deepEqual(resolvedCondition.reviewHistory.at(-1).taskCheckpoint.continuation.userAction, {
      reason: "real_world_confirmation",
      request: "确认构建产物是否满足实际验收要求",
      blockedAction: null,
    });

    const codexCheckpoint = recordTaskCheckpoint(store.db, config, {
      ...checkpointVersionInput(),
      taskId: "task-codex",
      resultState: "progressed",
      resultSummary: "已派发有界 Codex 修复任务",
      continuation: {
        kind: "codex_run",
        summary: "等待同一 child session 返回修复和测试证据",
        referenceId: "run-codex-1",
        sessionKey: "agent:main:subagent:codex-1",
        model: "openai/gpt-5.6-sol",
      },
    });
    assert.equal(codexCheckpoint.continuation.referenceId, "run-codex-1");
    const reviewDelay = Date.parse(codexCheckpoint.continuation.nextReviewAt) - Date.parse(codexCheckpoint.recordedAt);
    assert.ok(reviewDelay >= 29 * 60_000 && reviewDelay <= 31 * 60_000);
    assert.equal(store.db.prepare("SELECT next_review_at FROM work_task_attention WHERE card_id='task-codex'").get().next_review_at,
      codexCheckpoint.continuation.nextReviewAt);
    const bindAction = store.db.prepare("SELECT * FROM controller_outbox WHERE action_type='bind_workboard_execution'").get();
    assert.ok(bindAction);
    assert.deepEqual(JSON.parse(bindAction.payload_json), {
      taskId: "task-codex",
      runId: "run-codex-1",
      sessionKey: "agent:main:subagent:codex-1",
      model: "openai/gpt-5.6-sol",
      startedAt: codexCheckpoint.recordedAt,
      resultSummary: "已派发有界 Codex 修复任务",
      checkpointKey: JSON.parse(bindAction.payload_json).checkpointKey,
      checkpointRevision: 1,
      bindingRevision: 1,
      ownerSessionKey: null,
      expectedExecution: { runId: null, sessionKey: null },
    });

    emitContextChange(store.db, {
      eventKey: "checkpoint-done",
      kind: "human_agent_operation",
      sessionKey: "agent:main:shadow:test",
      summary: "用户确认任务完成",
      metadata: { taskId: "task-done" },
    });
    const doneChange = store.db.prepare("SELECT seq FROM context_changes WHERE event_key='checkpoint-done'").get();
    store.db.prepare("UPDATE context_changes SET status='leased', lease_owner='checkpoint-test' WHERE seq=?")
      .run(doneChange.seq);
    assert.equal(acknowledgeChanges(store.db, {
      sequences: [doneChange.seq],
      leaseOwner: "checkpoint-test",
      disposition: "processed",
      note: "Workboard 已是终态",
    }, config).updated, 1);
  } finally {
    workboard.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
