import fs from "node:fs";
import path from "node:path";

import { PROJECT_ROOT, resolveProjectPath } from "./paths.mjs";

function readJson(filePath, required = true) {
  if (!fs.existsSync(filePath)) {
    if (required) throw new Error(`Missing configuration file: ${filePath}`);
    return {};
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function merge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return override ?? base;
  if (base && override && typeof base === "object" && typeof override === "object") {
    const result = { ...base };
    for (const [key, value] of Object.entries(override)) {
      result[key] = key in result ? merge(result[key], value) : value;
    }
    return result;
  }
  return override ?? base;
}

export function expandEnvironment(value) {
  if (typeof value !== "string") return value;
  const expanded = value.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`);
  if (expanded === "~") return process.env.USERPROFILE ?? expanded;
  if (expanded.startsWith(`~${path.sep}`) || expanded.startsWith("~/")) {
    return path.join(process.env.USERPROFILE ?? "~", expanded.slice(2));
  }
  return expanded;
}

function normalizePath(value) {
  return resolveProjectPath(expandEnvironment(value));
}

export function resolveCliPath(value, searchPath = process.env.PATH ?? "") {
  const command = expandEnvironment(value);
  if (!command) return "";
  if (path.isAbsolute(command) || /[/\\]/.test(command)) return normalizePath(command);
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory.replace(/^"|"$/g, ""), command);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.resolve(candidate);
  }
  return command;
}

export function loadConfig() {
  const basePath = path.join(PROJECT_ROOT, "config", "agent.json");
  const localPath = path.join(PROJECT_ROOT, "config", "agent.local.json");
  const policyPath = path.join(PROJECT_ROOT, "config", "policy.json");
  const config = merge(readJson(basePath), readJson(localPath, false));

  if (process.env.SHADOW_AGENT_DATABASE) config.paths.database = process.env.SHADOW_AGENT_DATABASE;

  config.projectRoot = PROJECT_ROOT;
  config.paths.codexHome = normalizePath(config.paths.codexHome);
  config.paths.database = normalizePath(config.paths.database);
  config.paths.knowledgeRoot = normalizePath(config.paths.knowledgeRoot);
  config.paths.reportRoot = normalizePath(config.paths.reportRoot);
  config.paths.inboxRoots = config.paths.inboxRoots.map(normalizePath);
  config.contextGraph.ontologyFiles = (config.contextGraph.ontologyFiles ?? []).map(normalizePath);
  config.codex.workingDirectory = normalizePath(config.codex.workingDirectory);
  if (config.feishu) config.feishu.cliPath = resolveCliPath(config.feishu.cliPath);
  config.codex.titleMaintenance ??= {};
  config.codex.titleMaintenance.agentCwdRoots = (config.codex.titleMaintenance.agentCwdRoots ?? [])
    .map(normalizePath);
  config.policy = readJson(policyPath);
  config.policy.blockedPaths = config.policy.blockedPaths.map((item) =>
    path.normalize(expandEnvironment(item)),
  );
  return config;
}
