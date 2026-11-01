import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { contextGraphStats, emitContextChange, materializeContextGraph } from "../src/context-graph.mjs";
import { openDatabase } from "../src/db.mjs";
import { upsertGraphEntity } from "../src/graph-model.mjs";
import { truncateUtf8 } from "../src/utils.mjs";

test("temporal context graph materializes provenance and incremental changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-context-"));
  const store = openDatabase(path.join(root, "context.sqlite"));
  const config = { contextGraph: { maxEvidencePerCycle: 100 } };
  try {
    const source = store.upsertSource({ sourceKey: "codex:test", kind: "codex", uri: "test://codex" });
    store.upsertProject({ projectKey: "examplevision", name: "ExampleVision", rootPath: "D:\\ExampleVision" });
    store.upsertThread({
      id: "thread-1",
      title: `通信协议重构${"长标题".repeat(1000)}`,
      cwd: "D:\\ExampleVision",
      rolloutPath: "test://rollout",
      projectKey: "examplevision",
      updatedAtMs: Date.now(),
    });
    const firstEvidence = store.addEvidence({
      sourceId: source.id,
      kind: "codex_thread_digest",
      threadId: "thread-1",
      projectKey: "examplevision",
      title: "通信协议重构摘要",
      content: "完成 TCP 握手、心跳和报文边界梳理。",
      sourceLocator: "test://rollout#digest-1",
      fingerprint: "graph-digest-1",
    });

    const bootstrap = materializeContextGraph(store, config);
    assert.equal(bootstrap.version, "epistemic-context-v4");
    assert.ok(contextGraphStats(store.db).entities >= 3);
    assert.ok(contextGraphStats(store.db).activeFacts >= 2);
    const workspaceRoute = store.db.prepare(`
      SELECT assertion_mode, epistemic_status, metadata_json
      FROM graph_facts WHERE status='active' AND predicate='HAS_LOCAL_WORKSPACE'
    `).get();
    assert.equal(workspaceRoute.assertion_mode, "structural_route");
    assert.equal(workspaceRoute.epistemic_status, "proposed");
    assert.equal(JSON.parse(workspaceRoute.metadata_json).responsibilitySemantics, false);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM graph_facts WHERE status='active' AND predicate='TRACKS_PROJECT'").get().count, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM graph_entity_evidence WHERE evidence_id=?").get(firstEvidence.id).count, 1);
    assert.ok(store.db.prepare("SELECT MAX(length(CAST(name AS BLOB))) AS size FROM graph_entities").get().size <= 2000);
    assert.ok(store.db.prepare("SELECT MAX(length(CAST(alias AS BLOB))) AS size FROM graph_aliases").get().size <= 2000);

    upsertGraphEntity(store.db, {
      canonicalKey: "session:thread-1",
      type: "Session",
      name: "通信协议重构与验证",
      summary: "人工整理后的长期知识名称和摘要。",
      metadata: { curatedBy: "codex:test" },
    });
    materializeContextGraph(store, config);
    const curated = store.db.prepare("SELECT name, summary, metadata_json FROM graph_entities WHERE canonical_key='session:thread-1'").get();
    assert.equal(curated.name, "通信协议重构与验证");
    assert.equal(curated.summary, "人工整理后的长期知识名称和摘要。");
    assert.equal(JSON.parse(curated.metadata_json).presentationPriority, 50);

    const pendingBeforeQuietDigest = contextGraphStats(store.db).pendingChanges;
    store.addEvidence({
      sourceId: source.id,
      kind: "codex_thread_digest",
      threadId: "thread-1",
      projectKey: "examplevision",
      title: "通信协议重构摘要（仅助手日志更新）",
      content: "只有工具日志更新，不应再次唤醒 Agent。",
      sourceLocator: "test://rollout#digest-quiet",
      fingerprint: "graph-digest-quiet",
      metadata: { chunkIndex: 0, attentionWorthy: false },
    });
    materializeContextGraph(store, config, { refreshStructural: false, runMaintenance: false });
    assert.equal(contextGraphStats(store.db).pendingChanges, pendingBeforeQuietDigest);

    const deltaEvidence = store.addEvidence({
      sourceId: source.id,
      kind: "shadow_agent_task_result",
      projectKey: "examplevision",
      title: "已解决问题的知识差量",
      content: "该结果已有精确知识维护事件，不应再产生普通证据批次唤醒。",
      sourceLocator: "shadow-agent://knowledge-delta/test",
      externalId: "resolution-delta:test",
      fingerprint: "graph-resolution-delta-test",
      metadata: { knowledgeDelta: { idempotencyKey: "test-delta" } },
    });
    materializeContextGraph(store, config, { refreshStructural: false, runMaintenance: false });
    assert.equal(store.db.prepare(`
      SELECT COUNT(*) AS count FROM context_changes
      WHERE evidence_id=? AND kind='evidence_batch_ingested'
    `).get(deltaEvidence.id).count, 0);
    emitContextChange(store.db, {
      eventKey: "legacy-duplicate-delta-batch",
      kind: "evidence_batch_ingested",
      evidenceId: deltaEvidence.id,
      projectKey: "examplevision",
      summary: "旧版本产生的重复普通批次事件",
      metadata: { evidenceKind: "shadow_agent_task_result" },
    });
    materializeContextGraph(store, config, { refreshStructural: false, runMaintenance: false });
    const duplicateDeltaBatch = store.db.prepare(`
      SELECT status, ack_note FROM context_changes WHERE event_key='legacy-duplicate-delta-batch'
    `).get();
    assert.equal(duplicateDeltaBatch.status, "acknowledged");
    assert.equal(duplicateDeltaBatch.ack_note, "superseded by exact knowledge delta review");

    store.addEvidence({
      sourceId: source.id,
      kind: "feishu_task",
      projectKey: "examplevision",
      title: "验证发那科接入",
      content: "补充 FANUC 现场联调证据。",
      sourceLocator: "feishu://task/1",
      externalId: "task-1",
      fingerprint: "graph-task-1",
    });
    const refresh = materializeContextGraph(store, config);
    assert.ok(refresh.changes >= 1);
    assert.ok(contextGraphStats(store.db).pendingChanges >= 2);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM graph_facts WHERE status='active' AND predicate='BELONGS_TO'").get().count >= 2, true);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM graph_facts WHERE status='active' AND predicate='BELONGS_TO' AND assertion_mode<>'structural_route'").get().count, 0);

    store.addEvidence({
      sourceId: source.id,
      kind: "feishu_task",
      projectKey: "examplevision",
      title: "验证发那科接入（更新）",
      content: "同一外部任务的新证据应合并到尚未领取的变化中。",
      sourceLocator: "feishu://task/1#update",
      externalId: "task-1",
      fingerprint: "graph-task-1-update",
    });
    materializeContextGraph(store, config);
    const taskEntity = store.db.prepare("SELECT id FROM graph_entities WHERE canonical_key='externaltask:task-1'").get();
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM context_changes WHERE entity_id=? AND status='pending'").get(taskEntity.id).count, 1);

    for (const [id, signal] of [["message-1", "unassigned_group"], ["message-2", "explicit_self_mention"]]) {
      store.addEvidence({
        sourceId: source.id,
        kind: "feishu_message",
        title: "同一个飞书群",
        content: `消息 ${id}`,
        sourceLocator: `feishu://message/${id}`,
        externalId: id,
        fingerprint: `graph-${id}`,
        metadata: {
          chatId: "chat-1",
          chatType: "group",
          threadId: null,
          conversationKey: "im:chat-1:thread:main",
          ownershipSignal: signal,
        },
      });
    }
    materializeContextGraph(store, config, { refreshStructural: false, runMaintenance: false });
    const conversationChange = store.db.prepare(`
      SELECT metadata_json FROM context_changes
      WHERE coalesce_key='evidence-batch:feishu-conversation:im:chat-1:thread:main' AND status='pending'
    `).get();
    assert.ok(conversationChange);
    const conversationMetadata = JSON.parse(conversationChange.metadata_json);
    assert.equal(conversationMetadata.count, 2);
    assert.equal(conversationMetadata.evidenceIds.length, 2);
    assert.deepEqual(conversationMetadata.ownershipSignals.sort(), ["explicit_self_mention", "unassigned_group"]);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("UTF-8 truncation enforces a byte budget for Chinese context", () => {
  const output = truncateUtf8("通信协议".repeat(1000), 1024);
  assert.ok(Buffer.byteLength(output, "utf8") <= 1024);
  assert.match(output, /truncated/);
});
