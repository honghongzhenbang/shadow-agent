import path from "node:path";

import { loadConfig } from "../src/config.mjs";
import { importCognitiveProfile, readCognitiveProfile } from "../src/cognitive-profile.mjs";
import { openDatabase } from "../src/db.mjs";

function argumentsFrom(argv) {
  const result = { file: path.join("config", "cognitive-profile.local.json"), dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--file") result.file = argv[++index];
    else if (argument === "--dry-run") result.dryRun = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

const args = argumentsFrom(process.argv.slice(2));
const config = loadConfig();
const { profile, resolved } = readCognitiveProfile(args.file);
const store = openDatabase(config.paths.database);
try {
  const result = importCognitiveProfile(store, profile, {
    dryRun: args.dryRun,
    sourceLocator: resolved,
    externalId: `cognitive-profile:${path.basename(resolved)}`,
  });
  process.stdout.write(`${JSON.stringify({ database: config.paths.database, file: resolved, ...result }, null, 2)}\n`);
} finally {
  store.close();
}
