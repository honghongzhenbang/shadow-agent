import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db.mjs";
import { materializeContextGraph, refreshKnowledgeEntries } from "../src/context-graph.mjs";
import { upsertGraphEntity } from "../src/graph-model.mjs";
import { buildDigests } from "../src/digests.mjs";
import { DOCUMENT_CATALOG_LEAVES_SQL } from "../src/knowledge-entries.mjs";

const config = { contextGraph: { maxEvidencePerCycle: 2000 }, collection: {
  maxEvidenceChars: 5000, digestThreadQuietSeconds: 0, projectDigestDocumentLimit: 100,
  projectDigestExcerptChars: 200, digestTargetsPerCollection: 30,
} };
const options = { refreshStructural: true, runMaintenance: false, emitChanges: false };
function fixture(database = ":memory:") {
  const store = openDatabase(database);
  const source = store.upsertSource({ sourceKey: "entry:test", kind: "project_root", uri: "X:/entry" });
  store.upsertProject({ projectKey: "entry", name: "Entry", rootPath: "X:/entry" });
  let seq = 0;
  const add = (kind, content, metadata = {}, extras = {}) => store.addEvidence({
    sourceId: source.id, projectKey: "entry", kind, title: `Entry ${++seq}`, content,
    sourceLocator: `test://entry/${seq}`, fingerprint: `entry-${seq}`,
    occurredAt: "2026-01-01T00:00:00.000Z", metadata, ...extras,
  });
  const sync = () => materializeContextGraph(store, config, options);
  const entity = key => store.db.prepare("SELECT * FROM graph_entities WHERE canonical_key=?").get(key);
  const matches = term => store.db.prepare("SELECT entity_id FROM graph_entity_fts WHERE graph_entity_fts MATCH ?").all(term).map(r => r.entity_id);
  return { store, add, sync, entity, matches, source };
}

test("repository history and checkout survive either arrival order, late snapshots and curated edits", () => {
  for (const reverse of [false, true]) {
    const f = fixture();
    try {
      f.sync();
      const arrivals = [
        () => f.add("git_history_digest", "calibrationexport historical change", { repoPath: "X:/entry", digestHash: "v1", chunkIndex: 0 }),
        () => f.add("git_repository_snapshot", "checkout-main", { repoPath: "X:/entry" }),
      ];
      if (reverse) arrivals.reverse();
      for (const arrive of arrivals) { arrive(); f.sync(); }
      const key = "repository:x:/entry";
      assert.match(f.entity(key).summary, /calibrationexport/);
      assert.match(f.entity(key).summary, /checkout-main/);
      f.add("git_repository_snapshot", "obsolete-checkout", { repoPath: "X:/entry" }, { occurredAt: "2025-01-01T00:00:00.000Z" });
      f.sync();
      assert.doesNotMatch(f.entity(key).summary, /obsolete-checkout/);
      upsertGraphEntity(f.store.db, { canonicalKey: key, type: "Repository", name: "Business profile", summary: "Human maintained introduction" });
      assert.ok(f.matches("calibrationexport").includes(f.entity(key).id));
      f.add("git_repository_snapshot", "checkout-next", { repoPath: "X:/entry" }, { occurredAt: "2027-01-01T00:00:00.000Z" });
      f.sync();
      assert.equal(f.entity(key).summary, "Human maintained introduction");
      assert.match(JSON.parse(f.entity(key).metadata_json).knowledgeEntry.searchText, /checkout-next/);
      assert.ok(f.matches("calibrationexport").includes(f.entity(key).id));
    } finally { f.store.close(); }
  }
});

test("documents have separate routes, current-version chunks and exact source links", () => {
  const f = fixture();
  try {
    f.sync();
    const old = f.add("project_document", "oldword", { fullPath: "X:/entry/a/design.md", contentHash: "old", chunkIndex: 0 });
    const first = f.add("project_document", "hydraulicroute", { fullPath: "X:/entry/a/design.md", contentHash: "new", chunkIndex: 0 }, { occurredAt: "2026-02-01T00:00:00.000Z" });
    const second = f.add("project_document", "opticalroute", { fullPath: "X:/entry/a/design.md", contentHash: "new", chunkIndex: 1 }, { occurredAt: "2026-02-01T00:00:00.000Z" });
    const thermal = f.add("project_document", "thermalroute", { fullPath: "X:/entry/b/design.md", contentHash: "other", chunkIndex: 0 });
    const otherSource = f.store.upsertSource({ sourceKey: "another-host", kind: "project_root", uri: "other-host://entry" });
    const foreign = f.add("project_document", "foreignroute", { fullPath: "X:/entry/a/design.md", contentHash: "new", chunkIndex: 0 }, { sourceId: otherSource.id });
    const d1 = f.add("project_document_digest", "directory part one", { digestHash: "d1", chunkIndex: 0 });
    const d2 = f.add("project_document_digest", "directory part two", { digestHash: "d1", chunkIndex: 1 });
    f.store.linkEvidence(d1.id, [first.id, second.id], "summarizes");
    f.store.linkEvidence(d2.id, [thermal.id, foreign.id], "summarizes");
    const queryPlan = f.store.db.prepare(`EXPLAIN QUERY PLAN ${DOCUMENT_CATALOG_LEAVES_SQL}`).all(d1.id);
    assert.match(queryPlan[0].detail, /SEARCH l .*parent_evidence_id=/);
    assert.ok(queryPlan.some(row => /SEARCH e .*\(id=/.test(row.detail)));
    f.add("project_document", "unselected-log", { fullPath: "X:/entry/logs/run.json", contentHash: "log", chunkIndex: 0 });
    f.sync();
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM graph_entities WHERE type='Document'").get().n, 3);
    assert.equal(f.matches("unselected" ).length, 0);
    const id = f.matches("hydraulicroute")[0];
    assert.ok(id);
    assert.deepEqual(f.matches("opticalroute"), [id]);
    assert.equal(f.matches("oldword").length, 0);
    assert.notEqual(f.matches("foreignroute")[0], id);
    const sourceIds = f.store.db.prepare("SELECT evidence_id FROM graph_entity_evidence WHERE entity_id=? AND relation='retrieval_source'").all(id).map(r => r.evidence_id).sort();
    assert.deepEqual(sourceIds, [first.id, second.id].sort());
    assert.ok(f.store.db.prepare("SELECT id FROM evidence WHERE id=?").get(old.id));
    const directory = f.entity("document-set:entry");
    assert.equal(JSON.parse(directory.metadata_json).knowledgeEntry.chunks, 2);
    assert.doesNotMatch(directory.summary, /directory part two/);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM graph_entity_evidence WHERE entity_id=? AND relation='retrieval_source'").get(directory.id).n, 2);
  } finally { f.store.close(); }
});

test("normal digest generation, historical repair and later ingestion use the same entry rules", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "entry-maintenance-"));
  const database = path.join(root, "test.sqlite");
  const f = fixture(database);
  let reopened;
  try {
    for (let i = 0; i < 45; i++) {
      f.add("project_document", `document-${i} details`.repeat(20), { fullPath: `X:/entry/docs/guide-${i}.md`, contentHash: `hash${i}`, chunkIndex: 0 });
      f.add("git_commit", `commit-${i}`, { repoPath: "X:/entry" }, { title: `historicalfeature${i}`, externalId: String(i).padStart(40, "a") });
    }
    const built = buildDigests(f.store, config);
    assert.ok(built.projectDocuments.chunks > 1);
    assert.ok(built.git.chunks > 1);
    f.sync();
    const beforeCount = f.store.db.prepare("SELECT count(*) AS n FROM evidence").get().n;
    // Simulate the old presentation defect only; leave all real generated evidence intact.
    f.store.db.prepare("UPDATE graph_entities SET summary='old broken summary', metadata_json='{}' WHERE type IN ('Repository','DocumentSet')").run();
    const repaired = refreshKnowledgeEntries(f.store.db);
    assert.ok([...repaired.values()].some(e => e.item.changed));
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM evidence").get().n, beforeCount);
    const snapshot = () => f.store.db.prepare("SELECT canonical_key,summary,metadata_json FROM graph_entities ORDER BY canonical_key").all();
    const once = snapshot();
    refreshKnowledgeEntries(f.store.db);
    assert.deepEqual(snapshot(), once);
    f.add("git_repository_snapshot", "new-checkout", { repoPath: "X:/entry" });
    f.add("project_document", "newmaintenanceentry", { fullPath: "X:/entry/docs/new.md", contentHash: "new", chunkIndex: 0 });
    buildDigests(f.store, config);
    f.sync();
    assert.ok(f.matches("newmaintenanceentry").length);
    assert.match(f.entity("repository:x:/entry").summary, /historicalfeature/);
    assert.match(f.entity("repository:x:/entry").summary, /new-checkout/);
    f.store.close();
    reopened = openDatabase(database);
    materializeContextGraph(reopened, config, options);
    assert.equal(reopened.db.prepare("SELECT count(*) AS n FROM graph_entities WHERE type='Document'").get().n, 46);
    assert.equal(reopened.db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  } finally {
    (reopened ?? f.store).close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
