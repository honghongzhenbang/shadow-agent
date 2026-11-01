import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { resolveTaskOwnerSession } from "../src/agent-operations.mjs";
import { loadConfig } from "../src/config.mjs";
import { openDatabase } from "../src/db.mjs";

const apply = process.argv.includes("--apply");
const config = loadConfig();
const workboardPath = path.join(
  config.projectRoot,
  "runtime",
  "openclaw-poc",
  "state",
  "plugins",
  "workboard",
  "workboard.sqlite",
);

if (!fs.existsSync(workboardPath)) throw new Error(`Workboard database not found: ${workboardPath}`);

const store = openDatabase(config.paths.database);
const workboard = new DatabaseSync(workboardPath, { readOnly: true });
const activeStatuses = ["triage", "backlog", "todo", "scheduled", "ready", "running", "review", "blocked"];
const cards = workboard.prepare(`
  SELECT id, title, notes, status, board_id, session_key, automation_json
  FROM workboard_cards
  WHERE archived_at IS NULL
    AND status IN (${activeStatuses.map(() => "?").join(",")})
  ORDER BY updated_at DESC
`).all(...activeStatuses);

const result = [];
store.db.exec("BEGIN IMMEDIATE");
try {
  for (const row of cards) {
    const card = {
      id: row.id,
      title: row.title,
      notes: row.notes,
      status: row.status,
      boardId: row.board_id,
      session_key: row.session_key,
      automation: JSON.parse(row.automation_json || "{}"),
    };
    const owner = resolveTaskOwnerSession(store, card);
    result.push({
      cardId: card.id,
      title: card.title,
      status: card.status,
      controllerSessionKey: owner.sessionKey,
      controllerSessionKind: owner.binding.session_kind,
      bindingReason: owner.bindingReason,
      workboardExecutionSessionKey: card.session_key,
    });
  }
  if (apply) store.db.exec("COMMIT");
  else store.db.exec("ROLLBACK");
} catch (error) {
  try { store.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
  throw error;
} finally {
  workboard.close();
  store.close();
}

const summary = result.reduce((output, row) => {
  output[row.bindingReason] = (output[row.bindingReason] ?? 0) + 1;
  return output;
}, {});
console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", cards: result.length, summary, result }, null, 2));
