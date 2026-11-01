import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runOpenClawTurn } from "../src/openclaw/cli.mjs";
import { loadOpenClawGatewaySettings, OpenClawGatewayClient } from "../src/openclaw/gateway-client.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-access-smoke-"));
const nonce = randomUUID();
fs.writeFileSync(path.join(directory, "challenge.txt"), nonce, "utf8");
const probePath = path.join(directory, "record-proof.cjs");
fs.writeFileSync(probePath, `const fs = require('node:fs');
const path = require('node:path');
const role = process.argv[2];
if (!['parent', 'child'].includes(role)) throw new Error('Invalid probe role');
const proof = { role, nonce: fs.readFileSync(path.join(__dirname, 'challenge.txt'), 'utf8'),
  processId: process.pid, runtime: process.version, files: fs.readdirSync(__dirname) };
fs.writeFileSync(path.join(__dirname, role + '-proof.json'), JSON.stringify(proof), 'utf8');
console.log(JSON.stringify(proof));
`, "utf8");
const evidence = path.join(root, "runtime", "openclaw-poc", "evidence", `system-access-${Date.now()}`);
fs.mkdirSync(evidence, { recursive: true });
const save = (name, value) => fs.writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2), "utf8");
const sessionKey = `agent:main:shadow:access-smoke:${randomUUID()}`;
const client = new OpenClawGatewayClient({ ...loadOpenClawGatewaySettings(root), scopes: ["operator.read", "operator.write", "operator.admin"] });
const operation = (role) => [
  `Execute the existing test probe using a local command tool: executable ${JSON.stringify(process.execPath)}, arguments ${JSON.stringify([probePath, role])}.`,
  `It lists ${JSON.stringify(directory)}, reads challenge.txt, and writes ${role}-proof.json there. It prints only a compact proof. Do not modify the probe or implement a substitute.`,
  "This is the only directory you may write. Do not use tool-only read/write as a workaround: command execution is part of this test. Do not invent evidence.",
].join("\n");
save("request.json", { sessionKey, directory, startedAt: new Date().toISOString() });
console.log(JSON.stringify({ evidence, directory, sessionKey }));
try {
  const parent = await runOpenClawTurn(root, {
    sessionKey,
    message: [
      "Isolated local permission smoke, not business work. No Workboard, knowledge, external messages, credential access, scheduling, or configuration changes.",
      operation("parent"),
      `Then call sessions_spawn exactly once with runtime=subagent, mode=run, visible=true, label=${JSON.stringify(`System access ${nonce.slice(0, 8)}`)}.`,
      `Give the child this complete bounded task (do not do its work yourself): ${operation("child")}`,
      "The child must not spawn or touch any business tools. After spawn returns, reply ONLY JSON with childSessionKey and runId from its actual response; do not wait or poll.",
    ].join("\n"),
    thinking: "low", runTimeoutSeconds: 600, waitSliceSeconds: 60,
    triggerKind: "integration_smoke", budgets: { historyMessageLimit: 60 },
  });
  save("parent.json", parent);
  const commandTools = new Set(["bash", "exec", "gateway_exec", "shell", "exec_command"]);
  assert.ok(parent.payload.terminal.terminalReceipt.successfulToolNames.some(name => commandTools.has(name)), "Parent did not execute a command");
  assert.equal(parent.metrics.toolNames.sessions_spawn, 1);
  const spawned = JSON.parse(parent.text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  assert.ok(spawned.childSessionKey?.startsWith("agent:main:"));
  assert.ok(spawned.runId);
  await client.connect();
  const deadline = Date.now() + 15 * 60_000;
  let terminal;
  while (Date.now() < deadline) {
    terminal = await client.request("agent.wait", { runId: spawned.runId, timeoutMs: 60_000 }, 70_000);
    save("child-wait.json", terminal);
    if (terminal.endedAt || terminal.status === "error") break;
  }
  assert.equal(terminal?.status, "ok", "Child has no confirmed successful terminal; retain evidence, do not resubmit");
  assert.ok(terminal.endedAt, "A wait window is not execution completion");
  const history = await client.request("chat.history", { sessionKey: spawned.childSessionKey, limit: 60, maxChars: 128_000 });
  save("child-history.json", history);
  assert.ok(history.messages.some(message => message.role === "toolResult"
    && !message.isError && commandTools.has(message.toolName)), "Child did not execute a command");
  save("child-tools.json", await client.request("tools.effective", { sessionKey: spawned.childSessionKey }));
  for (const role of ["parent", "child"]) {
    const proof = JSON.parse(fs.readFileSync(path.join(directory, `${role}-proof.json`), "utf8").replace(/^\uFEFF/, ""));
    assert.equal(proof.role, role);
    assert.equal(proof.nonce, nonce);
    assert.ok(Number(proof.processId) > 0);
    assert.ok(proof.runtime);
    assert.ok(proof.files.includes("challenge.txt"));
    save(`${role}-proof.json`, proof);
  }
  save("result.json", { passed: true, evidence, directory, sessionKey, ...spawned, completedAt: new Date().toISOString() });
  console.log(JSON.stringify({ passed: true, evidence, directory, ...spawned }));
} catch (error) {
  save("result.json", { passed: false, evidence, directory, sessionKey, error: error.message, code: error.code, runId: error.runId });
  throw error;
} finally {
  client.stop();
}
