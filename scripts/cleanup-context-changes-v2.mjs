import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const databasePath = path.join(projectRoot, "runtime", "shadow-agent.sqlite");
const database = new DatabaseSync(databasePath);
database.exec("PRAGMA busy_timeout=5000");

try {
  const candidates = database.prepare(`
    SELECT * FROM context_changes
    WHERE status='pending'
      AND (
        kind IN ('entity_created', 'entity_updated', 'fact_asserted')
        OR (
          kind='evidence_batch_ingested'
          AND json_extract(metadata_json, '$.evidenceKind')='codex_thread_digest'
          AND json_extract(metadata_json, '$.count')>1
        )
      )
    ORDER BY seq
  `).all();
  const evidenceDirectory = path.join(
    projectRoot,
    "runtime",
    "openclaw-poc",
    "evidence",
    `v2-change-cleanup-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}`,
  );
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  fs.writeFileSync(path.join(evidenceDirectory, "duplicates.json"), JSON.stringify(candidates, null, 2), "utf8");

  database.exec("BEGIN IMMEDIATE");
  const statement = database.prepare(`
    UPDATE context_changes
    SET status='acknowledged', acknowledged_at=?, ack_note=?, lease_owner=NULL, lease_until=NULL
    WHERE seq=? AND status='pending'
  `);
  const now = new Date().toISOString();
  let updated = 0;
  for (const candidate of candidates) {
    updated += Number(statement.run(
      now,
      "V2 cutover cleanup: duplicate entity/chunk notification preserved in evidence and superseded by one batch change.",
      candidate.seq,
    ).changes ?? 0);
  }
  database.prepare(`
    INSERT INTO settings(key, value, updated_at) VALUES('migration:context-change-cleanup:v2', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(JSON.stringify({ updated, evidenceDirectory }), now);
  database.exec("COMMIT");
  console.log(JSON.stringify({ candidates: candidates.length, updated, evidenceDirectory }, null, 2));
} catch (error) {
  try { database.exec("ROLLBACK"); } catch { /* no active transaction */ }
  throw error;
} finally {
  database.close();
}
