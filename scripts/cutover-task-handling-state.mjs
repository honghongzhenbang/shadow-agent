import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { planTaskHandlingCutover } from "../src/task-handling.mjs";

const projectRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1")));
const runtimeRoot = path.join(projectRoot, "runtime");
const databasePath = path.join(runtimeRoot, "shadow-agent.sqlite");
const workboardPath = path.join(runtimeRoot, "openclaw-poc", "state", "plugins", "workboard", "workboard.sqlite");
const apply = process.argv.includes("--apply");
const now = new Date().toISOString();

function columns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function readState(database, workboard) {
  return {
    cards: workboard.prepare(`
      SELECT * FROM workboard_cards
      WHERE archived_at IS NULL
        AND status IN ('triage','backlog','todo','scheduled','ready','running','review','blocked')
    `).all(),
    attentions: database.prepare("SELECT * FROM work_task_attention").all(),
    watches: database.prepare("SELECT * FROM condition_watches").all(),
    outboundDrafts: database.prepare("SELECT * FROM outbound_message_drafts").all(),
  };
}

function countBy(items, field) {
  return Object.fromEntries([...items.reduce((map, item) => {
    const key = String(item[field] ?? "none");
    map.set(key, (map.get(key) ?? 0) + 1);
    return map;
  }, new Map()).entries()].sort());
}

if (!fs.existsSync(databasePath)) throw new Error(`Shadow database not found: ${databasePath}`);
if (!fs.existsSync(workboardPath)) throw new Error(`Workboard database not found: ${workboardPath}`);

const database = new DatabaseSync(databasePath);
const workboard = new DatabaseSync(workboardPath, { readOnly: !apply });
database.exec("PRAGMA busy_timeout=10000");
workboard.exec("PRAGMA busy_timeout=10000");
if (!apply) workboard.exec("PRAGMA query_only=ON");

try {
  const state = readState(database, workboard);
  const plan = planTaskHandlingCutover({ ...state, now });
  const report = {
    apply,
    databasePath,
    workboardPath,
    targetVersion: 1,
    before: {
      activeCards: state.cards.length,
      continuationKinds: countBy(state.attentions.filter((row) => state.cards.some((card) => card.id === row.card_id)), "continuation_kind"),
      plannedChanges: plan.changes.length,
      reasons: countBy(plan.changes, "reason"),
    },
    changes: plan.changes,
  };

  if (!apply) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(0);
  }

  database.exec("PRAGMA wal_checkpoint(FULL)");
  workboard.exec("PRAGMA wal_checkpoint(FULL)");
  const stamp = now.replace(/[:.]/g, "-");
  const backupRoot = path.join(runtimeRoot, "backups", "task-handling-cutover", stamp);
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.copyFileSync(databasePath, path.join(backupRoot, path.basename(databasePath)));
  fs.copyFileSync(workboardPath, path.join(backupRoot, path.basename(workboardPath)));

  if (!columns(database, "work_task_attention").has("continuation_user_action_json")) {
    database.exec("ALTER TABLE work_task_attention ADD COLUMN continuation_user_action_json TEXT");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const upsert = database.prepare(`
      INSERT INTO work_task_attention(
        card_id, next_review_at, continuation_kind, continuation_reference_id,
        continuation_summary, continuation_user_action_json, continuation_change_seq,
        continuation_recorded_at, continuation_evidence_ids_json,
        updated_by, updated_at
      ) VALUES(?, ?, ?, NULL, ?, NULL, NULL, ?, '[]', 'task-handling-cutover', ?)
      ON CONFLICT(card_id) DO UPDATE SET
        next_review_at=excluded.next_review_at,
        continuation_kind=excluded.continuation_kind,
        continuation_reference_id=NULL,
        continuation_summary=excluded.continuation_summary,
        continuation_user_action_json=NULL,
        continuation_change_seq=NULL,
        continuation_recorded_at=excluded.continuation_recorded_at,
        continuation_evidence_ids_json='[]',
        updated_by=excluded.updated_by,
        updated_at=excluded.updated_at
    `);
    for (const change of plan.changes) {
      upsert.run(
        change.taskId,
        change.nextReviewAt,
        change.continuationKind,
        change.continuationSummary,
        now,
        now,
      );
    }
    database.prepare(`
      INSERT INTO settings(key, value, updated_at) VALUES('taskHandling:version', '1', ?)
      ON CONFLICT(key) DO UPDATE SET value='1', updated_at=excluded.updated_at
    `).run(now);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  const afterState = readState(database, workboard);
  const afterPlan = planTaskHandlingCutover({ ...afterState, now });
  report.backupRoot = backupRoot;
  report.after = {
    activeCards: afterState.cards.length,
    continuationKinds: countBy(afterState.attentions.filter((row) => afterState.cards.some((card) => card.id === row.card_id)), "continuation_kind"),
    remainingChanges: afterPlan.changes.length,
  };
  const reportPath = path.join(backupRoot, "cutover-report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  report.reportPath = reportPath;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  workboard.close();
  database.close();
}
