import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadOpenClawGatewaySettings, OpenClawGatewayClient } from "../src/openclaw/gateway-client.mjs";
import { runOpenClawTurn } from "../src/openclaw/cli.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const personalHome = path.join(os.homedir(), ".codex");
const agentHome = path.join(projectRoot, "runtime", "openclaw-poc", "state", "agents", "main", "agent", "codex-home");

function countThreads(home) {
  const databasePath = path.join(home, "state_5.sqlite");
  if (!fs.existsSync(databasePath)) return 0;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Number(database.prepare("SELECT COUNT(*) AS count FROM threads").get()?.count ?? 0);
  } finally {
    database.close();
  }
}

const before = { personal: countThreads(personalHome), agent: countThreads(agentHome) };
const client = new OpenClawGatewayClient(loadOpenClawGatewaySettings(projectRoot));
let ownerlessRejected = false;
let turn;
try {
  await client.connect();
  const ownerless = await client.invokeTool("codex_endpoint_probe");
  ownerlessRejected = ownerless?.ok === false && ownerless?.error?.code === "not_found";
  turn = await runOpenClawTurn(projectRoot, {
    sessionKey: `agent:main:shadow:codex-isolation-smoke-${Date.now()}`,
    message: [
      "执行一次只读 Codex Supervisor 隔离检查。",
      "依次且各调用一次 codex_endpoint_probe、codex_sessions_list、codex_session_read，不得调用其他工具。",
      "codex_sessions_list 最多读取 5 条；选择第一个含 threadId 的会话，用 include_turns=false 调用 codex_session_read。",
      "全部成功时只回复 CODEX_ISOLATION_READY，否则只回复 CODEX_ISOLATION_FAILED。",
    ].join("\n"),
    runTimeoutSeconds: 600,
    waitSliceSeconds: 60,
    thinking: "low",
    triggerKind: "integration_smoke",
    budgets: { historyMessageLimit: 20 },
  });
} finally {
  client.stop();
}

const after = { personal: countThreads(personalHome), agent: countThreads(agentHome) };
const expectedTools = ["codex_endpoint_probe", "codex_sessions_list", "codex_session_read"];
const actualTools = Object.keys(turn?.metrics?.toolNames ?? {});
const toolsReady = expectedTools.every((name) => turn?.metrics?.toolNames?.[name] === 1)
  && actualTools.every((name) => expectedTools.includes(name));
const result = {
  ready: ownerlessRejected
    && turn?.text?.trim() === "CODEX_ISOLATION_READY"
    && toolsReady
    && before.personal === after.personal
    && after.agent > before.agent,
  ownerlessRejected,
  supervisorReply: turn?.text?.trim() ?? null,
  tools: turn?.metrics?.toolNames ?? {},
  threads: { before, after },
  model: turn?.metrics?.model ?? null,
  durationMs: turn?.metrics?.durationMs ?? null,
  usage: turn?.metrics?.usage ?? null,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ready) process.exitCode = 1;
