import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { PROJECT_ROOT, resolveProjectPath } from "../paths.mjs";

export const DEFAULT_KIMI_EXECUTOR_CONFIG = path.join(PROJECT_ROOT, "runtime", "openclaw-poc", "kimi-code-executor.private.json");

function required(value, name) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${name} is required.`);
  return result;
}

function absolute(value, name, base = PROJECT_ROOT) {
  const input = required(value, name);
  return path.isAbsolute(input) ? path.normalize(input) : path.resolve(base, input);
}

function taskKey(value) {
  const input = required(value, "task");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input)) {
    throw new Error("task must contain only letters, digits, dot, underscore, or hyphen (max 128 characters).");
  }
  return input;
}

function atomicJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export function loadKimiExecutorConfig(configPath = process.env.SHADOW_KIMI_EXECUTOR_CONFIG || DEFAULT_KIMI_EXECUTOR_CONFIG) {
  const resolvedConfig = absolute(configPath, "config path");
  const raw = readJson(resolvedConfig);
  if (!raw) throw new Error(`Kimi executor config not found: ${resolvedConfig}`);
  const configBase = path.dirname(resolvedConfig);
  const executable = absolute(raw.executable, "executable", configBase);
  const config = {
    configPath: resolvedConfig,
    enabled: raw.enabled === true,
    executable,
    prefixArgs: Array.isArray(raw.prefixArgs) ? raw.prefixArgs.map(String) : [],
    kimiCodeHome: absolute(raw.kimiCodeHome, "kimiCodeHome", configBase),
    stateDir: absolute(raw.stateDir, "stateDir", configBase),
    shellPath: raw.shellPath ? absolute(raw.shellPath, "shellPath", configBase) : null,
    defaultTimeoutSeconds: Number(raw.defaultTimeoutSeconds ?? 1800),
    maxLogBytes: Number(raw.maxLogBytes ?? 16 * 1024 * 1024),
  };
  if (!Number.isInteger(config.defaultTimeoutSeconds) || config.defaultTimeoutSeconds < 1) {
    throw new Error("defaultTimeoutSeconds must be a positive integer.");
  }
  if (!Number.isInteger(config.maxLogBytes) || config.maxLogBytes < 1024) {
    throw new Error("maxLogBytes must be an integer of at least 1024.");
  }
  return config;
}

export function kimiEnvironment(config) {
  return {
    ...process.env,
    KIMI_CODE_HOME: config.kimiCodeHome,
    ...(config.shellPath ? { KIMI_SHELL_PATH: config.shellPath } : {}),
  };
}

export function taskPaths(config, task) {
  const root = path.join(config.stateDir, "tasks", taskKey(task));
  return {
    root,
    manifest: path.join(root, "manifest.json"),
    request: path.join(root, "pending-turn.json"),
    stdout: path.join(root, "events.jsonl"),
    stderr: path.join(root, "stderr.log"),
    artifacts: path.join(root, "artifacts.json"),
  };
}

export function readTaskManifest(config, task) {
  return readJson(taskPaths(config, task).manifest);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function terminateProcessTree(pid) {
  if (!Number.isInteger(pid) || pid < 1 || !processAlive(pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 15000,
    });
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch {}
}

export function taskStatus(config, task, { tailBytes = 8192 } = {}) {
  const files = taskPaths(config, task);
  const manifest = readJson(files.manifest);
  if (!manifest) return { task: taskKey(task), status: "not_found" };
  const tail = (filePath) => {
    try {
      const data = fs.readFileSync(filePath);
      return data.subarray(Math.max(0, data.length - tailBytes)).toString("utf8");
    } catch (error) {
      if (error.code === "ENOENT") return "";
      throw error;
    }
  };
  return {
    ...manifest,
    workerAlive: processAlive(manifest.workerPid),
    stdoutTail: tail(files.stdout),
    stderrTail: tail(files.stderr),
    artifacts: readJson(files.artifacts),
  };
}

function spawnCli(config, args, options = {}) {
  return spawn(config.executable, [...config.prefixArgs, ...args], {
    cwd: options.cwd,
    env: kimiEnvironment(config),
    shell: false,
    windowsHide: true,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    detached: options.detached ?? false,
  });
}

function runCliSync(config, args, options = {}) {
  return spawnSync(config.executable, [...config.prefixArgs, ...args], {
    cwd: options.cwd,
    env: kimiEnvironment(config),
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30000,
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
  });
}

export function listNativeSessions(config, workspace) {
  const result = runCliSync(config, ["session", "list", "--cwd", workspace, "--json"]);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`kimi session list failed (${result.status}): ${String(result.stderr).trim()}`);
  const sessions = JSON.parse(result.stdout || "[]");
  if (!Array.isArray(sessions)) throw new Error("kimi session list --json did not return an array.");
  return sessions;
}

function nativeSessionId(item) {
  return item?.sessionId ?? item?.session_id ?? item?.id ?? null;
}

function sessionTimestamp(item) {
  return Date.parse(item?.updatedAt ?? item?.updated_at ?? item?.createdAt ?? item?.created_at ?? 0) || 0;
}

function discoverSession(config, workspace, previousIds, expectedId = null) {
  const sessions = listNativeSessions(config, workspace);
  if (expectedId) return sessions.some((item) => nativeSessionId(item) === expectedId) ? expectedId : null;
  const candidates = sessions
    .filter((item) => !previousIds.has(nativeSessionId(item)))
    .sort((left, right) => sessionTimestamp(right) - sessionTimestamp(left));
  return nativeSessionId(candidates[0]) ?? null;
}

function gitArtifacts(workspace) {
  const run = (args) => spawnSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true, timeout: 15000 });
  const status = run(["status", "--short"]);
  if (status.status !== 0) return { gitRepository: false };
  const stat = run(["diff", "--stat"]);
  const nameCommands = [
    ["diff", "--name-only"],
    ["diff", "--cached", "--name-only"],
    ["ls-files", "--others", "--exclude-standard"],
  ];
  const changedFiles = new Set();
  for (const args of nameCommands) {
    const result = run(args);
    if (result.status !== 0) continue;
    for (const file of String(result.stdout).split(/\r?\n/).filter(Boolean)) changedFiles.add(file);
  }
  return {
    gitRepository: true,
    statusShort: String(status.stdout).trim(),
    diffStat: String(stat.stdout).trim(),
    changedFiles: [...changedFiles].sort(),
  };
}

function appendBounded(filePath, chunk, maxBytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const current = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  if (current >= maxBytes) return;
  fs.appendFileSync(filePath, chunk.subarray(0, Math.max(0, maxBytes - current)));
}

export function queueKimiTurn(config, { task, workspace, promptFile, timeoutSeconds, resume = false, runnerPath }) {
  if (!config.enabled) throw new Error(`Kimi executor is disabled in ${config.configPath}`);
  const id = taskKey(task);
  const cwd = absolute(workspace, "workspace");
  if (!fs.statSync(cwd).isDirectory()) throw new Error(`workspace is not a directory: ${cwd}`);
  const promptPath = absolute(promptFile, "promptFile");
  const prompt = fs.readFileSync(promptPath, "utf8").trim();
  if (!prompt) throw new Error("promptFile is empty.");
  const files = taskPaths(config, id);
  const current = readJson(files.manifest);
  if (current && ["starting", "running", "stopping"].includes(current.status) && processAlive(current.workerPid)) {
    throw new Error(`Task ${id} already has an active Kimi turn.`);
  }
  if (resume && !current?.nativeSessionId) throw new Error(`Task ${id} has no Kimi native session to resume.`);
  if (!resume && current?.nativeSessionId) throw new Error(`Task ${id} is already bound to ${current.nativeSessionId}; use resume.`);
  const turnId = randomUUID();
  fs.mkdirSync(files.root, { recursive: true });
  atomicJson(files.request, {
    task: id,
    turnId,
    workspace: cwd,
    prompt,
    timeoutSeconds: Number(timeoutSeconds ?? config.defaultTimeoutSeconds),
    resume,
    previousSessionId: current?.nativeSessionId ?? null,
  });
  const manifest = {
    schemaVersion: 1,
    provider: "kimi-code",
    task: id,
    turnId,
    turnNumber: Number(current?.turnNumber ?? 0) + 1,
    status: "starting",
    workspace: cwd,
    nativeSessionId: current?.nativeSessionId ?? null,
    workerPid: null,
    queuedAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    error: null,
    files: { stdout: files.stdout, stderr: files.stderr, artifacts: files.artifacts },
  };
  atomicJson(files.manifest, manifest);
  const worker = spawn(process.execPath, [absolute(runnerPath, "runnerPath"), "_run", "--config", config.configPath, "--task", id], {
    cwd: PROJECT_ROOT,
    env: process.env,
    shell: false,
    windowsHide: true,
    detached: true,
    stdio: "ignore",
  });
  worker.unref();
  const latest = readJson(files.manifest, manifest);
  const queued = { ...latest, workerPid: latest.workerPid ?? worker.pid };
  atomicJson(files.manifest, queued);
  return queued;
}

export async function runQueuedKimiTurn(config, task) {
  const files = taskPaths(config, task);
  const request = readJson(files.request);
  if (!request) throw new Error(`Pending turn not found for ${task}.`);
  fs.rmSync(files.request, { force: true });
  let manifest = readJson(files.manifest);
  manifest = { ...manifest, status: "running", workerPid: process.pid, startedAt: new Date().toISOString() };
  atomicJson(files.manifest, manifest);
  const previous = new Set(listNativeSessions(config, request.workspace).map(nativeSessionId).filter(Boolean));
  const args = [];
  if (request.resume) args.push("--session", request.previousSessionId);
  args.push("--prompt", request.prompt, "--output-format", "stream-json");
  const child = spawnCli(config, args, { cwd: request.workspace });
  manifest = { ...readJson(files.manifest), childPid: child.pid };
  atomicJson(files.manifest, manifest);
  let timedOut = false;
  let stopped = false;
  const stop = () => { stopped = true; terminateProcessTree(child.pid); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  child.stdout.on("data", (chunk) => appendBounded(files.stdout, chunk, config.maxLogBytes));
  child.stderr.on("data", (chunk) => appendBounded(files.stderr, chunk, config.maxLogBytes));
  const timer = setTimeout(() => { timedOut = true; terminateProcessTree(child.pid); }, request.timeoutSeconds * 1000);
  const result = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: -1, signal: null, error: error.message }));
    child.once("close", (code, signal) => resolve({ code: code ?? -1, signal, error: null }));
  });
  clearTimeout(timer);
  let sessionId = request.previousSessionId;
  let discoveryError = null;
  try { sessionId = discoverSession(config, request.workspace, previous, request.previousSessionId); } catch (error) { discoveryError = error.message; }
  const artifacts = { capturedAt: new Date().toISOString(), ...gitArtifacts(request.workspace) };
  atomicJson(files.artifacts, artifacts);
  const successful = result.code === 0 && Boolean(sessionId);
  manifest = {
    ...readJson(files.manifest),
    status: stopped ? "cancelled" : timedOut ? "timed_out" : successful ? "completed" : "failed",
    nativeSessionId: sessionId,
    endedAt: new Date().toISOString(),
    exitCode: timedOut ? 124 : result.code,
    signal: result.signal,
    timedOut,
    error: result.error ?? discoveryError ?? (!sessionId && result.code === 0 ? "Kimi completed without a discoverable native session ID." : null),
  };
  atomicJson(files.manifest, manifest);
  return manifest;
}

export function stopKimiTurn(config, task) {
  const files = taskPaths(config, task);
  const manifest = readJson(files.manifest);
  if (!manifest) throw new Error(`Task ${taskKey(task)} not found.`);
  if (!["starting", "running", "stopping"].includes(manifest.status)) return manifest;
  terminateProcessTree(manifest.childPid);
  terminateProcessTree(manifest.workerPid);
  const next = {
    ...manifest,
    status: "cancelled",
    stopRequestedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    signal: "SIGTERM",
  };
  atomicJson(files.manifest, next);
  return next;
}

export function doctorKimiExecutor(config) {
  const version = runCliSync(config, ["--version"]);
  const doctor = runCliSync(config, ["doctor"]);
  return {
    provider: "kimi-code",
    enabled: config.enabled,
    executable: config.executable,
    prefixArgs: config.prefixArgs,
    kimiCodeHome: config.kimiCodeHome,
    stateDir: config.stateDir,
    shellPath: config.shellPath,
    version: String(version.stdout).trim(),
    versionExitCode: version.status,
    doctorExitCode: doctor.status,
    doctorOutput: `${doctor.stdout ?? ""}${doctor.stderr ?? ""}`.trim(),
  };
}
