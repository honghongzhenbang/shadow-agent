import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import { openDatabase, openDatabaseReadOnly } from "../src/db.mjs";
import { initializeUserProfile } from "../src/user-profile-schema.mjs";
import { previewUserBasics, confirmUserBasics, migrateUserProfile, readUserProfile,
  syncUserProfileFile, userProfileDirectory } from "../src/user-profile.mjs";

const [command = "status", ...args] = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--apply") options.apply = true;
  else if (["--file", "--confirm", "--owner", "--database"].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith("--")) options[args[i].slice(2)] = args[++i];
  else throw new Error(`Unknown argument ${args[i]}`);
}
const readInput = () => {
  if (!options.file) throw new Error("Explicit --file BASIC.json is required.");
  if (fs.statSync(options.file).size > 65536) throw new Error("Input exceeds 64 KiB.");
  return JSON.parse(fs.readFileSync(options.file, "utf8").replace(/^\uFEFF/, ""));
};
if (command === "preview") {
  process.stdout.write(`${JSON.stringify(previewUserBasics(readInput()), null, 2)}\n`);
} else {
  if (!["status", "confirm", "migrate", "sync"].includes(command)) throw new Error("Commands: preview, confirm, status, migrate, sync");
  const database = path.resolve(options.database ?? loadConfig().paths.database);
  const write = command === "confirm" || command === "sync" || (command === "migrate" && options.apply);
  const input = command === "confirm" ? readInput() : null;
  if (input && previewUserBasics(input).confirmation !== options.confirm) throw new Error("Run preview, review the plan and pass its --confirm hash.");
  const store = (write ? openDatabase : openDatabaseReadOnly)(database);
  try {
    let result;
    if (command === "migrate") {
      if (write) initializeUserProfile(store.db);
      result = migrateUserProfile(store.db, { ownerEntityId: options.owner, apply: Boolean(options.apply) });
    } else if (command === "confirm") result = confirmUserBasics(store, input, options.confirm);
    else if (command === "sync") result = syncUserProfileFile(store.db, userProfileDirectory(database));
    else result = readUserProfile(store.db);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally { store.close(); }
}
