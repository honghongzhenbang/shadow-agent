import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openDatabase } from "../src/db.mjs";

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "shadow-init-cleanup-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), parent);
    assert.ok(path.basename(root).startsWith("shadow-init-cleanup-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return path.join(root, "fixture.sqlite");
}

function snapshot(db) {
  return JSON.parse(JSON.stringify({
    evidence: db.prepare("SELECT * FROM evidence ORDER BY rowid").all(),
    version: db.prepare("SELECT * FROM settings WHERE key='search:index:version'").get(),
    triggers: db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='evidence' ORDER BY name").all(),
    members: db.prepare("SELECT * FROM evidence_fts_docsize ORDER BY id").all(),
    matches: db.prepare("SELECT rowid,title,content FROM evidence_fts WHERE evidence_fts MATCH 'cleanupquartz'").all(),
  }));
}

function seed(file) {
  const store = openDatabase(file);
  try {
    const source = store.upsertSource({ sourceKey: "cleanup-fixture", kind: "test", uri: "fixture://cleanup" });
    store.addEvidence({ sourceId: source.id, kind: "project_document", title: "Cleanup fixture",
      content: "cleanupquartz original source", fingerprint: "cleanup-original", sourceLocator: "fixture://cleanup#original" });
    store.db.prepare("UPDATE settings SET value='cleanup-fixture-old-version' WHERE key='search:index:version'").run();
    return snapshot(store.db);
  } finally { store.close(); }
}

function independentWrite(file) {
  const child = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    try {
      db.exec('PRAGMA busy_timeout=100; BEGIN IMMEDIATE');
      db.prepare("INSERT INTO settings(key,value,updated_at) VALUES('cleanup:writer','committed','fixture')").run();
      db.exec('COMMIT');
      console.log('committed');
    } finally { db.close(); }
  `, file], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "committed");
}

const failurePoints = [
  ["schema", sql => sql.includes("CREATE TABLE IF NOT EXISTS sources"), sql => "SELECT * FROM cleanup_fixture_missing_table;"],
  ["index-drop", sql => sql.includes("DROP TABLE IF EXISTS evidence_fts;"),
    sql => sql.replace("DROP TABLE IF EXISTS evidence_fts;", "DROP TABLE IF EXISTS evidence_fts; SELECT * FROM cleanup_fixture_missing_table;")],
  ["index-backfill", sql => sql.includes("DROP TABLE IF EXISTS evidence_fts;"),
    sql => sql.replace("INSERT INTO settings(key, value, updated_at)", "SELECT * FROM cleanup_fixture_missing_table; INSERT INTO settings(key, value, updated_at)")],
  ["index-version", sql => sql.includes("DROP TABLE IF EXISTS evidence_fts;"),
    sql => sql.replace("COMMIT;", "SELECT * FROM cleanup_fixture_missing_table; COMMIT;")],
];

for (const [name, matches, inject] of failurePoints) {
  test(`failed initialization closes its connection after ${name} while the caller stays alive`, t => {
    const file = fixture(t);
    const before = seed(file);
    const exec = DatabaseSync.prototype.exec;
    let failedDb, originalError;
    t.mock.method(DatabaseSync.prototype, "exec", function (sql) {
      if (!failedDb && matches(sql)) {
        failedDb = this;
        try { return exec.call(this, inject(sql)); }
        catch (error) { originalError = error; throw error; }
      }
      return exec.call(this, sql);
    });
    try {
      assert.throws(() => openDatabase(file), error => error === originalError
        && /cleanup_fixture_missing_table/.test(error.message));
      assert.ok(failedDb);
      // Check the other writer before cleaning the retained handle in the test.
      independentWrite(file);
      assert.equal(failedDb.isOpen, false);
      const reader = new DatabaseSync(file, { readOnly: true });
      try {
        assert.deepEqual(snapshot(reader), before);
        assert.equal(reader.prepare("SELECT value FROM settings WHERE key='cleanup:writer'").get().value, "committed");
      } finally { reader.close(); }
    } finally {
      t.mock.restoreAll();
      if (failedDb?.isOpen) failedDb.close();
    }
    const recovered = openDatabase(file);
    try { assert.equal(recovered.searchEvidence("cleanupquartz")[0].content, "cleanupquartz original source"); }
    finally { recovered.close(); }
  });
}

test("successful initialization transfers an open connection to the store", t => {
  const file = fixture(t);
  const store = openDatabase(file);
  try {
    assert.equal(store.db.isOpen, true);
    store.setSetting("cleanup:success", "kept");
    assert.equal(store.getSetting("cleanup:success"), "kept");
  } finally { store.close(); }
  assert.equal(store.db.isOpen, false);
});

test("invalid database content closes the handle and preserves the initialization error", t => {
  const file = fixture(t);
  fs.writeFileSync(file, "not a sqlite database");
  let closes = 0;
  const close = DatabaseSync.prototype.close;
  t.mock.method(DatabaseSync.prototype, "close", function () { closes++; return close.call(this); });
  assert.throws(() => openDatabase(file), /not a database/);
  // SQLite accepts the handle, then schema initialization detects the invalid file.
  assert.equal(closes, 1);
});

test("constructor failure does not try to close an uncreated handle", t => {
  const file = fixture(t);
  let closes = 0;
  t.mock.method(DatabaseSync.prototype, "close", function () { closes++; });
  assert.throws(() => openDatabase(path.dirname(file)), /unable to open database file/);
  assert.equal(closes, 0);
});

test("cleanup errors retain both the initialization failure and cleanup diagnostic", t => {
  const file = fixture(t);
  const initial = new Error("initialization fault");
  const cleanup = new Error("cleanup fault");
  const close = DatabaseSync.prototype.close;
  let handle;
  t.mock.method(DatabaseSync.prototype, "exec", function () { handle = this; throw initial; });
  t.mock.method(DatabaseSync.prototype, "close", function () { close.call(this); throw cleanup; });
  assert.throws(() => openDatabase(file), error => error instanceof AggregateError
    && error.cause === initial && error.errors[0] === initial && error.errors[1] === cleanup);
  assert.equal(handle.isOpen, false);
});
