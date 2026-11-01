import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  markAgentOperationEffectApplied,
  recordAgentOperation,
  resolveTaskOwnerSession,
} from "../src/agent-operations.mjs";
import { openDatabase } from "../src/db.mjs";
import { DIRECT_INPUT_SESSION_KEY, ensureDirectInputSession } from "../src/direct-input.mjs";
import { processControllerOutbox } from "../src/controller-outbox.mjs";
import { applyWorkboardOperation, bindWorkboardExecution } from "../src/workboard-operations.mjs";

function createStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-agent-operation-"));
  const store = openDatabase(path.join(root, "shadow.sqlite"));
  store.setSetting("contextGraph:version", "epistemic-context-v4");
  return { root, store };
}

function fakeWorkboard(card) {
  return {
    comments: 0,
    proofs: 0,
    moves: 0,
    archives: 0,
    async invokeTool(name, args) {
      if (name === "workboard_read") return { output: { details: { card } } };
      if (name === "workboard_comment") {
        this.comments += 1;
        card.metadata.comments.push({ body: args.body });
        return { ok: true };
      }
      if (name === "workboard_proof") {
        this.proofs += 1;
        card.metadata.proof.push({ status: args.status, label: args.label?.trim(), note: args.note?.trim() });
        return { ok: true };
      }
      throw new Error(`Unexpected tool: ${name}`);
    },
    async request(method, args) {
      if (method === "workboard.cards.update") {
        Object.assign(card, args.patch);
        return { card };
      }
      if (method === "workboard.cards.move") {
        this.moves += 1;
        card.status = args.status;
        return { card };
      }
      assert.equal(method, "workboard.cards.archive");
      this.archives += 1;
      card.metadata.archivedAt = args.archived ? new Date().toISOString() : null;
      return { card };
    },
  };
}

test("versioned Codex binding uses native execution fields without moving the business card", async (t) => {
  const store = openDatabase(":memory:");
  t.after(() => store.close());
  const card = { id: "card-codex", status: "ready", metadata: { comments: [], proof: [] } };
  const client = fakeWorkboard(card);
  const binding = {
    taskId: card.id,
    runId: "run-1",
    sessionKey: "agent:main:subagent:child-1",
    model: "openai/gpt-5.6-sol",
    startedAt: "2026-08-31T08:00:00.000Z",
    checkpointRevision: 1, bindingRevision: 1, ownerSessionKey: null,
    checkpointKey: "test-checkpoint-receipt",
    expectedExecution: { runId: null, sessionKey: null },
  };
  store.db.prepare(`INSERT INTO work_task_attention(card_id, checkpoint_revision, continuation_kind, continuation_reference_id, updated_by, updated_at)
    VALUES(?, 1, 'codex_run', ?, 'test', ?)`).run(card.id, binding.runId, new Date().toISOString());
  store.setSetting(binding.checkpointKey, JSON.stringify({ checkpoint: {
    taskId: card.id, applied: true, checkpointRevision: 1, execution: binding.expectedExecution,
    continuation: { referenceId: binding.runId, sessionKey: binding.sessionKey, model: binding.model },
  } }));
  const first = await bindWorkboardExecution(client, binding, { database: store.db });
  const second = await bindWorkboardExecution(client, binding, { database: store.db });
  assert.equal(first.status, "ready");
  assert.equal(second.idempotent, true);
  assert.equal(card.execution.runId, binding.runId);
  assert.equal(card.execution.sessionKey, binding.sessionKey);
  assert.equal(card.execution.engine, "codex");
  assert.equal(card.sessionKey, binding.sessionKey);
  assert.equal(card.runId, binding.runId);
});

test("Codex execution binding survives controller restart through the durable outbox", async () => {
  const { root, store } = createStore();
  try {
    store.enqueueControllerAction({
      idempotencyKey: "bind-workboard-execution:card-1:run-1",
      actionType: "bind_workboard_execution",
      payload: {
        taskId: "card-1",
        runId: "run-1",
        sessionKey: "agent:main:subagent:child-1",
        model: "openai/gpt-5.6-sol",
      },
    });
    let received = null;
    const result = await processControllerOutbox(store, { projectRoot: root }, {
      dependencies: {
        bindWorkboardExecution: async (payload) => {
          received = payload;
          return { cardId: payload.taskId, status: "running" };
        },
      },
    });
    assert.equal(result.completed, 1);
    assert.equal(received.runId, "run-1");
    assert.equal(received.sessionKey, "agent:main:subagent:child-1");
    assert.equal(store.db.prepare("SELECT status FROM controller_outbox").get().status, "completed");
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("every task owns a stable session while source conversation and project remain references", () => {
  const { root, store } = createStore();
  try {
    const conversationCard = {
      id: "card-conversation",
      session_key: "agent:main:subagent:native-execution",
      automation: { conversationKey: "im:chat-1" },
    };
    const conversation = resolveTaskOwnerSession(store, conversationCard);
    assert.equal(conversation.binding.session_kind, "task");
    assert.equal(conversation.sourceConversationKey, "im:chat-1");
    assert.equal(conversationCard.session_key, "agent:main:subagent:native-execution");

    const repeated = resolveTaskOwnerSession(store, conversationCard);
    assert.equal(repeated.sessionKey, conversation.sessionKey);
    assert.equal(repeated.attention.binding_revision, conversation.attention.binding_revision);

    const project = resolveTaskOwnerSession(store, { id: "card-project", automation: { projectKey: "examplevision" } });
    assert.equal(project.binding.session_kind, "task");
    assert.equal(project.projectKey, "examplevision");
    assert.equal(project.bindingReason, "dedicated_task_session");
    assert.notEqual(project.sessionKey, conversation.sessionKey);
    const legacyWorkstream = store.bindWorkSession({
      provider: "workstream",
      routeKey: "legacy-project",
      sessionKey: "agent:main:shadow:workstream:legacy",
      kind: "workstream",
    });
    store.db.prepare(`
      INSERT INTO work_task_attention(
        card_id, project_key, owner_session_key, binding_reason, binding_revision,
        bound_at, updated_by, updated_at
      ) VALUES('card-legacy', 'legacy-project', ?, 'project_workstream', 1, ?, 'test', ?)
    `).run(legacyWorkstream.session_key, new Date().toISOString(), new Date().toISOString());
    const migrated = resolveTaskOwnerSession(store, { id: "card-legacy", automation: { projectKey: "legacy-project" } });
    assert.equal(migrated.binding.session_kind, "task");
    assert.equal(migrated.bindingReason, "dedicated_task_session");
    const inbox = resolveTaskOwnerSession(store, { id: "card-inbox" });
    assert.match(inbox.sessionKey, /^agent:main:shadow:task:/);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("direct input tasks are isolated from the main conversation and each other", () => {
  const { root, store } = createStore();
  try {
    const binding = ensureDirectInputSession(store);
    assert.equal(binding.session_key, DIRECT_INPUT_SESSION_KEY);
    const card = { id: "card-direct-user", status: "todo", notes: "来源 Evidence: direct-evidence" };
    const owner = resolveTaskOwnerSession(store, card, {
      sessionKey: DIRECT_INPUT_SESSION_KEY,
      bindingReason: "direct_user_input",
      evidenceIds: ["direct-evidence"],
    });
    assert.notEqual(owner.sessionKey, DIRECT_INPUT_SESSION_KEY);
    assert.equal(owner.binding.task_id, card.id);
    assert.equal(owner.attention.owner_session_key, owner.sessionKey);
    assert.equal(owner.attention.binding_reason, "dedicated_task_session");
    assert.equal(card.session_key, undefined);

    const source = store.upsertSource({
      sourceKey: "direct-input-recovery",
      kind: "manual",
      uri: "shadow-agent://direct-input/recovery",
    });
    const evidence = store.addEvidence({
      sourceId: source.id,
      kind: "manual_knowledge",
      threadId: DIRECT_INPUT_SESSION_KEY,
      title: "直接交代的任务",
      content: "创建任务并持续跟进",
      sourceLocator: "shadow-agent://direct-input/recovery",
      externalId: "direct-input-recovery",
    });
    const recovered = resolveTaskOwnerSession(store, {
      id: "card-direct-recovery",
      status: "todo",
      notes: `来源 Evidence: ${evidence.id}`,
    });
    assert.notEqual(recovered.sessionKey, DIRECT_INPUT_SESSION_KEY);
    assert.notEqual(recovered.sessionKey, owner.sessionKey);
    assert.equal(recovered.attention.binding_reason, "dedicated_task_session");
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("one agent operation atomically records knowledge, context, outbox, and task audit", () => {
  const { root, store } = createStore();
  try {
    const card = { id: "task-1", title: "验证任务", status: "ready", automation: { projectKey: "examplevision" } };
    const input = {
      operationId: "operation-1",
      action: "direct_next_step",
      targetType: "workboard_task",
      targetId: card.id,
      taskId: card.id,
      card,
      baseStatus: card.status,
      desiredEffect: "interpret_task_instruction",
      summary: "用户补充任务下一步",
      knowledge: {
        action: "direct_next_step",
        actionLabel: "交代任务下一步",
        targetType: "workboard_task",
        targetId: card.id,
        targetLabel: card.title,
        content: "先核实失败日志，再决定是否重试。",
      },
      workboardEffect: {
        cardId: card.id,
        effect: "task_instruction_comment",
        comment: "先核实失败日志，再决定是否重试。",
      },
    };
    const operation = recordAgentOperation(store, input);
    assert.equal(operation.duplicate, false);
    assert.ok(operation.knowledge.evidenceId);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM context_changes WHERE event_key='agent-operation:operation-1'").get().count, 1);
    assert.equal(store.db.prepare("SELECT action_type FROM controller_outbox WHERE id=?").get(operation.action.id).action_type, "apply_workboard_operation");
    const attention = store.db.prepare("SELECT * FROM work_task_attention WHERE card_id='task-1'").get();
    assert.equal(attention.last_operation_id, "operation-1");
    assert.equal(attention.owner_session_key, operation.owner.sessionKey);

    const duplicate = recordAgentOperation(store, input);
    assert.equal(duplicate.duplicate, true);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM evidence WHERE external_id='agent-operation:operation-1'").get().count, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM controller_outbox WHERE idempotency_key LIKE 'operation-1:%'").get().count, 1);

    markAgentOperationEffectApplied(store, operation, { status: "ready" });
    assert.equal(store.db.prepare("SELECT status FROM controller_outbox WHERE id=?").get(operation.action.id).status, "completed");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM controller_outbox WHERE action_type='schedule_attention'").get().count, 1);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Workboard operation effects are idempotent and natural instructions do not change status", async () => {
  const instructionCard = { id: "task-2", status: "ready", metadata: { comments: [], proof: [] } };
  const instructionClient = fakeWorkboard(instructionCard);
  const instruction = {
    operationId: "operation-comment",
    cardId: instructionCard.id,
    effect: "task_instruction_comment",
    comment: "这项工作不属于我的职责，交给 Agent 判断后续。",
  };
  await applyWorkboardOperation(instructionClient, instruction);
  await applyWorkboardOperation(instructionClient, instruction);
  assert.equal(instructionClient.comments, 1);
  assert.equal(instructionClient.moves, 0);
  assert.equal(instructionCard.status, "ready");

  const doneCard = { id: "task-3", status: "review", metadata: { comments: [], proof: [] } };
  const doneClient = fakeWorkboard(doneCard);
  const confirm = { operationId: "operation-done", cardId: doneCard.id, effect: "confirm_done", note: "现场已完成" };
  await applyWorkboardOperation(doneClient, confirm);
  await applyWorkboardOperation(doneClient, confirm);
  assert.equal(doneClient.proofs, 1);
  assert.equal(doneClient.moves, 1);
  assert.equal(doneCard.status, "done");

  const wrongCard = { id: "task-wrong-owner", status: "done", metadata: { comments: [], proof: [] } };
  const wrongClient = fakeWorkboard(wrongCard);
  const correction = {
    operationId: "operation-owner-correction",
    cardId: wrongCard.id,
    effect: "archive_misclassified",
    comment: "示例人员18与当前用户是不同人员，该报告不属于用户职责。",
    note: "精确身份和消息提及均未指向当前用户。",
  };
  await applyWorkboardOperation(wrongClient, correction);
  await applyWorkboardOperation(wrongClient, correction);
  assert.equal(wrongClient.comments, 1);
  assert.equal(wrongClient.proofs, 1);
  assert.equal(wrongClient.archives, 1);
  assert.ok(wrongCard.metadata.archivedAt);
});

test("offline Workboard effects retry durably and wake the owning session once", async () => {
  const { root, store } = createStore();
  try {
    const card = { id: "task-offline", title: "离线恢复", status: "ready", automation: { projectKey: "examplevision" } };
    const operation = recordAgentOperation(store, {
      operationId: "operation-offline",
      action: "direct_next_step",
      targetType: "workboard_task",
      targetId: card.id,
      taskId: card.id,
      card,
      desiredEffect: "interpret_task_instruction",
      workboardEffect: { cardId: card.id, effect: "task_instruction_comment", comment: "恢复后继续" },
    });
    let attempts = 0;
    const first = await processControllerOutbox(store, { projectRoot: root }, {
      dependencies: {
        applyWorkboardOperation: async () => {
          attempts += 1;
          throw new Error("gateway offline");
        },
        scheduleAttention: () => {},
      },
    });
    assert.equal(first.retried, 1);
    assert.equal(store.db.prepare("SELECT status FROM controller_outbox WHERE id=?").get(operation.action.id).status, "retry");

    store.db.prepare("UPDATE controller_outbox SET next_attempt_at=? WHERE id=?")
      .run(new Date(0).toISOString(), operation.action.id);
    const second = await processControllerOutbox(store, { projectRoot: root }, {
      dependencies: {
        applyWorkboardOperation: async () => {
          attempts += 1;
          return { status: "ready" };
        },
        scheduleAttention: () => {},
      },
    });
    assert.equal(second.completed, 1);
    assert.equal(attempts, 2);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM controller_outbox WHERE action_type='schedule_attention' AND status='pending'").get().count, 1);

    let scheduled = 0;
    await processControllerOutbox(store, { projectRoot: root }, {
      dependencies: {
        scheduleAttention: ({ sessionKey }) => {
          scheduled += 1;
          assert.equal(sessionKey, operation.owner.sessionKey);
        },
      },
    });
    assert.equal(scheduled, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM controller_outbox WHERE status IN ('pending','retry','processing')").get().count, 0);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
