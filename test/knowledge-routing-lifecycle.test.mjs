import assert from "node:assert/strict";
import test from "node:test";

import { openV4TestDatabase as openDatabase } from "../openclaw/shadow-work/src/test-fixture.mjs";
import { assessFactEvidence, assertGraphFact, upsertGraphEntity } from "../src/graph-model.mjs";
import { captureKnowledge, completeKnowledgeAnnotation } from "../openclaw/shadow-work/src/epistemic.js";
import { resolveCognitiveRoute } from "../openclaw/shadow-work/src/routing.js";

function capture(store, name = "routing-lifecycle") {
  return captureKnowledge(store.db, {
    sourceType: "note", title: name, content: `${name} source record`, summary: `${name} summary`,
    keywords: [name, "source", "review"], retrievalCues: [`find ${name}`, `${name} source`],
    generatedBy: "routing-test",
  });
}

function complete(store, evidenceId, status, outcome = null, factIds = []) {
  return completeKnowledgeAnnotation(store.db, {
    evidenceId, title: "routing-lifecycle", summary: "routing-lifecycle summary",
    keywords: ["routing-lifecycle", "source", "review"],
    retrievalCues: ["find routing-lifecycle", "routing-lifecycle source"],
    graphReview: { status, outcome, factIds, rationale: "isolated review evidence" },
  });
}

test("knowledge routes survive canonical review completion and needs_input without metadata fallback", () => {
  const store = openDatabase(":memory:");
  try {
    const { evidenceId } = capture(store);
    const route = () => resolveCognitiveRoute(store.db, { query: "routing-lifecycle" });
    assert.equal(route().reviewPending[0].evidenceId, evidenceId);
    complete(store, evidenceId, "needs_input");
    assert.equal(route().reviewPending[0].reviewStatus, "needs_input");
    complete(store, evidenceId, "completed", "no_durable_facts");
    // Canonical columns, not the redundant metadata mirror, are authoritative.
    store.db.prepare("UPDATE graph_episode_annotations SET metadata_json='{}' WHERE evidence_id=?").run(evidenceId);
    const result = route();
    assert.equal(result.reviewPending.length, 0);
    assert.equal(result.verifiedFacts.length, 0);
    assert.equal(result.retrievalRoutes[0].evidence.id, evidenceId);
    assert.equal(result.retrievalRoutes[0].reviewStatus, "completed");
    assert.equal(result.retrievalRoutes[0].reviewOutcome, "no_durable_facts");
    store.db.prepare("UPDATE graph_episode_annotations SET status='superseded' WHERE evidence_id=?").run(evidenceId);
    assert.equal(route().retrievalRoutes.length, 0);
  } finally { store.close(); }
});

test("completed review is not fact trust, and supported facts retain their reviewed source", () => {
  const store = openDatabase(":memory:");
  try {
    const { evidenceId } = capture(store);
    const topic = upsertGraphEntity(store.db, { canonicalKey: "topic:routing-lifecycle", type: "KnowledgeTopic", name: "routing-lifecycle" });
    const fact = assertGraphFact(store.db, { subject: topic.id, predicate: "HAS_VALUE", objectValue: "result" });
    assessFactEvidence(store.db, {
      factId: fact.id, evidenceId, stance: "supports", basis: "user_statement", directness: "direct",
      method: "document_record", environment: "local", outcome: "observed", confidence: 0.95,
    });
    complete(store, evidenceId, "completed", "facts_recorded", [fact.id]);
    const route = () => resolveCognitiveRoute(store.db, { query: "routing-lifecycle" });
    assert.ok(route().verifiedFacts.some((item) => item.id === fact.id));
    const contradiction = capture(store, "routing-contradiction");
    for (const trust of ["proposed", "disputed", "refuted"]) {
      assessFactEvidence(store.db, {
        factId: fact.id, evidenceId, stance: "supports", basis: "user_statement", directness: "direct",
        method: "document_record", environment: "local", outcome: "observed", confidence: 0.95,
        validUntil: trust === "disputed" ? null : "2000-01-01T00:00:00.000Z",
      });
      if (trust !== "proposed") assessFactEvidence(store.db, {
        factId: fact.id, evidenceId: contradiction.evidenceId, stance: "contradicts",
        method: "document_record", environment: "local", outcome: "contradicted", confidence: 0.95,
      });
      assert.equal(store.db.prepare("SELECT epistemic_status FROM graph_facts WHERE id=?").get(fact.id).epistemic_status, trust);
      const result = route();
      assert.equal(result.verifiedFacts.length, 0);
      assert.ok(result.retrievalRoutes.some((item) => item.evidence?.id === evidenceId));
      if (trust === "proposed") assert.ok(result.reviewPending.some((item) => item.id === fact.id));
      if (trust === "disputed") assert.ok(result.conflicts.some((item) => item.id === fact.id));
    }
  } finally { store.close(); }
});

test("bounded knowledge routing reports discarded results instead of implying complete recall", () => {
  const store = openDatabase(":memory:");
  try {
    for (let i = 0; i < 8; i++) {
      captureKnowledge(store.db, {
        sourceType: "note", title: `routing-volume ${i}`, content: `source-${i}`,
        summary: `routing-volume ${"detail ".repeat(300)}`,
        keywords: ["routing-volume", "source", "review"], retrievalCues: ["find routing-volume", "routing-volume source"],
      });
    }
    const result = resolveCognitiveRoute(store.db, { query: "routing-volume", maxBytes: 4096 });
    assert.equal(result.truncated, true);
    assert.ok(result.omittedByByteBudget.reviewPending > 0);
    assert.equal(result.retrievalScope, "bounded_candidates_not_exhaustive");
    assert.equal(result.bytes, Buffer.byteLength(JSON.stringify(result), "utf8"));
    assert.ok(result.bytes <= 4096);
  } finally { store.close(); }
});
