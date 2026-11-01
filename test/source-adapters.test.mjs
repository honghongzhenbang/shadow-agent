import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase } from "../src/db.mjs";
import {
  SOURCE_ADAPTER_CAPABILITIES,
  adapterSourceMetadata,
  getSourceAdapter,
  listSourceAdapters,
  requireSourceCapability,
} from "../src/source-adapters/index.mjs";
import { ensureCanonicalSourceStorage, SOURCE_STORAGE_VERSION } from "../src/source-records.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-source-adapters-"));
  return { root, store: openDatabase(path.join(root, "test.sqlite")) };
}

function cleanup(state) {
  state.store.close();
  fs.rmSync(state.root, { recursive: true, force: true });
}

test("source adapters publish a complete capability contract", () => {
  const adapters = listSourceAdapters();
  assert.deepEqual(adapters.map((adapter) => adapter.provider), ["codex", "feishu", "voice"]);
  for (const adapter of adapters) {
    assert.ok(["collaboration", "execution"].includes(adapter.family));
    assert.deepEqual(Object.keys(adapter.capabilities), [...SOURCE_ADAPTER_CAPABILITIES]);
    assert.ok(Object.values(adapter.capabilities).every((value) => typeof value === "boolean"));
  }
  assert.equal(requireSourceCapability(getSourceAdapter("feishu"), "sendAsUser"), true);
  assert.throws(
    () => requireSourceCapability(getSourceAdapter("codex"), "sendMessage"),
    (error) => error.code === "SOURCE_CAPABILITY_UNSUPPORTED" && error.provider === "codex",
  );
});

test("Feishu evidence writes canonical Observation and Collaboration without copying content", () => {
  const state = fixture();
  try {
    const source = state.store.upsertSource({
      sourceKey: "feishu:user",
      kind: "feishu",
      uri: "feishu://current-user",
      metadata: adapterSourceMetadata("feishu", { identity: "user" }),
    });
    const evidence = state.store.addEvidence({
      sourceId: source.id,
      kind: "feishu_message",
      occurredAt: "2026-09-02T01:00:00.000Z",
      title: "项目沟通",
      content: "请核对接口并在周五前回复。",
      sourceLocator: "feishu://message/om_projection",
      externalId: "om_projection",
      metadata: {
        conversationKey: "im:oc_projection",
        chatId: "oc_projection",
        senderOpenId: "ou_owner",
        senderType: "user",
        senderName: "负责人",
        replyToMessageId: "om_parent",
        mentionOpenIds: ["ou_self"],
      },
    });
    const record = state.store.sourceRecord(evidence.id);
    assert.equal(record.observation.schemaVersion, SOURCE_STORAGE_VERSION);
    assert.equal(record.observation.provider, "feishu");
    assert.equal(record.observation.sourceFamily, "collaboration");
    assert.equal(record.observation.eventKind, "message");
    assert.equal(record.observation.streamId, "im:oc_projection");
    assert.equal(record.collaboration.actorId, "ou_owner");
    assert.equal(record.collaboration.replyTo, "om_parent");
    assert.deepEqual(record.collaboration.mentions, ["ou_self"]);
    assert.equal(JSON.stringify(record).includes("周五前回复"), false);
    assert.equal(state.store.db.prepare("PRAGMA table_info(source_observations)").all()
      .some((item) => item.name === "content"), false);
    assert.equal(ensureCanonicalSourceStorage(state.store.db), false);
  } finally {
    cleanup(state);
  }
});

test("Codex evidence writes one stable Execution session with runtime metadata", () => {
  const state = fixture();
  try {
    state.store.upsertThread({
      id: "thread-projection",
      title: "实现来源投影",
      cwd: "X:\\ExampleProjects\\sdagent",
      rolloutPath: "E:\\Codex\\rollout.jsonl",
      projectKey: "sdagent",
      metadata: {
        modelProvider: "openai",
        model: "codex",
        reasoningEffort: "high",
        gitBranch: "codex/source-adapters",
        gitSha: "abc123",
      },
    });
    const source = state.store.upsertSource({
      sourceKey: "codex-rollout:test",
      kind: "codex_rollout",
      uri: "E:\\Codex\\rollout.jsonl",
      metadata: adapterSourceMetadata("codex", { threadId: "thread-projection" }),
    });
    const evidence = state.store.addEvidence({
      sourceId: source.id,
      kind: "codex_tool_call",
      occurredAt: "2026-09-02T01:10:00.000Z",
      title: "Tool call: apply_patch",
      content: "large provider-specific tool payload",
      sourceLocator: "E:\\Codex\\rollout.jsonl#byte=120",
      externalId: "call-1",
      threadId: "thread-projection",
      projectKey: "sdagent",
      metadata: { tool_name: "apply_patch" },
    });
    const record = state.store.sourceRecord(evidence.id);
    assert.equal(record.observation.provider, "codex");
    assert.equal(record.observation.sourceFamily, "execution");
    assert.equal(record.observation.eventKind, "tool_call");
    assert.equal(record.execution.sessionId, "thread-projection");
    assert.equal(record.execution.workspace, "X:\\ExampleProjects\\sdagent");
    assert.equal(record.execution.toolName, "apply_patch");
    assert.equal(record.execution.branch, "codex/source-adapters");
    assert.equal(record.execution.modelProvider, "openai");
  } finally {
    cleanup(state);
  }
});

test("only registered source adapters write canonical records and domain queries do not cross families", () => {
  const state = fixture();
  try {
    const unknownSource = state.store.upsertSource({ sourceKey: "unknown", kind: "test", uri: "unknown://source" });
    const ignored = state.store.addEvidence({
      sourceId: unknownSource.id,
      kind: "feishu_message",
      title: "unregistered message",
      content: "ignored by canonical source storage",
      sourceLocator: "unknown://message/0",
      externalId: "unknown-message",
    });
    assert.equal(state.store.sourceRecord(ignored.id), null);
    const legacyFeishu = state.store.upsertSource({ sourceKey: "feishu-current", kind: "feishu", uri: "feishu://current-user" });
    const message = state.store.addEvidence({
      sourceId: legacyFeishu.id,
      kind: "feishu_message",
      title: "legacy message",
      content: "legacy",
      sourceLocator: "legacy://message/1",
      externalId: "legacy-message",
      metadata: { conversationKey: "im:legacy" },
    });
    const legacyCodex = state.store.upsertSource({ sourceKey: "codex-current", kind: "codex_rollout", uri: "codex://rollout" });
    const execution = state.store.addEvidence({
      sourceId: legacyCodex.id,
      kind: "codex_user_message",
      title: "legacy intent",
      content: "legacy",
      sourceLocator: "legacy://codex/1",
      threadId: "thread-legacy",
    });
    assert.equal(state.store.sourceRecord(message.id).observation.provider, "feishu");
    assert.equal(state.store.sourceRecord(execution.id).observation.provider, "codex");
    const collaboration = state.store.querySourceRecords({ sourceFamilies: ["collaboration"], limit: 10 });
    assert.deepEqual(collaboration.map((item) => item.observation.evidenceId), [message.id]);
    const codex = state.store.querySourceRecords({ providers: ["codex"], eventKinds: ["user_intent"], limit: 10 });
    assert.deepEqual(codex.map((item) => item.observation.evidenceId), [execution.id]);
  } finally {
    cleanup(state);
  }
});

test("canonical storage cutover backfills current adapters and removes legacy views", () => {
  const state = fixture();
  try {
    const source = state.store.upsertSource({ sourceKey: "cutover-feishu", kind: "feishu", uri: "feishu://cutover" });
    const evidence = state.store.addEvidence({
      sourceId: source.id,
      kind: "feishu_message",
      title: "cutover",
      content: "one canonical body",
      sourceLocator: "feishu://message/cutover",
      externalId: "cutover-message",
      metadata: { conversationKey: "im:cutover" },
    });
    state.store.db.exec(`
      DELETE FROM collaboration_events;
      DELETE FROM source_observations;
      UPDATE settings SET value='1' WHERE key='source:storage:version';
      CREATE VIEW source_observation_projection AS SELECT id AS evidence_id FROM evidence;
    `);
    assert.equal(ensureCanonicalSourceStorage(state.store.db), true);
    assert.equal(state.store.sourceRecord(evidence.id).observation.streamId, "im:cutover");
    assert.equal(state.store.db.prepare("SELECT type FROM sqlite_master WHERE name='source_observation_projection'").get(), undefined);
  } finally {
    cleanup(state);
  }
});

test("Evidence and its canonical source record commit atomically", () => {
  const state = fixture();
  try {
    const source = state.store.upsertSource({ sourceKey: "atomic-codex", kind: "codex_rollout", uri: "codex://atomic" });
    state.store.db.exec("DROP TABLE execution_events");
    assert.throws(() => state.store.addEvidence({
      sourceId: source.id,
      kind: "codex_user_message",
      title: "must roll back",
      content: "must roll back",
      sourceLocator: "codex://atomic/1",
      externalId: "atomic-1",
      threadId: "thread-atomic",
    }), /execution_events/);
    assert.equal(state.store.db.prepare("SELECT COUNT(*) AS count FROM evidence WHERE external_id='atomic-1'").get().count, 0);
    assert.equal(state.store.db.prepare("SELECT COUNT(*) AS count FROM source_observations WHERE source_object_id='atomic-1'").get().count, 0);
  } finally {
    cleanup(state);
  }
});
