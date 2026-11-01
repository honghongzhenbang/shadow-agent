import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_CODEX_DIGEST_TITLE_CHARS,
  DEFAULT_CODEX_THREAD_TITLE_CHARS,
  codexDigestTitle,
  isAgentGeneratedCodexThread,
  normalizeCodexThreadTitle,
} from "./codex-thread-title.mjs";

function openStateDatabase(codexHome, readOnly) {
  const databasePath = path.join(codexHome, "state_5.sqlite");
  if (!fs.existsSync(databasePath)) return { database: null, databasePath };
  const database = new DatabaseSync(databasePath, { readOnly });
  if (!readOnly) database.exec("PRAGMA busy_timeout=5000");
  return { database, databasePath };
}

export function inspectCodexStateTitles(config) {
  const maintenance = config.codex?.titleMaintenance ?? {};
  const maxTitleChars = maintenance.maxThreadTitleChars ?? DEFAULT_CODEX_THREAD_TITLE_CHARS;
  const { database, databasePath } = openStateDatabase(config.paths.codexHome, true);
  if (!database) return { databasePath, candidates: [] };
  try {
    const candidates = [];
    const rows = database.prepare(`
      SELECT id, title, name, cwd, created_at_ms, updated_at_ms
      FROM threads
      WHERE length(COALESCE(title,'')) > ? OR length(COALESCE(name,'')) > ?
    `).all(maxTitleChars, maxTitleChars);
    for (const row of rows) {
      if (!isAgentGeneratedCodexThread(row, maintenance.agentCwdRoots ?? [])) continue;
      const newTitle = normalizeCodexThreadTitle(row, maxTitleChars);
      if (row.title === newTitle && (!row.name || row.name === newTitle)) continue;
      candidates.push({
        id: row.id,
        cwd: row.cwd,
        oldTitleChars: Array.from(String(row.title ?? "")).length,
        oldTitle: row.title,
        newTitle,
      });
    }
    return { databasePath, candidates };
  } finally {
    database.close();
  }
}

export function repairCodexStateTitles(config, options = {}) {
  const maxTitleChars = config.codex?.titleMaintenance?.maxThreadTitleChars
    ?? DEFAULT_CODEX_THREAD_TITLE_CHARS;
  const inspection = options.inspection ?? inspectCodexStateTitles(config);
  if (options.apply === false || inspection.candidates.length === 0) {
    return {
      databasePath: inspection.databasePath,
      changed: 0,
      candidateCount: inspection.candidates.length,
      reclaimedTitleChars: inspection.candidates.reduce((sum, row) => sum + row.oldTitleChars - Array.from(row.newTitle).length, 0),
    };
  }
  const { database } = openStateDatabase(config.paths.codexHome, false);
  if (!database) return { databasePath: inspection.databasePath, changed: 0, candidateCount: 0 };
  try {
    const update = database.prepare(`
      UPDATE threads
      SET title=?, name=CASE WHEN name IS NULL OR trim(name)='' OR length(name)>? THEN ? ELSE name END
      WHERE id=?
    `);
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of inspection.candidates) update.run(row.newTitle, maxTitleChars, row.newTitle, row.id);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return {
      databasePath: inspection.databasePath,
      changed: inspection.candidates.length,
      candidateCount: inspection.candidates.length,
      reclaimedTitleChars: inspection.candidates.reduce((sum, row) => sum + row.oldTitleChars - Array.from(row.newTitle).length, 0),
    };
  } finally {
    database.close();
  }
}

export function inspectShadowDigestTitles(databasePath, candidates, maxDigestTitleChars = DEFAULT_CODEX_DIGEST_TITLE_CHARS) {
  if (!fs.existsSync(databasePath) || candidates.length === 0) {
    return { databasePath, threads: 0, digestRows: 0, titleChars: 0 };
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const threadQuery = database.prepare("SELECT COUNT(*) AS count FROM threads WHERE id=?");
    const digestQuery = database.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(length(title)),0) AS title_chars
      FROM evidence WHERE kind='codex_thread_digest' AND thread_id=?
    `);
    let threads = 0;
    let digestRows = 0;
    let titleChars = 0;
    for (const candidate of candidates) {
      threads += Number(threadQuery.get(candidate.id)?.count ?? 0);
      const row = digestQuery.get(candidate.id);
      digestRows += Number(row?.count ?? 0);
      titleChars += Number(row?.title_chars ?? 0);
    }
    return { databasePath, threads, digestRows, titleChars, maxDigestTitleChars };
  } finally {
    database.close();
  }
}

export function inspectShadowStoredTitles(databasePath, options = {}) {
  const maxThreadTitleChars = options.maxThreadTitleChars ?? DEFAULT_CODEX_THREAD_TITLE_CHARS;
  const maxDigestTitleChars = options.maxDigestTitleChars ?? DEFAULT_CODEX_DIGEST_TITLE_CHARS;
  if (!fs.existsSync(databasePath)) {
    return { databasePath, candidates: [], threads: 0, digestRows: 0, titleChars: 0, maxDigestTitleChars };
  }
  const canonicalTitles = new Map((options.canonicalCandidates ?? []).map((row) => [row.id, row.newTitle]));
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT id, title, cwd
      FROM threads
      WHERE length(COALESCE(title,'')) > ?
         OR EXISTS (
           SELECT 1 FROM evidence
           WHERE kind='codex_thread_digest' AND thread_id=threads.id AND length(title) > ?
         )
    `).all(maxThreadTitleChars, maxDigestTitleChars);
    const candidates = rows.map((row) => ({
      id: row.id,
      oldTitleChars: Array.from(String(row.title ?? "")).length,
      newTitle: canonicalTitles.get(row.id) ?? normalizeCodexThreadTitle(row, maxThreadTitleChars),
    }));
    const summary = inspectShadowDigestTitles(databasePath, candidates, maxDigestTitleChars);
    return { ...summary, candidates };
  } finally {
    database.close();
  }
}

export function repairShadowDigestTitles(databasePath, candidates, options = {}) {
  const maxDigestTitleChars = options.maxDigestTitleChars ?? DEFAULT_CODEX_DIGEST_TITLE_CHARS;
  const inspection = options.inspection ?? inspectShadowDigestTitles(databasePath, candidates, maxDigestTitleChars);
  const { candidates: _inspectionCandidates, ...summary } = inspection;
  if (options.apply === false || candidates.length === 0 || !fs.existsSync(databasePath)) {
    return { ...summary, changedThreads: 0, changedDigests: 0 };
  }
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA busy_timeout=10000");
  const updateThread = database.prepare("UPDATE threads SET title=? WHERE id=? AND title<>?");
  const digestRows = database.prepare(`
    SELECT id, CASE WHEN json_valid(metadata_json) THEN COALESCE(json_extract(metadata_json,'$.chunkIndex'),0) ELSE 0 END AS chunk_index
    FROM evidence WHERE kind='codex_thread_digest' AND thread_id=?
  `);
  const updateDigest = database.prepare("UPDATE evidence SET title=? WHERE id=? AND title<>?");
  let changedThreads = 0;
  let changedDigests = 0;
  try {
    for (const candidate of candidates) {
      database.exec("BEGIN IMMEDIATE");
      try {
        changedThreads += Number(updateThread.run(candidate.newTitle, candidate.id, candidate.newTitle).changes ?? 0);
        for (const digest of digestRows.iterate(candidate.id)) {
          const title = codexDigestTitle(candidate.newTitle, digest.chunk_index, maxDigestTitleChars);
          changedDigests += Number(updateDigest.run(title, digest.id, title).changes ?? 0);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
    database.exec("PRAGMA optimize");
    return { ...summary, changedThreads, changedDigests };
  } finally {
    database.close();
  }
}
