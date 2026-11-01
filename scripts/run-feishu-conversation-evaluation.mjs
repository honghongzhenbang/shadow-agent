import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { importCognitiveProfile, readCognitiveProfile } from "../src/cognitive-profile.mjs";
import { loadConfig } from "../src/config.mjs";
import { materializeContextGraph } from "../src/context-graph.mjs";
import { openDatabase } from "../src/db.mjs";
import {
  selectEvaluationConversations,
  splitConversationBatches,
} from "../src/feishu-conversation-evaluation.mjs";
import { validateEvaluationResponse } from "../src/feishu-evaluation-result.mjs";
import { assistantTextAfter } from "../src/openclaw/cli.mjs";
import { OpenClawGatewayClient } from "../src/openclaw/gateway-client.mjs";
import { ensureDirectory, parseJsonLoose, safeEvidenceText, sha256 } from "../src/utils.mjs";
import { routePendingContextChanges, stableWorkSessionKey } from "../src/work-sessions.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const portableNode = path.join(projectRoot, "tools", "node-v24.19.0-win-x64", "node.exe");
const openClawEntry = path.join(projectRoot, "tools", "openclaw-runtime", "node_modules", "openclaw", "openclaw.mjs");

function argumentsFrom(argv) {
  const result = {
    capture: path.join(projectRoot, "runtime", "evaluations", "feishu-conversations", "2026-08-28-capture.json"),
    conversations: 6,
    batchSize: 12,
    maxBatches: 2,
    timeoutSeconds: 240,
    onlyUnknown: false,
    review: null,
    strata: [],
    samplePerStratum: 1,
    maxEpisodes: 0,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--capture") result.capture = path.resolve(argv[++index]);
    else if (argument === "--conversations") result.conversations = Number(argv[++index]);
    else if (argument === "--batch-size") result.batchSize = Number(argv[++index]);
    else if (argument === "--max-batches") result.maxBatches = Number(argv[++index]);
    else if (argument === "--timeout-seconds") result.timeoutSeconds = Number(argv[++index]);
    else if (argument === "--only-unknown") result.onlyUnknown = true;
    else if (argument === "--review") result.review = path.resolve(argv[++index]);
    else if (argument === "--stratum") result.strata.push(String(argv[++index]));
    else if (argument === "--sample-per-stratum") result.samplePerStratum = Number(argv[++index]);
    else if (argument === "--max-episodes") result.maxEpisodes = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function writeJson(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function byteLength(value) {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

function modelTextBytes(result) {
  return byteLength((result?.output?.content ?? []).map((item) => item?.text ?? "").join(""));
}

function evaluationPrompt({ sessionKey, leaseOwner, batchIndex, batchCount, episode = null }) {
  return [
    "这是 Shadow Agent 的隔离只读评测，不是生产任务。",
    `本轮会话键：${sessionKey}`,
    `本轮租约所有者：${leaseOwner}`,
    episode
      ? `当前输入是一个真实飞书 Episode，类型=${episode.chatMode}，进入模式=${episode.ingressModes.join(",")}，批次=${batchIndex + 1}/${batchCount}。`
      : `当前是同一真实单聊的第 ${batchIndex + 1}/${batchCount} 个时间顺序批次。`,
    "先调用 shadow_attention_packet，参数必须使用上述 sessionKey、leaseOwner、limit=1。",
    "只在需要消除一个具体歧义时调用 shadow_context_query 或 shadow_context_entity，最多额外查询 3 次。",
    "不得创建或修改 Workboard 卡片、提醒、条件跟踪、外发草稿，不得发送消息，不得调用 Codex 子任务。",
    "判断业务相关性与用户结果责任要分开；姓名、同领域、项目候选和历史摘要都不能单独证明这是用户的任务。",
    "完成分析后用同一个 leaseOwner 调用 shadow_context_ack，disposition=processed。",
    "最后只输出一个 JSON 对象，字段为：ingressDecision、conversationAssessment、ownershipBasis、relationshipFactsUsed、verifiedFacts、activeUserActions、completedUserWork、waitingOnOthers、reply、continuation、knowledgeUpdates、uncertainties、nextLookup。",
    "ingressDecision 只能是 ignore、evidence_only、wake_existing、wake_new、review_reply；conversationAssessment 只能是 user_owned、user_involved、background、uncertain。",
    "relationshipFactsUsed、verifiedFacts、activeUserActions、completedUserWork、waitingOnOthers、knowledgeUpdates、uncertainties 必须始终为数组；activeUserActions 每项必须带 title、owner、evidence、confidence。",
    "reply 必须始终为 {needed:boolean,reason:string,draft:string}，draft 仅供审核且不得发送；continuation 必须始终为 {needed:boolean,kind:string,reason:string}，没有后续也不得简写为 false 或 null。",
  ].join("\n");
}

function buildIsolatedConfig({ runRoot, databasePath, port, token, workspacePath }) {
  const productionPath = path.join(projectRoot, "runtime", "openclaw-poc", "state", "openclaw.json");
  const config = JSON.parse(fs.readFileSync(productionPath, "utf8").replace(/^\uFEFF/, ""));
  config.gateway = {
    ...(config.gateway ?? {}),
    port,
    bind: "loopback",
    auth: { mode: "token", token },
  };
  config.agents.defaults.workspace = workspacePath;
  config.agents.defaults.thinkingDefault = "medium";
  config.agents.list = [{
    id: "main",
    default: true,
    tools: {
      profile: "minimal",
      alsoAllow: [
        "shadow_attention_packet",
        "shadow_conversation_window",
        "shadow_context_status",
        "shadow_context_changes",
        "shadow_context_ack",
        "shadow_context_query",
        "shadow_context_entity",
      ],
    },
  }];
  config.plugins = {
    allow: ["shadow-work", "codex"],
    load: { paths: [path.join(projectRoot, "openclaw", "shadow-work")] },
    entries: {
      "shadow-work": {
        enabled: true,
        config: {
          databasePath,
          workboardDatabasePath: path.join(runRoot, "no-production-workboard.sqlite"),
          maxContextBytes: 16_384,
        },
      },
      codex: config.plugins?.entries?.codex ?? { enabled: true },
      workboard: { enabled: false },
      "codex-supervisor": { enabled: false },
    },
  };
  delete config.hooks;
  delete config.channels;
  return config;
}

async function connectGateway(settings, processHandle, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error(`Isolated OpenClaw exited with ${processHandle.exitCode}.`);
    const client = new OpenClawGatewayClient({ ...settings, requestTimeoutMs: 30_000 });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      client.stop();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`Timed out waiting for isolated OpenClaw: ${lastError?.message ?? "unknown error"}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

const args = argumentsFrom(process.argv.slice(2));
const capture = args.review ? null : JSON.parse(fs.readFileSync(args.capture, "utf8").replace(/^\uFEFF/, ""));
const profilePath = path.join(projectRoot, "docs", "knowledge", "structured", "team-cognitive-profile.v1.json");
const { profile } = readCognitiveProfile(profilePath);
const personKeys = new Set(profile.entities.filter((entity) => entity.type === "Person").map((entity) => entity.canonicalKey));
const identityKeys = new Set(profile.relations
  .filter((relation) => relation.predicate === "IDENTIFIED_BY" && personKeys.has(relation.subject))
  .map((relation) => relation.object));
const knownPeople = [...new Set(profile.entities
  .filter((entity) => entity.type === "Person" || identityKeys.has(entity.canonicalKey))
  .flatMap((entity) => [entity.name, ...(entity.aliases ?? [])])
  .filter(Boolean))];
let selected;
if (args.review) {
  const review = JSON.parse(fs.readFileSync(args.review, "utf8").replace(/^\uFEFF/, ""));
  if (review.schema !== "shadow-agent/feishu-evaluation-review-queue/v2") {
    throw new Error(`Unsupported review schema: ${review.schema}`);
  }
  if (review.holdoutExcluded !== true || review.selected.some((item) => item.episode?.split === "holdout")) {
    throw new Error("The review queue must exclude holdout episodes.");
  }
  const perStratum = Math.max(1, Number(args.samplePerStratum || 1));
  const counts = new Map();
  const eligible = args.strata.length
    ? review.selected.filter((item) => args.strata.includes(item.stratum))
    : review.selected;
  const sampled = eligible.filter((item) => {
    const count = counts.get(item.stratum) ?? 0;
    if (count >= perStratum) return false;
    counts.set(item.stratum, count + 1);
    return true;
  });
  const bounded = args.maxEpisodes > 0 ? sampled.slice(0, args.maxEpisodes) : sampled;
  selected = bounded.map((item) => {
    const episode = item.episode;
    const selfCount = episode.messages.filter((message) => message.sentBySelf).length;
    return {
      stratum: item.stratum,
      episode,
      conversation: {
        conversationKey: episode.conversationKey,
        title: episode.title,
        chatMode: episode.chatMode,
        messages: episode.messages,
      },
      score: 0,
      selfCount,
      otherCount: episode.messages.length - selfCount,
      contentChars: episode.messages.reduce((sum, message) => sum + JSON.stringify(message.content ?? "").length, 0),
    };
  });
} else {
  const selectionPool = args.onlyUnknown
    ? capture.conversations.filter((conversation) => !knownPeople.includes(conversation.title))
    : capture.conversations;
  selected = selectEvaluationConversations(selectionPool, {
    knownPeople,
    limit: args.conversations,
  });
}
if (!selected.length) throw new Error("No sufficiently rich P2P conversations were captured.");

const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const runRoot = path.join(projectRoot, "runtime", "evaluations", args.review ? "feishu-dataset-v2" : "feishu-conversations", `run-${runId}`);
const databasePath = path.join(runRoot, "shadow-evaluation.sqlite");
const statePath = path.join(runRoot, "openclaw-state");
const workspacePath = path.join(runRoot, "workspace");
ensureDirectory(statePath);
ensureDirectory(workspacePath);

fs.writeFileSync(path.join(workspacePath, "AGENTS.md"), [
  "# Shadow Agent 隔离评测",
  "",
  "这是只读隔离环境。每轮先领取指定会话的注意力包，只分析该包和按需检索的局部知识图。",
  "不得创建或修改任务、提醒、跟踪、外发草稿，不得发送消息或启动 Codex 子任务。",
  "业务相关性不等于用户责任。只有明确指派、用户承诺、权威归属或既有任务延续才可判定 user_owned。",
  "输出必须遵循用户当轮要求的 JSON 结构。",
  "",
].join("\n"), "utf8");

const config = loadConfig();
config.paths.database = databasePath;
const store = openDatabase(databasePath);
const summary = {
  schema: args.review ? "shadow-agent/feishu-episode-isolated-evaluation/v2" : "shadow-agent/feishu-p2p-isolated-evaluation/v1",
  runId,
  capture: args.review ? null : path.relative(projectRoot, args.capture),
  review: args.review ? path.relative(projectRoot, args.review) : null,
  safety: {
    productionServicesStarted: false,
    productionDatabaseTouched: false,
    productionWorkboardTouched: false,
    outboundMessagesSent: false,
    remindersOrTasksCreated: false,
  },
  selection: selected.map((item) => ({
    episodeId: item.episode?.episodeId ?? null,
    stratum: item.stratum ?? null,
    conversationKey: item.conversation.conversationKey,
    knownProfilePerson: knownPeople.includes(item.conversation.title),
    messageCount: item.conversation.messages.length,
    score: item.score,
    selfCount: item.selfCount,
    otherCount: item.otherCount,
    contentChars: item.contentChars,
  })),
  timings: {},
  conversations: [],
};
let gatewayProcess = null;
let client = null;
try {
  let startedAt = performance.now();
  materializeContextGraph(store, config, { refreshStructural: false, runMaintenance: false });
  store.db.prepare(`UPDATE context_changes SET status='acknowledged', acknowledged_at=?, ack_note='isolated bootstrap' WHERE status='pending'`)
    .run(new Date().toISOString());
  summary.timings.databaseBootstrapMs = Math.round(performance.now() - startedAt);

  startedAt = performance.now();
  const imported = importCognitiveProfile(store, profile, {
    sourceLocator: profilePath,
    externalId: `isolated-profile:${profile.metadata?.sourceSha256 ?? sha256(profilePath)}`,
  });
  store.db.prepare(`UPDATE context_changes SET status='acknowledged', acknowledged_at=?, ack_note='isolated profile bootstrap' WHERE status='pending'`)
    .run(new Date().toISOString());
  summary.timings.profileImportMs = Math.round(performance.now() - startedAt);
  summary.profile = { entities: imported.entities, relations: imported.relations };

  const source = store.upsertSource({
    sourceKey: args.review ? "feishu:evaluation-episodes" : "feishu:evaluation-capture",
    kind: "feishu",
    uri: args.review ? "private-evaluation://feishu-episodes" : "private-evaluation://feishu-p2p",
    metadata: { private: true, isolated: true, input: path.basename(args.review ?? args.capture) },
  });

  const port = await findFreePort();
  const token = crypto.randomBytes(32).toString("hex");
  const isolatedConfig = buildIsolatedConfig({ runRoot, databasePath, port, token, workspacePath });
  const configPath = path.join(statePath, "openclaw.json");
  writeJson(configPath, isolatedConfig);
  const runtimeEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: statePath,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_WORKSPACE_DIR: workspacePath,
    OPENCLAW_GATEWAY_PORT: String(port),
    PATH: `${path.dirname(portableNode)};${process.env.PATH ?? ""}`,
  };
  const gatewayLog = fs.createWriteStream(path.join(runRoot, "gateway.log"), { flags: "a" });
  gatewayProcess = spawn(portableNode, [openClawEntry, "gateway", "run", "--port", String(port), "--bind", "loopback", "--compact"], {
    cwd: projectRoot,
    env: runtimeEnv,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  gatewayProcess.stdout.pipe(gatewayLog);
  gatewayProcess.stderr.pipe(gatewayLog);
  startedAt = performance.now();
  client = await connectGateway({ url: `ws://127.0.0.1:${port}`, token }, gatewayProcess);
  summary.timings.gatewayStartupMs = Math.round(performance.now() - startedAt);
  const observedEvents = [];
  client.on("event", (frame) => observedEvents.push({ event: frame.event, at: new Date().toISOString() }));

  for (const selectedItem of selected) {
    const conversation = selectedItem.conversation;
    const selfMessageKeys = new Set(conversation.messages
      .filter((message) => message.sentBySelf)
      .map((message) => message.messageKey));
    const batches = selectedItem.episode
      ? [conversation.messages]
      : splitConversationBatches(conversation.messages, {
        batchSize: args.batchSize,
        maxBatches: args.maxBatches,
      });
    const sessionKey = selectedItem.episode
      ? stableWorkSessionKey("conversation", "feishu-eval", selectedItem.episode.episodeId)
      : stableWorkSessionKey("conversation", "feishu", conversation.conversationKey);
    const conversationResult = {
      episodeId: selectedItem.episode?.episodeId ?? null,
      stratum: selectedItem.stratum ?? null,
      conversationKey: conversation.conversationKey,
      knownProfilePerson: knownPeople.includes(conversation.title),
      sourceMessageCount: conversation.messages.length,
      replayedMessageCount: batches.flat().length,
      sessionKey,
      graphLookup: null,
      batches: [],
    };

    startedAt = performance.now();
    const lookup = await client.invokeTool("shadow_context_query", {
      query: conversation.title,
      depth: 1,
      maxBytes: 16_384,
    });
    conversationResult.graphLookup = {
      ms: Math.round(performance.now() - startedAt),
      responseBytes: byteLength(lookup),
      modelBytes: modelTextBytes(lookup),
      ok: lookup?.ok === true,
    };

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex];
      const batchResult = {
        batchIndex,
        messageCount: batch.length,
        evidenceBytes: byteLength(batch),
      };
      startedAt = performance.now();
      for (const message of batch) {
        const replyToSelf = Boolean(message.parentMessageKey && selfMessageKeys.has(message.parentMessageKey));
        store.addEvidence({
          sourceId: source.id,
          kind: "feishu_message",
          occurredAt: message.occurredAt,
          title: conversation.title,
          content: safeEvidenceText({
            sender: { name: message.senderName, sender_type: message.senderType },
            content: message.content,
            chat: conversation.title,
          }, 16_000),
          sourceLocator: `private-evaluation://message/${message.messageKey}`,
          externalId: `${message.messageKey}:batch:${batchIndex}`,
          fingerprint: sha256(`evaluation:${message.messageKey}:${message.updatedAt ?? message.occurredAt ?? ""}`),
          metadata: {
            chatId: conversation.conversationKey,
            chatType: conversation.chatMode ?? "p2p",
            conversationKey: conversation.conversationKey,
            senderType: message.senderType,
            ownershipSignal: message.sentBySelf
              ? "self_authored"
              : replyToSelf
                ? "reply_to_self"
                : message.mentionsSelf
                  ? "explicit_self_mention"
                  : conversation.chatMode === "p2p" ? "direct_message" : "unassigned_group",
            senderOpenId: message.senderKey,
            senderName: message.senderName,
            sentBySelf: message.sentBySelf,
            mentionsSelf: Boolean(message.mentionsSelf),
            replyToMessageId: message.parentMessageKey ?? null,
            replyToSelf,
            isolatedEvaluation: true,
          },
        });
      }
      batchResult.ingestMs = Math.round(performance.now() - startedAt);

      startedAt = performance.now();
      batchResult.materialized = materializeContextGraph(store, config, { refreshStructural: false, runMaintenance: false });
      batchResult.materializeMs = Math.round(performance.now() - startedAt);
      startedAt = performance.now();
      batchResult.routed = routePendingContextChanges(store, config.attention ?? {});
      const rebound = store.db.prepare(`
        UPDATE context_changes
        SET session_key=?, not_before=?
        WHERE status='pending'
      `).run(sessionKey, new Date(Date.now() - 1000).toISOString());
      batchResult.reboundChanges = Number(rebound.changes ?? 0);
      batchResult.routeMs = Math.round(performance.now() - startedAt);

      const leaseOwner = `eval-${sha256(`${runId}:${sessionKey}:${batchIndex}`).slice(0, 16)}`;
      const prompt = evaluationPrompt({
        sessionKey,
        leaseOwner,
        batchIndex,
        batchCount: batches.length,
        episode: selectedItem.episode,
      });
      batchResult.promptBytes = byteLength(prompt);
      const turnStartedAt = Date.now();
      const eventStart = observedEvents.length;
      startedAt = performance.now();
      const accepted = await client.request("agent", {
        message: prompt,
        agentId: "main",
        sessionKey,
        thinking: "medium",
        timeout: args.timeoutSeconds,
        deliver: false,
        idempotencyKey: crypto.randomUUID(),
      }, 45_000);
      const terminal = await client.request("agent.wait", {
        runId: accepted?.runId,
        timeoutMs: args.timeoutSeconds * 1000,
      }, (args.timeoutSeconds + 45) * 1000);
      const history = await client.request("chat.history", {
        sessionKey,
        limit: 30,
        maxChars: 256_000,
      }, 30_000);
      const assistantText = assistantTextAfter(history?.messages, turnStartedAt);
      batchResult.modelTurnMs = Math.round(performance.now() - startedAt);
      batchResult.responseBytes = byteLength(assistantText);
      batchResult.terminalStatus = terminal?.status ?? (terminal?.error ? "error" : "unknown");
      batchResult.events = observedEvents.slice(eventStart);
      if (batchResult.terminalStatus === "error" || !assistantText.trim()) {
        writeJson(path.join(runRoot, "failed-turn.private.json"), {
          conversationKey: conversation.conversationKey,
          batchIndex,
          terminal,
          events: batchResult.events,
        });
        throw new Error(terminal?.error ?? `Isolated Agent returned no visible response for batch ${batchIndex}.`);
      }
      try {
        batchResult.response = parseJsonLoose(assistantText);
        batchResult.responseParsed = Boolean(batchResult.response && typeof batchResult.response === "object");
        batchResult.responseValidation = validateEvaluationResponse(batchResult.response);
      } catch {
        batchResult.response = safeEvidenceText(assistantText, 12_000);
        batchResult.responseParsed = false;
        batchResult.responseValidation = { valid: false, errors: ["response is not valid JSON"] };
      }
      batchResult.acknowledged = Number(store.db.prepare(`
        SELECT COUNT(*) AS count FROM context_changes
        WHERE session_key=? AND status='acknowledged' AND ack_note IS NOT NULL
      `).get(sessionKey)?.count ?? 0);
      conversationResult.batches.push(batchResult);
      writeJson(path.join(runRoot, "progress.json"), { ...summary, conversations: [...summary.conversations, conversationResult] });
    }
    summary.conversations.push(conversationResult);
  }

  summary.timings.totalReplayMs = summary.conversations.reduce((sum, conversation) => (
    sum + conversation.graphLookup.ms + conversation.batches.reduce((batchSum, batch) => (
      batchSum + batch.ingestMs + batch.materializeMs + batch.routeMs + batch.modelTurnMs
    ), 0)
  ), 0);
  summary.aggregate = {
    conversations: summary.conversations.length,
    batches: summary.conversations.reduce((sum, item) => sum + item.batches.length, 0),
    messages: summary.conversations.reduce((sum, item) => sum + item.replayedMessageCount, 0),
    parsedResponses: summary.conversations.reduce((sum, item) => sum + item.batches.filter((batch) => batch.responseParsed).length, 0),
    outboundMessagesSent: 0,
  };
  writeJson(path.join(runRoot, "result.private.json"), summary);
  process.stdout.write(`${JSON.stringify({ runRoot, ...summary.aggregate, timings: summary.timings }, null, 2)}\n`);
} finally {
  client?.stop();
  await stopProcess(gatewayProcess);
  store.close();
}
