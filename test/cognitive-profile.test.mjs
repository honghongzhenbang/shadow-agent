import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importCognitiveProfile, validateCognitiveProfile } from "../src/cognitive-profile.mjs";
import { openDatabase } from "../src/db.mjs";

function removeDatabase(databasePath) {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${databasePath}${suffix}`, { force: true });
}

const profile = {
  version: 1,
  title: "测试认知路由",
  entities: [
    { canonicalKey: "topic:test", type: "KnowledgeTopic", name: "测试主题" },
    { canonicalKey: "code:test", type: "CodeLocation", name: "测试源码", metadata: { path: "D:/test/src" } },
  ],
  relations: [
    { subject: "topic:test", predicate: "IMPLEMENTED_IN", object: "code:test", confidence: 0.9 },
  ],
};

test("structured cognitive profile is idempotent and evidence-backed", () => {
  const databasePath = path.join(os.tmpdir(), `shadow-profile-${process.pid}-${Date.now()}.sqlite`);
  const store = openDatabase(databasePath);
  try {
    const first = importCognitiveProfile(store, profile, { sourceLocator: "test://profile" });
    const second = importCognitiveProfile(store, profile, { sourceLocator: "test://profile" });
    assert.equal(first.entities, 2);
    assert.equal(first.relations, 1);
    assert.equal(second.evidenceInserted, false);
    assert.match(first.profileScope, /^cognitive-profile:[0-9a-f]{24}$/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM graph_entities WHERE canonical_key IN ('topic:test','code:test')").get().count, 2);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM graph_facts WHERE predicate='IMPLEMENTED_IN'").get().count, 1);
    assert.equal(store.db.prepare("SELECT scope_key FROM graph_facts WHERE predicate='IMPLEMENTED_IN'").get().scope_key, first.profileScope);
    assert.equal(store.db.prepare("SELECT MAX(level) AS level FROM graph_evidence_assessments").get().level, 2);
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

test("cognitive profile updates retire removed routes without touching other support", () => {
  const databasePath = path.join(os.tmpdir(), `shadow-profile-update-${process.pid}-${Date.now()}.sqlite`);
  const store = openDatabase(databasePath);
  try {
    const first = importCognitiveProfile(store, profile, { sourceLocator: "test://profile-update", occurredAt: "2024-01-01T00:00:00Z" });
    const oldFact = store.db.prepare("SELECT id FROM graph_facts WHERE predicate='IMPLEMENTED_IN'").get().id;
    const changed = {
      ...profile,
      entities: [profile.entities[0]],
      relations: [],
    };
    const second = importCognitiveProfile(store, changed, { sourceLocator: "test://profile-update", occurredAt: "2025-01-01T00:00:00Z" });
    assert.equal(first.relations, 1);
    assert.equal(second.relations, 0);
    assert.equal(second.supersededRelations, 1);
    assert.equal(second.inactivatedEntities, 1);
    assert.equal(store.db.prepare("SELECT status FROM graph_facts WHERE predicate='IMPLEMENTED_IN'").get().status, "superseded");
    assert.equal(store.db.prepare("SELECT status FROM graph_entities WHERE canonical_key='code:test'").get().status, "inactive");
    assert.ok(store.db.prepare("SELECT valid_until FROM graph_evidence_assessments").get().valid_until);

    const restored = importCognitiveProfile(store, profile, { sourceLocator: "test://profile-update", occurredAt: "2026-01-01T00:00:00Z" });
    assert.equal(restored.supersededRelations, 0);
    assert.equal(store.db.prepare("SELECT status FROM graph_facts WHERE id=?").get(oldFact).status, "superseded");
    const current = store.db.prepare("SELECT id FROM graph_facts WHERE predicate='IMPLEMENTED_IN' AND status='active'").all();
    assert.equal(current.length, 1);
    assert.notEqual(current[0].id, oldFact);
    importCognitiveProfile(store, profile, { sourceLocator: "test://profile-update", occurredAt: "2026-02-01T00:00:00Z" });
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM graph_facts WHERE predicate='IMPLEMENTED_IN'").get().n, 2);
    assert.equal(store.db.prepare("SELECT epistemic_status FROM graph_facts WHERE id=?").get(current[0].id).epistemic_status, "supported");
    assert.equal(store.db.prepare("SELECT status FROM graph_entities WHERE canonical_key='code:test'").get().status, "active");
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

test("cognitive profile rejects secret-bearing fields", () => {
  assert.throws(() => validateCognitiveProfile({
    ...profile,
    entities: [{ ...profile.entities[0], metadata: { accessToken: "do-not-store" } }],
  }), /Secret-bearing field/);
});

test("shipped example profile cannot become authoritative personal knowledge unchanged", () => {
  const example = JSON.parse(fs.readFileSync("config/cognitive-profile.example.json", "utf8"));
  assert.throws(() => validateCognitiveProfile(example), /Example profile is not user knowledge/);
  const customized = { ...profile, exampleOnly: false };
  assert.doesNotThrow(() => validateCognitiveProfile(customized));
});
