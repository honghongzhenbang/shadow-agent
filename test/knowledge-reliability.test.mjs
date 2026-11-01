import assert from "node:assert/strict";
import test from "node:test";
import { openV4TestDatabase } from "../openclaw/shadow-work/src/test-fixture.mjs";
import { captureKnowledge, proposeKnowledge, completeKnowledgeAnnotation } from "../openclaw/shadow-work/src/epistemic.js";
import { applyKnowledgeBundle, currentFactTrust, recomputeFactTrust, registerRelationType,
  enqueueKnowledgeBackfill, restoreAssessedProfileReview } from "../src/graph-model.mjs";
import { importCognitiveProfile } from "../src/cognitive-profile.mjs";
import { deriveFactTrust } from "../src/knowledge-policy.mjs";

const profile = { method: "document_record", directness: "direct", basis: "artifact", environment: "local" };
const entities = [{ canonicalKey: "topic:test", type: "KnowledgeTopic", name: "Reliability fixture" }];
function note(db, content) {
  return captureKnowledge(db, { sourceType: "note", title: "Reliability fixture", content,
    summary: content, keywords: ["fixture", "knowledge", "revision"], retrievalCues: ["fixture revision", "fixture knowledge"] }).evidenceId;
}
function propose(db, value, extras = {}, evidenceId = note(db, `Source for ${value} ${JSON.stringify(extras)}`)) {
  const result = proposeKnowledge(db, { createdBy: "test", entities,
    facts: [{ subjectCanonicalKey: "topic:test", predicate: "HAS_VALUE", objectValue: value,
      sourceEvidenceIds: [evidenceId], evidenceProfile: profile, ...extras }] });
  return { ...result.facts[0], evidenceId };
}
function complete(db, fact) {
  return completeKnowledgeAnnotation(db, { evidenceId: fact.evidenceId, summary: "Reviewed fixture",
    graphReview: { status: "completed", outcome: "facts_recorded", factIds: [fact.id], rationale: "Fixture revision checked" } });
}
function fixture(run) {
  const store = openV4TestDatabase(":memory:");
  try { return run(store.db, store); } finally { store.close(); }
}

test("K4 repeated manual intake preserves the entire semantic review and revised fact history", () => fixture((db) => {
  const first = propose(db, "A");
  complete(db, first);
  const correction = propose(db, "B", { supersedesFactId: first.id, supersessionReason: "New source corrects value" });
  complete(db, correction);
  const tables = ["graph_episode_annotations", "graph_facts", "graph_fact_evidence", "graph_evidence_assessments", "context_changes", "graph_enrichment_queue"];
  const snapshot = () => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const before = snapshot();
  for (const evidence of db.prepare("SELECT * FROM evidence ORDER BY rowid").all()) {
    assert.equal(note(db, evidence.content), evidence.id);
  }
  assert.deepEqual(snapshot(), before, "Source retry cannot erase curator summary, review identity/version or provenance");
  assert.equal(db.prepare("SELECT status FROM graph_facts WHERE id=?").get(first.id).status, "superseded");
  const distinct = note(db, "Actual new source material");
  assert.equal(db.prepare("SELECT review_status FROM graph_episode_annotations WHERE evidence_id=?").get(distinct).review_status, "pending");
}));

test("K4 source retry preserves needs-input and no-durable review outcomes", () => fixture((db) => {
  for (const status of ["needs_input", "completed"]) {
    const content = `Source ${status}`;
    const evidenceId = note(db, content);
    completeKnowledgeAnnotation(db, { evidenceId, summary: "Curator-only summary", keywords: ["curated", "source", "context"],
      retrievalCues: ["curated lookup", "source review"],
      graphReview: { status, ...(status === "completed" ? { outcome: "no_durable_facts" } : {}), rationale: "No supported durable claim" } });
    const read = () => db.prepare("SELECT * FROM graph_episode_annotations WHERE evidence_id=?").get(evidenceId);
    const before = read();
    assert.equal(note(db, content), evidenceId);
    assert.deepEqual(read(), before);
  }
}));

test("K4 source title and project corrections keep discovery aligned without resetting semantic review", () => fixture((db) => {
  for (const reviewed of [false, true]) {
    const input = { sourceType: "note", title: "Old source title", content: `Header fixture ${reviewed}`,
      summary: "Source summary", keywords: ["source", "header", "fixture"], retrievalCues: ["header source", "fixture note"],
      projectKey: "project:old" };
    const first = captureKnowledge(db, input);
    if (reviewed) completeKnowledgeAnnotation(db, { evidenceId: first.evidenceId, title: "Curated title",
      summary: "Curated summary", scope: { projectKey: "project:old", topic: "preserve" },
      graphReview: { status: "completed", outcome: "no_durable_facts", rationale: "Checked once" } });
    const read = () => db.prepare("SELECT * FROM graph_episode_annotations WHERE evidence_id=?").get(first.evidenceId);
    const before = read();
    captureKnowledge(db, input);
    assert.deepEqual(read(), before, "Unchanged source header cannot overwrite a curated title");
    const result = captureKnowledge(db, { ...input, title: "Corrected source title", projectKey: "project:new" });
    assert.equal(result.evidenceId, first.evidenceId);
    const after = read(), evidence = db.prepare("SELECT * FROM evidence WHERE id=?").get(first.evidenceId);
    assert.equal(after.title, evidence.title);
    assert.equal(JSON.parse(after.scope_json).projectKey, evidence.project_key);
    assert.deepEqual(JSON.parse(after.scope_json), { ...JSON.parse(before.scope_json), projectKey: "project:new" });
    for (const key of ["summary", "keywords_json", "retrieval_cues_json", "metadata_json", "review_status", "review_outcome"])
      assert.equal(after[key], before[key], key);
  }
}));

test("K1 plugin and core use the same provenance, conflict and expiry rules", () => {
  const outcomes = ["plugin", "core"].map((entry) => fixture((db) => {
    registerRelationType(db, { predicate: "HAS_VALUE", functional: true, description: "Single fixture value" });
    for (const value of ["A", "B"]) {
      const evidenceId = note(db, `Fixture value ${value}`);
      if (entry === "plugin") propose(db, value, {}, evidenceId);
      else applyKnowledgeBundle(db, { createdBy: "test", entities, facts: [{ subject: "topic:test",
        predicate: "HAS_VALUE", objectValue: value, sourceEvidenceIds: [evidenceId],
        evidenceAssessments: [{ evidenceId, ...profile }] }] });
    }
    return { conflicts: db.prepare("SELECT count(*) n FROM graph_fact_conflicts WHERE status='open'").get().n,
      facts: db.prepare("SELECT id, object_value, epistemic_status FROM graph_facts ORDER BY id").all().map((row) => ({ ...row })) };
  }));
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.equal(outcomes[0].conflicts, 1);
  assert.ok(outcomes[0].facts.every((row) => row.epistemic_status === "disputed"));
});

test("K1 invalid provenance rolls back entities, facts and earlier bundle rows", () => fixture((db) => {
  const evidenceId = note(db, "Valid first source");
  assert.throws(() => proposeKnowledge(db, { entities, facts: [
    { subjectCanonicalKey: "topic:test", predicate: "HAS_VALUE", objectValue: "A", sourceEvidenceIds: [evidenceId] },
    { subjectCanonicalKey: "topic:test", predicate: "HAS_VALUE", objectValue: "B", sourceEvidenceIds: ["missing"] },
  ] }), /Unknown evidence/);
  assert.equal(db.prepare("SELECT count(*) n FROM graph_facts").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM graph_entities WHERE canonical_key='topic:test'").get().n, 0);
}));

test("K1 effective evidence is evaluated at query time and invalid dates cannot support trust", () => fixture((db) => {
  const fact = propose(db, "A");
  db.prepare("UPDATE graph_evidence_assessments SET valid_until=? WHERE fact_id=?").run("2026-01-02T00:00:00Z", fact.id);
  assert.equal(currentFactTrust(db, fact.id, { asOf: "2026-01-01T00:00:00Z" }), "supported");
  assert.equal(recomputeFactTrust(db, fact.id, { asOf: "2026-01-02T00:00:00Z" }), "proposed");
  assert.equal(deriveFactTrust([{ stance: "supports", level: 5, valid_until: "invalid" }]), "proposed");
  assert.throws(() => currentFactTrust(db, fact.id, { asOf: "invalid" }), /Invalid/);
}));

test("K1 multi-valued and nonoverlapping single-valued relationships are not conflicts", () => fixture((db) => {
  propose(db, "A"); propose(db, "B");
  assert.equal(db.prepare("SELECT count(*) n FROM graph_fact_conflicts").get().n, 0);
  registerRelationType(db, { predicate: "HAS_VALUE", functional: true, description: "Single dated value" });
  propose(db, "C", { scopeKey: "time-test", validFrom: "2024-01-01T00:00:00Z", validTo: "2025-01-01T00:00:00Z" });
  propose(db, "D", { scopeKey: "time-test", validFrom: "2025-01-01T00:00:00Z" });
  assert.equal(db.prepare("SELECT count(*) n FROM graph_fact_conflicts").get().n, 0);
}));

test("K3 returning to an old value creates an explicit occurrence while source retries stay idempotent", () => fixture((db) => {
  const a = propose(db, "A", { validFrom: "2024-01-01T00:00:00Z" });
  const b = propose(db, "B", { validFrom: "2025-01-01T00:00:00Z", supersedesFactId: a.id, supersessionReason: "First handover" });
  const options = { validFrom: "2026-01-01T00:00:00Z", supersedesFactId: b.id, supersessionReason: "Return to previous operator" };
  const a2 = propose(db, "A", options);
  const replay = propose(db, "A", options, a2.evidenceId);
  assert.notEqual(a2.id, a.id);
  assert.equal(replay.id, a2.id);
  assert.equal(replay.supersession.allowed, true);
  assert.equal(replay.supersession.alreadyApplied, true);
  const rows = db.prepare("SELECT id,status,valid_from,valid_to,supersedes_fact_id FROM graph_facts ORDER BY valid_from").all();
  assert.equal(rows.length, 3);
  assert.equal(rows[0].status, "superseded");
  assert.equal(rows[1].supersedes_fact_id, a.id);
  assert.equal(rows[2].supersedes_fact_id, b.id);
  assert.equal(rows[2].status, "active");
  propose(db, "A", {}, a.evidenceId);
  assert.equal(db.prepare("SELECT status FROM graph_facts WHERE id=?").get(a.id).status, "superseded");
  assert.equal(db.prepare("SELECT count(*) n FROM graph_fact_evidence WHERE fact_id=? AND evidence_id=?").get(a2.id, a.evidenceId).n, 0);
}));

test("K4 rejected revisions cannot be marked completed and corrected retry closes the same review", () => fixture((db) => {
  const a = propose(db, "A"); complete(db, a);
  const b = propose(db, "B", { supersedesFactId: a.id, relationToExisting: "conflicts", supersessionReason: "Responsibility handover" });
  assert.equal(b.supersession.allowed, false);
  const firstReview = complete(db, b);
  assert.equal(firstReview.queueStatus, "review_needed");
  assert.equal(firstReview.graphReviewStatus, "needs_input");
  assert.deepEqual(firstReview.unresolvedRevisions[0].problems, ["not_same_claim"]);
  const fixed = propose(db, "B", { supersedesFactId: a.id, relationToExisting: "same_claim", supersessionReason: "Responsibility handover" }, b.evidenceId);
  assert.equal(fixed.id, b.id);
  assert.equal(fixed.supersession.allowed, true);
  assert.equal(complete(db, fixed).queueStatus, "completed");
  assert.equal(db.prepare("SELECT status FROM graph_facts WHERE id=?").get(a.id).status, "superseded");
  assert.equal(JSON.parse(db.prepare("SELECT metadata_json FROM graph_facts WHERE id=?").get(b.id).metadata_json).supersessionReview, undefined);
}));

test("K2 backfill repair is scoped to unchanged assessed profiles, not ordinary or disputed sources", () => fixture((db, store) => {
  const imported = importCognitiveProfile(store, { version: 1, title: "Profile fixture", entities,
    relations: [{ subject: "topic:test", predicate: "HAS_VALUE", objectValue: "A" }] }, { sourceLocator: "test://profile" });
  enqueueKnowledgeBackfill(db);
  assert.equal(db.prepare("SELECT review_status FROM graph_episode_annotations WHERE evidence_id=?").get(imported.evidenceId).review_status, "completed");
  const manual = propose(db, "B");
  assert.equal(restoreAssessedProfileReview(db, manual.evidenceId).eligible, false);
  assert.equal(db.prepare("SELECT review_status FROM graph_episode_annotations WHERE evidence_id=?").get(manual.evidenceId).review_status, "pending");
  db.prepare("UPDATE graph_episode_annotations SET review_status='needs_input' WHERE evidence_id=?").run(imported.evidenceId);
  assert.equal(restoreAssessedProfileReview(db, imported.evidenceId).eligible, false);
}));
