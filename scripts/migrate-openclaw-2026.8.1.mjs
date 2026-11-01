import fs from "node:fs";
import path from "node:path";

const projectRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1")));
const configPath = process.env.OPENCLAW_CONFIG_PATH
  || path.join(projectRoot, "runtime", "openclaw-poc", "state", "openclaw.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const changes = [];

if (Array.isArray(config.agents?.list)) {
  const entries = {};
  for (const item of config.agents.list) {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string" || !item.id) {
      throw new Error("Cannot migrate invalid agents.list entry.");
    }
    const { id, default: _default, ...agentConfig } = item;
    if (entries[id]) throw new Error(`Duplicate agent id: ${id}`);
    entries[id] = agentConfig;
  }
  delete config.agents.list;
  config.agents.entries = entries;
  changes.push("agents.list -> agents.entries");
}

function removeKey(owner, key, label) {
  if (!owner || !Object.hasOwn(owner, key)) return;
  delete owner[key];
  changes.push(label);
}

removeKey(config.meta, "lastTouchedAt", "meta.lastTouchedAt");
removeKey(config.agents?.defaults?.heartbeat, "skipWhenBusy", "agents.defaults.heartbeat.skipWhenBusy");
removeKey(config.agents?.defaults?.compaction, "truncateAfterCompaction", "agents.defaults.compaction.truncateAfterCompaction");
removeKey(config.agents?.defaults?.compaction, "maxHistoryShare", "agents.defaults.compaction.maxHistoryShare");
removeKey(config.gateway?.tailscale, "resetOnExit", "gateway.tailscale.resetOnExit");
if (config.agents?.defaults?.modelPolicy?.allow) {
  removeKey(config.agents.defaults, "models", "agents.defaults.models");
}

const loopDetection = config.tools?.loopDetection;
if (loopDetection) {
  for (const key of [
    "historySize",
    "warningThreshold",
    "criticalThreshold",
    "unknownToolThreshold",
    "globalCircuitBreakerThreshold",
    "detectors",
    "postCompactionGuard",
  ]) {
    removeKey(loopDetection, key, `tools.loopDetection.${key}`);
  }
}

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ configPath, changes }, null, 2));
