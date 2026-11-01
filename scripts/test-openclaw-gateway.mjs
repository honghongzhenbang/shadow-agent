import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadOpenClawGatewaySettings,
  OpenClawGatewayClient,
  workboardCardsFromToolResult,
} from "../src/openclaw/gateway-client.mjs";
import { runOpenClawTurn } from "../src/openclaw/cli.mjs";
import { inspectRuntimeProfile } from "../src/openclaw/runtime-profile.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const evidenceDirectory = path.join(
  projectRoot,
  "runtime",
  "openclaw-poc",
  "evidence",
  `gateway-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}`,
);
fs.mkdirSync(evidenceDirectory, { recursive: true });

const client = new OpenClawGatewayClient(loadOpenClawGatewaySettings(projectRoot));
const observedEvents = [];
client.on("event", (frame) => observedEvents.push({ event: frame.event, at: new Date().toISOString() }));

const writeEvidence = (name, value) => {
  fs.writeFileSync(path.join(evidenceDirectory, name), JSON.stringify(value, null, 2), "utf8");
};

const requiredTools = [
  "shadow_attention_packet",
  "shadow_context_status",
  "shadow_context_focus",
  "shadow_context_focus_update",
  "shadow_context_changes",
  "shadow_context_ack",
  "shadow_context_resolve",
  "shadow_context_query",
  "shadow_context_entity",
  "shadow_context_impact",
  "shadow_context_capture",
  "shadow_context_enrichment",
  "shadow_context_annotate",
  "shadow_context_vocabulary",
  "shadow_context_propose",
  "codex_endpoint_probe",
  "codex_sessions_list",
  "codex_session_read",
  "sessions_spawn",
  "sessions_history",
  "sessions_send",
  "sessions_yield",
  "subagents",
  "workboard_list",
];
const legacyTools = ["shadow_work_status", "shadow_work_search", "shadow_work_task"];

try {
  const startedAt = performance.now();
  const status = await client.connect();
  const connectedAt = performance.now();

  const catalog = await client.request("tools.catalog", { agentId: "main" });
  const catalogAt = performance.now();
  const catalogText = JSON.stringify(catalog);
  for (const toolName of requiredTools) {
    if (!catalogText.includes(toolName)) throw new Error(`Gateway tool catalog is missing ${toolName}`);
  }
  for (const toolName of legacyTools) {
    if (catalogText.includes(toolName)) throw new Error(`Legacy tool must not be advertised: ${toolName}`);
  }
  writeEvidence("tools-catalog.json", catalog);

  const runtimeConfig = JSON.parse(fs.readFileSync(
    path.join(projectRoot, "runtime", "openclaw-poc", "state", "openclaw.json"),
    "utf8",
  ));
  const codexConfig = runtimeConfig.plugins?.entries?.codex?.config ?? {};
  const supervisorConfig = codexConfig.supervision ?? {};
  const codexRuntimeConfig = codexConfig.appServer ?? {};
  const configuredSelection = inspectRuntimeProfile(runtimeConfig).configuredSelection;
  if (supervisorConfig.allowWriteControls !== false) {
    throw new Error("Codex Supervisor write controls must remain disabled for user-owned sessions");
  }
  if (codexRuntimeConfig.homeScope !== "agent"
    || codexRuntimeConfig.sandbox !== "danger-full-access"
    || !configuredSelection.codingWorker.runtime) {
    throw new Error("Agent-managed Codex must use the isolated Agent home and fail-closed native runtime");
  }
  const codexSupervisorStartedAt = performance.now();
  const ownerlessCodexProbe = await client.invokeTool("codex_endpoint_probe");
  if (ownerlessCodexProbe?.ok !== false || ownerlessCodexProbe?.error?.code !== "not_found") {
    throw new Error("Owner-only Codex Supervisor tools must reject generic Gateway tool invocation");
  }
  writeEvidence("codex-supervisor-ownerless-rejection.json", ownerlessCodexProbe);

  const codexSupervisorTurn = await runOpenClawTurn(projectRoot, {
    sessionKey: `agent:main:shadow:gateway-codex-owner-smoke-${Date.now()}`,
    message: [
      "执行一次只读 Codex Supervisor 集成检查。",
      "依次且各调用一次 codex_endpoint_probe、codex_sessions_list、codex_session_read，不得调用其他工具。",
      "codex_sessions_list 需要包含已存储会话并最多读取 20 条；选择其中第一个有 threadId 的会话，用 include_turns=false 调用 codex_session_read。",
      "三个工具都成功且 endpoint 全部健康时，只回复 CODEX_SUPERVISOR_READY；否则只回复 CODEX_SUPERVISOR_FAILED。",
    ].join("\n"),
    runTimeoutSeconds: 600,
    waitSliceSeconds: 60,
    thinking: "low",
    triggerKind: "integration_smoke",
    budgets: { historyMessageLimit: 40 },
  });
  const expectedCodexTools = ["codex_endpoint_probe", "codex_sessions_list", "codex_session_read"];
  const codexToolNames = Object.keys(codexSupervisorTurn.metrics.toolNames);
  const codexToolContractReady = codexSupervisorTurn.text.trim() === "CODEX_SUPERVISOR_READY"
    && expectedCodexTools.every((name) => codexSupervisorTurn.metrics.toolNames[name] === 1)
    && codexToolNames.every((name) => expectedCodexTools.includes(name));
  if (!codexToolContractReady) {
    throw new Error(`Codex Supervisor owner turn failed: ${codexSupervisorTurn.text}`);
  }
  const codexSupervisorAt = performance.now();
  writeEvidence("codex-supervisor-owner-turn.json", codexSupervisorTurn);

  const shadowStatus = await client.invokeTool("shadow_context_status");
  const statusAt = performance.now();
  if (!shadowStatus?.ok
    || shadowStatus?.output?.details?.runtime?.["controller:mode"] !== "openclaw-single-controller") {
    throw new Error("shadow_context_status returned an invalid controller contract");
  }
  writeEvidence("shadow-context-status.json", shadowStatus);

  const shadowFocus = await client.invokeTool("shadow_context_focus", { limit: 5 });
  const focusAt = performance.now();
  if (!shadowFocus?.ok
    || !shadowFocus?.output?.details?.profile
    || !shadowFocus?.output?.details?.radar?.available) {
    throw new Error("shadow_context_focus returned an invalid work radar");
  }
  writeEvidence("shadow-context-focus.json", shadowFocus);

  const contextQueryStartedAt = performance.now();
  const contextQuery = await client.request("tools.invoke", {
    name: "shadow_context_query",
    agentId: "main",
    args: { query: "\u901a\u4fe1\u534f\u8bae", limit: 3, maxBytes: 8192 },
  }, 30_000);
  const contextQueryAt = performance.now();
  const contextQueryMs = Math.round(contextQueryAt - contextQueryStartedAt);
  const contextQueryModelBytes = Buffer.byteLength(
    (contextQuery?.output?.content ?? []).map((item) => item.text ?? "").join(""),
    "utf8",
  );
  if (!contextQuery?.ok) throw new Error("shadow_context_query failed");
  if (contextQueryModelBytes > 8192) {
    throw new Error(`Context query rendered payload exceeded 8192 bytes: ${contextQueryModelBytes}`);
  }
  if (contextQueryMs > 10_000) {
    throw new Error(`Context query exceeded the 10 second integration budget: ${contextQueryMs} ms`);
  }
  writeEvidence("shadow-context-query.json", contextQuery);

  const routeStartedAt = performance.now();
  const cognitiveRoute = await client.request("tools.invoke", {
    name: "shadow_context_resolve",
    agentId: "main",
    args: {
      query: `deliberately unknown V4 runtime route probe ${Date.now()}`,
      sessionKey: `agent:main:shadow:v4-route-smoke-${Date.now()}`,
      maxBytes: 8192,
    },
  }, 30_000);
  const routeAt = performance.now();
  const cognitiveRouteMs = Math.round(routeAt - routeStartedAt);
  const routeDetails = cognitiveRoute?.output?.details;
  const cognitiveRouteModelBytes = Buffer.byteLength(
    (cognitiveRoute?.output?.content ?? []).map((item) => item.text ?? "").join(""),
    "utf8",
  );
  if (!cognitiveRoute?.ok
    || routeDetails?.outcome !== "unresolved_with_next_step"
    || routeDetails?.nonBlockingFallback?.action !== "update_workboard_and_continue"
    || routeDetails?.policy?.externalMessageMode !== "authorization_required") {
    throw new Error("shadow_context_resolve did not preserve the non-blocking unknown contract");
  }
  if (cognitiveRouteMs > 10_000) {
    throw new Error(`Cognitive routing exceeded the 10 second integration budget: ${cognitiveRouteMs} ms`);
  }
  if (cognitiveRouteModelBytes > 8192) {
    throw new Error(`Cognitive routing rendered payload exceeded 8192 bytes: ${cognitiveRouteModelBytes}`);
  }
  writeEvidence("shadow-context-resolve-unknown.json", cognitiveRoute);

  const reminders = await client.invokeTool("shadow_reminder_list", { limit: 5 });
  const conditions = await client.invokeTool("shadow_condition_list", { limit: 5 });
  const runtimeToolsAt = performance.now();
  const workboard = await client.invokeTool("workboard_list", { limit: 50, includeArchived: false });
  const completedAt = performance.now();
  const workboardCards = workboardCardsFromToolResult(workboard);
  const workboardStatusCounts = Object.fromEntries(
    Object.entries(Object.groupBy(workboardCards, (card) => card.status ?? "unknown"))
      .map(([statusName, cards]) => [statusName, cards.length]),
  );

  const summary = {
    passed: true,
    connectedMs: Math.round(connectedAt - startedAt),
    catalogMs: Math.round(catalogAt - connectedAt),
    codexSupervisorMs: Math.round(codexSupervisorAt - codexSupervisorStartedAt),
    shadowStatusMs: Math.round(statusAt - codexSupervisorAt),
    focusMs: Math.round(focusAt - statusAt),
    contextQueryMs,
    contextQueryBytes: Buffer.byteLength(JSON.stringify(contextQuery), "utf8"),
    contextQueryModelBytes,
    cognitiveRouteMs,
    cognitiveRouteModelBytes,
    cognitiveRouteOutcome: routeDetails.outcome,
    cognitiveRouteFirstStep: routeDetails.steps?.[0]?.action ?? null,
    cognitiveRouteFallback: routeDetails.nonBlockingFallback.action,
    externalMessageMode: routeDetails.policy.externalMessageMode,
    codexSupervisorReady: codexToolContractReady,
    codexSupervisorOwnerlessRejected: ownerlessCodexProbe.error.code === "not_found",
    codexSupervisorToolNames: codexSupervisorTurn.metrics.toolNames,
    codexSupervisorTurnMs: codexSupervisorTurn.metrics.durationMs,
    codexSupervisorWriteControls: supervisorConfig.allowWriteControls,
    codexIsolatedAgentHome: codexRuntimeConfig.homeScope === "agent",
    codexSystemAccess: codexRuntimeConfig.sandbox === "danger-full-access",
    configuredSelection,
    codexRuntimeForced: configuredSelection.codingWorker.runtime === "codex",
    runtimeToolsMs: Math.round(runtimeToolsAt - routeAt),
    workboardMs: Math.round(completedAt - runtimeToolsAt),
    gateway: status,
    evidenceCount: shadowStatus?.output?.details?.evidenceCount ?? null,
    graphEntityCount: shadowStatus?.output?.details?.entityCount ?? null,
    pendingChangeCount: shadowStatus?.output?.details?.pendingChangeCount ?? null,
    focusProfileRevision: shadowFocus?.output?.details?.profile?.sourceRevision ?? null,
    focusRadarCount: shadowFocus?.output?.details?.radar?.cards?.length ?? null,
    reminderToolReady: reminders?.ok === true,
    conditionToolReady: conditions?.ok === true,
    workboardCardCount: workboardCards.length,
    workboardStatusCounts,
    workboardSample: workboardCards.slice(0, 5).map((card) => ({
      id: card.id,
      title: card.title,
      status: card.status,
      priority: card.priority,
    })),
    advertisedEvents: client.features.events,
    observedEvents,
    evidenceDirectory,
  };

  writeEvidence("summary.json", summary);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  client.stop();
}
