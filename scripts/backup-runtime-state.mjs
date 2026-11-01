import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { loadConfig } from "../src/config.mjs";

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sha256(filePath) {
  const hash = createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    while (true) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!bytes) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

async function backupDatabase(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) return null;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    source.exec("PRAGMA query_only=ON");
    await backup(source, targetPath);
  } finally {
    source.close();
  }
  const checked = new DatabaseSync(targetPath, { readOnly: true });
  let quickCheck;
  try {
    quickCheck = checked.prepare("PRAGMA quick_check").get()?.quick_check ?? "unknown";
  } finally {
    checked.close();
  }
  return {
    source: sourcePath,
    target: targetPath,
    bytes: fs.statSync(targetPath).size,
    sha256: sha256(targetPath),
    quickCheck,
  };
}

function copyTree(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) return null;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });
  const files = [];
  const visit = (entry) => {
    const stat = fs.statSync(entry);
    if (stat.isFile()) files.push(entry);
    else for (const child of fs.readdirSync(entry)) visit(path.join(entry, child));
  };
  visit(targetPath);
  return {
    source: sourcePath,
    target: targetPath,
    files: files.length,
    bytes: files.reduce((total, entry) => total + fs.statSync(entry).size, 0),
  };
}

const config = loadConfig();
const requestedTarget = process.argv.find((value) => value.startsWith("--target="))?.slice(9);
const targetRoot = path.resolve(requestedTarget
  || path.join(config.projectRoot, "..", "shadow-agent-backups", `runtime-pre-v4-${stamp()}`));
const stateRoot = path.join(config.projectRoot, "runtime", "openclaw-poc", "state");
const mainAgentRoot = path.join(stateRoot, "agents", "main");
const databases = [
  [config.paths.database, path.join(targetRoot, "databases", "shadow-agent.sqlite")],
  [path.join(stateRoot, "plugins", "workboard", "workboard.sqlite"), path.join(targetRoot, "databases", "workboard.sqlite")],
  [path.join(stateRoot, "state", "openclaw.sqlite"), path.join(targetRoot, "databases", "openclaw.sqlite")],
  [path.join(mainAgentRoot, "agent", "openclaw-agent.sqlite"), path.join(targetRoot, "databases", "openclaw-agent.sqlite")],
];

fs.mkdirSync(targetRoot, { recursive: true });
const databaseResults = [];
for (const [source, target] of databases) {
  const result = await backupDatabase(path.resolve(source), target);
  if (result) databaseResults.push(result);
}

const copiedState = [
  copyTree(path.join(stateRoot, "openclaw.json"), path.join(targetRoot, "openclaw", "openclaw.json")),
  copyTree(path.join(mainAgentRoot, "sessions"), path.join(targetRoot, "openclaw", "sessions")),
  copyTree(path.join(stateRoot, "identity"), path.join(targetRoot, "openclaw", "identity")),
  copyTree(path.join(stateRoot, "workspace-attestations"), path.join(targetRoot, "openclaw", "workspace-attestations")),
  copyTree(path.join(mainAgentRoot, "agent", "models.json"), path.join(targetRoot, "openclaw", "models.json")),
].filter(Boolean);

const manifest = {
  schemaVersion: "shadow-agent-runtime-backup-v1",
  createdAt: new Date().toISOString(),
  targetRoot,
  sensitivity: "private-runtime-state; contains OpenClaw config and private sessions; excludes Codex auth, caches, and dependencies; never share",
  databases: databaseResults,
  copiedState,
};
fs.writeFileSync(path.join(targetRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
