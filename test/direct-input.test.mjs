import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { processControllerOutbox } from "../src/controller-outbox.mjs";
import { openDatabase } from "../src/db.mjs";
import {
  buildDirectInputPrompt,
  cardsForEvidence,
  DIRECT_INPUT_SESSION_KEY,
  enqueueDirectInputRequest,
} from "../src/direct-input.mjs";
import { assistantTextAfter, runOpenClawTurn } from "../src/openclaw/cli.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-direct-input-"));
  return {
    root,
    config: {
      projectRoot: root,
      attention: { runTimeoutSeconds: 0, waitSliceSeconds: 60 },
    },
    store: openDatabase(path.join(root, "shadow.sqlite")),
  };
}

function addDirectEvidence(store, suffix = "one") {
  const source = store.upsertSource({
    sourceKey: `direct-input-${suffix}`,
    kind: "manual",
    uri: `shadow-agent://direct-input/${suffix}`,
  });
  return store.addEvidence({
    sourceId: source.id,
    kind: "manual_knowledge",
    threadId: DIRECT_INPUT_SESSION_KEY,
    title: "用户直接告诉 Agent 的消息",
    content: `请核对 ${suffix} 的发布证据`,
    sourceLocator: `shadow-agent://direct-input/${suffix}`,
    externalId: `direct-input-${suffix}`,
  });
}

function cleanup(state) {
  state.store.close();
  fs.rmSync(state.root, { recursive: true, force: true });
}

test("direct input outbox recovers the same native run after restart without publishing partial success", async () => {
  const state = fixture();
  let completed = false;
  const calls = [];
  const client = {
    async connect() {}, stop() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === "agent") return { runId: "native-direct-run" };
      if (method === "agent.wait") {
        if (!completed) throw new Error("connection lost");
        assert.equal(params.runId, "native-direct-run");
        return { status: "ok", terminalReply: { disposition: "visible", text: "Verified delivery." } };
      }
      return { messages: [{ role: "assistant", timestamp: Date.now(), stopReason: "toolUse", content: "Checking..." }] };
    },
  };
  const dependencies = {
    runDirectInputConversation: (root, input) => runOpenClawTurn(root, input, { client }),
    listWorkboardCards: async () => [],
    sendFeishu: async () => assert.fail("No external sending is allowed in this test"),
  };
  try {
    const evidence = addDirectEvidence(state.store, "run-recovery");
    const queued = enqueueDirectInputRequest(state.store, { evidenceId: evidence.id });
    const first = await processControllerOutbox(state.store, state.config, { dependencies });
    assert.equal(first.completed, 0);
    assert.equal(first.retried, 1);
    assert.equal(state.store.directInputReceipt(queued.receipt.id).response_text, null);
    state.store.close();
    state.store = openDatabase(path.join(state.root, "shadow.sqlite"));
    state.store.db.prepare("UPDATE controller_outbox SET next_attempt_at='2020-01-01T00:00:00Z'").run();
    completed = true;
    const recovered = await processControllerOutbox(state.store, state.config, { dependencies });
    assert.equal(recovered.completed, 1);
    const receipt = state.store.directInputReceipt(queued.receipt.id);
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.response_text, "Verified delivery.");
    assert.equal(calls.filter((call) => call.method === "agent").length, 1);
    assert.equal(calls.filter((call) => call.method === "agent.wait").length, 2);
  } finally { cleanup(state); }
});

test("unified direct input delegates intent and task creation to the sole controller", () => {
  assert.equal(DIRECT_INPUT_SESSION_KEY, "agent:main:shadow:user");
  const prompt = buildDirectInputPrompt({ text: "帮我核对构建结果", evidenceId: "evidence-direct-1" });
  assert.match(prompt, /不要要求用户预先选择/);
  assert.match(prompt, /workboard_create/);
  assert.match(prompt, /普通讨论或一次性回答不得.*创建卡片/);
  assert.match(prompt, /Evidence ID：evidence-direct-1/);
  assert.match(prompt, /帮我核对构建结果/);
});

test("history extraction retains partial text for diagnostics without proving turn success", () => {
  const text = assistantTextAfter([
    { role: "assistant", timestamp: 100, content: [{ type: "text", text: "旧回复" }] },
    { role: "assistant", timestamp: 300, content: [{ type: "text", text: "任务已建卡" }] },
  ], 200);
  assert.equal(text, "任务已建卡");
});

test("task receipt reports every card linked to the submitted evidence after a retry", () => {
  const created = cardsForEvidence([
    { id: "existing", title: "重试前已创建的卡", notes: "evidence-direct-1" },
    { id: "unrelated", title: "并发卡", notes: "other-evidence" },
    { id: "created", title: "本次新卡", notes: "来源 Evidence: evidence-direct-1" },
  ], "evidence-direct-1");
  assert.deepEqual(created, [
    { id: "existing", title: "重试前已创建的卡" },
    { id: "created", title: "本次新卡" },
  ]);
});

test("direct input is durably queued and produces one persistent receipt", async () => {
  const state = fixture();
  const calls = [];
  try {
    const evidence = addDirectEvidence(state.store, "durable");
    const queued = state.store.transaction(() => enqueueDirectInputRequest(state.store, {
      evidenceId: evidence.id,
      source: "test",
    }));
    assert.equal(queued.receipt.status, "queued");
    assert.equal(queued.action.status, "pending");

    const result = await processControllerOutbox(state.store, state.config, {
      dependencies: {
        runDirectInputConversation: async (_root, input) => {
          calls.push(input);
          return { text: "已核对并创建任务。", payload: { accepted: { runId: "run-durable" } } };
        },
        listWorkboardCards: async () => [{
          id: "card-durable",
          title: "核对 durable 发布证据",
          notes: `来源 Evidence: ${evidence.id}`,
        }],
      },
    });
    assert.equal(result.completed, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sessionKey, DIRECT_INPUT_SESSION_KEY);
    assert.equal(calls[0].thinking, "high");
    assert.equal(calls[0].idempotencyKey, queued.receipt.idempotency_key);
    assert.match(calls[0].message, new RegExp(evidence.id));

    const receipt = state.store.directInputReceipt(queued.receipt.id);
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.response_text, "已核对并创建任务。");
    assert.deepEqual(JSON.parse(receipt.created_task_ids_json), ["card-durable"]);
    assert.equal(receipt.run_id, "run-durable");
    const owner = state.store.db.prepare("SELECT owner_session_key FROM work_task_attention WHERE card_id='card-durable'").get().owner_session_key;
    assert.notEqual(owner, DIRECT_INPUT_SESSION_KEY);
    assert.match(owner, /^agent:main:shadow:task:/);
    const handoff = state.store.db.prepare("SELECT * FROM context_changes WHERE json_extract(metadata_json,'$.taskId')='card-durable'").get();
    assert.equal(handoff.session_key, owner);
    assert.equal(JSON.parse(handoff.metadata_json).userText, "请核对 durable 的发布证据");

    const replay = await processControllerOutbox(state.store, state.config, {
      dependencies: {
        runDirectInputConversation: async () => { throw new Error("must not run twice"); },
        listWorkboardCards: async () => [],
        scheduleAttention: () => {},
      },
    });
    assert.equal(replay.claimed, 1); // Independent task handoff, not a second main-chat run.
    assert.equal(state.store.listDirectInputReceipts().length, 1);
  } finally {
    cleanup(state);
  }
});

test("offline direct input retries with the same run identity and survives restart recovery", async () => {
  const state = fixture();
  const calls = [];
  try {
    const evidence = addDirectEvidence(state.store, "retry");
    const queued = enqueueDirectInputRequest(state.store, { evidenceId: evidence.id, source: "test" });

    const first = await processControllerOutbox(state.store, state.config, {
      dependencies: {
        runDirectInputConversation: async (_root, input) => {
          calls.push(input);
          throw new Error("gateway offline");
        },
      },
    });
    assert.equal(first.retried, 1);
    const retryReceipt = state.store.directInputReceipt(queued.receipt.id);
    assert.equal(retryReceipt.status, "retry");
    assert.equal(retryReceipt.last_error, "gateway offline");
    assert.ok(retryReceipt.started_at);

    state.store.db.prepare("UPDATE controller_outbox SET status='failed' WHERE id=?").run(queued.action.id);
    const recovered = state.store.recoverDirectInputActions();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, "retry");
    state.store.db.prepare("UPDATE controller_outbox SET next_attempt_at=? WHERE id=?")
      .run(new Date(Date.now() - 1000).toISOString(), queued.action.id);

    const second = await processControllerOutbox(state.store, state.config, {
      dependencies: {
        runDirectInputConversation: async (_root, input) => {
          calls.push(input);
          return { text: "恢复后完成。", payload: { accepted: { runId: "run-retry" } } };
        },
        listWorkboardCards: async () => [],
      },
    });
    assert.equal(second.completed, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].idempotencyKey, calls[1].idempotencyKey);
    assert.equal(calls[0].historySinceAt, calls[1].historySinceAt);
    assert.equal(state.store.directInputReceipt(queued.receipt.id).status, "completed");
    assert.equal(state.store.directInputReceipt(queued.receipt.id).response_text, "恢复后完成。");
  } finally {
    cleanup(state);
  }
});
