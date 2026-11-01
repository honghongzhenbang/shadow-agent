import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyKnowledgeBundle,
  assessFactEvidence,
  backfillGraphReviewState,
  deriveEvidenceLevel,
  enqueueKnowledgeBackfill,
  epistemicGraphStats,
  loadOntologyFile,
  traceGraphImpact,
  upsertKnowledgeAnnotation,
} from "../src/graph-model.mjs";
import { openDatabase } from "../src/db.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-graph-v3-"));
  const store = openDatabase(path.join(root, "graph.sqlite"));
  loadOntologyFile(store.db, path.join(projectRoot, "knowledge", "ontology", "core.json"));
  loadOntologyFile(store.db, path.join(projectRoot, "knowledge", "ontology", "software-version.json"));
  const source = store.upsertSource({ sourceKey: "test:evidence", kind: "test", uri: "test://evidence" });
  const evidence = store.addEvidence({
    sourceId: source.id,
    kind: "import_document",
    title: "结构与变更证据",
    content: "用于验证通用图谱事实、证据画像和影响传播。",
    sourceLocator: "test://evidence/1",
    fingerprint: "graph-v3-evidence-1",
  });
  return {
    root,
    store,
    evidenceId: evidence.id,
    close() {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("evidence levels keep artifact, execution, integration and field proof distinct", () => {
  assert.equal(deriveEvidenceLevel({ method: "llm_summary" }), 1);
  assert.equal(deriveEvidenceLevel({ method: "git_diff" }), 2);
  assert.equal(deriveEvidenceLevel({ method: "build", environment: "local" }), 3);
  assert.equal(deriveEvidenceLevel({ method: "hardware_in_loop", environment: "target" }), 4);
  assert.equal(deriveEvidenceLevel({ method: "production_observation", environment: "production" }), 5);
  assert.equal(deriveEvidenceLevel({ method: "human_confirmation", environment: "unknown" }), 1);
});

test("software version knowledge uses the generic entity and fact model", () => {
  const testContext = fixture();
  try {
    const result = applyKnowledgeBundle(testContext.store.db, {
      createdBy: "codex:test",
      entities: [
        { canonicalKey: "software:examplevision", type: "SoftwareProduct", name: "ExampleVision" },
        { canonicalKey: "version:examplevision:v5", type: "SoftwareVersion", name: "ExampleVision v5.0.0" },
        { canonicalKey: "manifest:examplevision:v5", type: "VersionManifest", name: "ExampleVision v5.0.0 manifest" },
        { canonicalKey: "interface:camera-image", type: "InterfaceContract", name: "Camera Image contract" },
        { canonicalKey: "component:consumer", type: "SoftwareComponent", name: "Image consumer" },
      ],
      facts: [
        {
          subject: "version:examplevision:v5",
          predicate: "SPECIALIZATION_OF",
          objectEntity: "software:examplevision",
          sourceEvidenceIds: [testContext.evidenceId],
          evidenceAssessments: [{ evidenceId: testContext.evidenceId, method: "document_record", basis: "artifact" }],
        },
        {
          subject: "manifest:examplevision:v5",
          predicate: "DESCRIBES_VERSION",
          objectEntity: "version:examplevision:v5",
          sourceEvidenceIds: [testContext.evidenceId],
          evidenceAssessments: [{ evidenceId: testContext.evidenceId, method: "source_inspection", basis: "artifact" }],
        },
        {
          subject: "interface:camera-image",
          predicate: "PART_OF",
          objectEntity: "manifest:examplevision:v5",
          sourceEvidenceIds: [testContext.evidenceId],
          evidenceAssessments: [{ evidenceId: testContext.evidenceId, method: "source_inspection", basis: "artifact" }],
        },
        {
          subject: "component:consumer",
          predicate: "DEPENDS_ON",
          objectEntity: "interface:camera-image",
          sourceEvidenceIds: [testContext.evidenceId],
          evidenceAssessments: [{ evidenceId: testContext.evidenceId, method: "git_diff", basis: "artifact" }],
        },
      ],
    });

    assert.equal(result.entities.length, 5);
    assert.equal(result.facts.length, 4);
    const impact = traceGraphImpact(testContext.store.db, {
      seedEntityIds: ["interface:camera-image"],
      maxDepth: 2,
      minConfidence: 0.1,
    });
    assert.ok(impact.impacts.some((item) => item.entity?.canonical_key === "component:consumer"));
    assert.equal(epistemicGraphStats(testContext.store.db).evidenceAssessments, 4);
    assert.equal(testContext.store.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'software_%'").get().count, 0);
  } finally {
    testContext.close();
  }
});

test("the same propagation engine works for non-software knowledge", () => {
  const testContext = fixture();
  try {
    applyKnowledgeBundle(testContext.store.db, {
      createdBy: "codex:test",
      entities: [
        { canonicalKey: "document:meeting-notes", type: "Document", name: "会议纪要" },
        { canonicalKey: "document:weekly-report", type: "Document", name: "周报" },
      ],
      facts: [
        {
          subject: "document:weekly-report",
          predicate: "DERIVED_FROM",
          objectEntity: "document:meeting-notes",
          sourceEvidenceIds: [testContext.evidenceId],
          evidenceAssessments: [{ evidenceId: testContext.evidenceId, method: "document_record", basis: "artifact" }],
        },
      ],
    });
    const impact = traceGraphImpact(testContext.store.db, {
      seedEntityIds: ["document:meeting-notes"],
      maxDepth: 2,
      minConfidence: 0.1,
    });
    assert.equal(impact.impacts[0].entity.canonical_key, "document:weekly-report");
    assert.equal(impact.impacts[0].path[0].predicate, "DERIVED_FROM");
  } finally {
    testContext.close();
  }
});

test("learned types and relations remain open but do not propagate by default", () => {
  const testContext = fixture();
  try {
    applyKnowledgeBundle(testContext.store.db, {
      createdBy: "codex:test",
      entities: [
        { canonicalKey: "custom:a", type: "FutureDomainObject", name: "A" },
        { canonicalKey: "custom:b", type: "FutureDomainObject", name: "B" },
      ],
      facts: [
        {
          subject: "custom:a",
          predicate: "NEW_DOMAIN_RELATION",
          objectEntity: "custom:b",
          sourceEvidenceIds: [testContext.evidenceId],
        },
      ],
    });
    assert.ok(testContext.store.db.prepare("SELECT 1 FROM graph_entity_types WHERE type='FutureDomainObject'").get());
    const relation = testContext.store.db.prepare("SELECT * FROM graph_relation_types WHERE predicate='NEW_DOMAIN_RELATION'").get();
    assert.equal(relation.forward_impact_weight, 0);
    assert.equal(relation.reverse_impact_weight, 0);
    assert.equal(traceGraphImpact(testContext.store.db, { seedEntityIds: ["custom:a"] }).impacts.length, 0);
  } finally {
    testContext.close();
  }
});

test("legacy evidence is queued once and upgraded into a retrieval card", () => {
  const testContext = fixture();
  try {
    const queued = enqueueKnowledgeBackfill(testContext.store.db, { limit: 20 });
    assert.equal(queued.queued, 1);
    const provisional = testContext.store.db.prepare("SELECT * FROM graph_episode_annotations WHERE evidence_id=?").get(testContext.evidenceId);
    assert.equal(provisional.status, "pending");
    assert.ok(JSON.parse(provisional.retrieval_cues_json).length >= 1);
    assert.equal(enqueueKnowledgeBackfill(testContext.store.db, { limit: 20 }).queued, 0);

    upsertKnowledgeAnnotation(testContext.store.db, {
      evidenceId: testContext.evidenceId,
      title: "通用图谱验证知识",
      summary: "这条知识说明软件版本和普通文档关系使用同一个开放事实模型。",
      keywords: ["知识图谱", "软件版本", "开放事实"],
      retrievalCues: ["软件版本如何表示", "普通文档如何关联"],
      scope: { test: true },
      generatedBy: "codex:test",
      status: "ready",
    });
    assert.equal(epistemicGraphStats(testContext.store.db).knowledgeUnits, 1);
    assert.equal(testContext.store.db.prepare("SELECT status FROM graph_enrichment_queue WHERE evidence_id=?").get(testContext.evidenceId).status, "completed");
    const reviewBackfill = backfillGraphReviewState(testContext.store.db);
    assert.deepEqual({ factsRecorded: reviewBackfill.factsRecorded, requeued: reviewBackfill.requeued }, { factsRecorded: 0, requeued: 1 });
    assert.equal(testContext.store.db.prepare("SELECT status FROM graph_enrichment_queue WHERE evidence_id=?").get(testContext.evidenceId).status, "pending");
    assert.equal(
      JSON.parse(testContext.store.db.prepare("SELECT metadata_json FROM graph_episode_annotations WHERE evidence_id=?").get(testContext.evidenceId).metadata_json).graphReview.status,
      "pending",
    );
  } finally {
    testContext.close();
  }
});

test("graph review backfill preserves cards that already have evidence-backed facts", () => {
  const testContext = fixture();
  try {
    upsertKnowledgeAnnotation(testContext.store.db, {
      evidenceId: testContext.evidenceId,
      title: "已有事实的知识卡",
      summary: "该知识卡已经通过事实评价与通用语义图建立了可追溯关联。",
      keywords: ["事实评价", "知识卡", "图关系"],
      retrievalCues: ["这条知识是否已补链", "事实证据来自哪里"],
      generatedBy: "codex:test",
      status: "ready",
    });
    const bundle = applyKnowledgeBundle(testContext.store.db, {
      createdBy: "codex:test",
      entities: [
        { canonicalKey: "document:review-source", type: "Document", name: "来源文档" },
        { canonicalKey: "concept:review-target", type: "Concept", name: "长期结论" },
      ],
      facts: [{
        subject: "concept:review-target",
        predicate: "DERIVED_FROM",
        objectEntity: "document:review-source",
        sourceEvidenceIds: [testContext.evidenceId],
        evidenceAssessments: [{ evidenceId: testContext.evidenceId, method: "document_record" }],
      }],
    });
    const result = backfillGraphReviewState(testContext.store.db);
    assert.deepEqual({ factsRecorded: result.factsRecorded, requeued: result.requeued }, { factsRecorded: 1, requeued: 0 });
    const metadata = JSON.parse(testContext.store.db.prepare("SELECT metadata_json FROM graph_episode_annotations WHERE evidence_id=?").get(testContext.evidenceId).metadata_json);
    assert.equal(metadata.graphReview.status, "completed");
    assert.equal(metadata.graphReview.outcome, "facts_recorded");
    assert.deepEqual(metadata.graphReview.factIds, [bundle.facts[0].id]);
    assert.equal(testContext.store.db.prepare("SELECT status FROM graph_enrichment_queue WHERE evidence_id=?").get(testContext.evidenceId).status, "completed");
  } finally {
    testContext.close();
  }
});

test("fact trust is derived from evidence instead of review completion", () => {
  const testContext = fixture();
  try {
    const weak = applyKnowledgeBundle(testContext.store.db, {
      createdBy: "codex:test",
      entities: [{ canonicalKey: "claim:trust", type: "Concept", name: "可信状态测试" }],
      facts: [{
        subject: "claim:trust",
        predicate: "HAS_VALUE",
        objectValue: "A",
        sourceEvidenceIds: [testContext.evidenceId],
        evidenceAssessments: [{ evidenceId: testContext.evidenceId, method: "statement", stance: "supports" }],
      }],
    }).facts[0];
    assert.equal(testContext.store.db.prepare("SELECT epistemic_status FROM graph_facts WHERE id=?").get(weak.id).epistemic_status, "proposed");

    const source = testContext.store.upsertSource({ sourceKey: "test:direct-proof", kind: "test", uri: "test://direct-proof" });
    const direct = testContext.store.addEvidence({
      sourceId: source.id, kind: "project_document", title: "直接证据", content: "A",
      sourceLocator: "test://direct-proof/1", fingerprint: "trust-direct-proof",
    });
    assessFactEvidence(testContext.store.db, {
      factId: weak.id, evidenceId: direct.id, method: "source_inspection", stance: "supports", assessedBy: "codex:test",
    });
    assert.equal(testContext.store.db.prepare("SELECT epistemic_status FROM graph_facts WHERE id=?").get(weak.id).epistemic_status, "supported");

    const contradiction = testContext.store.addEvidence({
      sourceId: source.id, kind: "project_document", title: "矛盾证据", content: "not A",
      sourceLocator: "test://direct-proof/2", fingerprint: "trust-contradiction",
    });
    assessFactEvidence(testContext.store.db, {
      factId: weak.id, evidenceId: contradiction.id, method: "source_inspection", stance: "contradicts", assessedBy: "codex:test",
    });
    assert.equal(testContext.store.db.prepare("SELECT epistemic_status FROM graph_facts WHERE id=?").get(weak.id).epistemic_status, "disputed");
    assert.throws(() => assessFactEvidence(testContext.store.db, {
      factId: weak.id, evidenceId: contradiction.id, method: "message_record", stance: "mentions", assessedBy: "codex:test",
    }), /entity evidence links/);
  } finally {
    testContext.close();
  }
});

test("identical replacement retains the fact without inventing or clearing a review", () => {
  const f = fixture();
  try {
    const propose = extras => applyKnowledgeBundle(f.store.db, {
      entities: [{ canonicalKey: "setting:duplicate", type: "Setting", name: "Duplicate fixture" }],
      facts: [{ subject: "setting:duplicate", predicate: "HAS_VALUE", objectValue: "same",
        sourceEvidenceIds: [f.evidenceId],
        evidenceAssessments: [{ evidenceId: f.evidenceId, method: "document_record" }], ...extras }],
    }).facts[0];
    const original = propose({});
    const metadata = () => JSON.parse(f.store.db.prepare("SELECT metadata_json FROM graph_facts WHERE id=?").get(original.id).metadata_json);
    const retry = () => propose({ supersedesFactId: original.id, supersessionReason: "Repeated observation" });
    assert.equal(retry().id, original.id);
    assert.equal(retry().supersession.action, "retain_existing_fact");
    assert.equal(metadata().supersessionReview, undefined);
    const previous = { status: "needs_input", targetFactId: "prior", problems: ["different_scope"] };
    f.store.db.prepare("UPDATE graph_facts SET metadata_json=? WHERE id=?")
      .run(JSON.stringify({ ...metadata(), supersessionReview: previous }), original.id);
    assert.equal(retry().supersession.allowed, false);
    assert.deepEqual(metadata().supersessionReview, previous);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM graph_facts").get().n, 1);
  } finally { f.close(); }
});

test("unsafe supersession preserves both facts and requests review", () => {
  const testContext = fixture();
  try {
    const original = applyKnowledgeBundle(testContext.store.db, {
      createdBy: "codex:test",
      entities: [
        { canonicalKey: "setting:a", type: "Setting", name: "设置 A" },
        { canonicalKey: "setting:b", type: "Setting", name: "设置 B" },
      ],
      facts: [{
        subject: "setting:a", predicate: "HAS_VALUE", objectValue: "old",
        sourceEvidenceIds: [testContext.evidenceId],
        evidenceAssessments: [{ evidenceId: testContext.evidenceId, method: "document_record" }],
      }],
    }).facts[0];
    const candidate = applyKnowledgeBundle(testContext.store.db, {
      createdBy: "codex:test",
      facts: [{
        subject: "setting:b", predicate: "HAS_VALUE", objectValue: "new",
        sourceEvidenceIds: [testContext.evidenceId],
        evidenceAssessments: [{ evidenceId: testContext.evidenceId, method: "document_record" }],
        supersedesFactId: original.id,
        relationToExisting: "same_claim",
        supersessionReason: "尝试跨主体替换",
      }],
    }).facts[0];
    assert.equal(testContext.store.db.prepare("SELECT status FROM graph_facts WHERE id=?").get(original.id).status, "active");
    const candidateRow = testContext.store.db.prepare("SELECT status, supersedes_fact_id, metadata_json FROM graph_facts WHERE id=?").get(candidate.id);
    assert.equal(candidateRow.status, "active");
    assert.equal(candidateRow.supersedes_fact_id, null);
    assert.ok(JSON.parse(candidateRow.metadata_json).supersessionReview.problems.includes("different_subject"));
  } finally {
    testContext.close();
  }
});
