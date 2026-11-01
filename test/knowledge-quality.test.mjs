import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditKnowledgeDatabase,
  auditKnowledgeQuality,
  knowledgeQualityExitCode,
} from "../scripts/audit-knowledge-quality.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function createAuditDatabase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-knowledge-audit-"));
  const databasePath = path.join(root, "audit.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE evidence (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      content TEXT NOT NULL
    );
    CREATE TABLE graph_episode_annotations (
      evidence_id TEXT PRIMARY KEY,
      summary TEXT NOT NULL DEFAULT '',
      keywords_json TEXT NOT NULL DEFAULT '[]',
      retrieval_cues_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      review_status TEXT NOT NULL DEFAULT 'pending',
      review_outcome TEXT,
      content_hash TEXT NOT NULL,
      generated_by TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE graph_enrichment_queue (
      evidence_id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 50,
      queued_at TEXT NOT NULL DEFAULT '2026-08-11T00:00:00.000Z',
      attempts INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      last_error TEXT
    );
    CREATE TABLE graph_facts (
      id TEXT PRIMARY KEY,
      predicate TEXT NOT NULL,
      subject_entity_id TEXT NOT NULL,
      object_entity_id TEXT,
      status TEXT NOT NULL,
      epistemic_status TEXT NOT NULL,
      assertion_mode TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE graph_evidence_assessments (
      fact_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL
    );
    CREATE TABLE graph_derivations (
      conclusion_fact_id TEXT NOT NULL
    );
    CREATE TABLE graph_relation_types (
      predicate TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      origin TEXT NOT NULL,
      forward_impact_weight REAL NOT NULL,
      reverse_impact_weight REAL NOT NULL,
      max_impact_hops INTEGER NOT NULL
    );
  `);
  return {
    database,
    databasePath,
    cleanup() {
      try { database.close(); } catch {}
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function addEvidence(database, id, kind, content) {
  database.prepare("INSERT INTO evidence(id, kind, content) VALUES(?, ?, ?)").run(id, kind, content);
}

function addAnnotation(database, input) {
  database.prepare(`
    INSERT INTO graph_episode_annotations(
      evidence_id, summary, keywords_json, retrieval_cues_json,
      status, review_status, review_outcome, content_hash, generated_by, metadata_json
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.evidenceId,
    input.summary,
    JSON.stringify(input.keywords),
    JSON.stringify(input.retrievalCues),
    input.status,
    input.graphReview?.status ?? "pending",
    input.graphReview?.outcome ?? null,
    input.contentHash,
    input.generatedBy,
    JSON.stringify(input.graphReview === undefined ? {} : { graphReview: input.graphReview }),
  );
}

function addQueue(database, evidenceId, status, contentHash) {
  database.prepare(`
    INSERT INTO graph_enrichment_queue(evidence_id, content_hash, reason, status)
    VALUES(?, ?, 'test', ?)
  `).run(evidenceId, contentHash, status);
}

function addFact(database, id, epistemicStatus, withAssessment = false, withDerivation = false) {
  database.prepare(`
    INSERT INTO graph_facts(
      id, predicate, subject_entity_id, object_entity_id,
      status, epistemic_status, assertion_mode
    ) VALUES(?, 'RELATED_TO', 'subject', 'object', 'active', ?, 'observed')
  `).run(id, epistemicStatus);
  if (withAssessment) {
    database.prepare(`
      INSERT INTO graph_evidence_assessments(fact_id, evidence_id) VALUES(?, 'e-ready')
    `).run(id);
  }
  if (withDerivation) {
    database.prepare("INSERT INTO graph_derivations(conclusion_fact_id) VALUES(?)").run(id);
  }
}

test("audits migration state, retrieval cards, provenance, and learned relation weights", () => {
  const fixture = createAuditDatabase();
  try {
    const { database } = fixture;
    const contents = {
      "e-ready": "ready source",
      "e-pending": "changed pending source",
      "e-leased": "leased source",
      "e-failed": "failed source",
    };
    for (const [id, content] of Object.entries(contents)) {
      addEvidence(database, id, id === "e-ready" ? "manual_knowledge" : "codex_thread_digest", content);
    }

    addEvidence(database, "e-cold", "codex_thread_digest", "retrievable cold inventory");
    addAnnotation(database, {
      evidenceId: "e-cold",
      summary: "Cold history remains retrievable without active model work.",
      keywords: ["cold", "history", "retrieval"],
      retrievalCues: ["Which history is cold?", "Can cold history be retrieved?"],
      status: "pending",
      contentHash: hash("retrievable cold inventory"),
      generatedBy: "deterministic-backfill",
    });
    addQueue(database, "e-cold", "cold", hash("retrievable cold inventory"));

    addAnnotation(database, {
      evidenceId: "e-ready",
      summary: "A complete retrieval card.",
      keywords: ["one", "two", "three"],
      retrievalCues: ["question one", "question two"],
      status: "ready",
      contentHash: hash(contents["e-ready"]),
      generatedBy: "codex",
    });
    addQueue(database, "e-ready", "completed", hash(contents["e-ready"]));

    addEvidence(database, "e-review-pending", "manual_knowledge", "pending graph review");
    addAnnotation(database, {
      evidenceId: "e-review-pending",
      summary: "Card ready but graph review is pending.",
      keywords: ["graph", "review", "pending"],
      retrievalCues: ["Which review is pending?", "Why is graph review pending?"],
      status: "ready",
      contentHash: hash("pending graph review"),
      generatedBy: "codex",
      graphReview: { status: "pending" },
    });
    addQueue(database, "e-review-pending", "pending", hash("pending graph review"));

    addEvidence(database, "e-review-needed", "manual_knowledge", "review follow-up");
    addAnnotation(database, {
      evidenceId: "e-review-needed",
      summary: "Card requires a separate graph follow-up.",
      keywords: ["graph", "review", "followup"],
      retrievalCues: ["Which review needs follow-up?", "What remains unresolved?"],
      status: "ready",
      contentHash: hash("review follow-up"),
      generatedBy: "codex",
      graphReview: { status: "needs_input" },
    });
    addQueue(database, "e-review-needed", "review_needed", hash("review follow-up"));

    addAnnotation(database, {
      evidenceId: "e-pending",
      summary: "",
      keywords: ["one", "two"],
      retrievalCues: ["only one"],
      status: "pending",
      contentHash: hash("stale source"),
      generatedBy: "deterministic-backfill",
    });
    addQueue(database, "e-pending", "pending", hash("stale source"));

    for (const [id, status] of [["e-leased", "leased"], ["e-failed", "failed"]]) {
      addAnnotation(database, {
        evidenceId: id,
        summary: `${status} but structurally complete`,
        keywords: ["one", "two", "three"],
        retrievalCues: ["question one", "question two"],
        status: "pending",
        contentHash: hash(contents[id]),
        generatedBy: "codex",
      });
      addQueue(database, id, status, hash(contents[id]));
    }

    addAnnotation(database, {
      evidenceId: "e-orphan",
      summary: "Orphan annotation",
      keywords: ["one", "two", "three"],
      retrievalCues: ["question one", "question two"],
      status: "pending",
      contentHash: hash("orphan"),
      generatedBy: "legacy-import",
    });

    addFact(database, "f-supported", "supported", true, false);
    addFact(database, "f-proposed", "proposed", false, true);
    addFact(database, "f-disputed", "disputed", false, false);
    addFact(database, "f-refuted", "refuted", true, false);

    database.exec(`
      INSERT INTO graph_relation_types VALUES
        ('LEARNED_NEUTRAL', 'neutral learned relation', 'learned', 0, 0, 0),
        ('LEARNED_BAD', 'unsafe learned relation', 'learned', 0.5, 0, 2),
        ('CORE_BAD', 'invalid core weight', 'core', 1.2, 0, 0);
    `);

    const report = auditKnowledgeQuality(database, { generatedAt: "2026-08-11T00:00:00.000Z" });
    assert.deepEqual(report.migrationStatus, {
      ready: 3,
      pending: 2,
      leased: 1,
      cold: 1,
      completed: 1,
      failed: 1,
      reviewNeeded: 1,
    });
    assert.equal(report.contentHashes.total, 2);
    assert.equal(report.contentHashes.affectedEvidence, 1);
    assert.equal(report.retrievalCards.affectedCards, 1);
    assert.deepEqual(report.retrievalCards.counts, {
      missingSummary: 1,
      fewerThanThreeKeywords: 1,
      fewerThanTwoRetrievalCues: 1,
      invalidKeywordsJson: 0,
      invalidRetrievalCuesJson: 0,
    });
    assert.equal(report.orphans.annotations.count, 1);
    assert.deepEqual(report.graphReview.statusDistribution, {
      completed: 0,
      needs_input: 1,
      pending: 2,
      missing: 0,
      other: {},
    });
    assert.deepEqual(report.graphReview.outcomeDistribution, {
      facts_recorded: 0,
      no_durable_facts: 0,
      none: 3,
      other: {},
    });
    assert.equal(report.graphReview.missingOrPending.count, 2);
    assert.equal(report.graphReview.reviewNeeded.count, 1);
    assert.ok(!report.lifecycle.items.some((item) => item.evidenceId === "e-review-pending"));
    assert.equal(report.strict.violations.readyCardsWithMissingOrPendingGraphReview, 2);
    assert.equal(report.strict.violations.graphReviewNeeded, 1);
    assert.equal(report.queueGovernance.coldInventory.count, 1);
    assert.ok(report.strict.uniqueAffectedObjects < report.strict.violationCount);
    assert.equal(report.activeFacts.withoutEvidenceAssessmentOrDerivation.count, 1);
    assert.deepEqual(report.activeFacts.epistemicStatusCounts, {
      proposed: 1,
      supported: 1,
      disputed: 1,
      refuted: 1,
      other: {},
    });
    assert.equal(report.relations.learned.count, 2);
    assert.deepEqual(
      report.relations.propagationWeightAnomalies.items.map((item) => item.predicate),
      ["CORE_BAD", "LEARNED_BAD"],
    );
    assert.ok(report.annotationsByEvidenceKindAndGeneratedBy.some((row) =>
      row.evidenceKind === "manual_knowledge" && row.generatedBy === "codex" && row.ready === 3));
    assert.equal(report.strict.passed, false);
    assert.ok(report.strict.violationCount > 0);
  } finally {
    fixture.cleanup();
  }
});

test("clean temporary database passes reusable path audit and strict exit policy", () => {
  const fixture = createAuditDatabase();
  try {
    const { database, databasePath } = fixture;
    const content = "verified knowledge";
    addEvidence(database, "e-ready", "manual_knowledge", content);
    addAnnotation(database, {
      evidenceId: "e-ready",
      summary: "Verified complete knowledge card.",
      keywords: ["verified", "complete", "knowledge"],
      retrievalCues: ["What was verified?", "Which knowledge is complete?"],
      status: "ready",
      contentHash: hash(content),
      generatedBy: "codex",
      graphReview: { status: "completed", outcome: "facts_recorded", factIds: ["f-supported"] },
    });
    addQueue(database, "e-ready", "completed", hash(content));
    addFact(database, "f-supported", "supported", true, false);
    database.exec(`
      INSERT INTO graph_relation_types VALUES
        ('LEARNED_NEUTRAL', 'neutral learned relation', 'learned', 0, 0, 0);
    `);
    database.close();

    const exportedReport = auditKnowledgeDatabase(databasePath, {
      generatedAt: "2026-08-11T00:00:00.000Z",
    });
    assert.equal(exportedReport.strict.passed, true);
    assert.equal(exportedReport.strict.violationCount, 0);
    assert.equal(exportedReport.strict.uniqueAffectedObjects, 0);

    assert.equal(knowledgeQualityExitCode(exportedReport, { strict: true }), 0);
    assert.equal(exportedReport.databasePath, path.resolve(databasePath));
  } finally {
    fixture.cleanup();
  }
});

test("strict exit policy returns code 2 when migration quality gate fails", () => {
  const fixture = createAuditDatabase();
  try {
    const { database, databasePath } = fixture;
    const content = "pending knowledge";
    addEvidence(database, "e-pending", "codex_thread_digest", content);
    addAnnotation(database, {
      evidenceId: "e-pending",
      summary: "",
      keywords: [],
      retrievalCues: [],
      status: "pending",
      contentHash: hash(content),
      generatedBy: "deterministic-backfill",
    });
    addQueue(database, "e-pending", "pending", hash(content));
    database.close();

    const report = auditKnowledgeDatabase(databasePath);
    assert.equal(knowledgeQualityExitCode(report, { strict: true }), 2);
    assert.equal(report.strict.passed, false);
    assert.equal(report.strict.violations.incompleteEnrichment, 1);
    assert.equal(report.strict.violations.incompleteRetrievalCards, 1);
  } finally {
    fixture.cleanup();
  }
});
