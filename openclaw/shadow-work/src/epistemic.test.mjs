import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  captureKnowledge,
  captureKnowledgeEpisode,
  captureResolutionKnowledgeDelta,
  completeKnowledgeAnnotation,
  leaseKnowledgeEnrichment,
  proposeKnowledge,
  reviseKnowledge,
} from "./epistemic.js";
import { openV4TestDatabase } from "./test-fixture.mjs";
import { stableJson } from "../../../src/utils.mjs";

function fixture() {
  const databasePath = path.join(os.tmpdir(), `shadow-epistemic-${process.pid}-${Date.now()}-${Math.random()}.sqlite`);
  const store = openV4TestDatabase(databasePath);
  return {
    store,
    close() {
      store.close();
      for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${databasePath}${suffix}`, { force: true });
    },
  };
}

test("human feedback reuses the existing knowledge episode and enrichment pipeline", () => {
  const context = fixture();
  try {
    const captured = captureKnowledgeEpisode(context.store.db, {
      action: "reject_outbound",
      actionLabel: "拒绝飞书消息",
      targetType: "outbound_message",
      targetId: "draft-1",
      targetLabel: "发给测试同事的飞书消息",
      title: "用户拒绝飞书消息：测试同事",
      content: "被拒绝的草稿：明天一定完成。\n\n用户填写的拒绝原因：尚未验证，不应承诺完成时间。",
      externalId: "feedback-reject-draft-1",
      feedbackSource: "pet-ui",
    });
    const evidence = context.store.db.prepare("SELECT kind, metadata_json FROM evidence WHERE id=?").get(captured.evidenceId);
    const annotation = context.store.db.prepare("SELECT status, summary, keywords_json FROM graph_episode_annotations WHERE evidence_id=?").get(captured.evidenceId);
    assert.equal(evidence.kind, "manual_knowledge");
    assert.equal(JSON.parse(evidence.metadata_json).humanFeedback.action, "reject_outbound");
    assert.equal(annotation.status, "ready");
    assert.ok(annotation.summary.length >= 20);
    assert.ok(JSON.parse(annotation.keywords_json).length >= 3);
    const review = context.store.db.prepare("SELECT kind, status, evidence_id FROM context_changes WHERE event_key=?")
      .get(`knowledge-governance-review:${captured.evidenceId}`);
    assert.deepEqual({ ...review }, { kind: "knowledge_review_due", status: "pending", evidence_id: captured.evidenceId });
    const leased = leaseKnowledgeEnrichment(context.store.db, { limit: 1, leaseOwner: "feedback-test" });
    assert.equal(leased.episodes[0].metadata.humanFeedback.targetId, "draft-1");
  } finally {
    context.close();
  }
});

test("resolved task emits an idempotent knowledge delta without writing graph facts", () => {
  const context = fixture();
  try {
    const source = context.store.upsertSource({ sourceKey: "resolution-source", kind: "test", uri: "test://resolution-source" });
    const primary = context.store.addEvidence({
      sourceId: source.id,
      kind: "project_document",
      title: "现有标定说明",
      content: "固定姿态六点法的项目说明。",
      sourceLocator: "test://resolution-source/calibration",
    });
    const beforeFacts = context.store.db.prepare("SELECT COUNT(*) AS value FROM graph_facts").get().value;
    const input = {
      idempotencyKey: "task-calibration-1:resolution-1",
      question: "固定姿态六点法如何用于眼在手外标定？",
      resolutionSummary: "已基于项目文档确认固定姿态六点法的适用边界，等待知识维护会话查重后写图谱。",
      durableCandidates: ["固定姿态六点法可通过机器人基坐标中的非共线基准点建立传感器到基座的刚体变换。"],
      decisions: ["沿用现有固定姿态六点法，不引入变姿态手眼标定。"],
      unknowns: ["现场基准点提取精度仍需实测。"],
      sourceEvidenceIds: [primary.id],
      sourceLocators: ["docs/calibration.md:12"],
      keywords: ["六点法", "眼在手外", "固定姿态"],
      retrievalCues: ["眼在手外如何沿用六点法", "固定姿态标定需要哪些基准点"],
      projectKey: "examplevision",
      sessionKey: "agent:main:shadow:workstream:test",
      metadata: { taskId: "task-calibration-1", checkpointApplied: true },
    };
    const first = captureResolutionKnowledgeDelta(context.store.db, input);
    const second = captureResolutionKnowledgeDelta(context.store.db, { ...input });
    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
    assert.equal(second.evidenceId, first.evidenceId);
    for (const changed of [
      { resolutionSummary: `${input.resolutionSummary} Changed conclusion.` },
      { durableCandidates: ["A different claim from the same source."] },
      { scope: { task: "different-task" } },
      { sourceEvidenceIds: [] },
      { metadata: { taskId: "another-task", checkpointApplied: true } },
    ]) {
      assert.throws(() => captureResolutionKnowledgeDelta(context.store.db, { ...input, ...changed }), /idempotencyKey.*different request/);
    }
    assert.equal(context.store.db.prepare("SELECT COUNT(*) n FROM evidence WHERE external_id=?")
      .get(`resolution-delta:${input.idempotencyKey}`).n, 1);
    assert.equal(captureResolutionKnowledgeDelta(context.store.db, input).inserted, false);
    assert.equal(captureResolutionKnowledgeDelta(context.store.db, { ...input,
      metadata: { ...input.metadata, checkpointApplied: false } }).inserted, false);
    assert.equal(context.store.db.prepare("SELECT COUNT(*) AS value FROM graph_facts").get().value, beforeFacts);
    const evidence = context.store.db.prepare("SELECT kind, role, external_id, metadata_json FROM evidence WHERE id=?").get(first.evidenceId);
    assert.equal(evidence.kind, "shadow_agent_task_result");
    assert.equal(evidence.role, "assistant");
    assert.equal(JSON.parse(evidence.metadata_json).knowledgeDelta.requiresExistingKnowledgeComparison, true);
    assert.equal(context.store.db.prepare(`
      SELECT COUNT(*) AS value FROM evidence_links
      WHERE parent_evidence_id=? AND child_evidence_id=? AND relation='summarizes'
    `).get(first.evidenceId, primary.id).value, 1);
    const change = context.store.db.prepare("SELECT kind, status, evidence_id FROM context_changes WHERE event_key=?")
      .get(`knowledge-delta-review:${first.evidenceId}`);
    assert.deepEqual({ ...change }, { kind: "knowledge_delta_due", status: "pending", evidence_id: first.evidenceId });
    assert.equal(context.store.db.prepare("SELECT COUNT(*) AS value FROM graph_enrichment_queue WHERE evidence_id=? AND reason='resolution-knowledge-delta'").get(first.evidenceId).value, 1);
    assert.deepEqual(
      JSON.parse(context.store.db.prepare("SELECT scope_json FROM graph_episode_annotations WHERE evidence_id=?").get(first.evidenceId).scope_json),
      { projectKey: "examplevision" },
    );
    assert.throws(() => captureResolutionKnowledgeDelta(context.store.db, {
      ...input,
      idempotencyKey: "recursive-curator-delta",
      sourceEvidenceIds: [first.evidenceId],
    }), /cannot summarize another knowledge delta/);
    assert.equal(context.store.db.prepare("SELECT COUNT(*) AS value FROM evidence WHERE external_id='resolution-delta:recursive-curator-delta'").get().value, 0);
  } finally {
    context.close();
  }
});

function manualInput(externalId) {
  return {
    sourceType: "dialogue",
    title: "人工维护规则",
    content: `用户明确补充一条可长期复用的维护规则：${externalId}`,
    summary: "这是一条需要进入知识召回卡并完成语义复核的人工维护规则。",
    keywords: ["人工知识", "维护规则", externalId],
    retrievalCues: ["人工补充了什么规则", "这条规则是否需要图关系"],
    scope: { domain: "test", projectKey: "ExampleVision", repository: "ui_refactor_product", topic: "manual-update" },
    salience: 0.8,
    externalId,
    generatedBy: "test",
  };
}

function candidateInput(sourceEvidenceIds, idempotencyKey = "represented-candidate") {
  return {
    idempotencyKey, question: "Which maintenance rule applies?",
    resolutionSummary: "The task found a reusable rule in the original source document.",
    durableCandidates: ["The original source documents the maintenance rule."],
    sourceEvidenceIds, keywords: ["maintenance", "rule", "source"],
    retrievalCues: ["Which rule applies?", "Where is the primary evidence?"],
  };
}

for (const legacyHash of [false, true]) {
  test(`knowledge delta ignores checkpoint transport metadata but retains payload conflicts (${legacyHash ? "persisted legacy hash" : "current hash"})`, () => {
    const context = fixture();
    try {
      const { db } = context.store;
      const primary = captureKnowledge(db, manualInput(`transport-source-${legacyHash}`));
      const other = captureKnowledge(db, manualInput(`other-transport-source-${legacyHash}`));
      const input = { ...candidateInput([primary.evidenceId], "transport-replay"),
        scope: { task: "task-one" }, decisions: ["Use the documented scope."], unknowns: ["Field acceptance remains unverified."],
        metadata: { taskId: "task-one", businessMeaning: "bounded rule", checkpointApplied: true,
          checkpointChangeSeq: 3, expectedCheckpointRevision: 1, expectedBindingRevision: 2,
          expectedExecution: { runId: "run-one", sessionKey: "execution-one" }, ownerSessionKey: "owner-one" } };
      const originalInput = structuredClone(input);
      const first = captureResolutionKnowledgeDelta(db, input);
      if (legacyHash) {
        // Persist the exact pre-fix fingerprint to exercise read-only recovery of older receipts.
        const { checkpointApplied, ...metadata } = input.metadata;
        const requestHash = createHash("sha256").update(stableJson({ ...input, metadata })).digest("hex");
        db.prepare("UPDATE evidence SET metadata_json=json_set(metadata_json,'$.knowledgeDelta.requestHash',?) WHERE id=?")
          .run(requestHash, first.evidenceId);
      }
      const snapshot = () => Object.fromEntries(["evidence", "evidence_links", "graph_episode_annotations", "graph_enrichment_queue", "context_changes"]
        .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
      const before = snapshot();
      const updates = { checkpointApplied: false, checkpointChangeSeq: 30,
        expectedCheckpointRevision: 5, expectedBindingRevision: 7,
        expectedExecution: { runId: "run-two", sessionKey: "execution-two" }, ownerSessionKey: "owner-two" };
      for (const changed of Object.entries(updates).map(([key, value]) => ({ [key]: value })).concat(updates)) {
        const replay = captureResolutionKnowledgeDelta(db, { ...input, metadata: { ...input.metadata, ...changed } });
        assert.equal(replay.inserted, false);
        assert.equal(replay.evidenceId, first.evidenceId);
        assert.deepEqual(snapshot(), before);
      }
      assert.equal(captureResolutionKnowledgeDelta(db, { ...input,
        metadata: { taskId: "task-one", businessMeaning: "bounded rule" } }).inserted, false);
      for (const changed of [
        { question: "A different knowledge question?" },
        { resolutionSummary: "The same evidence now supposedly proves a different conclusion." },
        { durableCandidates: ["A materially different claim."] },
        { decisions: ["Use a different rule."] }, { unknowns: [] },
        { sourceEvidenceIds: [other.evidenceId] }, { scope: { task: "task-two" } },
        { metadata: { ...input.metadata, taskId: "task-two" } },
        { metadata: { ...input.metadata, businessMeaning: "a broader rule" } },
        { metadata: { ...input.metadata, reason: "another semantic purpose" } },
      ]) {
        assert.throws(() => captureResolutionKnowledgeDelta(db, { ...input, ...changed }), /idempotencyKey.*different request/);
        assert.deepEqual(snapshot(), before);
      }
      assert.deepEqual(input, originalInput);
    } finally { context.close(); }
  });
}

test("transport-only metadata is equivalent to omitted metadata for a learning replay", () => {
  const context = fixture();
  try {
    const { db } = context.store;
    const primary = captureKnowledge(db, manualInput("optional-transport-source"));
    const input = candidateInput([primary.evidenceId], "optional-transport");
    const first = captureResolutionKnowledgeDelta(db, input);
    const replay = captureResolutionKnowledgeDelta(db, { ...input, metadata: {
      checkpointChangeSeq: 4, expectedCheckpointRevision: 10, checkpointApplied: false,
    } });
    assert.equal(replay.inserted, false);
    assert.equal(replay.evidenceId, first.evidenceId);
  } finally { context.close(); }
});

function sourceFact(database, evidenceId, key = "represented") {
  return proposeKnowledge(database, {
    entities: [{ canonicalKey: `rule:${key}`, type: "Rule", name: key }],
    facts: [{ subjectCanonicalKey: `rule:${key}`, predicate: "HAS_VALUE", objectValue: "current rule",
      sourceEvidenceIds: [evidenceId], evidenceProfile: { method: "document_record", directness: "direct" } }],
  }).facts[0].id;
}

test("represented primary support completes a delta without creating independent summary support", () => {
  const context = fixture();
  try {
    const { db } = context.store;
    const primary = captureKnowledge(db, manualInput("represented-primary"));
    const factId = sourceFact(db, primary.evidenceId);
    const delta = captureResolutionKnowledgeDelta(db, candidateInput([primary.evidenceId]));
    const input = { evidenceId: delta.evidenceId, summary: "Already represented by the primary document.",
      graphReview: { status: "completed", outcome: "facts_recorded", rationale: "The original source already supports this exact claim.",
        alreadyRepresentedFactIds: [factId] } };
    const before = db.prepare("SELECT COUNT(*) n FROM graph_evidence_assessments").get().n;
    const result = completeKnowledgeAnnotation(db, input);
    assert.equal(result.linkedFactCount, 1);
    assert.equal(result.alreadyRepresentedFactCount, 1);
    assert.equal(result.queueStatus, "completed");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM graph_evidence_assessments").get().n, before);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM graph_evidence_assessments WHERE evidence_id=?").get(delta.evidenceId).n, 0);
    assert.equal(completeKnowledgeAnnotation(db, input).reviewVersion, result.reviewVersion);
    const recorded = JSON.parse(db.prepare("SELECT metadata_json FROM graph_episode_annotations WHERE evidence_id=?")
      .get(delta.evidenceId).metadata_json).graphReview;
    assert.deepEqual(recorded.alreadyRepresentedFactIds, [factId]);
    assert.equal(recorded.materialChange, false);
    assert.throws(() => completeKnowledgeAnnotation(db, { ...input,
      graphReview: { ...input.graphReview, alreadyRepresentedFactIds: [], factIds: [factId] } }), /assessment from this knowledge episode/);
  } finally { context.close(); }
});

test("represented facts require current primary support from this delta, not unrelated or opposing evidence", () => {
  const context = fixture();
  try {
    const { db } = context.store;
    const primary = captureKnowledge(db, manualInput("representation-source"));
    const other = captureKnowledge(db, manualInput("unrelated-source"));
    const factId = sourceFact(db, other.evidenceId);
    const delta = captureResolutionKnowledgeDelta(db, candidateInput([primary.evidenceId]));
    const input = { evidenceId: delta.evidenceId,
      graphReview: { status: "completed", outcome: "facts_recorded", rationale: "Claim is already represented.", alreadyRepresentedFactIds: [factId] } };
    assert.throws(() => completeKnowledgeAnnotation(db, input), /primary sourceEvidenceIds/);
    assert.throws(() => completeKnowledgeAnnotation(db, { ...input, evidenceId: primary.evidenceId }), /knowledge delta/);
    const ownFact = sourceFact(db, primary.evidenceId, "own-fact");
    input.graphReview.alreadyRepresentedFactIds = [ownFact];
    db.prepare("UPDATE graph_evidence_assessments SET stance='refutes' WHERE fact_id=?").run(ownFact);
    assert.throws(() => completeKnowledgeAnnotation(db, input), /current support/);
    db.prepare("UPDATE graph_evidence_assessments SET stance='supports', valid_until='2000-01-01T00:00:00Z' WHERE fact_id=?").run(ownFact);
    assert.throws(() => completeKnowledgeAnnotation(db, input), /current support/);
    assert.equal(db.prepare("SELECT status FROM graph_enrichment_queue WHERE evidence_id=?").get(delta.evidenceId).status, "pending");
    for (const value of ["not-an-array", [null], Array(101).fill(ownFact)]) {
      assert.throws(() => completeKnowledgeAnnotation(db, { ...input,
        graphReview: { ...input.graphReview, alreadyRepresentedFactIds: value } }), /at most 100/);
    }
  } finally { context.close(); }
});

test("review feedback can reveal a genuinely new claim from an already reviewed source", () => {
  const context = fixture();
  try {
    const { db } = context.store;
    const primary = captureKnowledge(db, manualInput("shared-source"));
    const first = captureResolutionKnowledgeDelta(db, candidateInput([primary.evidenceId], "claim-one"));
    completeKnowledgeAnnotation(db, { evidenceId: first.evidenceId,
      graphReview: { status: "completed", outcome: "no_durable_facts", rationale: "First candidate was already covered by the task." } });
    const second = captureResolutionKnowledgeDelta(db, { ...candidateInput([primary.evidenceId], "claim-two"),
      durableCandidates: ["The same document also defines a previously missed scope restriction."],
      metadata: { reason: "knowledge_feedback_reviewed" } });
    assert.equal(second.inserted, true);
    assert.notEqual(second.evidenceId, first.evidenceId);
    const factId = sourceFact(db, second.evidenceId, "new-claim");
    assert.equal(completeKnowledgeAnnotation(db, { evidenceId: second.evidenceId,
      graphReview: { status: "completed", outcome: "facts_recorded", rationale: "A distinct scoped claim was recorded.", factIds: [factId] } }).linkedFactCount, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM evidence_links WHERE child_evidence_id=? AND relation='summarizes'").get(primary.evidenceId).n, 2);
  } finally { context.close(); }
});

test("review feedback accepts new primary evidence and a new candidate while preserving replay and recursive-source guards", () => {
  const context = fixture();
  try {
    const { db } = context.store;
    const original = captureKnowledge(db, manualInput("feedback-original"));
    const first = captureResolutionKnowledgeDelta(db, candidateInput([original.evidenceId], "before-review"));
    completeKnowledgeAnnotation(db, { evidenceId: first.evidenceId,
      graphReview: { status: "completed", outcome: "no_durable_facts", rationale: "The task needs stronger primary evidence." } });
    const source = context.store.upsertSource({ sourceKey: "new-review-source", kind: "test", uri: "test:new-review-source" });
    const fresh = context.store.addEvidence({ sourceId: source.id, kind: "project_document", title: "New scope evidence",
      content: "A newly inspected document limits the maintenance rule to the tested configuration.",
      sourceLocator: "test:new-review-source/document" });
    const input = { ...candidateInput([fresh.id], "after-review"),
      durableCandidates: ["The rule applies only to the tested configuration, not every deployment."],
      metadata: { taskId: "task-one", reason: "knowledge_feedback_reviewed" } };
    const result = captureResolutionKnowledgeDelta(db, input);
    assert.equal(result.inserted, true);
    assert.notEqual(result.evidenceId, first.evidenceId);
    assert.deepEqual(db.prepare("SELECT child_evidence_id FROM evidence_links WHERE parent_evidence_id=? AND relation='summarizes'")
      .all(result.evidenceId).map(row => row.child_evidence_id), [fresh.id]);
    const count = db.prepare("SELECT COUNT(*) n FROM evidence").get().n;
    const replay = captureResolutionKnowledgeDelta(db, input);
    assert.equal(replay.evidenceId, result.evidenceId);
    assert.equal(replay.inserted, false);
    assert.throws(() => captureResolutionKnowledgeDelta(db, { ...input, durableCandidates: ["A different claim."] }), /different request/);
    assert.throws(() => captureResolutionKnowledgeDelta(db, { ...input, idempotencyKey: "recursive-after-review",
      sourceEvidenceIds: [fresh.id, result.evidenceId] }), /cannot summarize another knowledge delta/);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM evidence").get().n, count);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM graph_facts").get().n, 0);
  } finally { context.close(); }
});

test("manual capture remains searchable while semantic review is pending", () => {
  const context = fixture();
  try {
    const captured = captureKnowledge(context.store.db, manualInput("no-durable-fact"));
    assert.equal(captured.status, "ready");
    assert.equal(captured.graphReviewStatus, "pending");
    assert.equal(context.store.db.prepare("SELECT status FROM graph_enrichment_queue WHERE evidence_id=?").get(captured.evidenceId).status, "pending");

    const leased = leaseKnowledgeEnrichment(context.store.db, { limit: 1, leaseOwner: "test" });
    assert.equal(leased.episodes[0].evidence_id, captured.evidenceId);
    const completed = completeKnowledgeAnnotation(context.store.db, {
      evidenceId: captured.evidenceId,
      leaseOwner: "test",
      generatedBy: "test",
      title: "人工维护规则",
      summary: "该人工说明只用于验证召回入口，没有形成需要长期维护的实体关系。",
      keywords: ["人工知识", "维护规则", "语义复核"],
      retrievalCues: ["人工知识如何完成复核", "何时可以不建立图关系"],
      graphReview: {
        status: "completed",
        outcome: "no_durable_facts",
        rationale: "测试材料不描述两个长期对象之间的关系。",
      },
    });
    assert.equal(completed.queueStatus, "completed");
    assert.equal(completed.graphReviewStatus, "completed");
    assert.equal(completed.graphReviewOutcome, "no_durable_facts");
    const metadata = JSON.parse(context.store.db.prepare("SELECT metadata_json FROM graph_episode_annotations WHERE evidence_id=?").get(captured.evidenceId).metadata_json);
    assert.equal(metadata.graphReview.status, "completed");
    assert.equal(metadata.graphReview.outcome, "no_durable_facts");
    const annotation = context.store.db.prepare("SELECT scope_json, salience FROM graph_episode_annotations WHERE evidence_id=?").get(captured.evidenceId);
    assert.deepEqual(JSON.parse(annotation.scope_json), {
      domain: "test",
      projectKey: "ExampleVision",
      repository: "ui_refactor_product",
      topic: "manual-update",
    });
    assert.equal(annotation.salience, 0.8);
  } finally {
    context.close();
  }
});

test("cold inventory is skipped by FIFO and promoted only by exact evidence id", () => {
  const context = fixture();
  try {
    const cold = captureKnowledge(context.store.db, manualInput("cold-on-demand"));
    const active = captureKnowledge(context.store.db, manualInput("active-review"));
    context.store.db.prepare(`
      UPDATE graph_enrichment_queue SET status='cold',
        metadata_json='{"governanceTier":"cold_inventory"}' WHERE evidence_id=?
    `).run(cold.evidenceId);

    const fifo = leaseKnowledgeEnrichment(context.store.db, { limit: 1, leaseOwner: "fifo-test" });
    assert.equal(fifo.episodes[0].evidence_id, active.evidenceId);
    context.store.db.prepare(`
      UPDATE graph_enrichment_queue SET status='pending', lease_owner=NULL, lease_until=NULL
      WHERE evidence_id=?
    `).run(active.evidenceId);

    const exact = leaseKnowledgeEnrichment(context.store.db, {
      evidenceIds: [cold.evidenceId],
      limit: 1,
      leaseOwner: "exact-test",
    });
    assert.deepEqual(exact.requestedEvidenceIds, [cold.evidenceId]);
    assert.equal(exact.episodes[0].evidence_id, cold.evidenceId);
    const queue = context.store.db.prepare("SELECT status, reason, metadata_json FROM graph_enrichment_queue WHERE evidence_id=?").get(cold.evidenceId);
    assert.equal(queue.status, "leased");
    assert.equal(queue.reason, "on-demand-knowledge-enrichment");
    assert.equal(JSON.parse(queue.metadata_json).governanceTier, "active_review");
  } finally {
    context.close();
  }
});

test("manual capture redacts credentials before evidence is stored", () => {
  const context = fixture();
  try {
    const input = manualInput("secret-redaction");
    input.content += " Authorization: Bearer abcdefghijklmnop api_key=topsecret";
    input.sourceLocator = "https://example.invalid/doc?access_token=verysecretvalue";
    const captured = captureKnowledge(context.store.db, input);
    assert.equal(captured.secretRedactionApplied, true);
    const evidence = context.store.db.prepare("SELECT content, source_locator, metadata_json FROM evidence WHERE id=?").get(captured.evidenceId);
    assert.doesNotMatch(evidence.content, /abcdefghijklmnop|topsecret/);
    assert.doesNotMatch(evidence.source_locator, /verysecretvalue/);
    assert.equal(JSON.parse(evidence.metadata_json).secretRedactionApplied, true);
  } finally {
    context.close();
  }
});

test("linked semantic review accepts only facts assessed by the same episode", () => {
  const context = fixture();
  try {
    const captured = captureKnowledge(context.store.db, manualInput("linked-fact"));
    leaseKnowledgeEnrichment(context.store.db, { limit: 1, leaseOwner: "test" });
    const proposed = proposeKnowledge(context.store.db, {
      createdBy: "test",
      rationale: "人工规则明确描述文档与维护概念的关系。",
      entities: [
        { canonicalKey: "document:manual-rule", type: "Document", name: "人工规则文档" },
        { canonicalKey: "concept:maintenance-rule", type: "Concept", name: "维护规则" },
      ],
      facts: [{
        subjectCanonicalKey: "concept:maintenance-rule",
        predicate: "DERIVED_FROM",
        objectCanonicalKey: "document:manual-rule",
        sourceEvidenceIds: [captured.evidenceId],
        evidenceProfile: { method: "statement", directness: "direct" },
      }],
    });
    const factId = proposed.facts[0].id;
    const completed = completeKnowledgeAnnotation(context.store.db, {
      evidenceId: captured.evidenceId,
      leaseOwner: "test",
      generatedBy: "test",
      title: "人工维护规则",
      summary: "人工输入形成了维护规则与其来源文档之间的可追溯长期关系。",
      keywords: ["人工知识", "维护规则", "证据关系"],
      retrievalCues: ["维护规则来自哪里", "人工知识补了什么关系"],
      graphReview: {
        status: "completed",
        outcome: "facts_recorded",
        rationale: "已建立并用本条人工证据评价 DERIVED_FROM 事实。",
        factIds: [factId],
      },
    });
    assert.equal(completed.queueStatus, "completed");
    assert.equal(completed.linkedFactCount, 1);
    assert.equal(context.store.db.prepare("SELECT status FROM graph_enrichment_queue WHERE evidence_id=?").get(captured.evidenceId).status, "completed");
  } finally {
    context.close();
  }
});

test("manual revision appends evidence, supersedes the old card, and marks unsupported facts for review", () => {
  const context = fixture();
  try {
    const originalInput = manualInput("revision-original");
    const original = captureKnowledge(context.store.db, originalInput);
    leaseKnowledgeEnrichment(context.store.db, { limit: 1, leaseOwner: "test" });
    const proposed = proposeKnowledge(context.store.db, {
      createdBy: "test",
      rationale: "原始人工规则形成待维护事实。",
      entities: [
        { canonicalKey: "rule:revision", type: "Rule", name: "修订规则" },
        { canonicalKey: "value:old", type: "Concept", name: "旧结论" },
      ],
      facts: [{
        subjectCanonicalKey: "rule:revision",
        predicate: "HAS_VALUE",
        objectCanonicalKey: "value:old",
        sourceEvidenceIds: [original.evidenceId],
        evidenceProfile: { method: "statement", directness: "direct" },
      }],
    });
    const derived = proposeKnowledge(context.store.db, {
      createdBy: "test",
      rationale: "派生结论依赖原始维护规则。",
      entities: [{ canonicalKey: "value:derived", type: "Concept", name: "派生结论" }],
      facts: [{
        subjectCanonicalKey: "rule:revision",
        predicate: "DERIVES",
        objectCanonicalKey: "value:derived",
        derivationFactIds: [proposed.facts[0].id],
        rationale: "该结论仅由原始规则推导。",
      }],
    });
    completeKnowledgeAnnotation(context.store.db, {
      evidenceId: original.evidenceId,
      leaseOwner: "test",
      generatedBy: "test",
      title: originalInput.title,
      summary: originalInput.summary,
      keywords: originalInput.keywords,
      retrievalCues: originalInput.retrievalCues,
      graphReview: {
        status: "completed",
        outcome: "facts_recorded",
        rationale: "原始证据已建立事实。",
        factIds: [proposed.facts[0].id],
      },
    });
    const originalContent = context.store.db.prepare("SELECT content FROM evidence WHERE id=?").get(original.evidenceId).content;

    const revised = reviseKnowledge(context.store.db, {
      ...manualInput("revision-corrected"),
      content: "用户纠正：旧维护规则已经失效，应以新的明确说明为准。",
      summary: "旧维护规则已被人工纠正，新结论等待语义复核和事实重建。",
      supersedesEvidenceIds: [original.evidenceId],
      revisionReason: "用户明确纠正旧结论",
      generatedBy: "human-reviewer",
    });

    assert.notEqual(revised.revisionEvidenceId, original.evidenceId);
    assert.equal(revised.reviewStatus, "pending");
    assert.equal(revised.audit.immutableEvidence, true);
    assert.deepEqual(new Set(revised.markedNeedsReviewFactIds), new Set([proposed.facts[0].id, derived.facts[0].id]));
    assert.equal(context.store.db.prepare("SELECT content FROM evidence WHERE id=?").get(original.evidenceId).content, originalContent);
    assert.equal(context.store.db.prepare(`
      SELECT COUNT(*) AS value FROM evidence_links
      WHERE parent_evidence_id=? AND child_evidence_id=? AND relation='supersedes'
    `).get(revised.revisionEvidenceId, original.evidenceId).value, 1);
    assert.equal(context.store.db.prepare("SELECT status FROM graph_episode_annotations WHERE evidence_id=?").get(original.evidenceId).status, "superseded");
    assert.equal(context.store.db.prepare("SELECT epistemic_status FROM graph_facts WHERE id=?").get(proposed.facts[0].id).epistemic_status, "proposed");
    assert.equal(context.store.db.prepare("SELECT epistemic_status FROM graph_facts WHERE id=?").get(derived.facts[0].id).epistemic_status, "proposed");
    assert.equal(context.store.db.prepare("SELECT valid_until FROM graph_evidence_assessments WHERE fact_id=?").get(proposed.facts[0].id).valid_until !== null, true);
    const revisionAnnotation = context.store.db.prepare("SELECT metadata_json FROM graph_episode_annotations WHERE evidence_id=?").get(revised.revisionEvidenceId);
    assert.equal(JSON.parse(revisionAnnotation.metadata_json).graphReview.status, "pending");
  } finally {
    context.close();
  }
});

test("manual revision preserves facts that still have independent current support", () => {
  const context = fixture();
  try {
    const original = captureKnowledge(context.store.db, manualInput("revision-alternate-support"));
    const entities = [
      { canonicalKey: "rule:alternate-support", type: "Rule", name: "多来源规则" },
      { canonicalKey: "value:stable", type: "Concept", name: "稳定结论" },
    ];
    const factInput = {
      subjectCanonicalKey: "rule:alternate-support",
      predicate: "HAS_VALUE",
      objectCanonicalKey: "value:stable",
      evidenceProfile: { method: "document_record", directness: "direct" },
    };
    const first = proposeKnowledge(context.store.db, {
      createdBy: "test",
      rationale: "人工证据支持规则。",
      entities,
      facts: [{ ...factInput, sourceEvidenceIds: [original.evidenceId] }],
    });
    const source = context.store.upsertSource({ sourceKey: "alternate-support", kind: "test", uri: "test://alternate-support" });
    const alternate = context.store.addEvidence({
      sourceId: source.id,
      kind: "project_document",
      title: "独立支持材料",
      content: "独立项目文档继续支持同一事实。",
      sourceLocator: "test://alternate-support/document",
    });
    proposeKnowledge(context.store.db, {
      createdBy: "test",
      rationale: "独立项目文档提供第二份当前支持。",
      entities,
      facts: [{ ...factInput, sourceEvidenceIds: [alternate.id] }],
    });
    context.store.db.prepare("UPDATE graph_facts SET epistemic_status='supported' WHERE id=?").run(first.facts[0].id);

    const revised = reviseKnowledge(context.store.db, {
      ...manualInput("revision-alternate-correction"),
      content: "用户修订了第一份说明，但独立项目文档仍然有效。",
      summary: "第一份人工说明被修订，事实仍有独立项目文档作为当前支持。",
      supersedesEvidenceIds: [original.evidenceId],
      revisionReason: "替换第一份人工说明",
      generatedBy: "human-reviewer",
    });

    assert.deepEqual(revised.markedNeedsReviewFactIds, []);
    assert.equal(context.store.db.prepare("SELECT epistemic_status FROM graph_facts WHERE id=?").get(first.facts[0].id).epistemic_status, "supported");
    assert.equal(context.store.db.prepare(`
      SELECT COUNT(*) AS value FROM graph_evidence_assessments
      WHERE fact_id=? AND evidence_id=? AND (valid_until IS NULL OR valid_until>?)
    `).get(first.facts[0].id, alternate.id, new Date().toISOString()).value, 1);
  } finally {
    context.close();
  }
});

test("curator proposals can supersede an obsolete fact without deleting history", () => {
  const context = fixture();
  try {
    const oldEvidence = captureKnowledge(context.store.db, manualInput("fact-supersession-old"));
    const newEvidence = captureKnowledge(context.store.db, manualInput("fact-supersession-new"));
    const entities = [
      { canonicalKey: "setting:knowledge-test", type: "Setting", name: "知识测试设置" },
      { canonicalKey: "value:old-setting", type: "Concept", name: "旧设置" },
      { canonicalKey: "value:new-setting", type: "Concept", name: "新设置" },
    ];
    const oldFact = proposeKnowledge(context.store.db, {
      createdBy: "curator-test",
      rationale: "旧证据支持旧设置。",
      entities,
      facts: [{
        subjectCanonicalKey: "setting:knowledge-test",
        predicate: "HAS_VALUE",
        objectCanonicalKey: "value:old-setting",
        sourceEvidenceIds: [oldEvidence.evidenceId],
        evidenceProfile: { method: "statement", directness: "direct" },
      }],
    }).facts[0];
    const newFact = proposeKnowledge(context.store.db, {
      createdBy: "curator-test",
      rationale: "新证据明确取代旧设置。",
      facts: [{
        subjectCanonicalKey: "setting:knowledge-test",
        predicate: "HAS_VALUE",
        objectCanonicalKey: "value:new-setting",
        sourceEvidenceIds: [newEvidence.evidenceId],
        supersedesFactId: oldFact.id,
        relationToExisting: "same_claim",
        supersessionReason: "新证据明确取代旧设置",
        evidenceProfile: { method: "statement", directness: "direct" },
      }],
    }).facts[0];
    const oldRow = context.store.db.prepare("SELECT status, valid_to FROM graph_facts WHERE id=?").get(oldFact.id);
    const newRow = context.store.db.prepare("SELECT supersedes_fact_id FROM graph_facts WHERE id=?").get(newFact.id);
    assert.equal(oldRow.status, "superseded");
    assert.ok(oldRow.valid_to);
    assert.equal(newRow.supersedes_fact_id, oldFact.id);
  } finally {
    context.close();
  }
});
