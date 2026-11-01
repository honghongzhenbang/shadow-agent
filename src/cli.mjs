#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { collectAll } from "./collectors/index.mjs";
import { contextGraphStats, materializeContextGraph } from "./context-graph.mjs";
import { getFeishuHealth } from "./collectors/feishu.mjs";
import { loadConfig } from "./config.mjs";
import { runDaemon } from "./daemon.mjs";
import { openDatabase, openDatabaseReadOnly } from "./db.mjs";
import { writeKnowledgeIndexes } from "./knowledge.mjs";
import { powershellScriptCommand } from "./process.mjs";
import { ensureDirectory } from "./utils.mjs";
import { inspectRuntimeProfile } from "./openclaw/runtime-profile.mjs";
import { listSourceAdapters } from "./source-adapters/index.mjs";

function parseArguments(values) {
  const result = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      result._.push(value);
      continue;
    }
    const [rawKey, inlineValue] = value.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inlineValue !== undefined) result[key] = inlineValue;
    else if (values[index + 1] && !values[index + 1].startsWith("--")) result[key] = values[++index];
    else result[key] = true;
  }
  return result;
}

function numeric(value) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function commaList(value) {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function collectionOptions(args) {
  return {
    maxRollouts: numeric(args.maxRollouts),
    maxLinesPerRollout: numeric(args.maxLinesPerRollout),
    maxTotalRolloutLines: numeric(args.maxTotalRolloutLines),
    maxProjectFiles: numeric(args.maxProjectFiles),
    skipProjects: Boolean(args.skipProjects),
    localOnly: Boolean(args.localOnly),
  };
}

function initializeDirectories(config) {
  const directories = [
    path.dirname(config.paths.database),
    config.paths.knowledgeRoot,
    config.paths.reportRoot,
    ...config.paths.inboxRoots,
    path.join(config.paths.knowledgeRoot, "generated"),
  ];
  for (const directory of directories) ensureDirectory(directory);
}

async function codexStatus() {
  const codexPath = path.join(process.env.APPDATA ?? "", "npm", "codex.ps1");
  if (!fs.existsSync(codexPath)) return { ready: false, path: codexPath, error: "codex.ps1 not found" };
  try {
    const result = await powershellScriptCommand(codexPath, ["login", "status"], { timeoutMs: 30000, check: false });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    return { ready: /logged in/i.test(output), path: codexPath, output };
  } catch (error) {
    return { ready: false, path: codexPath, error: error.message };
  }
}

async function doctor(config) {
  initializeDirectories(config);
  const codex = await codexStatus();
  const feishu = await getFeishuHealth(config);
  const database = openDatabase(config.paths.database);
  const graph = contextGraphStats(database.db);
  database.close();
  const packageConfig = readJsonSafe(path.join(config.projectRoot, "package.json"));
  const openClawConfig = readJsonSafe(path.join(config.projectRoot, "runtime", "openclaw-poc", "state", "openclaw.json"));
  const pluginManifest = readJsonSafe(path.join(config.projectRoot, "openclaw", "shadow-work", "openclaw.plugin.json"));
  const runtimeProfile = inspectRuntimeProfile(openClawConfig, pluginManifest);
  const controller = {
    mode: graph.controllerMode,
    localPlannerRemoved: !packageConfig?.scripts?.patrol && !packageConfig?.scripts?.daemon,
    incrementalToolsReady: runtimeProfile.incrementalToolsReady,
    missingRequiredTools: runtimeProfile.missingRequiredTools,
    legacyToolsRemoved: runtimeProfile.legacyToolsRemoved,
    contextEngineReady: runtimeProfile.contextEngineReady,
  };
  const skills = inspectSkills([
    path.join(config.paths.codexHome, "skills"),
    path.join(process.env.USERPROFILE ?? "", ".agents", "skills"),
  ]);
  const report = {
    ok: codex.ready
      && fs.existsSync(config.paths.codexHome)
      && graph.version === "epistemic-context-v4"
      && controller.localPlannerRemoved
      && controller.incrementalToolsReady
      && controller.legacyToolsRemoved
      && controller.contextEngineReady,
    node: { version: process.version, supported: Number(process.versions.node.split(".")[0]) >= 22 },
    codex,
    feishu: {
      enabled: feishu.enabled,
      userReady: feishu.userReady,
      botReady: feishu.botReady,
      error: feishu.error,
      note: feishu.userReady ? "User identity ready" : "Local collection works; Feishu user data waits for user authorization",
    },
    graph,
    controller,
    skills,
    paths: {
      projectRoot: config.projectRoot,
      codexHome: config.paths.codexHome,
      database: config.paths.database,
      knowledgeRoot: config.paths.knowledgeRoot,
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
  return report;
}

function readJsonSafe(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
}

function inspectSkills(roots) {
  const invalid = [];
  let total = 0;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const skillPath = path.join(root, entry.name, "SKILL.md");
      if (!fs.existsSync(skillPath)) continue;
      total += 1;
      const text = fs.readFileSync(skillPath, "utf8").replace(/^\uFEFF/, "");
      if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
        invalid.push({ name: entry.name, path: skillPath, error: "missing YAML frontmatter" });
      }
    }
  }
  return { total, valid: total - invalid.length, invalid };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const command = args._[0] ?? "status";
  const config = loadConfig();
  initializeDirectories(config);

  if (command === "doctor") {
    await doctor(config);
    return;
  }

  const readOnlyCommand = ["status", "search", "source-adapters"].includes(command);
  const store = readOnlyCommand
    ? openDatabaseReadOnly(config.paths.database)
    : openDatabase(config.paths.database);
  let keepOpen = false;
  try {
    if (command === "init") {
      const graph = materializeContextGraph(store, config, { emitChanges: false });
      writeKnowledgeIndexes(store, config);
      process.stdout.write(`${JSON.stringify({ initialized: true, database: config.paths.database, graph, stats: store.stats() }, null, 2)}\n`);
      return;
    }
    if (command === "collect") {
      const result = await collectAll(store, config, collectionOptions(args));
      writeKnowledgeIndexes(store, config);
      process.stdout.write(`${JSON.stringify({ result, stats: store.stats() }, null, 2)}\n`);
      return;
    }
    if (command === "serve") {
      keepOpen = true;
      await runDaemon(store, config);
      return;
    }
    if (command === "status") {
      process.stdout.write(`${JSON.stringify({
        stats: store.stats(),
        sources: store.sourceStatuses(),
        sourceAdapters: listSourceAdapters(),
      }, null, 2)}\n`);
      return;
    }
    if (command === "source-adapters") {
      process.stdout.write(`${JSON.stringify({ sourceAdapters: listSourceAdapters() }, null, 2)}\n`);
      return;
    }
    if (command === "source-events") {
      const result = store.querySourceRecords({
        providers: commaList(args.providers ?? args.provider),
        sourceFamilies: commaList(args.sourceFamilies ?? args.sourceFamily),
        eventKinds: commaList(args.eventKinds ?? args.eventKind),
        streamId: args.streamId,
        limit: numeric(args.limit) ?? 20,
      });
      process.stdout.write(`${JSON.stringify({ result }, null, 2)}\n`);
      return;
    }
    if (command === "search") {
      const query = args._.slice(1).join(" ");
      process.stdout.write(`${JSON.stringify(store.searchEvidence(query, numeric(args.limit) ?? 50), null, 2)}\n`);
      return;
    }
    if (command === "optimize") {
      const result = store.optimizeStorage({
        maxTraceChars: config.collection.maxRawTraceChars,
        vacuum: Boolean(args.vacuum),
      });
      process.stdout.write(`${JSON.stringify({ result, stats: store.stats() }, null, 2)}\n`);
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  } finally {
    if (!keepOpen) store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
