import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeEpistemicGraph } from '../src/graph-model.mjs';
import { openDatabase } from '../src/db.mjs';
import { captureKnowledge, completeKnowledgeAnnotation } from '../openclaw/shadow-work/src/epistemic.js';
import { openV4TestDatabase } from '../openclaw/shadow-work/src/test-fixture.mjs';

const INDEX = 'graph_episode_annotations_review_identity_idx';
const ORIGINAL_QUERY = `SELECT metadata_json FROM graph_episode_annotations
  WHERE evidence_id=? OR json_extract(metadata_json, '$.graphReview.reviewIdentity')=?
  ORDER BY CAST(json_extract(metadata_json, '$.graphReview.reviewVersion') AS INTEGER) DESC,
    updated_at DESC, evidence_id LIMIT 1`;

function memory(t) {
  const store = openV4TestDatabase(':memory:');
  t.after(() => store.close());
  return store;
}

function indexRow(db) {
  return db.prepare("SELECT name, rootpage, sql FROM sqlite_master WHERE type='index' AND name=?").get(INDEX);
}

function annotation(db, id, identity, version, updatedAt = '2026-10-23T00:00:00Z') {
  db.prepare(`INSERT INTO evidence(id, fingerprint, source_id, kind, collected_at, content, source_locator)
    VALUES(?,?, 'synthetic-review-source', 'review_index_fixture', ?, 'Synthetic source', ?)`)
    .run(id, id, updatedAt, `test:review-index:${id}`);
  const metadata = { marker: id, graphReview: { reviewIdentity: identity, reviewVersion: version } };
  db.prepare(`INSERT INTO graph_episode_annotations(evidence_id, content_hash, updated_at, metadata_json)
    VALUES(?, 'synthetic-hash', ?, ?)`).run(id, updatedAt, JSON.stringify(metadata));
}

function syntheticSource(db) {
  db.prepare(`INSERT INTO sources(id, source_key, kind, uri, last_seen_at)
    VALUES('synthetic-review-source', 'synthetic-review-source', 'test', 'test:review-index', '2026-10-23')`).run();
}

// Capture the SQL executed by the real annotation path, not a test-only optimized copy.
function latestReviewQuery(t, db) {
  const captured = captureKnowledge(db, { sourceType: 'note', title: 'Index fixture',
    content: 'Isolated source used to capture the actual latest-review query.',
    summary: 'This fixture contains no durable fact and needs no task notification.',
    keywords: ['index', 'review', 'fixture'], retrievalCues: ['Which review is latest?', 'Which index is used?'] });
  const prepare = db.prepare.bind(db), exec = db.exec.bind(db), queries = [];
  const schemaVersion = prepare('PRAGMA schema_version').get().schema_version;
  const tracker = t.mock.method(db, 'prepare', sql => {
    assert.doesNotMatch(sql, /\b(?:CREATE|ALTER|DROP|REINDEX)\b/i, 'Annotation must not initialize schema');
    if (/^SELECT metadata_json FROM/.test(sql) && sql.includes('$.graphReview.reviewIdentity')) queries.push(sql);
    return prepare(sql);
  });
  const ddlGuard = t.mock.method(db, 'exec', sql => {
    assert.doesNotMatch(sql, /\b(?:CREATE|ALTER|DROP|REINDEX)\b/i, 'Annotation must not initialize schema');
    return exec(sql);
  });
  try {
    const input = { evidenceId: captured.evidenceId, graphReview: { status: 'completed',
      outcome: 'no_durable_facts', rationale: 'Test-only source with no durable claim.' } };
    const first = completeKnowledgeAnnotation(db, input);
    const replay = completeKnowledgeAnnotation(db, input);
    assert.equal(replay.reviewVersion, first.reviewVersion);
    assert.equal(replay.reviewHash, first.reviewHash);
    assert.equal(prepare('PRAGMA schema_version').get().schema_version, schemaVersion);
  } finally {
    tracker.mock.restore(); ddlGuard.mock.restore();
  }
  assert.equal(queries.length, 2, 'Both annotations must exercise the real latest-review lookup');
  assert.equal(queries[0], queries[1]);
  return queries[0];
}

test('normal graph initialization creates the review identity/order index idempotently', t => {
  const { db } = memory(t);
  const original = indexRow(db);
  assert.ok(original, 'Opening a normal store must initialize the index before any annotation');
  assert.match(original.sql, /json_extract\(metadata_json, '\$\.graphReview\.reviewIdentity'\)/);
  assert.match(original.sql, /CAST\(json_extract\(metadata_json, '\$\.graphReview\.reviewVersion'\) AS INTEGER\) DESC/);
  assert.match(original.sql, /updated_at DESC, evidence_id/);
  syntheticSource(db);
  annotation(db, 'legacy-no-review', undefined, undefined);
  annotation(db, 'reviewed', 'shared-review', 7);
  const before = db.prepare('SELECT * FROM graph_episode_annotations ORDER BY evidence_id').all();
  const schemaVersion = db.prepare('PRAGMA schema_version').get().schema_version;
  for (let i = 0; i < 3; i++) {
    initializeEpistemicGraph(db);
    assert.deepEqual(indexRow(db), original);
    assert.equal(db.prepare('PRAGMA schema_version').get().schema_version, schemaVersion);
    assert.deepEqual(db.prepare('SELECT * FROM graph_episode_annotations ORDER BY evidence_id').all(), before);
  }
});

test('opening a pre-index store upgrades once and preserves annotations across repeated reopen', t => {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'shadow-review-index-')));
  const filename = path.join(root, 'isolated.sqlite');
  let store = openDatabase(filename);
  t.after(() => {
    store.close();
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('shadow-review-index-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  syntheticSource(store.db);
  annotation(store.db, 'legacy-annotation', undefined, undefined);
  annotation(store.db, 'existing-review', 'shared-review', '12');
  const before = store.db.prepare('SELECT * FROM graph_episode_annotations ORDER BY evidence_id').all();
  store.db.exec(`DROP INDEX ${INDEX}`);
  assert.equal(indexRow(store.db), undefined);
  store.close(); store = openDatabase(filename);
  const created = indexRow(store.db);
  assert.ok(created);
  assert.deepEqual(store.db.prepare('SELECT * FROM graph_episode_annotations ORDER BY evidence_id').all(), before);
  store.close(); store = openDatabase(filename);
  assert.deepEqual(indexRow(store.db), created);
  assert.deepEqual(store.db.prepare('SELECT * FROM graph_episode_annotations ORDER BY evidence_id').all(), before);
});

test('annotation executes the optimized lookup without attempting schema DDL on either call', t => {
  const { db } = memory(t);
  assert.ok(indexRow(db));
  latestReviewQuery(t, db);
});

test('bounded latest-review lookup preserves numeric version, date, evidence-id and local fallback ordering', t => {
  const { db } = memory(t), query = latestReviewQuery(t, db);
  syntheticSource(db);
  annotation(db, 'local-newer', 'unrelated-identity', 11);
  annotation(db, 'identity-v9', 'shared-review', '9', '2099-01-01T00:00:00Z');
  annotation(db, 'identity-v10-old', 'shared-review', '10', '2020-01-01T00:00:00Z');
  annotation(db, 'identity-v10-b', 'shared-review', 10);
  annotation(db, 'identity-v10-a', 'shared-review', '10');
  annotation(db, 'local-older', 'other-identity', 1);
  annotation(db, 'legacy-a', 'legacy-review', undefined);
  annotation(db, 'legacy-b', 'legacy-review', undefined);
  annotation(db, 'legacy-local', undefined, undefined, '2020-01-01T00:00:00Z');
  const lookups = [
    ['local-newer', 'shared-review', 'local-newer'],
    ['local-older', 'shared-review', 'identity-v10-a'],
    ['identity-v10-a', 'shared-review', 'identity-v10-a'],
    ['missing', 'shared-review', 'identity-v10-a'],
    ['legacy-local', 'legacy-review', 'legacy-a'],
    ['legacy-local', 'missing', 'legacy-local'],
    ['local-newer', 'missing', 'local-newer'],
    ['missing', 'missing', undefined],
  ];
  db.exec('PRAGMA query_only=ON');
  for (const [id, identity, expected] of lookups) {
    const result = db.prepare(query).get(id, identity);
    assert.deepEqual(result, db.prepare(ORIGINAL_QUERY).get(id, identity));
    assert.equal(result ? JSON.parse(result.metadata_json).marker : undefined, expected);
  }
});

test('400k annotations use indexed bounded branches for sparse and crowded review identities', t => {
  const { db } = memory(t), query = latestReviewQuery(t, db);
  syntheticSource(db);
  db.exec(`BEGIN IMMEDIATE;
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<399999)
    INSERT INTO evidence(id, fingerprint, source_id, kind, collected_at, content, source_locator)
      SELECT printf('bulk-%06d',x), printf('bulk-%06d',x), 'synthetic-review-source',
        'review_index_fixture', '2026-10-23', 'Synthetic source', 'test:review-index' FROM n;
    INSERT INTO graph_episode_annotations(evidence_id, content_hash, updated_at, metadata_json)
      SELECT id, 'synthetic-hash', '2026-10-23',
        json_object('marker',id,'graphReview',json_object(
          'reviewIdentity',CASE WHEN CAST(substr(id,6) AS INTEGER)%2=0 THEN 'crowded-review' ELSE 'identity-'||id END,
          'reviewVersion',CAST(substr(id,6) AS INTEGER)))
      FROM evidence WHERE source_id='synthetic-review-source';
    COMMIT;`);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM graph_episode_annotations').get().n, 400000);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM graph_episode_annotations WHERE json_extract(metadata_json,'$.graphReview.reviewIdentity')=?")
    .get('crowded-review').n, 199999);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.exec('PRAGMA query_only=ON');
  for (const [identity, expected] of [
    ['identity-bulk-300001', 'bulk-300001'], ['crowded-review', 'bulk-399998'], ['absent', 'bulk-000001'],
  ]) {
    const params = ['bulk-000001', identity];
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...params);
    const details = plan.map(row => row.detail);
    assert.ok(details.some(detail => detail.includes(`SEARCH graph_episode_annotations USING INDEX ${INDEX}`)), details.join('\n'));
    assert.ok(details.some(detail => /SEARCH graph_episode_annotations USING INDEX .*\(evidence_id=\?\)/.test(detail)), details.join('\n'));
    assert.ok(!details.some(detail => /SCAN graph_episode_annotations|MULTI-INDEX OR/.test(detail)), details.join('\n'));
    // The only sort is above the bounded branches; the identity range uses index order.
    const sorts = plan.filter(row => row.detail.includes('TEMP B-TREE'));
    assert.equal(sorts.length, 1);
    assert.equal(sorts[0].parent, 0);
    const start = performance.now();
    const result = db.prepare(query).get(...params);
    const elapsedMs = performance.now() - start;
    assert.equal(JSON.parse(result.metadata_json).marker, expected);
    assert.deepEqual(result, db.prepare(ORIGINAL_QUERY).get(...params));
    t.diagnostic(`${identity}: ${elapsedMs.toFixed(3)} ms; ${details.filter(detail => detail.startsWith('SEARCH')).join('; ')}`);
  }
});
