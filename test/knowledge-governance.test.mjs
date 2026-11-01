import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { captureKnowledge } from "../openclaw/shadow-work/src/epistemic.js";
import { auditKnowledgeQuality } from "../scripts/audit-knowledge-quality.mjs";
import { materializeContextGraph } from "../src/context-graph.mjs";
import { openDatabase } from "../src/db.mjs";
import { applyKnowledgeGovernance, inspectKnowledgeGovernance } from "../src/knowledge-governance.mjs";
import { sha256 } from "../src/utils.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-knowledge-governance-"));
  const store = openDatabase(path.join(root, "shadow.sqlite"));
  return {
    root,
    store,
    close() {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("governance migration separates routes, active reviews, cold inventory, and test artifacts", () => {
  const context = fixture();
  try {
    const { store } = context;
    const source = store.upsertSource({ sourceKey: "governance-test", kind: "test", uri: "test://governance" });
    store.upsertProject({ projectKey: "examplevision", name: "ExampleVision", rootPath: "D:\\ExampleVision" });
    const coldEvidence = store.addEvidence({
      sourceId: source.id,
      kind: "codex_thread_digest",
      projectKey: "examplevision",
      threadId: "thread-cold",
      title: "历史会话摘要",
      content: "已经具备临时召回卡的历史内容。",
      sourceLocator: "codex://thread/cold",
      fingerprint: "governance-cold",
    });
    const activeTask = store.addEvidence({
      sourceId: source.id,
      kind: "feishu_task",
      projectKey: "examplevision",
      title: "当前飞书任务",
      content: "需要主控判断当前任务的长期知识。",
      sourceLocator: "feishu://task/current",
      externalId: "current-task",
      fingerprint: "governance-active-task",
    });
    materializeContextGraph(store, { contextGraph: { maxEvidencePerCycle: 100, maxKnowledgeBackfillPerCycle: 100 } });
    store.db.prepare(`
      UPDATE graph_enrichment_queue SET status='pending', attempts=0,
        metadata_json='{}' WHERE evidence_id=?
    `).run(coldEvidence.id);

    const belongs = store.db.prepare(`
      SELECT id FROM graph_facts WHERE status='active' AND predicate='BELONGS_TO' LIMIT 1
    `).get();
    store.db.prepare(`
      UPDATE graph_facts SET assertion_mode='observed', epistemic_status='supported',
        metadata_json='{}' WHERE id=?
    `).run(belongs.id);

    const self = store.db.prepare("SELECT id FROM graph_entities WHERE canonical_key='person:self'").get();
    const project = store.db.prepare("SELECT id FROM graph_entities WHERE canonical_key='project:examplevision'").get();
    const externalProjectId = "external-project-without-local-workspace";
    store.db.prepare(`
      INSERT INTO graph_entities(
        id, canonical_key, type, name, summary, project_key, status,
        first_seen_at, last_seen_at, updated_at, metadata_json
      ) VALUES(?, 'project:external-reference', 'Project', '外部项目引用', '', NULL, 'active',
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z', '{}')
    `).run(externalProjectId);
    const invalidWorkspaceFingerprint = sha256(`${self.id}:HAS_LOCAL_WORKSPACE:${externalProjectId}`);
    const invalidWorkspaceFactId = sha256(`graph-fact:${invalidWorkspaceFingerprint}`).slice(0, 32);
    store.db.prepare(`
      INSERT INTO graph_facts(
        id, fingerprint, subject_entity_id, predicate, object_entity_id, object_value,
        status, confidence, valid_from, observed_at, updated_at, metadata_json,
        scope_key, assertion_mode, epistemic_status, created_by
      ) VALUES(?, ?, ?, 'HAS_LOCAL_WORKSPACE', ?, NULL, 'active', 1,
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z',
        '{"structuralSource":{"table":"graph_entities","key":"project:external-reference"}}',
        'global', 'structural_route', 'proposed', 'system')
    `).run(invalidWorkspaceFactId, invalidWorkspaceFingerprint, self.id, externalProjectId);
    const legacyFingerprint = sha256(`${self.id}:TRACKS_PROJECT:${project.id}`);
    const legacyTrackId = sha256(`graph-fact:${legacyFingerprint}`).slice(0, 32);
    store.db.prepare(`
      INSERT INTO graph_facts(
        id, fingerprint, subject_entity_id, predicate, object_entity_id, object_value,
        status, confidence, valid_from, observed_at, updated_at, metadata_json,
        scope_key, assertion_mode, epistemic_status, created_by
      ) VALUES(?, ?, ?, 'TRACKS_PROJECT', ?, NULL, 'active', 1,
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z', '{}', 'global', 'observed', 'supported', 'system')
    `).run(legacyTrackId, legacyFingerprint, self.id, project.id);

    const smoke = captureKnowledge(store.db, {
      sourceType: "dialogue",
      title: "V4.9 统一输入任务建卡冒烟测试",
      content: "测试数据不得留在生产知识库。",
      summary: "该条记录只用于验证生产污染治理和限定删除规则。",
      keywords: ["统一输入", "任务建卡", "冒烟测试"],
      retrievalCues: ["冒烟记录是否清理", "测试数据是否进入生产库"],
      sourceLocator: "shadow-agent://smoke/governance-test",
      externalId: "governance-smoke",
      generatedBy: "unified-direct-input-smoke",
    });
    const feedback = captureKnowledge(store.db, {
      sourceType: "dialogue",
      title: "用户纠正职责归属",
      content: "该测试报告不是我的执行任务，不要继续归到我的职责。",
      summary: "用户明确纠正了一条职责归属，需要在同一知识链路完成语义复核。",
      keywords: ["职责纠正", "人工反馈", "任务归属"],
      retrievalCues: ["用户纠正了什么职责", "哪些任务不属于用户"],
      sourceLocator: "shadow://knowledge-episode/workboard/test",
      externalId: "governance-feedback",
      generatedBy: "shadow-human-feedback",
    });

    const plan = inspectKnowledgeGovernance(store.db);
    assert.equal(plan.smokeArtifacts, 1);
    assert.equal(plan.coldCandidates, 1);
    assert.equal(plan.legacyTracksProjectRoutes, 1);
    assert.ok(plan.structuralBelongsToCandidates >= 1);
    assert.equal(plan.invalidWorkspaceRoutes, 1);
    assert.equal(plan.manualReviewWakeCandidates, 0);

    const migrated = applyKnowledgeGovernance(store.db, { timestamp: "2026-08-30T00:00:00.000Z" });
    assert.deepEqual(migrated.actions.deletedSmokeEvidenceIds, [smoke.evidenceId]);
    assert.deepEqual(migrated.actions.coldEvidenceIds, [coldEvidence.id]);
    assert.deepEqual(migrated.actions.supersededTrackFactIds, [legacyTrackId]);
    assert.deepEqual(migrated.actions.supersededWorkspaceFactIds, [invalidWorkspaceFactId]);
    assert.deepEqual(migrated.actions.scheduledManualReviewEvidenceIds, []);
    assert.equal(store.db.prepare("SELECT 1 FROM evidence WHERE id=?").get(smoke.evidenceId), undefined);
    assert.equal(store.db.prepare("SELECT status FROM graph_enrichment_queue WHERE evidence_id=?").get(coldEvidence.id).status, "cold");
    assert.equal(store.db.prepare("SELECT status FROM graph_enrichment_queue WHERE evidence_id=?").get(activeTask.id).status, "pending");
    assert.equal(store.db.prepare("SELECT status FROM graph_facts WHERE id=?").get(legacyTrackId).status, "superseded");
    assert.equal(store.db.prepare("SELECT status FROM graph_facts WHERE id=?").get(invalidWorkspaceFactId).status, "superseded");
    assert.equal(store.db.prepare("SELECT assertion_mode FROM graph_facts WHERE id=?").get(belongs.id).assertion_mode, "structural_route");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM graph_facts WHERE status='active' AND predicate='HAS_LOCAL_WORKSPACE' AND assertion_mode='structural_route'").get().count, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM context_changes WHERE kind='knowledge_review_due' AND evidence_id=?").get(feedback.evidenceId).count, 1);

    const report = auditKnowledgeQuality(store.db);
    assert.equal(report.queueGovernance.coldInventory.count, 1);
    assert.equal(report.activeFacts.structuralRoutes.missingSource.count, 0);
    assert.equal(report.strict.violations.activeFactsWithoutEvidenceAssessmentOrDerivation, 0);
    assert.equal(report.strict.violations.structuralRoutesWithoutSource, 0);

    const repeated = applyKnowledgeGovernance(store.db, { timestamp: "2026-08-30T00:01:00.000Z" });
    assert.equal(repeated.actions.deletedSmokeEvidenceIds.length, 0);
    assert.equal(repeated.actions.coldEvidenceIds.length, 0);
    assert.equal(repeated.actions.supersededTrackFactIds.length, 0);
    assert.equal(repeated.actions.supersededWorkspaceFactIds.length, 0);
    assert.equal(repeated.actions.structuralFactIds.length, 0);
    assert.equal(repeated.actions.scheduledManualReviewEvidenceIds.length, 0);
  } finally {
    context.close();
  }
});
