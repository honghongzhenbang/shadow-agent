import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openDatabase } from "../src/db.mjs";
import {
  openClawTurnReceipt,
  pendingOpenClawTurn,
  runOpenClawTurn,
} from "../src/openclaw/cli.mjs";
import { processControllerOutbox } from "../src/controller-outbox.mjs";
import { recordAgentOperation, resolveTaskOwnerSession } from "../src/agent-operations.mjs";
import { evaluateConditionWatches, recoverConditionReviewActions } from "../src/condition-watches.mjs";
import { applyWorkboardOperation, bindWorkboardExecution } from "../src/workboard-operations.mjs";
import { emitContextChange } from "../src/context-graph.mjs";
import { completeKnowledgeAnnotation } from "../openclaw/shadow-work/src/epistemic.js";
import { nextAttentionSession } from "../src/work-sessions.mjs";
import { captureNativeSendBefore, captureNativeSendAfter, readNativeRunStart,
  nativeSendIdentity, createNativeSendObserver } from "../openclaw/shadow-work/src/native-continuation.mjs";

// Match the existing plugin tests: stub SDK registration only, keep all business code and I/O real.
const isolatedPluginUrl = new URL("../openclaw/shadow-work/src/index.js?runtime-boundary-recovery", import.meta.url).href;
const sdkUrl = `data:text/javascript,${encodeURIComponent(`
  export function defineToolPlugin(value) {
    return Object.assign(value, { register(api) {
      for (const definition of value.tools(item => item)) api.registerTool(definition);
    } });
  }
`)}`;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === isolatedPluginUrl) {
      if (specifier === "openclaw/plugin-sdk/tool-plugin") return { url: sdkUrl, shortCircuit: true };
      if (specifier === "openclaw/plugin-sdk/core") return {
        url: "data:text/javascript,export function delegateCompactionToRuntime(){throw new Error('Runtime forbidden')}",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
let checkpointModule;
try {
  checkpointModule = await import(isolatedPluginUrl);
} finally {
  hook.deregister();
}
const { recordTaskCheckpoint, acknowledgeChanges, workFocus, attentionPacket } = checkpointModule;
const checkpointTools = Object.fromEntries(checkpointModule.default.tools(item => item).map(item => [item.name, item]));

const NO_RUNTIME = "runtime-boundary-recovery:no-runtime";
const config = { projectRoot: NO_RUNTIME };
const forbidden = () => assert.fail("Unexpected external dependency in isolated recovery test");
const success = (text = "Execution result, not business acceptance.") => ({
  status: "ok",
  endedAt: Date.now(),
  terminalReply: { disposition: "visible", text },
});

function memoryStore(t) {
  const store = openDatabase(":memory:");
  store.setSetting("contextGraph:version", "epistemic-context-v4");
  t.after(() => store.close());
  return store;
}

function turn(store, overrides = {}) {
  return {
    stateStore: store,
    sessionKey: "agent:main:isolated-recovery",
    idempotencyKey: "request-1",
    message: "Inspect the isolated fixture only.",
    observeOnce: true,
    ...overrides,
  };
}

function gateway(handlers = {}) {
  const calls = [];
  return {
    calls,
    connections: 0,
    stops: 0,
    async connect() { this.connections += 1; },
    stop() { this.stops += 1; },
    async request(method, params) {
      calls.push({ method, params });
      if (handlers[method]) return handlers[method](params);
      if (method === "agent") return { runId: "accepted-run-1" };
      if (method === "agent.wait") return success();
      if (method === "chat.history") return { messages: [] };
      return forbidden();
    },
  };
}

function offlineGateway() {
  return { connect: forbidden, request: forbidden, stop() {} };
}

function run(input, client, overrides = {}) {
  return runOpenClawTurn(NO_RUNTIME, input, {
    client,
    readNativeTerminal: () => null,
    nativeRunAbsent: () => false,
    ...overrides,
  });
}

function processOutbox(store, dependencies = {}) {
  return processControllerOutbox(store, config, { dependencies: {
    wake: forbidden,
    runCli: forbidden,
    sendFeishu: forbidden,
    applyWorkboardOperation: forbidden,
    bindWorkboardExecution: forbidden,
    runDirectInputConversation: forbidden,
    listWorkboardCards: forbidden,
    scheduleAttention: forbidden,
    ...dependencies,
  } });
}

function actionRow(store, id) {
  return store.db.prepare("SELECT * FROM controller_outbox WHERE id=?").get(id);
}

function readyAgain(store, id) {
  store.db.prepare("UPDATE controller_outbox SET next_attempt_at=? WHERE id=?")
    .run(new Date(0).toISOString(), id);
}

function enqueueWake(store, input) {
  return store.enqueueControllerAction({
    idempotencyKey: input.idempotencyKey,
    actionType: "wake_condition",
    payload: { sessionKey: input.sessionKey, text: input.message },
  });
}

// Transport fixture only: mutations come from the real Workboard adapter.
function workboard(card, { afterComment = () => {} } = {}) {
  const calls = [];
  return {
    calls,
    async invokeTool(name, args) {
      calls.push({ name, args });
      assert.equal(args.id, card.id);
      if (name === "workboard_read") return { output: { details: { card: structuredClone(card) } } };
      if (name === "workboard_comment") {
        card.metadata.comments.push({ body: args.body });
        afterComment();
        return { ok: true };
      }
      if (name === "workboard_proof") {
        card.metadata.proof.push({ status: args.status, label: args.label?.trim(), note: args.note?.trim() });
        return { ok: true };
      }
      return forbidden();
    },
    async request(method, args) {
      calls.push({ name: method, args });
      assert.equal(args.id, card.id);
      if (method === "workboard.cards.move") card.status = args.status;
      else if (method === "workboard.cards.update") Object.assign(card, args.patch);
      else return forbidden();
      return { card: structuredClone(card) };
    },
  };
}

function card(id, status = "ready") {
  return { id, title: id, status, metadata: { comments: [], proof: [] } };
}

test("C01: lost acceptance acknowledgement persists identity before submission and never resubmits", async (t) => {
  const store = memoryStore(t);
  const input = turn(store);
  const first = gateway({ agent: ({ idempotencyKey }) => {
    const receipt = pendingOpenClawTurn(store, input.sessionKey);
    assert.equal(receipt.state, "submitting");
    assert.equal(receipt.requestId, idempotencyKey);
    throw new Error("Accepted remotely; acknowledgement dropped");
  } });
  await assert.rejects(run(input, first), { code: "OPENCLAW_RUN_UNCONFIRMED" });
  assert.equal(openClawTurnReceipt(store, input.sessionKey, input.idempotencyKey).state, "unconfirmed");

  const pending = gateway({ "agent.wait": () => ({ status: "pending" }) });
  await assert.rejects(run(input, pending), { code: "OPENCLAW_RUN_PENDING" });
  const recovered = gateway();
  await run(input, recovered);
  assert.deepEqual(pending.calls.map(({ method }) => method), ["agent.wait"]);
  assert.equal(recovered.calls[0].params.runId, input.idempotencyKey);
  assert.equal([first, pending, recovered].flatMap(({ calls }) => calls)
    .filter(({ method }) => method === "agent").length, 1);
  assert.equal(pendingOpenClawTurn(store, input.sessionKey), null);
});

test("C02 GAP: lost acknowledgement with an unavailable request-to-run alias remains unresolved", async (t) => {
  const store = memoryStore(t);
  const input = turn(store);
  await assert.rejects(run(input, gateway({ agent: () => {
    throw new Error("Accepted as a different backend run; acknowledgement dropped");
  } })), { code: "OPENCLAW_RUN_UNCONFIRMED" });
  const unknown = gateway({
    "agent.wait": ({ runId }) => {
      assert.equal(runId, input.idempotencyKey);
      return { status: "timeout", runKnown: false };
    },
  });
  await assert.rejects(run(input, unknown), { code: "OPENCLAW_RUN_UNCONFIRMED" });
  assert.equal(pendingOpenClawTurn(store, input.sessionKey).runId, input.idempotencyKey);
  assert.equal(unknown.calls.some(({ method }) => method === "agent"), false);
  await assert.rejects(run(turn(store, { idempotencyKey: "replacement" }), offlineGateway()), {
    code: "OPENCLAW_SESSION_RECONCILIATION_REQUIRED",
  });
});

test("C03: lost completion observation recovers the exact native run while the transport is offline", async (t) => {
  const store = memoryStore(t);
  const input = turn(store);
  const first = gateway({ "agent.wait": () => { throw new Error("Completion notification lost"); } });
  await assert.rejects(run(input, first), { code: "OPENCLAW_RUN_UNCONFIRMED" });
  let nativeReads = 0;
  const recovered = await run(input, offlineGateway(), { readNativeTerminal: (root, sessionKey, runId) => {
    nativeReads += 1;
    assert.equal(root, NO_RUNTIME);
    assert.equal(sessionKey, input.sessionKey);
    assert.equal(runId, "accepted-run-1");
    return success("Offline native result.");
  } });
  assert.equal(nativeReads, 1);
  assert.equal(recovered.text, "Offline native result.");
  assert.equal(recovered.metrics.historyComplete, false);
  assert.equal(openClawTurnReceipt(store, input.sessionKey, input.idempotencyKey).state, "completed");
  const replay = await run(input, offlineGateway(), { readNativeTerminal: forbidden });
  assert.equal(replay.payload.replayed, true);
  assert.equal(pendingOpenClawTurn(store, input.sessionKey), null);
});

test("C04: persisted terminal survives a failed final-result write and completes offline", async (t) => {
  const store = memoryStore(t);
  const input = turn(store);
  const setSetting = store.setSetting.bind(store);
  let injected = false;
  t.mock.method(store, "setSetting", (key, value) => {
    if (!injected && key.startsWith("controller:turn:") && JSON.parse(value).state === "completed") {
      injected = true;
      throw new Error("Injected failure before final receipt write");
    }
    return setSetting(key, value);
  });
  await assert.rejects(run(input, gateway()), /before final receipt write/);
  const saved = openClawTurnReceipt(store, input.sessionKey, input.idempotencyKey);
  assert.equal(injected, true);
  assert.equal(saved.state, "running");
  assert.equal(saved.terminal.status, "ok");
  assert.equal(saved.result, undefined);
  const recovered = await run(input, offlineGateway(), { readNativeTerminal: forbidden });
  assert.equal(recovered.text, saved.terminal.terminalReply.text);
  assert.equal(pendingOpenClawTurn(store, input.sessionKey), null);
});

test("C05: result committed before outbox completion retries offline without another execution", async (t) => {
  const store = memoryStore(t);
  const input = turn(store);
  const action = enqueueWake(store, input);
  const finish = store.finishControllerAction.bind(store);
  let injected = false;
  t.mock.method(store, "finishControllerAction", (id, result) => {
    if (id === action.id && result.status === "completed" && !injected) {
      injected = true;
      throw new Error("Consumer interrupted before outbox completion");
    }
    return finish(id, result);
  });
  const client = gateway();
  const wake = (transport) => (_root, message, sessionKey, options) =>
    run({ ...options, message, sessionKey }, transport);
  assert.equal((await processOutbox(store, { wake: wake(client) })).retried, 1);
  assert.equal(actionRow(store, action.id).status, "retry");
  assert.equal(openClawTurnReceipt(store, input.sessionKey, input.idempotencyKey).state, "completed");
  readyAgain(store, action.id);
  assert.equal((await processOutbox(store, { wake: wake(offlineGateway()) })).completed, 1);
  assert.equal(client.calls.filter(({ method }) => method === "agent").length, 1);
  assert.equal(actionRow(store, action.id).attempts, 2);
  assert.equal((await processOutbox(store)).claimed, 0);
});

test("C06: late duplicate receipt cannot displace a newer unresolved turn or reuse a different message", async (t) => {
  const store = memoryStore(t);
  const oldInput = turn(store);
  await run(oldInput, gateway());
  const newInput = turn(store, { idempotencyKey: "request-2", message: "Newer work." });
  await assert.rejects(run(newInput, gateway({
    agent: () => ({ runId: "accepted-run-2" }),
    "agent.wait": () => ({ status: "pending" }),
  })), { code: "OPENCLAW_RUN_PENDING" });
  const before = pendingOpenClawTurn(store, newInput.sessionKey);
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await run(oldInput, offlineGateway())).payload.replayed, true);
    assert.deepEqual(pendingOpenClawTurn(store, newInput.sessionKey), before);
  }
  await assert.rejects(run({ ...oldInput, message: "Different payload." }, offlineGateway()), /different message/);
  assert.deepEqual(pendingOpenClawTurn(store, newInput.sessionKey), before);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'controller:turn:%'").get().n, 2);
});

test("C07: Workboard effect acknowledgement loss rechecks the operation marker and schedules one attention row", async (t) => {
  const store = memoryStore(t);
  const target = card("effect-loss");
  const input = {
    operationId: "comment-operation",
    card: target,
    action: "direct_next_step",
    targetType: "workboard_task",
    targetId: target.id,
    workboardEffect: { cardId: target.id, effect: "task_instruction_comment", comment: "Inspect existing effects." },
  };
  const operation = recordAgentOperation(store, input);
  let dropped = false;
  const client = workboard(target, { afterComment: () => {
    if (!dropped) {
      dropped = true;
      throw new Error("Comment persisted but acknowledgement lost");
    }
  } });
  const dependencies = { applyWorkboardOperation: (payload) => applyWorkboardOperation(client, payload) };
  assert.equal((await processOutbox(store, dependencies)).retried, 1);
  assert.equal(target.metadata.comments.length, 1);
  const metadata = () => JSON.parse(store.db.prepare("SELECT metadata_json FROM context_changes WHERE event_key=?")
    .get("agent-operation:comment-operation").metadata_json);
  assert.equal(metadata().appliedStatus, "queued");
  readyAgain(store, operation.action.id);
  assert.equal((await processOutbox(store, dependencies)).completed, 1);
  assert.equal(metadata().appliedStatus, "applied");
  assert.equal(target.metadata.comments.length, 1);
  assert.equal(target.status, "ready");
  assert.equal(recordAgentOperation(store, input).duplicate, true);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM controller_outbox WHERE action_type='schedule_attention'").get().n, 1);
  let scheduled = 0;
  await processOutbox(store, { scheduleAttention: ({ operationId, sessionKey }) => {
    scheduled += 1;
    assert.equal(operationId, operation.operationId);
    assert.equal(sessionKey, operation.owner.sessionKey);
  } });
  assert.equal(scheduled, 1);
  assert.equal((await processOutbox(store)).claimed, 0);
});

test("C08 GAP: attention delivery is at least once when the scheduler acknowledgement is lost", async (t) => {
  const store = memoryStore(t);
  const operation = recordAgentOperation(store, {
    operationId: "schedule-loss",
    action: "direct_next_step",
    targetType: "workboard_task",
    targetId: "schedule-card",
    card: card("schedule-card"),
  });
  const deliveries = [];
  const scheduleAttention = (payload) => {
    deliveries.push(payload);
    if (deliveries.length === 1) throw new Error("Scheduler accepted; acknowledgement lost");
  };
  assert.equal((await processOutbox(store, { scheduleAttention })).retried, 1);
  readyAgain(store, operation.action.id);
  assert.equal((await processOutbox(store, { scheduleAttention })).completed, 1);
  assert.equal(deliveries.length, 2);
  assert.deepEqual(deliveries[0], deliveries[1]);
  assert.equal(deliveries[1].operationId, operation.operationId);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM controller_outbox").get().n, 1);
});

test("C09: human completion survives late runtime receipt recovery without a task-state write", async (t) => {
  const store = memoryStore(t);
  const target = card("human-closed", "running");
  const owner = resolveTaskOwnerSession(store, target);
  const input = turn(store, { sessionKey: owner.sessionKey });
  await assert.rejects(run(input, gateway({ "agent.wait": () => ({ status: "pending" }) })), {
    code: "OPENCLAW_RUN_PENDING",
  });
  recordAgentOperation(store, {
    operationId: "human-confirm-done",
    card: target,
    action: "confirm_done",
    targetType: "workboard_task",
    targetId: target.id,
    baseStatus: target.status,
    workboardEffect: { cardId: target.id, effect: "confirm_done", note: "User confirmed acceptance." },
  });
  const client = workboard(target);
  assert.equal((await processOutbox(store, {
    applyWorkboardOperation: (payload) => applyWorkboardOperation(client, payload),
  })).completed, 1);
  const afterHuman = structuredClone(target);
  const callCount = client.calls.length;
  const result = await run(input, offlineGateway(), { readNativeTerminal: () => success("Late old run result.") });
  assert.equal(result.text, "Late old run result.");
  assert.equal(target.status, "done");
  assert.deepEqual(target, afterHuman);
  assert.equal(client.calls.length, callCount);
  assert.equal(target.metadata.proof.length, 1);
  const metadata = JSON.parse(store.db.prepare("SELECT metadata_json FROM context_changes WHERE event_key=?")
    .get("agent-operation:human-confirm-done").metadata_json);
  assert.equal(metadata.effectResult.status, "done");
  assert.equal(openClawTurnReceipt(store, input.sessionKey, input.idempotencyKey).state, "completed");
});

test("C10: late execution binding cannot replace a newer run or a human terminal card", async () => {
  const target = card("late-binding", "running");
  target.execution = { runId: "newer-run", sessionKey: "newer-session", status: "running" };
  const client = workboard(target);
  const late = { taskId: target.id, runId: "older-run", sessionKey: "older-session", model: "fixture/model" };
  assert.equal((await bindWorkboardExecution(client, late)).skipped, true);
  await applyWorkboardOperation(client, { operationId: "close-newer", cardId: target.id, effect: "confirm_done" });
  target.execution.status = "done";
  const before = structuredClone(target);
  const result = await bindWorkboardExecution(client, late);
  assert.equal(result.status, "done");
  assert.equal(target.status, "done");
  assert.equal(target.execution.status, "done");
  assert.equal(result.reason, "terminal");
  assert.deepEqual(target, before);
  assert.equal(target.metadata.proof.length, 1);
});

test("C11: successful partial work does not resolve a condition or exhaust its semantic-review retry", async (t) => {
  const store = memoryStore(t);
  const watch = store.createConditionWatch({
    idempotencyKey: "partial-work",
    title: "Partial work",
    conditionText: "Acceptance still needs independent verification.",
    taskId: "partial-task",
    sessionKey: "agent:main:partial-task",
    status: "candidate",
  });
  const [actionId] = recoverConditionReviewActions(store);
  store.db.prepare("UPDATE controller_outbox SET attempts=10 WHERE id=?").run(actionId);
  const keys = [];
  const client = gateway({ "agent.wait": () => success("One substep completed; acceptance not checked.") });
  const dependencies = { wake: (_root, message, sessionKey, options) => {
    keys.push(options.idempotencyKey);
    return run({ ...options, message, sessionKey }, client);
  } };
  const first = await processOutbox(store, dependencies);
  assert.equal(first.completed, 0);
  assert.equal(first.retried, 1);
  assert.equal(first.failed, 0);
  assert.equal(store.conditionWatch(watch.id).status, "candidate");
  assert.match(store.conditionWatch(watch.id).last_error, /without resolving/);
  assert.equal(openClawTurnReceipt(store, watch.session_key, keys[0]).state, "completed");
  assert.equal(JSON.parse(actionRow(store, actionId).payload_json).reviewAttempt, 1);
  assert.equal((await processOutbox(store)).claimed, 0);
  readyAgain(store, actionId);
  assert.equal((await processOutbox(store, dependencies)).retried, 1);
  assert.equal(keys[1], `${keys[0]}:review:1`);
  assert.equal(store.conditionWatch(watch.id).status, "candidate");
});

test("C12: failed execution with partial assistant output cannot complete the outbox action", async (t) => {
  const store = memoryStore(t);
  const input = turn(store);
  const action = enqueueWake(store, input);
  const client = gateway({
    "agent.wait": () => ({ status: "error", endedAt: Date.now(), error: "Execution failed after one substep" }),
    "chat.history": () => ({ messages: [{
      role: "assistant", timestamp: Date.now() - 1000, content: "One substep is ready.", stopReason: "toolUse",
    }] }),
  });
  let executionError;
  const result = await processOutbox(store, { wake: async (_root, message, sessionKey, options) => {
    try {
      return await run({ ...options, message, sessionKey, historySinceAt: new Date(0).toISOString() }, client);
    } catch (error) {
      executionError = error;
      throw error;
    }
  } });
  assert.equal(executionError.code, "OPENCLAW_RUN_FAILED");
  assert.equal(executionError.partialText, "One substep is ready.");
  assert.equal(result.completed, 0);
  assert.equal(result.retried, 1);
  assert.equal(actionRow(store, action.id).status, "retry");
  assert.equal(openClawTurnReceipt(store, input.sessionKey, input.idempotencyKey).state, "failed");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM work_task_attention").get().n, 0);
});

test("C13: new human evidence routes a blocked task back to condition review without auto-completing it", async (t) => {
  const store = memoryStore(t);
  const target = card("blocked-task", "blocked");
  const owner = resolveTaskOwnerSession(store, target);
  const watch = store.createConditionWatch({
    idempotencyKey: "blocked-watch",
    title: "Await input",
    conditionText: "Review the user's new evidence.",
    taskId: target.id,
    sessionKey: owner.sessionKey,
    selector: { kinds: ["manual_knowledge"], threadIds: [owner.sessionKey] },
  });
  const humanInput = {
    operationId: "new-human-evidence",
    card: target,
    action: "direct_next_step",
    targetType: "workboard_task",
    targetId: target.id,
    knowledge: {
      action: "direct_next_step",
      targetType: "workboard_task",
      targetId: target.id,
      targetLabel: target.title,
      content: "Here is the missing observation; review it before resuming.",
    },
  };
  const operation = recordAgentOperation(store, humanInput);
  assert.equal(recordAgentOperation(store, humanInput).duplicate, true);
  const evaluated = evaluateConditionWatches(store);
  assert.equal(evaluated.candidates, 1);
  assert.deepEqual(JSON.parse(store.conditionWatch(watch.id).candidate_evidence_ids_json), [operation.knowledge.evidenceId]);
  assert.equal(evaluateConditionWatches(store).candidates, 0);
  assert.equal(recoverConditionReviewActions(store).length, 0);
  let scheduled = 0;
  let reviewed = 0;
  const result = await processOutbox(store, {
    scheduleAttention: ({ sessionKey }) => {
      scheduled += 1;
      assert.equal(sessionKey, owner.sessionKey);
    },
    wake: (_root, message, sessionKey, options) => {
      reviewed += 1;
      assert.equal(sessionKey, owner.sessionKey);
      assert.ok(message.includes(operation.knowledge.evidenceId));
      return run({ ...options, message, sessionKey }, gateway());
    },
  });
  assert.equal(scheduled, 1);
  assert.equal(reviewed, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.retried, 1);
  assert.equal(target.status, "blocked");
  assert.equal(store.conditionWatch(watch.id).status, "candidate");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE external_id=?")
    .get("agent-operation:new-human-evidence").n, 1);
});

test("C14: superseded condition generations are skipped and cancellation during a wake is preserved", async (t) => {
  const store = memoryStore(t);
  const watch = store.createConditionWatch({
    idempotencyKey: "generation-watch", title: "Wait", conditionText: "Review", status: "candidate",
  });
  const [oldId] = recoverConditionReviewActions(store);
  store.updateConditionWatch(watch.id, { candidateAt: "2026-10-20T00:00:00.000Z" });
  assert.equal((await processOutbox(store)).completed, 1);
  assert.equal(actionRow(store, oldId).status, "completed");
  const [newId] = recoverConditionReviewActions(store);
  assert.ok(newId);
  assert.notEqual(newId, oldId);
  let release;
  const processing = processOutbox(store, { wake: () => new Promise((resolve) => { release = resolve; }) });
  assert.equal(typeof release, "function");
  store.updateConditionWatch(watch.id, { status: "cancelled", resolutionNote: "Human closed the obligation." });
  release({ text: "Late model reply." });
  assert.equal((await processing).completed, 1);
  assert.equal(store.conditionWatch(watch.id).status, "cancelled");
  assert.equal(recoverConditionReviewActions(store).length, 0);
  assert.equal((await processOutbox(store)).claimed, 0);
});

function checkpointFixture(t, target) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, "sdagent-recovery-c-")));
  const pluginConfig = {
    databasePath: path.join(root, "shadow.sqlite"),
    workboardDatabasePath: path.join(root, "workboard.sqlite"),
    reuseConnections: false,
  };
  let store;
  let board;
  t.after(() => {
    board?.close();
    store?.close();
    const resolved = fs.realpathSync(root);
    assert.equal(resolved, root);
    assert.equal(path.dirname(resolved), tempRoot);
    assert.ok(path.basename(resolved).startsWith("sdagent-recovery-c-"));
    fs.rmSync(resolved, { recursive: true, force: true });
    assert.equal(fs.existsSync(resolved), false);
  });
  store = openDatabase(pluginConfig.databasePath);
  store.setSetting("contextGraph:version", "epistemic-context-v4");
  board = new DatabaseSync(pluginConfig.workboardDatabasePath);
  board.exec(`CREATE TABLE workboard_cards(
    id TEXT PRIMARY KEY, title TEXT, status TEXT, archived_at INTEGER,
    execution_status TEXT, execution_session_key TEXT, execution_run_id TEXT, automation_json TEXT
  )`);
  const setCard = (value) => {
    board.exec("PRAGMA query_only=OFF");
    board.prepare("INSERT OR REPLACE INTO workboard_cards VALUES(?, ?, ?, ?, ?, ?, ?, ?)").run(
      value.id, value.title, value.status, value.archivedAt ?? null,
      value.execution?.status ?? null, value.execution?.sessionKey ?? null,
      value.execution?.runId ?? null, JSON.stringify(value.automation ?? {}),
    );
    board.exec("PRAGMA query_only=ON");
  };
  setCard(target);
  return {
    root, store, board, pluginConfig, setCard,
    row: () => store.db.prepare("SELECT * FROM work_task_attention WHERE card_id=?").get(target.id),
    checkpoint: (input) => recordTaskCheckpoint(store.db, pluginConfig, { taskId: target.id, ...input }),
    resolve: (input) => checkpointTools.shadow_condition_resolve.execute(input, pluginConfig),
  };
}

function resultEvidence(store, runId) {
  const source = store.upsertSource({ sourceKey: "recovery-result", kind: "test", uri: "test://recovery-result" });
  return store.addEvidence({
    sourceId: source.id, kind: "project_document", title: `Observed ${runId}`,
    content: `Observed output from ${runId}; task acceptance is not established.`,
    sourceLocator: `test://recovery-result/${runId}`, externalId: runId,
    metadata: { runId },
  });
}

function progressPlan(expectedRevision, nextAction = "Inspect the remaining evidence") {
  return {
    expectedRevision, outcome: "Verify the isolated result", successCriteria: "Evidence meets acceptance",
    authorizedScope: "In-memory tests only", approach: "Inspect exact-run evidence",
    nextAction, stopCondition: "Stop at the authorization boundary", whyNow: "New evidence is available",
  };
}

function checkpointInput(evidenceId, overrides = {}) {
  return {
    expectedCheckpointRevision: 0, expectedBindingRevision: 1,
    expectedExecution: { runId: null, sessionKey: null },
    resultState: "progressed", resultSummary: "One verified substep; acceptance remains open.",
    evidenceIds: [evidenceId],
    continuation: {
      kind: "internal_review", summary: "Inspect the remaining evidence.",
      nextReviewAt: new Date(Date.now() + 3600000).toISOString(),
    },
    learning: {
      durableCandidates: ["The isolated result is reproducible within its stated scope."],
      keywords: ["recovery", "result", "scope"], retrievalCues: ["What was observed?", "What is unverified?"],
    },
    ...overrides,
  };
}

function checkpointSnapshot(fixture) {
  const focus = workFocus(fixture.store.db, fixture.pluginConfig, {
    taskId: fixture.board.prepare("SELECT id FROM workboard_cards").get().id,
  });
  return {
    expectedCheckpointRevision: focus.checkpointRevision,
    expectedBindingRevision: focus.bindingRevision,
    expectedExecution: focus.execution,
    ...(focus.ownerSessionKey ? { ownerSessionKey: focus.ownerSessionKey } : {}),
  };
}

function codexContinuation(runId) {
  return { kind: "codex_run", referenceId: runId, sessionKey: `session:${runId}`,
    model: "fixture/model", summary: `Observe exact execution ${runId}.` };
}

function continuationFixture(t) {
  const child = 'agent:main:subagent:owned-child';
  const target = { ...card('same-child', 'running'), execution: { runId: 'original', sessionKey: child, status: 'running' } };
  let native;
  t.after(() => native?.close());
  const f = checkpointFixture(t, target);
  const owner = resolveTaskOwnerSession(f.store, target).sessionKey;
  const filename = path.join(f.root, 'native.sqlite');
  native = new DatabaseSync(filename);
  native.exec('CREATE TABLE trajectory_runtime_events(run_id TEXT,session_id TEXT,seq INTEGER,event_json TEXT); CREATE INDEX run_lookup ON trajectory_runtime_events(run_id)');
  native.exec('CREATE TABLE session_nodes(session_key TEXT PRIMARY KEY,current_session_id TEXT,entry_valid INTEGER,archived_at TEXT,entry_json TEXT)');
  native.prepare('INSERT INTO session_nodes VALUES(?,?,1,NULL,?)').run(child, 'same-incarnation', JSON.stringify({ sessionId: 'same-incarnation' }));
  f.addRun = (runId, incarnation = 'same-incarnation', model = 'model') => {
    const event = { type: 'session.started', runId, sessionId: incarnation, sessionKey: child,
      ts: new Date().toISOString(), provider: 'fixture', modelId: model };
    native.prepare('INSERT INTO trajectory_runtime_events VALUES(?,?,?,?)').run(runId, incarnation, runId === 'original' ? 1 : 2, JSON.stringify(event));
  };
  f.addRun('original');
  const runtime = { sessionKey: owner };
  const identity = { sessionKey: owner, runId: 'owner-run', toolCallId: 'send-call' };
  const event = { params: { sessionKey: child, timeoutSeconds: 1, message: 'Use the new evidence.' } };
  const after = { ...event, result: { details: { status: 'accepted', runId: 'continuation', sessionKey: child } } };
  const rawCard = () => f.board.prepare('SELECT * FROM workboard_cards WHERE id=?').get(target.id);
  const version = checkpointSnapshot(f);
  const input = checkpointInput(resultEvidence(f.store, 'continuation').id, { taskId: target.id, ...version,
    idempotencyKey: 'new-native-checkpoint', continuation: { ...codexContinuation('continuation'), sessionKey: child } });
  return { ...f, target, child, owner, runtime, identity, event, after, input, native, filename,
    begin: () => captureNativeSendBefore(f.store.db, rawCard(), event, identity, filename),
    end: () => captureNativeSendAfter(f.store.db, after, identity),
    apply: (value = input) => recordTaskCheckpoint(f.store.db, f.pluginConfig, value, runtime),
  };
}

test('K4: trusted paired send and exact native incarnation bind one continuation through the existing outbox', async t => {
  const f = continuationFixture(t);
  assert.throws(() => f.apply(), /Trusted same-child/);
  assert.equal(f.begin().captured, true);
  assert.equal(f.begin().duplicate, true);
  assert.equal(f.end().eligible, true);
  assert.equal(f.end().duplicate, true);
  assert.throws(() => f.apply(), /Trusted same-child/, 'dispatch receipt alone is insufficient');
  f.addRun('continuation');
  assert.equal(readNativeRunStart(f.filename, 'continuation', f.child).sessionId, 'same-incarnation');
  const result = f.apply();
  assert.equal(result.applied, true);
  assert.equal(result.nativeContinuation.native.runId, 'continuation');
  const rows = f.store.db.prepare("SELECT * FROM controller_outbox WHERE action_type='bind_workboard_execution'").all();
  assert.equal(rows.length, 1);
  const payload = JSON.parse(rows[0].payload_json);
  assert.equal(payload.expectedExecution.runId, 'original');
  assert.equal(payload.runId, 'continuation');
  let writes = 0, current = f.target;
  const client = { invokeTool: async name => {
    assert.equal(name, 'workboard_read');
    return { output: { details: { card: current } } };
  }, request: async (method, params) => {
    assert.equal(method, 'workboard.cards.update');
    writes++;
    current = { ...current, execution: params.patch.execution };
    f.setCard(current);
    return { card: current };
  } };
  assert.equal((await bindWorkboardExecution(client, payload, { database: f.store.db })).skipped, undefined);
  await bindWorkboardExecution(client, payload, { database: f.store.db });
  assert.equal(writes, 1);
  assert.equal(current.status, 'running');
  assert.equal(f.apply().replayed, true);
  assert.equal(f.row().checkpoint_revision, 1);
  assert.equal(f.apply({ ...f.input, idempotencyKey: 'late-original', continuation: {
    ...f.input.continuation, referenceId: 'original' }, resultSummary: 'Late original result.' }).applied, false);
  assert.equal(f.row().continuation_reference_id, 'continuation');
  const settings = f.store.db.prepare("SELECT value FROM settings WHERE key LIKE 'native-send:%'").all();
  assert.equal(settings.length, 1);
  assert.ok(JSON.parse(settings[0].value).consumedBy);
  assert.ok(!settings[0].value.includes('Use the new evidence.'), 'message text is not duplicated');
});

test('K4: continuation receipt counterexamples do not change the card or create a binding', async t => {
  const cases = [
    ['missing before', f => { f.end(); }],
    ['missing after', f => { f.begin(); }],
    ['different caller', f => { f.begin(); captureNativeSendAfter(f.store.db, f.after, { ...f.identity, runId: 'other' }); }],
    ['different call', f => { f.begin(); captureNativeSendAfter(f.store.db, f.after, { ...f.identity, toolCallId: 'other' }); }],
    ['different owner', f => { f.begin(); captureNativeSendAfter(f.store.db, f.after, { ...f.identity, sessionKey: 'other' }); }],
    ['altered args', f => { f.begin(); f.after.params = { ...f.event.params, message: 'Altered' }; f.end(); }],
    ['wrong target', f => { f.begin(); f.after.result.details.sessionKey = 'wrong-child'; f.end(); }],
    ['zero wait', f => { f.event.params.timeoutSeconds = 0; f.begin(); f.end(); }],
    ['send failed', f => { f.begin(); f.after.result.details.status = 'error'; f.end(); }],
    ['pending error timeout', f => { f.begin(); f.after.result.details.status = 'timeout'; f.after.result.details.sentBeforeError = true; f.end(); }],
    ['top-level error', f => { f.begin(); f.after.error = 'error'; f.end(); }],
    ['error result', f => { f.begin(); f.after.result.isError = true; f.end(); }],
    ['no visible reply branch not yet enabled', f => { f.begin(); f.after.result.details.status = 'no_reply'; f.end(); }],
    ['reset child incarnation', f => { f.begin(); f.end(); f.native.prepare('DELETE FROM trajectory_runtime_events WHERE run_id=?').run('continuation'); f.addRun('continuation', 'new-incarnation'); }],
    ['reset after both run starts', f => { f.begin(); f.end(); f.native.exec("UPDATE session_nodes SET current_session_id='reset',entry_json='{\"sessionId\":\"reset\"}'"); }],
    ['archived child', f => { f.begin(); f.end(); f.native.exec("UPDATE session_nodes SET archived_at='2026-10-24'"); }],
    ['wrong resolved model', f => { f.begin(); f.end(); f.input.continuation.model = 'fiction/model'; }],
    ['old native time', f => { f.begin(); f.end(); f.addRun('continuation'); f.native.exec("UPDATE trajectory_runtime_events SET event_json=json_set(event_json,'$.ts','2000-01-01T00:00:00Z') WHERE run_id='continuation'"); }],
    ['ambiguous native start', f => { f.begin(); f.end(); f.addRun('continuation'); f.addRun('continuation'); }],
  ];
  for (const [name, setup] of cases) await t.test(name, tt => {
    const f = continuationFixture(tt);
    // Give the new start an unambiguously later timestamp than the before hook.
    setup(f);
    if (!readNativeRunStart(f.filename, 'continuation', f.child)
      && !['old native time', 'ambiguous native start'].includes(name)) f.addRun('continuation');
    assert.throws(() => f.apply(), /Trusted same-child/);
    assert.equal(f.row().checkpoint_revision, 0);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM controller_outbox WHERE action_type='bind_workboard_execution'").get().n, 0);
    assert.equal(f.board.prepare('SELECT execution_run_id FROM workboard_cards').get().execution_run_id, 'original');
  });
});

test('K4: positive-wait ok is native dispatch identity, not business acceptance', t => {
  const f = continuationFixture(t);
  f.begin();
  f.after.result.details.status = 'ok';
  f.after.result.details.reply = 'Claimed success must not become task completion.';
  assert.equal(f.end().eligible, true);
  f.addRun('continuation');
  assert.equal(f.apply().applied, true);
  assert.equal(f.board.prepare('SELECT status FROM workboard_cards').get().status, 'running');
});

test('K4: reset after checkpoint prevents the queued native continuation from rebinding', async t => {
  const f = continuationFixture(t);
  f.begin(); f.end(); f.addRun('continuation'); f.apply();
  const payload = JSON.parse(f.store.db.prepare("SELECT payload_json FROM controller_outbox WHERE action_type='bind_workboard_execution'").get().payload_json);
  f.native.exec("UPDATE session_nodes SET current_session_id='reset',entry_json='{\"sessionId\":\"reset\"}'");
  const client = { invokeTool: async () => ({ output: { details: { card: f.target } } }),
    request: async () => { throw new Error('Retired child must not be bound'); } };
  assert.equal((await bindWorkboardExecution(client, payload, { database: f.store.db })).reason, 'native_continuation_retired');
});

test('K4: native starts may flush after the paired send without losing its frozen version', t => {
  const f = continuationFixture(t);
  f.native.exec('DELETE FROM trajectory_runtime_events');
  assert.equal(f.begin().captured, true);
  assert.equal(f.end().eligible, true);
  assert.throws(() => f.apply(), /Trusted same-child/);
  f.addRun('original'); f.addRun('continuation');
  assert.equal(f.apply().applied, true);
});

test('K4: a subsequent codex checkpoint cannot cancel an authorized binding still in the outbox', t => {
  const f = continuationFixture(t);
  f.begin(); f.end(); f.addRun('continuation');
  f.apply();
  const before = f.store.db.prepare('SELECT * FROM controller_outbox').all();
  for (const referenceId of ['original', 'continuation']) assert.throws(() => f.apply({
    ...f.input, ...checkpointSnapshot(f), idempotencyKey: `pending-${referenceId}`,
    continuation: { ...f.input.continuation, referenceId },
  }), /binding is still pending/);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM controller_outbox').all(), before);
  assert.equal(f.row().checkpoint_revision, 1);
});

test('K4: native identity cannot be borrowed across owner generation or execution binding', async t => {
  for (const change of ['generation', 'execution', 'owner']) await t.test(change, tt => {
    const f = continuationFixture(tt);
    f.begin(); f.end(); f.addRun('continuation');
    if (change === 'generation') f.store.db.exec("UPDATE work_task_attention SET binding_revision=binding_revision+1");
    if (change === 'owner') f.store.db.exec("UPDATE work_task_attention SET owner_session_key='other-owner'");
    if (change === 'execution') f.setCard({ ...f.target, execution: { ...f.target.execution, runId: 'different' } });
    const current = { ...f.input, ...checkpointSnapshot(f) };
    assert.throws(() => f.apply(current), /Trusted same-child|owner.*match/);
  });
});

test('K4: delayed send after a newer checkpoint is not authorization to rebind', t => {
  const f = continuationFixture(t);
  f.begin();
  f.apply({ ...f.input, idempotencyKey: 'another-checkpoint', continuation: { ...f.input.continuation, referenceId: 'original' } });
  f.end(); f.addRun('continuation');
  const fresh = { ...f.input, ...checkpointSnapshot(f) };
  assert.throws(() => f.apply(fresh), /Trusted same-child/);
  assert.equal(f.row().continuation_reference_id, 'original');
});

test('K4: terminal closure and receipt/checkpoint rollback preserve the existing boundary', t => {
  const f = continuationFixture(t);
  f.begin(); f.end(); f.addRun('continuation');
  f.store.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON settings WHEN NEW.key LIKE 'task-checkpoint-receipt:%' BEGIN SELECT RAISE(ABORT,'receipt failure'); END;");
  assert.throws(() => f.apply(), /receipt failure/);
  assert.equal(f.row().checkpoint_revision, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM controller_outbox').get().n, 0);
  const key = f.store.db.prepare("SELECT key FROM settings WHERE key LIKE 'native-send:%'").get().key;
  assert.equal(JSON.parse(f.store.db.prepare('SELECT value FROM settings WHERE key=?').get(key).value).consumedBy, undefined);
  f.store.db.exec('DROP TRIGGER fail_receipt');
  f.setCard({ ...f.target, status: 'done' });
  assert.equal(f.apply().terminal, true);
  assert.equal(f.row().continuation_kind, null);
});

test('K4: host observer pairs native identities and exposes no model-submitted trusted envelope', async () => {
  const calls = [];
  const observer = createNativeSendObserver({ call: async (...args) => calls.push(args), resolveNativeDatabase: async () => 'isolated.sqlite' });
  const ctx = { sessionKey: 'owner', runId: 'host-run', toolCallId: 'host-call' };
  const event = { toolName: 'sessions_send', runId: 'host-run', toolCallId: 'host-call',
    params: { sessionKey: 'child', timeoutSeconds: 1 } };
  assert.equal(nativeSendIdentity(event, { ...ctx, runId: 'different' }), null);
  assert.equal(nativeSendIdentity(event, { ...ctx, toolCallId: 'different' }), null);
  await observer.before(event, ctx);
  await observer.after({ ...event, result: { details: { status: 'accepted', runId: 'native-run', sessionKey: 'child' } } }, ctx);
  assert.deepEqual(calls.map(call => call[0]), ['nativeSendBefore', 'nativeSendAfter']);
  assert.deepEqual(calls[0][1].identity, { sessionKey: 'owner', runId: 'host-run', toolCallId: 'host-call' });
});

test("G01a: stale progress-plan revision rejects the entire real checkpoint including learning", (t) => {
  const fixture = checkpointFixture(t, card("version-guard", "running"));
  const { store } = fixture;
  const old = checkpointInput(resultEvidence(store, "old-run").id, { progressPlan: progressPlan(0) });
  fixture.checkpoint(old);
  fixture.checkpoint(checkpointInput(resultEvidence(store, "new-run").id, {
    expectedCheckpointRevision: 1,
    resultSummary: "Newer observation has been checked.", progressPlan: progressPlan(1, "Use the newer evidence"),
  }));
  const before = fixture.row();
  const evidenceBefore = store.db.prepare("SELECT * FROM evidence ORDER BY id").all();
  const eventsBefore = store.db.prepare("SELECT * FROM context_changes ORDER BY seq").all();
  assert.throws(() => fixture.checkpoint({
    ...old, resultSummary: "A distinct stale result must not leak learning.",
  }), /read revision 2/);
  assert.deepEqual(fixture.row(), before);
  assert.deepEqual(store.db.prepare("SELECT * FROM evidence ORDER BY id").all(), evidenceBefore);
  assert.deepEqual(store.db.prepare("SELECT * FROM context_changes ORDER BY seq").all(), eventsBefore);
});

test("G01b: stale checkpoint without progressPlan preserves newer continuation and retains deduplicated learning", (t) => {
  const target = card("old-attempt", "running");
  target.execution = { runId: "old-run", sessionKey: "old-session", status: "running" };
  const fixture = checkpointFixture(t, target);
  const { store } = fixture;
  const old = checkpointInput(resultEvidence(store, "old-run").id, {
    expectedExecution: { runId: "old-run", sessionKey: "old-session" },
    resultSummary: "Old execution requires missing user input.",
    continuation: {
      kind: "requires_user", summary: "Wait for the old execution input.",
      userAction: { reason: "missing_input", request: "Provide the old execution input." },
    },
  });
  const first = fixture.checkpoint({ ...old, progressPlan: progressPlan(0) });
  target.execution = { runId: "new-run", sessionKey: "new-session", status: "running" };
  fixture.setCard(target);
  const current = fixture.checkpoint(checkpointInput(resultEvidence(store, "new-run").id, {
    expectedCheckpointRevision: 1,
    expectedExecution: { runId: "new-run", sessionKey: "new-session" },
    resultSummary: "New execution has resolved the missing input.", progressPlan: progressPlan(1),
  }));
  const before = fixture.row();
  const replay = fixture.checkpoint({ ...old, expectedCheckpointRevision: undefined });
  assert.equal(replay.learning.inserted, false);
  assert.equal(replay.learning.evidenceId, first.learning.evidenceId);
  assert.equal(replay.applied, false);
  assert.equal(replay.reason, "checkpoint_revision_changed");
  assert.deepEqual(fixture.row(), before);
  assert.equal(fixture.checkpoint(old).applied, false);
  assert.deepEqual(fixture.row(), before);
  assert.deepEqual(JSON.parse(fixture.row().progress_plan_json), current.progressPlan);
  assert.equal(fixture.board.prepare("SELECT execution_run_id FROM workboard_cards").get().execution_run_id, "new-run");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM context_changes WHERE evidence_id=? AND kind='knowledge_delta_due'")
    .get(first.learning.evidenceId).n, 1);
  const properties = checkpointTools.shadow_task_checkpoint.parameters.properties;
  for (const field of ["expectedCheckpointRevision", "expectedBindingRevision", "expectedExecution", "ownerSessionKey", "idempotencyKey"]) {
    assert.equal(Object.hasOwn(properties, field), true);
  }
});

test("G02a: human-closed task retains late checkpoint evidence and rejects progress-plan revision", async (t) => {
  const target = card("closed-evidence", "running");
  const fixture = checkpointFixture(t, target);
  const { store } = fixture;
  const evidence = resultEvidence(store, "late-run");
  const active = fixture.checkpoint(checkpointInput(evidence.id, { progressPlan: progressPlan(0) }));
  const operation = recordAgentOperation(store, {
    operationId: "human-close-with-proof", card: target, action: "confirm_done",
    targetType: "workboard_task", targetId: target.id, baseStatus: target.status,
    workboardEffect: { cardId: target.id, effect: "confirm_done", note: "User has accepted the business result." },
  });
  const client = workboard(target);
  await processOutbox(store, { applyWorkboardOperation: payload => applyWorkboardOperation(client, payload) });
  fixture.setCard(target);
  const closed = fixture.board.prepare("SELECT * FROM workboard_cards").get();
  const humanEvent = store.db.prepare("SELECT * FROM context_changes WHERE seq=?").get(operation.change.seq);
  const late = checkpointInput(evidence.id, {
    resultSummary: "Late run evidence retained after human completion.", continuation: undefined,
  });
  const result = fixture.checkpoint(late);
  assert.equal(result.terminal, true);
  assert.equal(result.cardStatus, "done");
  assert.equal(result.continuation, null);
  assert.equal(result.learning.inserted, true);
  const stored = store.db.prepare("SELECT * FROM evidence WHERE id=?").get(result.learning.evidenceId);
  assert.equal(stored.kind, "shadow_agent_task_result");
  assert.deepEqual(JSON.parse(stored.metadata_json).knowledgeDelta.sourceEvidenceIds, [evidence.id]);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM evidence_links WHERE parent_evidence_id=? AND child_evidence_id=? AND relation='summarizes'")
    .get(stored.id, evidence.id).n, 1);
  assert.equal(fixture.checkpoint(late).learning.inserted, false);
  assert.throws(() => fixture.checkpoint({ ...late, progressPlan: progressPlan(1) }), /terminal card/);
  assert.deepEqual(JSON.parse(fixture.row().progress_plan_json), active.progressPlan);
  assert.deepEqual(fixture.board.prepare("SELECT * FROM workboard_cards").get(), closed);
  assert.deepEqual(store.db.prepare("SELECT * FROM context_changes WHERE seq=?").get(operation.change.seq), humanEvent);
  assert.equal(target.metadata.proof.length, 1);
});

test("G02b: terminal checkpoint retains evidence without active continuation or queued binding", (t) => {
  const target = card("terminal-continuation", "done");
  target.execution = { runId: "late-run", sessionKey: "late-session", status: "done" };
  const fixture = checkpointFixture(t, target);
  const evidence = resultEvidence(fixture.store, "late-run");
  const result = fixture.checkpoint(checkpointInput(evidence.id, {
    continuation: {
      kind: "codex_run", summary: "Continue observing the late execution.",
      referenceId: "late-run", sessionKey: "late-session", model: "fixture/model",
    },
  }));
  assert.equal(result.terminal, true);
  assert.equal(fixture.board.prepare("SELECT status FROM workboard_cards").get().status, "done");
  assert.equal(result.applied, false);
  assert.equal(result.continuation, null);
  assert.ok(result.learning.evidenceId);
  assert.equal(fixture.row()?.continuation_kind ?? null, null);
  const actions = fixture.store.db.prepare("SELECT * FROM controller_outbox WHERE action_type='bind_workboard_execution'").all();
  assert.equal(actions.length, 0);
});

test("G03a: blocked task new evidence passes real checkpoint, condition resolution, acknowledgement and outbox", async (t) => {
  const target = card("semantic-resume", "blocked");
  const fixture = checkpointFixture(t, target);
  const { store, pluginConfig } = fixture;
  const owner = resolveTaskOwnerSession(store, target);
  const watch = store.createConditionWatch({
    idempotencyKey: "semantic-watch", title: "Await missing input", conditionText: "Review new user evidence.",
    taskId: target.id, sessionKey: owner.sessionKey,
    selector: { kinds: ["manual_knowledge"], threadIds: [owner.sessionKey] },
  });
  const operation = recordAgentOperation(store, {
    operationId: "semantic-human-input", card: target, action: "direct_next_step",
    targetType: "workboard_task", targetId: target.id,
    knowledge: { action: "direct_next_step", targetType: "workboard_task", targetId: target.id,
      content: "The missing observation is now available for internal verification." },
  });
  const evaluated = evaluateConditionWatches(store);
  assert.equal(evaluated.candidates, 1);
  store.db.prepare("UPDATE context_changes SET status='leased', lease_owner=? WHERE seq=?")
    .run("isolated-controller", operation.change.seq);
  const ack = { sequences: [operation.change.seq], leaseOwner: "isolated-controller", disposition: "processed" };
  await assert.rejects(fixture.resolve({ watchId: watch.id, disposition: "satisfied" }), /fresh shadow_task_checkpoint/);
  assert.throws(() => acknowledgeChanges(store.db, ack, pluginConfig), /requires shadow_task_checkpoint/);
  let checkpoint;
  const processed = await processOutbox(store, {
    scheduleAttention: () => {},
    wake: async (_root, message, sessionKey, options) => {
      assert.equal(sessionKey, owner.sessionKey);
      checkpoint = await checkpointTools.shadow_task_checkpoint.execute({
        taskId: target.id, changeSeq: operation.change.seq, leaseOwner: "isolated-controller",
        ...checkpointInput(operation.knowledge.evidenceId, { progressPlan: progressPlan(0) }),
        ownerSessionKey: owner.sessionKey, expectedBindingRevision: owner.attention.binding_revision,
      }, pluginConfig);
      await fixture.resolve({ watchId: watch.id, disposition: "satisfied", note: "Input checked; verification continues." });
      assert.equal(acknowledgeChanges(store.db, ack, pluginConfig).updated, 1);
      return run({ ...options, message, sessionKey }, gateway());
    },
  });
  assert.equal(processed.completed, 2);
  assert.equal(processed.retried, 0);
  assert.equal(store.conditionWatch(watch.id).status, "completed");
  const history = JSON.parse(store.conditionWatch(watch.id).metadata_json).reviewHistory;
  assert.equal(history.at(-1).taskCheckpoint.continuation.kind, "internal_review");
  assert.equal(fixture.row().continuation_kind, "internal_review");
  assert.ok(Date.parse(fixture.row().next_review_at) > Date.now());
  assert.equal(JSON.parse(fixture.row().progress_plan_json).revision, 1);
  assert.equal(store.db.prepare("SELECT status FROM context_changes WHERE seq=?").get(operation.change.seq).status, "acknowledged");
  assert.equal(fixture.board.prepare("SELECT status FROM workboard_cards").get().status, "blocked");
  assert.equal(actionRow(store, evaluated.actions[0]).status, "completed");
  assert.equal(recoverConditionReviewActions(store).length, 0);
  assert.equal((await processOutbox(store)).claimed, 0);
  assert.equal(store.db.prepare("SELECT kind FROM evidence WHERE id=?").get(checkpoint.learning.evidenceId).kind, "shadow_agent_task_result");
  assert.equal(fs.realpathSync(path.dirname(pluginConfig.workboardDatabasePath)), fixture.root);
});

test("K4: completed feedback review returns to the original blocked card and requires a fresh controller checkpoint", t => {
  const target = card("feedback-original", "blocked");
  const fixture = checkpointFixture(t, target);
  const { store, pluginConfig } = fixture;
  const operation = recordAgentOperation(store, {
    operationId: "feedback-rejudge", card: target, action: "direct_next_step",
    targetType: "workboard_task", targetId: target.id,
    knowledge: { action: "direct_next_step", targetType: "workboard_task", targetId: target.id,
      content: "The missing input is available; inspect it internally and stop asking for it." },
  });
  store.db.prepare("UPDATE context_changes SET status='acknowledged' WHERE seq=?").run(operation.change.seq);
  const reviewed = completeKnowledgeAnnotation(store.db, {
    evidenceId: operation.knowledge.evidenceId, summary: "One-time continuation instruction, not durable knowledge.",
    graphReview: { status: "completed", outcome: "no_durable_facts", rationale: "Use this input for this task only." },
  });
  const due = nextAttentionSession(store, { readyOnly: true });
  assert.equal(due.session_key, operation.owner.sessionKey);
  const seq = reviewed.taskReviewChanges[0].seq;
  fixture.board.exec(`PRAGMA query_only=OFF;
    ALTER TABLE workboard_cards ADD COLUMN notes TEXT;
    ALTER TABLE workboard_cards ADD COLUMN priority TEXT DEFAULT 'normal';
    ALTER TABLE workboard_cards ADD COLUMN updated_at INTEGER DEFAULT 0;
    PRAGMA query_only=ON;`);
  const packet = attentionPacket(store.db, pluginConfig, {
    sessionKey: operation.owner.sessionKey, leaseOwner: 'task-review', limit: 4, maxBytes: 12288,
  });
  const delivered = packet.changes.find(change => change.seq === seq);
  assert.equal(delivered.metadata.reason, 'knowledge_feedback_reviewed');
  assert.equal(delivered.metadata.graphReview.status, 'completed');
  assert.equal(delivered.metadata.graphReview.outcome, 'no_durable_facts');
  assert.equal(delivered.metadata.grantsAuthorization, false);
  assert.match(delivered.metadata.graphReview.rationale, /this task only/);
  const ack = { sequences: [seq], leaseOwner: "task-review", disposition: "processed" };
  assert.throws(() => acknowledgeChanges(store.db, ack, pluginConfig), /requires shadow_task_checkpoint/);
  const result = fixture.checkpoint(checkpointInput(operation.knowledge.evidenceId, {
    ...checkpointSnapshot(fixture), changeSeq: seq, leaseOwner: "task-review",
    resultSummary: "Input received and verified; no repeat request. Continue internal validation.",
  }));
  assert.equal(result.applied, true);
  assert.equal(acknowledgeChanges(store.db, ack, pluginConfig).updated, 1);
  assert.equal(fixture.row().continuation_kind, "internal_review");
  assert.match(fixture.row().last_result_summary, /no repeat request/);
  assert.equal(fixture.board.prepare("SELECT status FROM workboard_cards").get().status, "blocked");
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM context_changes WHERE kind='task_progress_due'").get().n, 1);
});

test("G03b: actual condition resolution enforces fresh checkpoint, continuation identity and structured user action", async (t) => {
  const fixture = checkpointFixture(t, card("continue-watch", "blocked"));
  const { store } = fixture;
  const evidence = resultEvidence(store, "condition-result");
  const watch = store.createConditionWatch({
    idempotencyKey: "continue-watch", title: "Wait", conditionText: "Review", taskId: "continue-watch", status: "candidate",
  });
  store.updateConditionWatch(watch.id, { candidateAt: new Date(Date.now() - 1000).toISOString() });
  assert.throws(() => fixture.checkpoint(checkpointInput(evidence.id, {
    continuation: { kind: "requires_user", summary: "A specific decision is needed." },
  })), /structured userAction/);
  assert.equal(fixture.row(), undefined);
  const input = checkpointInput(evidence.id, {
    continuation: { kind: "condition_watch", referenceId: watch.id, summary: "Inspect the next exact reply.",
      nextReviewAt: new Date(Date.now() + 3600000).toISOString() },
  });
  fixture.checkpoint(input);
  await assert.rejects(fixture.resolve({ watchId: watch.id, disposition: "satisfied" }), /same closing watch/);
  store.db.prepare("UPDATE work_task_attention SET last_result_checked_at=?, continuation_recorded_at=? WHERE card_id=?")
    .run(new Date(0).toISOString(), new Date(0).toISOString(), "continue-watch");
  await assert.rejects(fixture.resolve({ watchId: watch.id, disposition: "continue" }), /fresh shadow_task_checkpoint/);
  fixture.checkpoint({ ...input, expectedCheckpointRevision: 1 });
  const continued = await fixture.resolve({ watchId: watch.id, disposition: "continue", note: "The result is not yet sufficient." });
  assert.equal(continued.status, "active");
  assert.equal(continued.reviewHistory.at(-1).taskCheckpoint.continuation.referenceId, watch.id);
  assert.equal(store.conditionWatch(watch.id).candidate_at, null);
  assert.equal(store.conditionWatch(watch.id).timeout_at, input.continuation.nextReviewAt);
});

test("G03c: real checkpoint transaction rolls back result evidence and review events on persistence failure", (t) => {
  const fixture = checkpointFixture(t, card("checkpoint-rollback", "running"));
  const { store } = fixture;
  const evidence = resultEvidence(store, "rollback-run");
  fixture.checkpoint(checkpointInput(evidence.id, { progressPlan: progressPlan(0) }));
  const before = fixture.row();
  const counts = () => Object.fromEntries(["evidence", "evidence_links", "context_changes", "controller_outbox"]
    .map(table => [table, store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
  const beforeCounts = counts();
  store.db.exec(`CREATE TRIGGER reject_checkpoint_update BEFORE UPDATE ON work_task_attention
    BEGIN SELECT RAISE(ABORT, 'isolated-checkpoint-failure'); END`);
  assert.throws(() => fixture.checkpoint(checkpointInput(evidence.id, {
    expectedCheckpointRevision: 1,
    resultSummary: "New result and learning must roll back together.", progressPlan: progressPlan(1),
  })), /isolated-checkpoint-failure/);
  assert.deepEqual(fixture.row(), before);
  assert.deepEqual(counts(), beforeCounts);
  store.db.exec("DROP TRIGGER reject_checkpoint_update");
  assert.equal(fixture.checkpoint(checkpointInput(evidence.id, {
    expectedCheckpointRevision: 1, progressPlan: progressPlan(1),
  })).progressPlan.revision, 2);
});

test("G04: no-plan writes advance checkpoint revision; stale novel results are evidence-only and exact retries survive reopen", (t) => {
  const fixture = checkpointFixture(t, card("no-plan-race", "running"));
  const evidence = resultEvidence(fixture.store, "initial");
  const firstInput = checkpointInput(evidence.id, {
    idempotencyKey: "first-checkpoint", progressPlan: progressPlan(0),
  });
  const first = fixture.checkpoint(firstInput);
  const secondInput = checkpointInput(evidence.id, {
    ...checkpointSnapshot(fixture), resultSummary: "New decision without a plan revision.",
  });
  const second = fixture.checkpoint(secondInput);
  assert.equal(second.applied, true);
  assert.equal(second.checkpointRevision, 2);
  assert.deepEqual(second.progressPlan, first.progressPlan);
  const before = fixture.row();
  assert.equal(fixture.checkpoint(Object.fromEntries(Object.entries(firstInput).reverse())).replayed, true);
  const stale = fixture.checkpoint(checkpointInput(evidence.id, {
    resultSummary: "A distinct late callback from the old observation.",
    continuation: { kind: "codex_run", referenceId: "obsolete", summary: "An old continuation with no valid session." },
  }));
  assert.equal(stale.applied, false);
  assert.equal(stale.learning.inserted, true);
  assert.equal(fixture.store.db.prepare("SELECT kind FROM evidence WHERE id=?").get(stale.learning.evidenceId).kind,
    "shadow_agent_task_result");
  assert.deepEqual(fixture.row(), before);
  assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS n FROM controller_outbox").get().n, 0);
  assert.throws(() => fixture.checkpoint({ ...firstInput, resultSummary: "Reuse with a different result." }), /different request/);
  const reopened = openDatabase(fixture.pluginConfig.databasePath);
  try {
    const replay = recordTaskCheckpoint(reopened.db, fixture.pluginConfig, { taskId: "no-plan-race", ...firstInput });
    assert.equal(replay.replayed, true);
    assert.equal(replay.applied, false);
    assert.equal(replay.recordedAt, first.recordedAt);
    assert.equal(replay.learning.inserted, false);
  } finally {
    reopened.close();
  }
  assert.deepEqual(fixture.row(), before);
});

test("G05: owner generation, execution identity and cross-task sessions fence checkpoint writes", (t) => {
  const target = card("scoped-task", "running");
  const fixture = checkpointFixture(t, target);
  const { store } = fixture;
  const owner = resolveTaskOwnerSession(store, target);
  const other = resolveTaskOwnerSession(store, card("different-task"));
  const evidence = resultEvidence(store, "owner-result");
  const input = checkpointInput(evidence.id, checkpointSnapshot(fixture));
  assert.equal(fixture.checkpoint(input).applied, true);
  const before = fixture.row();
  const counts = () => store.db.prepare("SELECT COUNT(*) AS n FROM evidence").get().n;
  const evidenceCount = counts();
  assert.throws(() => fixture.checkpoint({ ...input, ...checkpointSnapshot(fixture),
    ownerSessionKey: other.sessionKey }), /different task/);
  assert.throws(() => fixture.checkpoint({ ...input, ...checkpointSnapshot(fixture),
    continuation: { ...codexContinuation("cross-task-child"), sessionKey: other.sessionKey } }), /different task/);
  // Even changes outside TASK_GUARDED_CHANGE_KINDS retain their persisted task-session scope.
  emitContextChange(store.db, { eventKey: "cross-task-untyped", kind: "knowledge_delta_due",
    sessionKey: other.sessionKey, summary: "Other task evidence.", metadata: {} });
  const change = store.db.prepare("SELECT seq FROM context_changes WHERE event_key='cross-task-untyped'").get();
  store.db.prepare("UPDATE context_changes SET status='leased', lease_owner='fixture' WHERE seq=?").run(change.seq);
  assert.throws(() => fixture.checkpoint({ ...input, ...checkpointSnapshot(fixture), ownerSessionKey: undefined,
    changeSeq: change.seq, leaseOwner: "fixture" }), /different task/);
  assert.deepEqual(fixture.row(), before);
  assert.equal(counts(), evidenceCount);

  const oldBinding = checkpointSnapshot(fixture);
  store.db.prepare("UPDATE work_task_attention SET binding_revision=binding_revision+1 WHERE card_id=?").run(target.id);
  const rebound = fixture.row();
  const lateOwner = fixture.checkpoint({ ...input, ...oldBinding, resultSummary: "Late callback from the prior binding." });
  assert.equal(lateOwner.reason, "binding_revision_changed");
  assert.equal(lateOwner.learning.inserted, true);
  assert.deepEqual(fixture.row(), rebound);

  const oldExecution = checkpointSnapshot(fixture);
  target.execution = { runId: "same-run-id", sessionKey: "new-execution-session", status: "running" };
  fixture.setCard(target);
  assert.equal(fixture.checkpoint({ ...input, ...oldExecution,
    resultSummary: "Late result before a new execution was attached." }).reason, "execution_changed");
  const next = checkpointSnapshot(fixture);
  target.execution.sessionKey = "different-execution-session";
  fixture.setCard(target);
  assert.equal(fixture.checkpoint({ ...input, ...next,
    resultSummary: "Same run id from another execution session." }).reason, "execution_changed");
  assert.deepEqual(fixture.row(), rebound);
  assert.equal(fixture.row().owner_session_key, owner.sessionKey);
});

test("G06: queued and already-claimed bindings cannot survive a newer continuation; current binding retries idempotently", async (t) => {
  const target = card("queued-generation", "ready");
  const fixture = checkpointFixture(t, target);
  const { store } = fixture;
  const evidence = resultEvidence(store, "queue-evidence");
  fixture.checkpoint(checkpointInput(evidence.id, { continuation: codexContinuation("obsolete-run") }));
  const oldAction = store.db.prepare("SELECT * FROM controller_outbox WHERE action_type='bind_workboard_execution'").get();
  const oldPayload = JSON.parse(oldAction.payload_json);
  const client = workboard(target);
  const invoke = client.invokeTool.bind(client);
  let advanced = false;
  client.invokeTool = async (...args) => {
    const result = await invoke(...args);
    if (!advanced) {
      advanced = true;
      assert.equal(actionRow(store, oldAction.id).status, "processing");
      fixture.checkpoint(checkpointInput(evidence.id, {
        ...checkpointSnapshot(fixture), continuation: codexContinuation("current-run"),
      }));
    }
    return result;
  };
  const bind = (payload, options) => {
    assert.equal(options.database, store.db);
    return bindWorkboardExecution(client, payload, options);
  };
  assert.equal((await processOutbox(store, { bindWorkboardExecution: bind })).completed, 1);
  assert.equal(target.execution, undefined);
  const currentAction = store.db.prepare("SELECT * FROM controller_outbox WHERE status='pending'").get();
  assert.ok(currentAction);
  const finish = store.finishControllerAction.bind(store);
  let dropped = false;
  t.mock.method(store, "finishControllerAction", (id, result) => {
    if (id === currentAction.id && result.status === "completed" && !dropped) {
      dropped = true;
      throw new Error("Binding committed; consumer completion was lost.");
    }
    return finish(id, result);
  });
  assert.equal((await processOutbox(store, { bindWorkboardExecution: bind })).retried, 1);
  assert.equal(target.execution.runId, "current-run");
  assert.equal(target.status, "ready");
  readyAgain(store, currentAction.id);
  assert.equal((await processOutbox(store, { bindWorkboardExecution: bind })).completed, 1);
  const before = structuredClone(target);
  assert.equal((await bind(oldPayload, { database: store.db })).skipped, true);
  assert.deepEqual(target, before);
  assert.equal(client.calls.filter(call => call.name === "workboard.cards.update").length, 1);
});

test("G07: human done, cancelled and archived cards clear continuations and cancel pending bindings, retaining late evidence", async (t) => {
  for (const terminal of ["done", "cancelled", "archived"]) {
    await t.test(terminal, async (t) => {
      const target = card(`terminal-${terminal}`, "running");
      const fixture = checkpointFixture(t, target);
      const evidence = resultEvidence(fixture.store, "terminal-evidence");
      const first = checkpointInput(evidence.id, { continuation: codexContinuation("late-run") });
      fixture.checkpoint(first);
      const action = fixture.store.db.prepare("SELECT * FROM controller_outbox").get();
      if (terminal === "archived") target.archivedAt = Date.now();
      else target.status = terminal;
      fixture.setCard(target);
      const client = workboard(target);
      const before = structuredClone(target);
      assert.equal((await bindWorkboardExecution(client, JSON.parse(action.payload_json),
        { database: fixture.store.db })).reason, "terminal");
      const lateInput = { ...first, ...checkpointSnapshot(fixture),
        idempotencyKey: `terminal-cleanup-${terminal}`,
        resultSummary: "Late observation retained after human closure." };
      const beforeCleanupRevision = fixture.row().checkpoint_revision;
      const late = fixture.checkpoint(lateInput);
      assert.equal(late.terminal, true);
      assert.equal(late.applied, false);
      assert.equal(late.learning.inserted, true);
      assert.equal(late.continuation, null);
      assert.equal(fixture.row().continuation_kind, null);
      assert.equal(fixture.row().next_review_at, null);
      assert.equal(fixture.row().checkpoint_revision, beforeCleanupRevision + 1);
      assert.equal(late.checkpointRevision, fixture.row().checkpoint_revision);
      const saved = fixture.store.db.prepare(`SELECT value FROM settings
        WHERE key LIKE 'task-checkpoint-receipt:%' AND json_extract(value, '$.checkpoint.resultSummary')=?`)
        .get(late.resultSummary);
      assert.equal(JSON.parse(saved.value).checkpoint.checkpointRevision, late.checkpointRevision);
      const replay = fixture.checkpoint(lateInput);
      assert.equal(replay.replayed, true);
      assert.equal(replay.checkpointRevision, late.checkpointRevision);
      assert.equal(replay.currentCheckpointRevision, late.checkpointRevision);
      assert.equal(fixture.row().checkpoint_revision, late.checkpointRevision);
      assert.equal(fixture.row().last_result_summary, first.resultSummary);
      assert.equal(actionRow(fixture.store, action.id).status, "cancelled");
      assert.equal((await processOutbox(fixture.store)).claimed, 0);
      assert.equal(fixture.checkpoint(first).continuation, null);
      assert.deepEqual(target, before);
      assert.equal(client.calls.some(call => call.name === "workboard.cards.update"), false);
    });
  }
});

test("G08: superseding a pending binding cancels it, and unversioned queues cannot attach active work", async (t) => {
  const target = card("cancel-pending", "running");
  const fixture = checkpointFixture(t, target);
  const evidence = resultEvidence(fixture.store, "cancel-result");
  fixture.checkpoint(checkpointInput(evidence.id, { continuation: codexContinuation("old-queued") }));
  fixture.checkpoint(checkpointInput(evidence.id, checkpointSnapshot(fixture)));
  assert.equal(fixture.store.db.prepare("SELECT status FROM controller_outbox").get().status, "cancelled");
  assert.equal((await processOutbox(fixture.store)).claimed, 0);
  const client = workboard(target);
  const result = await bindWorkboardExecution(client, {
    taskId: target.id, runId: "legacy-run", sessionKey: "legacy-session", model: "fixture/model",
  }, { database: fixture.store.db });
  assert.equal(result.reason, "unversioned_binding");
  assert.equal(target.execution, undefined);
});

test("G09: stale checkpoint receipts cannot acknowledge current task progress, and an acknowledged retry is read-only", (t) => {
  const target = card("versioned-ack", "running");
  const fixture = checkpointFixture(t, target);
  const owner = resolveTaskOwnerSession(fixture.store, target);
  const evidence = resultEvidence(fixture.store, "ack-result");
  emitContextChange(fixture.store.db, { eventKey: "ack-version", kind: "task_progress_due",
    sessionKey: owner.sessionKey, summary: "Review task result.", metadata: { taskId: target.id } });
  const change = fixture.store.db.prepare("SELECT seq FROM context_changes WHERE event_key='ack-version'").get();
  fixture.store.db.prepare("UPDATE context_changes SET status='leased', lease_owner='fixture' WHERE seq=?").run(change.seq);
  const input = checkpointInput(evidence.id, { ...checkpointSnapshot(fixture), changeSeq: change.seq, leaseOwner: "fixture" });
  fixture.checkpoint(input);
  fixture.checkpoint(checkpointInput(evidence.id, { ...checkpointSnapshot(fixture), resultSummary: "A newer independent review." }));
  const ack = { sequences: [change.seq], leaseOwner: "fixture", disposition: "processed" };
  assert.equal(fixture.checkpoint(input).replayed, true);
  assert.throws(() => acknowledgeChanges(fixture.store.db, ack, fixture.pluginConfig), /requires shadow_task_checkpoint/);
  const current = { ...input, ...checkpointSnapshot(fixture) };
  fixture.checkpoint(current);
  assert.equal(acknowledgeChanges(fixture.store.db, ack, fixture.pluginConfig).updated, 1);
  const before = fixture.row();
  assert.equal(fixture.checkpoint(current).replayed, true);
  assert.deepEqual(fixture.row(), before);
});

function checkpointBatchFixture(t) {
  const target = card('checkpoint-batch', 'running');
  const fixture = checkpointFixture(t, target);
  const owner = resolveTaskOwnerSession(fixture.store, target);
  const evidence = resultEvidence(fixture.store, 'batch-result');
  const sequences = [0, 1, 2].map(index => {
    emitContextChange(fixture.store.db, { eventKey: `batch-${index}`, kind: 'task_progress_due',
      sessionKey: owner.sessionKey, summary: 'Review newly available evidence.', metadata: { taskId: target.id } });
    return fixture.store.db.prepare('SELECT seq FROM context_changes WHERE event_key=?').get(`batch-${index}`).seq;
  });
  fixture.store.db.prepare("UPDATE context_changes SET status='leased', lease_owner='fixture', lease_until=?")
    .run(new Date(Date.now() + 3600000).toISOString());
  const apply = seq => fixture.checkpoint(checkpointInput(evidence.id, {
    ...checkpointSnapshot(fixture), changeSeq: seq, leaseOwner: 'fixture', learning: undefined,
    resultSummary: `Processed change ${seq}; continue with the latest available evidence.`,
  }));
  return { ...fixture, target, owner, evidence, sequences, apply,
    ack: (ids = sequences) => acknowledgeChanges(fixture.store.db,
      { sequences: ids, leaseOwner: 'fixture', disposition: 'processed' }, fixture.pluginConfig),
    statuses: () => fixture.store.db.prepare('SELECT status FROM context_changes ORDER BY seq').all().map(row => row.status),
  };
}

test('G09b: consecutive checkpoints for one leased batch can be ACKed together without rewriting earlier decisions', t => {
  const f = checkpointBatchFixture(t);
  for (const seq of f.sequences) assert.equal(f.apply(seq).applied, true);
  const attention = f.row();
  const receipts = f.store.db.prepare("SELECT * FROM settings WHERE key LIKE 'task-checkpoint-receipt:%' ORDER BY key").all();
  assert.equal(f.ack([...f.sequences].reverse()).updated, 3);
  assert.deepEqual(f.statuses(), ['acknowledged', 'acknowledged', 'acknowledged']);
  assert.deepEqual(f.row(), attention, 'ACK consumes events; it cannot restore an earlier plan');
  assert.deepEqual(f.store.db.prepare("SELECT * FROM settings WHERE key LIKE 'task-checkpoint-receipt:%' ORDER BY key").all(), receipts);
  assert.equal(f.ack().updated, 0, 'Retry never performs task work again');
});

test('G09c: batch ACK does not bypass independent decisions, missing receipts, leases, ownership or execution changes', async t => {
  const cases = [
    ['independent review between batch decisions', f => {
      f.checkpoint(checkpointInput(f.evidence.id, { ...checkpointSnapshot(f), learning: undefined,
        resultSummary: 'Independent decision not included in this event batch.' }));
    }, null],
    ['missing middle receipt', null, f => f.store.db.prepare("UPDATE context_changes SET metadata_json=json_remove(metadata_json, '$.taskCheckpoint') WHERE seq=?").run(f.sequences[1])],
    ['wrong binding revision', null, f => f.store.db.prepare('UPDATE work_task_attention SET binding_revision=binding_revision+1').run()],
    ['owner changed', null, f => f.store.db.prepare("UPDATE work_task_attention SET owner_session_key='another-owner'").run()],
    ['execution changed without a new checkpoint', null, f => f.setCard({ ...f.target, execution: { runId: 'new-run', sessionKey: 'new-session' } })],
    ['one lease expired', null, f => f.store.db.prepare("UPDATE context_changes SET lease_until='2000-01-01T00:00:00.000Z' WHERE seq=?").run(f.sequences[0])],
    ['one lease belongs to another consumer', null, f => f.store.db.prepare("UPDATE context_changes SET lease_owner='another-consumer' WHERE seq=?").run(f.sequences[1])],
    ['one checkpoint was not applied', null, f => f.store.db.prepare("UPDATE context_changes SET metadata_json=json_set(metadata_json, '$.taskCheckpoint.applied', json('false')) WHERE seq=?").run(f.sequences[1])],
  ];
  for (const [label, between, after] of cases) await t.test(label, t => {
    const f = checkpointBatchFixture(t);
    f.apply(f.sequences[0]);
    between?.(f);
    for (const seq of f.sequences.slice(1)) f.apply(seq);
    after?.(f);
    const before = f.row();
    assert.throws(() => f.ack(), /requires shadow_task_checkpoint/);
    assert.deepEqual(f.statuses(), ['leased', 'leased', 'leased'], 'Rejected batches consume nothing');
    assert.deepEqual(f.row(), before);
  });
});

test('G09d: a batch cannot use a newer checkpoint omitted from its acknowledgement', t => {
  const f = checkpointBatchFixture(t);
  for (const seq of f.sequences) f.apply(seq);
  assert.throws(() => f.ack([f.sequences[0], f.sequences[2]]), /requires shadow_task_checkpoint/);
  assert.throws(() => f.ack([f.sequences[0]]), /requires shadow_task_checkpoint/);
  assert.deepEqual(f.statuses(), ['leased', 'leased', 'leased']);
});

test('G09e: the latest single receipt cannot ACK an expired lease or an unrelated replacement execution', async t => {
  for (const mode of ['expired', 'invalid-expiry', 'different-execution']) await t.test(mode, t => {
    const f = checkpointBatchFixture(t);
    const seq = f.sequences[0];
    f.apply(seq);
    if (mode === 'different-execution') f.setCard({ ...f.target, execution: { runId: 'replacement', sessionKey: 'replacement-session' } });
    else f.store.db.prepare('UPDATE context_changes SET lease_until=? WHERE seq=?')
      .run(mode === 'expired' ? '2000-01-01T00:00:00.000Z' : 'invalid', seq);
    assert.throws(() => f.ack([seq]), /requires shadow_task_checkpoint/);
    assert.equal(f.statuses()[0], 'leased');
  });
});

test('G09f: ACK permits the exact execution arranged by the current checkpoint after outbox binding', async t => {
  const f = checkpointBatchFixture(t);
  const seq = f.sequences[0];
  const continuation = codexContinuation('expected-new-run');
  const result = f.checkpoint(checkpointInput(f.evidence.id, { ...checkpointSnapshot(f),
    changeSeq: seq, leaseOwner: 'fixture', continuation, learning: undefined }));
  assert.equal(result.applied, true);
  const payload = JSON.parse(f.store.db.prepare("SELECT payload_json FROM controller_outbox WHERE action_type='bind_workboard_execution'").get().payload_json);
  const client = workboard(f.target);
  assert.equal((await bindWorkboardExecution(client, payload, { database: f.store.db })).skipped, undefined);
  f.setCard(f.target);
  assert.equal(f.target.execution.runId, 'expected-new-run');
  assert.equal(f.ack([seq]).updated, 1);
});

test('G09g: batch ACK accepts its latest exact planned binding but not a partial execution identity', async t => {
  for (const mode of ['exact', 'wrong-run', 'wrong-session', 'missing-run', 'missing-session']) await t.test(mode, async t => {
    const f = checkpointBatchFixture(t);
    for (const seq of f.sequences.slice(0, -1)) f.apply(seq);
    f.checkpoint(checkpointInput(f.evidence.id, { ...checkpointSnapshot(f), changeSeq: f.sequences.at(-1),
      leaseOwner: 'fixture', continuation: codexContinuation('planned-batch-run'), learning: undefined }));
    const payload = JSON.parse(f.store.db.prepare("SELECT payload_json FROM controller_outbox WHERE action_type='bind_workboard_execution'").get().payload_json);
    await bindWorkboardExecution(workboard(f.target), payload, { database: f.store.db });
    if (mode === 'wrong-run') f.target.execution.runId = 'other-run';
    if (mode === 'wrong-session') f.target.execution.sessionKey = 'other-session';
    if (mode === 'missing-run') delete f.target.execution.runId;
    if (mode === 'missing-session') delete f.target.execution.sessionKey;
    f.setCard(f.target);
    if (mode === 'exact') assert.equal(f.ack().updated, 3);
    else {
      assert.throws(() => f.ack(), /requires shadow_task_checkpoint/);
      assert.deepEqual(f.statuses(), ['leased', 'leased', 'leased']);
    }
  });
});

test("G10: receipt persistence failure rolls back evidence, version, queue cancellation and replacement together", (t) => {
  const fixture = checkpointFixture(t, card("receipt-rollback", "ready"));
  const evidence = resultEvidence(fixture.store, "receipt-result");
  fixture.checkpoint(checkpointInput(evidence.id, { continuation: codexContinuation("first-run") }));
  const before = fixture.row();
  const snapshot = () => Object.fromEntries(["evidence", "evidence_links", "context_changes", "controller_outbox", "settings"]
    .map(table => [table, fixture.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const saved = snapshot();
  fixture.store.db.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON settings
    WHEN NEW.key LIKE 'task-checkpoint-receipt:%'
    BEGIN SELECT RAISE(ABORT, 'receipt-write-failure'); END`);
  const input = checkpointInput(evidence.id, { ...checkpointSnapshot(fixture),
    continuation: codexContinuation("replacement-run"), resultSummary: "A new result must be atomic with its receipt." });
  assert.throws(() => fixture.checkpoint(input), /receipt-write-failure/);
  assert.deepEqual(fixture.row(), before);
  assert.deepEqual(snapshot(), saved);
  fixture.store.db.exec("DROP TRIGGER reject_receipt");
  assert.equal(fixture.checkpoint(input).applied, true);
});

test("G11: binding validates the exact receipt, current execution and owner even at the same checkpoint revision", async (t) => {
  const target = card("binding-identity", "ready");
  const fixture = checkpointFixture(t, target);
  resolveTaskOwnerSession(fixture.store, target);
  const evidence = resultEvidence(fixture.store, "binding-identity-result");
  fixture.checkpoint(checkpointInput(evidence.id, {
    ...checkpointSnapshot(fixture), continuation: codexContinuation("queued-run"),
  }));
  const payload = JSON.parse(fixture.store.db.prepare("SELECT payload_json FROM controller_outbox").get().payload_json);
  const client = workboard(target);
  const bind = input => bindWorkboardExecution(client, input, { database: fixture.store.db });
  assert.equal((await bindWorkboardExecution(client, payload)).reason, "checkpoint_store_unavailable");
  assert.equal((await bind({ ...payload, runId: "another-run" })).reason, "checkpoint_identity_mismatch");
  assert.equal((await bind({ ...payload, sessionKey: "another-session" })).reason, "checkpoint_identity_mismatch");
  assert.equal((await bind({ ...payload, model: "another/model" })).reason, "checkpoint_identity_mismatch");
  target.execution = { runId: "newer-completed-run", sessionKey: "newer-session", status: "done" };
  const before = structuredClone(target);
  assert.equal((await bind(payload)).reason, "execution_changed");
  fixture.store.db.prepare("UPDATE work_task_attention SET binding_revision=binding_revision+1 WHERE card_id=?").run(target.id);
  assert.equal((await bind(payload)).reason, "superseded_checkpoint");
  assert.deepEqual(target, before);
  assert.equal(client.calls.some(call => call.name === "workboard.cards.update"), false);
});
