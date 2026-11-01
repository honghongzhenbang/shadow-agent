import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { loadConfig } from "../src/config.mjs";
import { initializeUserProfile } from "../src/user-profile-schema.mjs";
import { migrateUserProfile, readUserProfile, syncUserProfileFile, userProfileDirectory } from "../src/user-profile.mjs";

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--apply")) throw new Error("Usage: migrate-user-profile.mjs [--apply]; default creates a verified backup/rehearsal only.");
const apply = args.includes("--apply");
const databasePath = loadConfig().paths.database;
const root = path.resolve(path.dirname(databasePath), "profile-migration", new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(root, { recursive: true });
const backupPath = path.join(root, "before.sqlite"), rehearsalPath = path.join(root, "rehearsal.sqlite");
const source = new DatabaseSync(databasePath, { readOnly: true });
const plan = migrateUserProfile(source);
if (plan.requiresOwner) { source.close(); throw new Error("Explicit owner binding is required before migration."); }
function factsFingerprint(db) {
  const hash = createHash("sha256");
  for (const row of db.prepare("SELECT * FROM graph_facts ORDER BY id").iterate()) hash.update(JSON.stringify(row));
  return hash.digest("hex");
}
process.stderr.write("Creating consistent backup...\n");
await backup(source, backupPath);
source.close();
const snapshot = new DatabaseSync(backupPath, { readOnly: true });
const before = { facts: factsFingerprint(snapshot), evidenceCount: snapshot.prepare("SELECT count(*) AS n FROM evidence").get().n };
snapshot.close();
process.stderr.write("Rehearsing migration and checking the full backup; large databases may take several minutes...\n");
fs.copyFileSync(backupPath, rehearsalPath, fs.constants.COPYFILE_EXCL);
const rehearsal = new DatabaseSync(rehearsalPath);
let tested;
try {
  initializeUserProfile(rehearsal);
  tested = migrateUserProfile(rehearsal, { apply: true });
  if (factsFingerprint(rehearsal) !== before.facts) throw new Error("Migration changed existing graph facts.");
  if (rehearsal.prepare("SELECT count(*) AS n FROM evidence").get().n < before.evidenceCount) throw new Error("Migration lost Evidence.");
  if (rehearsal.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw new Error("Rehearsal integrity failed.");
  const timings = [];
  for (let i = 0; i < 10; i++) { const start = performance.now(); readUserProfile(rehearsal); timings.push(performance.now() - start); }
  tested.timingsMs = timings;
} finally { rehearsal.close(); }
const evidence = { databasePath, backupPath, before, plan, rehearsal: tested, applied: false };
if (apply) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout=5000");
    initializeUserProfile(database);
    evidence.live = migrateUserProfile(database, { apply: true });
    evidence.view = syncUserProfileFile(database, userProfileDirectory(databasePath));
    evidence.applied = true;
  } finally { database.close(); }
}
fs.writeFileSync(path.join(root, "result.private.json"), JSON.stringify(evidence, null, 2), "utf8");
// Only the disposable, exact rehearsal file is removed; retain the verified pre-migration backup.
if (path.dirname(path.resolve(rehearsalPath)) !== root) throw new Error("Unsafe rehearsal cleanup path.");
fs.rmSync(rehearsalPath);
process.stdout.write(`${JSON.stringify({ applied: evidence.applied, backupPath,
  result: path.join(root, "result.private.json"), ownerEntityId: tested.ownerEntityId,
  items: tested.profile.items.length, candidates: tested.profile.candidates.length,
  missing: tested.profile.missing, medianReadMs: [...tested.timingsMs].sort((a,b)=>a-b)[5],
  view: evidence.view }, null, 2)}\n`);
