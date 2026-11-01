import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase } from "../src/db.mjs";
import {
  initializeGraphMaintenance,
  propagateKnowledgeStaleness,
} from "../src/graph-maintenance.mjs";
import {
  applyKnowledgeBundle,
  assessFactEvidence,
} from "../src/graph-model.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-graph-maintenance-"));
  const store = openDatabase(path.join(root, "graph.sqlite"));
  initializeGraphMaintenance(store.db);
  const source = store.upsertSource({
    sourceKey: `test:maintenance:${root}`,
    kind: "test",
    uri: "test://graph-maintenance",
  });
  let evidenceSequence = 0;

  return {
    store,
    addEvidence(label) {
      evidenceSequence += 1;
      return store.addEvidence({
        sourceId: source.id,
        kind: "import_document",
        title: label,
        content: `Evidence ${label}`,
        sourceLocator: `test://graph-maintenance/${evidenceSequence}`,
        fingerprint: `graph-maintenance-${label}-${evidenceSequence}`,
      });
    },
    close() {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function addObservedFact(context, key, evidence, methods = []) {
  const evidenceIds = Array.isArray(evidence) ? evidence.map((item) => item.id) : [evidence.id];
  const assessments = evidenceIds.map((evidenceId, index) => ({
    evidenceId,
    method: methods[index] ?? "source_inspection",
    basis: "artifact",
    stance: "supports",
  }));
  return applyKnowledgeBundle(context.store.db, {
    createdBy: "test:graph-maintenance",
    entities: [{
      canonicalKey: `maintenance:${key}`,
      type: "Entity",
      name: key,
    }],
    facts: [{
      subject: `maintenance:${key}`,
      predicate: "HAS_MAINTENANCE_VALUE",
      objectValue: { key },
      assertionMode: "observed",
      sourceEvidenceIds: evidenceIds,
      evidenceAssessments: assessments,
    }],
  }).facts[0].id;
}

function addDerivedFact(context, key, inputFactIds) {
  return applyKnowledgeBundle(context.store.db, {
    createdBy: "test:graph-maintenance",
    entities: [{
      canonicalKey: `maintenance:${key}`,
      type: "Entity",
      name: key,
    }],
    facts: [{
      subject: `maintenance:${key}`,
      predicate: "HAS_DERIVED_MAINTENANCE_VALUE",
      objectValue: { key },
      assertionMode: "derived",
      derivationFactIds: inputFactIds,
      ruleKey: "test_derivation",
    }],
  }).facts[0].id;
}

function fact(database, factId) {
  return database.prepare("SELECT * FROM graph_facts WHERE id=?").get(factId);
}

test("expiry invalidates sole support but not another current assessment of the same source", () => {
  const context = fixture();
  try {
    const source = context.addEvidence("expiry");
    const factId = addObservedFact(context, "expiry", source);
    context.store.db.prepare("UPDATE graph_evidence_assessments SET valid_until='2026-01-01' WHERE fact_id=?").run(factId);
    const expired = propagateKnowledgeStaleness(context.store.db, { now: "2026-02-01" });
    assert.equal(expired.changes.markedNeedsReview, 1);
    assert.equal(expired.transitions[0].reason, "all_supporting_evidence_inactive");
    assessFactEvidence(context.store.db, { factId, evidenceId: source.id, method: "document_record",
      basis: "record", directness: "direct", assessedBy: "current-source-review" });
    const current = propagateKnowledgeStaleness(context.store.db, { now: "2026-02-01" });
    assert.equal(current.evidence.fullySupersededFacts, 0);
    assert.equal(fact(context.store.db, factId).epistemic_status, "supported");
  } finally { context.close(); }
});

test("superseding every supporting evidence downgrades trust and records review need", () => {
  const context = fixture();
  try {
    const original = context.addEvidence("original");
    const replacement = context.addEvidence("replacement");
    const factId = addObservedFact(context, "single-support", original);
    context.store.linkEvidence(replacement.id, [original.id], "supersedes");

    const result = propagateKnowledgeStaleness(context.store.db, {
      now: "2026-08-11T10:00:00.000Z",
      runId: "test-evidence-replacement",
    });

    const stored = fact(context.store.db, factId);
    const metadata = JSON.parse(stored.metadata_json);
    assert.equal(stored.status, "active");
    assert.equal(stored.epistemic_status, "proposed");
    assert.equal(metadata.graphMaintenance.reason, "all_supporting_evidence_superseded");
    assert.equal(metadata.graphMaintenance.changedAt, "2026-08-11T10:00:00.000Z");
    assert.deepEqual(metadata.graphMaintenance.supersededEvidenceIds, [original.id]);
    assert.equal(result.evidence.fullySupersededFacts, 1);
    assert.equal(result.changes.markedNeedsReview, 1);
    assert.equal(result.transitions[0].factId, factId);
    assert.equal(
      context.store.db.prepare("SELECT COUNT(*) AS count FROM graph_fact_status_history WHERE fact_id=?").get(factId).count,
      1,
    );
    const auditRun = context.store.db.prepare("SELECT * FROM graph_maintenance_runs WHERE id=?").get(result.runId);
    assert.equal(auditRun.status, "completed");
    assert.equal(JSON.parse(auditRun.stats_json).changes.markedNeedsReview, 1);
  } finally {
    context.close();
  }
});

test("legacy unassessed graph_fact_evidence participates in staleness checks", () => {
  const context = fixture();
  try {
    const original = context.addEvidence("legacy-original");
    const replacement = context.addEvidence("legacy-replacement");
    const factId = addObservedFact(context, "legacy-support", original);
    context.store.db.prepare(`
      DELETE FROM graph_evidence_assessments WHERE fact_id=? AND evidence_id=?
    `).run(factId, original.id);
    context.store.linkEvidence(replacement.id, [original.id], "supersedes");

    const result = propagateKnowledgeStaleness(context.store.db, {
      now: "2026-08-11T10:02:00.000Z",
      runId: "test-legacy-evidence-link",
    });

    assert.equal(fact(context.store.db, factId).epistemic_status, "proposed");
    assert.equal(result.evidence.fullySupersededFacts, 1);
  } finally {
    context.close();
  }
});

test("one remaining unsuperseded support keeps a multi-evidence fact current", () => {
  const context = fixture();
  try {
    const oldEvidence = context.addEvidence("old");
    const currentEvidence = context.addEvidence("current");
    const replacement = context.addEvidence("replacement");
    const factId = addObservedFact(
      context,
      "multiple-supports",
      [oldEvidence, currentEvidence],
      ["document_record", "source_inspection"],
    );
    context.store.linkEvidence(replacement.id, [oldEvidence.id], "supersedes");

    const result = propagateKnowledgeStaleness(context.store.db, {
      now: "2026-08-11T10:05:00.000Z",
      runId: "test-one-support-remains",
    });

    assert.equal(fact(context.store.db, factId).epistemic_status, "supported");
    assert.equal(result.evidence.fullySupersededFacts, 0);
    assert.equal(result.evidence.keptFreshByAlternativeEvidence, 1);
    assert.equal(result.changes.total, 0);
    assert.equal(
      context.store.db.prepare("SELECT COUNT(*) AS count FROM graph_fact_status_history WHERE fact_id=?").get(factId).count,
      0,
    );
    assert.equal(result.persisted, false);
    assert.equal(
      context.store.db.prepare("SELECT COUNT(*) AS count FROM graph_maintenance_runs").get().count,
      0,
    );
  } finally {
    context.close();
  }
});

test("invalidity propagates recursively through derived facts", () => {
  const context = fixture();
  try {
    const original = context.addEvidence("root-original");
    const replacement = context.addEvidence("root-replacement");
    const rootFactId = addObservedFact(context, "root", original);
    const firstDerivedId = addDerivedFact(context, "derived-one", [rootFactId]);
    const secondDerivedId = addDerivedFact(context, "derived-two", [firstDerivedId]);
    context.store.linkEvidence(replacement.id, [original.id], "supersedes");

    const result = propagateKnowledgeStaleness(context.store.db, {
      now: "2026-08-11T10:10:00.000Z",
      runId: "test-recursive-derivation",
    });

    assert.equal(fact(context.store.db, rootFactId).epistemic_status, "proposed");
    assert.equal(fact(context.store.db, firstDerivedId).epistemic_status, "proposed");
    assert.equal(fact(context.store.db, secondDerivedId).epistemic_status, "proposed");
    assert.deepEqual(
      JSON.parse(fact(context.store.db, firstDerivedId).metadata_json).graphMaintenance.invalidInputFactIds,
      [rootFactId],
    );
    assert.deepEqual(
      JSON.parse(fact(context.store.db, secondDerivedId).metadata_json).graphMaintenance.invalidInputFactIds,
      [firstDerivedId],
    );
    assert.equal(result.changes.markedNeedsReview, 1);
    assert.equal(result.changes.metadataUpdated, 2);
    assert.equal(result.changes.total, 3);
    assert.equal(result.derivation.invalidConclusions, 2);
    assert.equal(result.derivation.recursivelyInvalidConclusions, 1);
    assert.equal(result.derivation.maximumPropagationDepth, 2);
  } finally {
    context.close();
  }
});

test("fresh support restores the root and its derivation chain by evidence level", () => {
  const context = fixture();
  try {
    const original = context.addEvidence("restore-original");
    const replacement = context.addEvidence("restore-replacement");
    const rootFactId = addObservedFact(context, "restore-root", original);
    const firstDerivedId = addDerivedFact(context, "restore-derived-one", [rootFactId]);
    const secondDerivedId = addDerivedFact(context, "restore-derived-two", [firstDerivedId]);
    context.store.linkEvidence(replacement.id, [original.id], "supersedes");
    propagateKnowledgeStaleness(context.store.db, {
      now: "2026-08-11T10:15:00.000Z",
      runId: "test-before-restore",
    });

    const fresh = context.addEvidence("fresh-build-proof");
    const assessment = assessFactEvidence(context.store.db, {
      factId: rootFactId,
      evidenceId: fresh.id,
      stance: "supports",
      basis: "execution",
      method: "build",
      environment: "local",
      assessedBy: "test:graph-maintenance",
    });
    assert.equal(assessment.level, 3);

    const result = propagateKnowledgeStaleness(context.store.db, {
      now: "2026-08-11T10:20:00.000Z",
      runId: "test-after-restore",
    });

    assert.equal(fact(context.store.db, rootFactId).epistemic_status, "supported");
    assert.equal(fact(context.store.db, firstDerivedId).epistemic_status, "proposed");
    assert.equal(fact(context.store.db, secondDerivedId).epistemic_status, "proposed");
    assert.equal(result.changes.recoveredSupported, 1);
    assert.equal(result.changes.recoveredProposed, 2);
    assert.equal(result.derivation.invalidConclusions, 0);
    const rootMetadata = JSON.parse(fact(context.store.db, rootFactId).metadata_json);
    assert.equal(rootMetadata.graphMaintenance.reason, "fresh_supporting_evidence");
    assert.equal(rootMetadata.graphMaintenance.highestActiveEvidenceLevel, 3);
    assert.equal(rootMetadata.graphMaintenanceHistory.at(-1).state, "needs_review");
  } finally {
    context.close();
  }
});

test("fact trust is centrally recomputed from current assessments", () => {
  const context = fixture();
  try {
    const oldRefuted = context.addEvidence("old-refuted");
    const oldDisputed = context.addEvidence("old-disputed");
    const refutedId = addObservedFact(context, "manual-refuted", oldRefuted);
    const disputedId = addObservedFact(context, "manual-disputed", oldDisputed);
    context.store.db.prepare("UPDATE graph_facts SET epistemic_status='refuted' WHERE id=?").run(refutedId);
    context.store.db.prepare("UPDATE graph_facts SET epistemic_status='disputed' WHERE id=?").run(disputedId);

    for (const [factId, label] of [[refutedId, "new-refuted"], [disputedId, "new-disputed"]]) {
      const fresh = context.addEvidence(label);
      assessFactEvidence(context.store.db, {
        factId,
        evidenceId: fresh.id,
        stance: "supports",
        method: "build",
        environment: "local",
        assessedBy: "test:graph-maintenance",
      });
    }

    const result = propagateKnowledgeStaleness(context.store.db, {
      now: "2026-08-11T10:25:00.000Z",
      runId: "test-protected-manual-statuses",
    });

    assert.equal(fact(context.store.db, refutedId).epistemic_status, "supported");
    assert.equal(fact(context.store.db, disputedId).epistemic_status, "supported");
    assert.equal(result.changes.protectedManualStatuses, 0);
    assert.equal(result.changes.total, 0);
  } finally {
    context.close();
  }
});
