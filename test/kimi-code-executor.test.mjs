import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  doctorKimiExecutor,
  loadKimiExecutorConfig,
  queueKimiTurn,
  stopKimiTurn,
  taskStatus,
} from "../src/execution-providers/kimi-code.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerPath = path.join(rootDir, "scripts", "kimi-code-executor.mjs");
const fakeCli = path.join(rootDir, "test", "fixtures", "fake-kimi-code.mjs");

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `${result.stderr || result.stdout}`);
  return result;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-kimi-executor-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    executable: process.execPath,
    prefixArgs: [fakeCli],
    kimiCodeHome: path.join(root, "kimi-home"),
    stateDir: path.join(root, "state"),
    defaultTimeoutSeconds: 10,
    maxLogBytes: 1024 * 1024,
  }));
  return { root, workspace, configPath, config: loadKimiExecutorConfig(configPath) };
}

async function terminal(config, task, waitMs = 10000) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const status = taskStatus(config, task);
    if (!["starting", "running", "stopping"].includes(status.status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${task}`);
}

test("copied example config resolves relative paths from the private config directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-kimi-config-"));
  try {
    const privateDir = path.join(root, "runtime", "openclaw-poc");
    fs.mkdirSync(privateDir, { recursive: true });
    const privateConfig = path.join(privateDir, "kimi-code-executor.private.json");
    fs.copyFileSync(path.join(rootDir, "config", "kimi-code-executor.example.json"), privateConfig);

    const config = loadKimiExecutorConfig(privateConfig);
    assert.equal(config.executable, path.join(root, "tools", "node-v24.19.0-win-x64", "node.exe"));
    assert.equal(config.kimiCodeHome, path.join(privateDir, "state", "kimi-code-home"));
    assert.equal(config.stateDir, path.join(privateDir, "state", "kimi-code-executor"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Kimi executor binds and resumes the same native session", async () => {
  const state = fixture();
  try {
    const doctor = doctorKimiExecutor(state.config);
    assert.equal(doctor.version, "2.2.0-fake");
    assert.equal(doctor.doctorExitCode, 0);
    const firstPrompt = path.join(state.root, "first.txt");
    fs.writeFileSync(firstPrompt, "FIRST");
    queueKimiTurn(state.config, {
      task: "task-resume",
      workspace: state.workspace,
      promptFile: firstPrompt,
      runnerPath,
    });
    const first = await terminal(state.config, "task-resume");
    assert.equal(first.status, "completed", JSON.stringify(first, null, 2));
    assert.match(first.nativeSessionId, /^session-/);
    const secondPrompt = path.join(state.root, "second.txt");
    fs.writeFileSync(secondPrompt, "SECOND");
    queueKimiTurn(state.config, {
      task: "task-resume",
      workspace: state.workspace,
      promptFile: secondPrompt,
      runnerPath,
      resume: true,
    });
    const second = await terminal(state.config, "task-resume");
    assert.equal(second.status, "completed");
    assert.equal(second.nativeSessionId, first.nativeSessionId);
    assert.equal(second.turnNumber, 2);
    assert.match(fs.readFileSync(path.join(state.workspace, "fake-result.txt"), "utf8"), /start:FIRST\nresume:SECOND/);
  } finally {
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test("Kimi executor reports staged, unstaged, and untracked artifact names without file content", async () => {
  const state = fixture();
  try {
    git(state.workspace, ["init", "--quiet"]);
    fs.writeFileSync(path.join(state.workspace, "tracked.txt"), "tracked baseline\n");
    fs.writeFileSync(path.join(state.workspace, "staged-only.txt"), "staged secret body\n");
    git(state.workspace, ["add", "tracked.txt", "staged-only.txt"]);
    fs.appendFileSync(path.join(state.workspace, "tracked.txt"), "unstaged secret body\n");
    fs.writeFileSync(path.join(state.workspace, "untracked.txt"), "untracked secret body\n");

    const prompt = path.join(state.root, "artifacts.txt");
    fs.writeFileSync(prompt, "ARTIFACTS");
    queueKimiTurn(state.config, {
      task: "task-artifacts",
      workspace: state.workspace,
      promptFile: prompt,
      runnerPath,
    });
    const completed = await terminal(state.config, "task-artifacts");
    assert.equal(completed.status, "completed", JSON.stringify(completed, null, 2));
    assert.deepEqual(completed.artifacts.changedFiles, [
      "fake-result.txt",
      "staged-only.txt",
      "tracked.txt",
      "untracked.txt",
    ]);
    assert.doesNotMatch(JSON.stringify(completed.artifacts), /secret body/);
  } finally {
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test("Kimi executor preserves failures and enforces timeout", async () => {
  const state = fixture();
  try {
    const failedPrompt = path.join(state.root, "failed.txt");
    fs.writeFileSync(failedPrompt, "FAIL");
    queueKimiTurn(state.config, {
      task: "task-failure",
      workspace: state.workspace,
      promptFile: failedPrompt,
      runnerPath,
    });
    const failed = await terminal(state.config, "task-failure");
    assert.equal(failed.status, "failed");
    assert.equal(failed.exitCode, 7);
    assert.match(failed.stderrTail, /controlled failure/);

    const timeoutPrompt = path.join(state.root, "timeout.txt");
    fs.writeFileSync(timeoutPrompt, "TIMEOUT");
    queueKimiTurn(state.config, {
      task: "task-timeout",
      workspace: state.workspace,
      promptFile: timeoutPrompt,
      timeoutSeconds: 1,
      runnerPath,
    });
    const timedOut = await terminal(state.config, "task-timeout");
    assert.equal(timedOut.status, "timed_out");
    assert.equal(timedOut.exitCode, 124);
    assert.equal(timedOut.timedOut, true);
  } finally {
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test("Kimi executor stop cancels an active turn without deleting its task state", async () => {
  const state = fixture();
  try {
    const prompt = path.join(state.root, "stop.txt");
    fs.writeFileSync(prompt, "TIMEOUT");
    queueKimiTurn(state.config, {
      task: "task-stop",
      workspace: state.workspace,
      promptFile: prompt,
      timeoutSeconds: 10,
      runnerPath,
    });
    const deadline = Date.now() + 3000;
    while (taskStatus(state.config, "task-stop").status !== "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const stopping = stopKimiTurn(state.config, "task-stop");
    assert.equal(stopping.status, "cancelled");
    const cancelled = await terminal(state.config, "task-stop");
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.task, "task-stop");
  } finally {
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});
