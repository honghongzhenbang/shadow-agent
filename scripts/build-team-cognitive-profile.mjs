import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildTeamCognitiveProfile } from "../src/team-profile.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(argv) {
  const result = { output: path.join(root, "runtime", "profiles", "team-cognitive-profile.json") };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--source", "--output", "--owner", "--profile-id"].includes(argument)
      && (!argv[index + 1] || argv[index + 1].startsWith("--"))) throw new Error(`Missing value for ${argument}`);
    if (argument === "--source") result.source = path.resolve(argv[++index]);
    else if (argument === "--output") result.output = path.resolve(argv[++index]);
    else if (argument === "--owner") result.ownerName = argv[++index];
    else if (argument === "--profile-id") result.profileId = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!result.source || !result.ownerName || !result.profileId) {
    throw new Error("Required: --source FILE --owner NAME --profile-id STABLE_ID [--output FILE]");
  }
  return result;
}

const args = parseArguments(process.argv.slice(2));
const source = fs.readFileSync(args.source, "utf8");
const profile = buildTeamCognitiveProfile(source, {
  sourcePath: path.relative(root, args.source).replaceAll("\\", "/"),
  generatedAt: fs.statSync(args.source).mtime.toISOString(),
  ownerName: args.ownerName,
  profileId: args.profileId,
});
fs.mkdirSync(path.dirname(args.output), { recursive: true });
fs.writeFileSync(args.output, `${JSON.stringify(profile, null, 2)}\n`, "utf8");

process.stdout.write(`${JSON.stringify({
  source: args.source,
  output: args.output,
  asOf: profile.metadata.asOf,
  entities: profile.entities.length,
  relations: profile.relations.length,
}, null, 2)}\n`);
