import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const databasePath = path.join(
  projectRoot,
  "runtime",
  "openclaw-poc",
  "state",
  "agents",
  "main",
  "agent",
  "openclaw-agent.sqlite",
);
const apply = process.argv.includes("--apply");

if (!fs.existsSync(databasePath)) {
  throw new Error(`OpenClaw auth database not found: ${databasePath}`);
}

const database = new DatabaseSync(databasePath);
const storeRow = database.prepare(`
  SELECT store_json
  FROM auth_profile_store
  WHERE store_key = 'primary'
`).get();
const stateRow = database.prepare(`
  SELECT state_json
  FROM auth_profile_state
  WHERE state_key = 'primary'
`).get();

const store = storeRow ? JSON.parse(storeRow.store_json) : { version: 1, profiles: {} };
const state = stateRow ? JSON.parse(stateRow.state_json) : { version: 1 };
const removedProfileIds = Object.entries(store.profiles ?? {})
  .filter(([, profile]) => profile?.provider === "openai")
  .map(([profileId]) => profileId);

if (!apply) {
  console.log(JSON.stringify({
    apply: false,
    databasePath,
    wouldRemoveOpenAiProfiles: removedProfileIds.length,
    preservesUserCodexHome: true,
  }, null, 2));
  process.exit(0);
}

const backupDirectory = path.join(projectRoot, "runtime", "openclaw-poc", "backups", "auth");
fs.mkdirSync(backupDirectory, { recursive: true });
const backupPath = path.join(
  backupDirectory,
  `openclaw-agent-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}.sqlite`,
);
fs.copyFileSync(databasePath, backupPath);

for (const profileId of removedProfileIds) {
  delete store.profiles[profileId];
  if (state.usageStats) delete state.usageStats[profileId];
}
if (state.lastGood?.openai && removedProfileIds.includes(state.lastGood.openai)) {
  delete state.lastGood.openai;
}

const now = Date.now();
database.exec("BEGIN IMMEDIATE");
try {
  database.prepare(`
    UPDATE auth_profile_store
    SET store_json = ?, updated_at = ?
    WHERE store_key = 'primary'
  `).run(JSON.stringify(store), now);
  if (stateRow) {
    database.prepare(`
      UPDATE auth_profile_state
      SET state_json = ?, updated_at = ?
      WHERE state_key = 'primary'
    `).run(JSON.stringify(state), now);
  }
  database.exec("COMMIT");
} catch (error) {
  database.exec("ROLLBACK");
  throw error;
} finally {
  database.close();
}

console.log(JSON.stringify({
  apply: true,
  databasePath,
  backupPath,
  removedOpenAiProfiles: removedProfileIds.length,
  preservesUserCodexHome: true,
}, null, 2));
