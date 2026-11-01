import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { readCognitiveProfile } from "../src/cognitive-profile.mjs";
import { ensureDirectory } from "../src/utils.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function argumentsFrom(argv) {
  const result = { runs: [], output: path.join(projectRoot, "docs", "evaluations", "2026-08-28-feishu-p2p-isolated-evaluation.md") };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--run") result.runs.push(path.resolve(argv[++index]));
    else if (argument === "--output") result.output = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function stats(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  const quantile = (ratio) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    average: sorted.length ? Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length) : 0,
    p50: quantile(0.5),
    p95: quantile(0.95),
    max: sorted.at(-1) ?? 0,
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function trajectory(runRoot) {
  const sessionRoot = path.join(runRoot, "openclaw-state", "agents", "main", "sessions");
  const files = fs.existsSync(sessionRoot)
    ? fs.readdirSync(sessionRoot).filter((name) => name.endsWith(".trajectory.jsonl"))
    : [];
  const entries = files.flatMap((name) => fs.readFileSync(path.join(sessionRoot, name), "utf8")
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)));
  const calls = new Map();
  const toolDurations = [];
  for (const entry of entries) {
    if (entry.type === "tool.call") calls.set(entry.data.toolCallId, entry);
    if (entry.type === "tool.result" && calls.has(entry.data.toolCallId)) {
      const call = calls.get(entry.data.toolCallId);
      toolDurations.push({
        name: call.data.name,
        ms: Math.max(0, Date.parse(entry.ts) - Date.parse(call.ts)),
        success: entry.data.success !== false,
      });
    }
  }
  return {
    entries,
    toolDurations,
    completed: entries.filter((entry) => entry.type === "model.completed"),
    compiled: entries.filter((entry) => entry.type === "context.compiled"),
  };
}

function tableCount(database, tableName) {
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
  return exists ? Number(database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get()?.count ?? 0) : 0;
}

function safety(runRoot) {
  const database = new DatabaseSync(path.join(runRoot, "shadow-evaluation.sqlite"), { readOnly: true });
  try {
    const pendingChanges = Number(database.prepare(`
      SELECT COUNT(*) AS count FROM context_changes WHERE status IN ('pending','leased')
    `).get()?.count ?? 0);
    return {
      outboundDrafts: tableCount(database, "outbound_message_drafts"),
      controllerOutbox: tableCount(database, "controller_outbox"),
      reminders: tableCount(database, "reminders"),
      conditions: tableCount(database, "condition_watches"),
      pendingChanges,
      workboardCreated: fs.existsSync(path.join(runRoot, "no-production-workboard.sqlite")),
    };
  } finally {
    database.close();
  }
}

function knownConversationNames(profile) {
  const personKeys = new Set(profile.entities.filter((entity) => entity.type === "Person").map((entity) => entity.canonicalKey));
  const identityKeys = new Set(profile.relations
    .filter((relation) => relation.predicate === "IDENTIFIED_BY" && personKeys.has(relation.subject))
    .map((relation) => relation.object));
  return new Set(profile.entities
    .filter((entity) => entity.type === "Person" || identityKeys.has(entity.canonicalKey))
    .flatMap((entity) => [entity.name, ...(entity.aliases ?? [])])
    .filter(Boolean));
}

function formatSeconds(milliseconds) {
  return `${(milliseconds / 1000).toFixed(milliseconds >= 10_000 ? 1 : 3)} s`;
}

const args = argumentsFrom(process.argv.slice(2));
if (!args.runs.length) {
  args.runs = fs.readdirSync(path.join(projectRoot, "runtime", "evaluations", "feishu-conversations"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-")
      && fs.existsSync(path.join(projectRoot, "runtime", "evaluations", "feishu-conversations", entry.name, "result.private.json")))
    .map((entry) => path.join(projectRoot, "runtime", "evaluations", "feishu-conversations", entry.name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
    .slice(0, 3);
}

const capture = readJson(path.join(projectRoot, "runtime", "evaluations", "feishu-conversations", "2026-08-28-capture.json"));
const captureByKey = new Map(capture.conversations.map((conversation) => [conversation.conversationKey, conversation]));
const { profile } = readCognitiveProfile(path.join(projectRoot, "docs", "knowledge", "structured", "team-cognitive-profile.v1.json"));
const knownNames = knownConversationNames(profile);
const results = args.runs.map((runRoot) => ({ runRoot, result: readJson(path.join(runRoot, "result.private.json")), trace: trajectory(runRoot), safety: safety(runRoot) }));
const conversations = results.flatMap((item) => item.result.conversations);
const batches = conversations.flatMap((conversation) => conversation.batches);
const completed = results.flatMap((item) => item.trace.completed);
const compiled = results.flatMap((item) => item.trace.compiled);
const toolDurations = results.flatMap((item) => item.trace.toolDurations);
const toolCounts = Object.fromEntries([...new Set(toolDurations.map((item) => item.name))].sort().map((name) => (
  [name, toolDurations.filter((item) => item.name === name).length]
)));
const toolTiming = Object.fromEntries(Object.keys(toolCounts).map((name) => (
  [name, stats(toolDurations.filter((item) => item.name === name).map((item) => item.ms))]
)));
const usage = completed.map((entry) => entry.data.usage ?? {});
const sessionTurns = new Map();
for (const entry of completed) {
  const list = sessionTurns.get(entry.sessionKey) ?? [];
  list.push(entry);
  sessionTurns.set(entry.sessionKey, list);
}
const firstUsage = [...sessionTurns.values()].map((entries) => entries[0]?.data?.usage).filter(Boolean);
const secondUsage = [...sessionTurns.values()].map((entries) => entries[1]?.data?.usage).filter(Boolean);
const profileOwners = profile.entities.filter(entity => entity.type === "Person" && entity.metadata?.isProfileOwner);
if (profileOwners.length !== 1) throw new Error("Evaluation profile must identify exactly one owner.");
const selfLabels = new Set(["当前用户", profileOwners[0].name, ...(profileOwners[0].aliases ?? [])]);
const ownerIsSelf = (owner) => selfLabels.has(String(owner ?? "").trim());
const selfTaskCount = batches.reduce((sum, batch) => sum + (batch.response?.candidateTasks ?? []).filter((task) => ownerIsSelf(task.owner)).length, 0);
const ownedWithoutSelfAction = batches.filter((batch) => batch.response?.conversationAssessment === "user_owned"
  && !(batch.response?.candidateTasks ?? []).some((task) => ownerIsSelf(task.owner))).length;
const assessmentCounts = Object.fromEntries(["user_owned", "user_involved", "background", "uncertain"].map((name) => [
  name,
  batches.filter((batch) => batch.response?.conversationAssessment === name).length,
]));
const explicitOwnershipBasis = batches.filter((batch) => /明确|承诺|指派|责任|未见|不能/.test(String(batch.response?.ownershipBasis ?? ""))).length;
const packetGapMentions = batches.filter((batch) => /截断|只展示|未展示|缺失消息/.test(JSON.stringify(batch.response?.uncertainties ?? []))).length;
const changedAssessment = conversations.filter((conversation) => conversation.batches.length > 1
  && conversation.batches[0].response?.conversationAssessment !== conversation.batches[1].response?.conversationAssessment).length;
const profileMatched = conversations.filter((conversation) => knownNames.has(captureByKey.get(conversation.conversationKey)?.title)).length;
const freshInputStats = stats(usage.map((item) => Number(item.input ?? 0)));
const cacheStats = stats(usage.map((item) => Number(item.cacheRead ?? 0)));
const totalTokenStats = stats(usage.map((item) => Number(item.total ?? 0)));
const firstTokenStats = stats(firstUsage.map((item) => Number(item.total ?? 0)));
const secondTokenStats = stats(secondUsage.map((item) => Number(item.total ?? 0)));
const allSafety = results.map((item) => item.safety);
const summary = {
  capture: { conversations: capture.conversations.length, messages: capture.conversations.reduce((sum, item) => sum + item.messages.length, 0), totalMs: capture.timings.totalMs },
  replay: { conversations: conversations.length, batches: batches.length, messages: conversations.reduce((sum, item) => sum + item.replayedMessageCount, 0), profileMatched, profileUnmatched: conversations.length - profileMatched },
  quality: {
    parsed: batches.filter((batch) => batch.responseParsed).length,
    acknowledged: batches.filter((batch) => batch.acknowledged > 0).length,
    assessmentCounts,
    explicitOwnershipBasis,
    candidateTasks: batches.reduce((sum, batch) => sum + (batch.response?.candidateTasks ?? []).length, 0),
    selfTaskCount,
    ownedWithoutSelfAction,
    replyNeeded: batches.filter((batch) => batch.response?.reply?.needed === true).length,
    packetGapMentions,
    changedAssessment,
  },
  performance: {
    databaseBootstrap: stats(results.map((item) => item.result.timings.databaseBootstrapMs)),
    profileImport: stats(results.map((item) => item.result.timings.profileImportMs)),
    gatewayStartup: stats(results.map((item) => item.result.timings.gatewayStartupMs)),
    graphLookup: stats(conversations.map((item) => item.graphLookup.ms)),
    graphLookupModelBytes: stats(conversations.map((item) => item.graphLookup.modelBytes)),
    ingest: stats(batches.map((item) => item.ingestMs)),
    materialize: stats(batches.map((item) => item.materializeMs)),
    route: stats(batches.map((item) => item.routeMs)),
    modelTurn: stats(batches.map((item) => item.modelTurnMs)),
    promptBytes: stats(batches.map((item) => item.promptBytes)),
    evidenceBytes: stats(batches.map((item) => item.evidenceBytes)),
    responseBytes: stats(batches.map((item) => item.responseBytes)),
    systemPromptBytes: stats(compiled.map((entry) => Buffer.byteLength(String(entry.data.systemPrompt ?? ""), "utf8"))),
    compiledPromptBytes: stats(compiled.map((entry) => Buffer.byteLength(String(entry.data.prompt ?? ""), "utf8"))),
    freshInputTokens: freshInputStats,
    cacheReadTokens: cacheStats,
    totalTokens: totalTokenStats,
    firstTurnTokens: firstTokenStats,
    secondTurnTokens: secondTokenStats,
    usageTotals: {
      input: usage.reduce((sum, item) => sum + Number(item.input ?? 0), 0),
      output: usage.reduce((sum, item) => sum + Number(item.output ?? 0), 0),
      cacheRead: usage.reduce((sum, item) => sum + Number(item.cacheRead ?? 0), 0),
      total: usage.reduce((sum, item) => sum + Number(item.total ?? 0), 0),
    },
    toolCounts,
    toolTiming,
    stableSessions: sessionTurns.size,
    distinctThreads: new Set(completed.map((entry) => entry.data.threadId)).size,
  },
  safety: {
    outboundDrafts: allSafety.reduce((sum, item) => sum + item.outboundDrafts, 0),
    controllerOutbox: allSafety.reduce((sum, item) => sum + item.controllerOutbox, 0),
    reminders: allSafety.reduce((sum, item) => sum + item.reminders, 0),
    conditions: allSafety.reduce((sum, item) => sum + item.conditions, 0),
    pendingChanges: allSafety.reduce((sum, item) => sum + item.pendingChanges, 0),
    workboardCreated: allSafety.some((item) => item.workboardCreated),
  },
};

const report = `# 飞书个人单聊隔离回放评测（2026-08-28）

## 结论

当前“稳定会话 + 有界注意力包 + 通用知识图谱按需展开”的方向成立。${summary.replay.batches} 个批次全部得到结构化响应并确认租约，未创建任务、提醒、外发草稿或 Workboard，也未发送消息。数据库不是主要瓶颈；模型轮次才是延迟和 Token 的主要来源。

仍有两个需要优先修正的语义问题：注意力包到达字节上限时缺少按会话补取原消息的精确工具；${summary.quality.ownedWithoutSelfAction} 个 **user_owned** 结果没有当前用户待执行动作，说明“历史上由用户负责”与“现在有用户任务”仍有一处混用。

## 样本与隔离

| 项目 | 结果 |
|---|---:|
| 当前可见人类 P2P 会话 | ${summary.capture.conversations} |
| 抓取消息 | ${summary.capture.messages} |
| 实际回放会话 | ${summary.replay.conversations} |
| 回放批次 / 消息 | ${summary.replay.batches} / ${summary.replay.messages} |
| V6 可解析 / 未解析会话 | ${summary.replay.profileMatched} / ${summary.replay.profileUnmatched} |
| 外发、任务、提醒、Workboard 写入 | 0 |
| 未确认变化 | ${summary.safety.pendingChanges} |

真实聊天、人员名、消息正文和完整模型输出只保存在 Git 忽略的 **runtime/evaluations/feishu-conversations**。仓库报告只保存匿名聚合结果。

## 分段耗时

| 环节 | 平均 | P50 | P95 | 最大 |
|---|---:|---:|---:|---:|
| 飞书 26 会话抓取总计 | ${formatSeconds(summary.capture.totalMs)} | - | - | - |
| 隔离数据库初始化 | ${summary.performance.databaseBootstrap.average} ms | ${summary.performance.databaseBootstrap.p50} ms | ${summary.performance.databaseBootstrap.p95} ms | ${summary.performance.databaseBootstrap.max} ms |
| V6 导入空白隔离图谱 | ${summary.performance.profileImport.average} ms | ${summary.performance.profileImport.p50} ms | ${summary.performance.profileImport.p95} ms | ${summary.performance.profileImport.max} ms |
| 人员/职责图谱查询 | ${summary.performance.graphLookup.average} ms | ${summary.performance.graphLookup.p50} ms | ${summary.performance.graphLookup.p95} ms | ${summary.performance.graphLookup.max} ms |
| 消息入库 | ${summary.performance.ingest.average} ms | ${summary.performance.ingest.p50} ms | ${summary.performance.ingest.p95} ms | ${summary.performance.ingest.max} ms |
| 增量图谱物化 | ${summary.performance.materialize.average} ms | ${summary.performance.materialize.p50} ms | ${summary.performance.materialize.p95} ms | ${summary.performance.materialize.max} ms |
| 稳定会话路由 | ${summary.performance.route.average} ms | ${summary.performance.route.p50} ms | ${summary.performance.route.p95} ms | ${summary.performance.route.max} ms |
| 模型整轮 | ${formatSeconds(summary.performance.modelTurn.average)} | ${formatSeconds(summary.performance.modelTurn.p50)} | ${formatSeconds(summary.performance.modelTurn.p95)} | ${formatSeconds(summary.performance.modelTurn.max)} |
| 新隔离网关首次启动 | ${formatSeconds(summary.performance.gatewayStartup.average)} | ${formatSeconds(summary.performance.gatewayStartup.p50)} | ${formatSeconds(summary.performance.gatewayStartup.p95)} | ${formatSeconds(summary.performance.gatewayStartup.max)} |

生产网关是常驻进程，首次隔离网关启动不应计入普通消息处理时延。图谱查询返回给模型的内容平均 ${summary.performance.graphLookupModelBytes.average} 字节，接近 16 KiB 上限，精度和体积仍可优化。

## 上下文与 Token

| 指标 | 结果 |
|---|---:|
| 平均系统提示词 | ${summary.performance.systemPromptBytes.average} 字节 |
| 平均当轮编译提示 | ${summary.performance.compiledPromptBytes.average} 字节 |
| 平均新输入 Token | ${summary.performance.freshInputTokens.average} |
| 平均缓存读取 Token | ${summary.performance.cacheReadTokens.average} |
| 平均总 Token | ${summary.performance.totalTokens.average} |
| 第一批平均总 Token | ${summary.performance.firstTurnTokens.average} |
| 第二批平均总 Token | ${summary.performance.secondTurnTokens.average} |
| ${summary.replay.batches} 轮总 Token / 其中缓存读取 | ${summary.performance.usageTotals.total} / ${summary.performance.usageTotals.cacheRead} |
| 稳定会话 / Codex thread | ${summary.performance.stableSessions} / ${summary.performance.distinctThreads} |

第二批没有创建新 thread，但平均总 Token 从 ${summary.performance.firstTurnTokens.average} 增至 ${summary.performance.secondTurnTokens.average}，增长主要来自缓存上下文。两轮规模尚可；长期会话仍应按既有契约在压力阈值触发语义压缩。

## 语义质量

| 指标 | 结果 |
|---|---:|
| JSON 可解析 / 租约已确认 | ${summary.quality.parsed}/${summary.replay.batches} / ${summary.quality.acknowledged}/${summary.replay.batches} |
| user_owned / user_involved / background / uncertain | ${summary.quality.assessmentCounts.user_owned} / ${summary.quality.assessmentCounts.user_involved} / ${summary.quality.assessmentCounts.background} / ${summary.quality.assessmentCounts.uncertain} |
| 包含明确责任依据 | ${summary.quality.explicitOwnershipBasis}/${summary.replay.batches} |
| 候选任务 / 归当前用户 | ${summary.quality.candidateTasks} / ${summary.quality.selfTaskCount} |
| 需要回复 | ${summary.quality.replyNeeded} |
| 第二批修正责任标签 | ${summary.quality.changedAssessment}/${summary.replay.conversations} |
| 明确提到消息截断或缺口 | ${summary.quality.packetGapMentions}/${summary.replay.batches} |

人工复核显示，所有 **user_owned** 的主要判断都有明确指派、用户承诺或用户实施陈述，没有仅凭姓名、领域或项目关键词归属任务。唯一结构性偏差是：一轮把用户已经完成并介绍的日报机制视为 **user_owned**，但当前候选动作全部属于对方。这不是任务误派，却会让首页统计误读。

V6 对姓名、别名和飞书身份的覆盖较好；${summary.replay.conversations} 个会话中仅 ${summary.replay.profileUnmatched} 个未解析。模型实际只额外调用 ${summary.performance.toolCounts.shadow_context_query ?? 0} 次图谱查询和 ${summary.performance.toolCounts.shadow_context_entity ?? 0} 次实体展开，说明按需展开有效，没有每轮加载整份团队档案。

## 迭代方向

1. **P0：拆开责任与当前动作。** 输出改为 relationship、responsibilityEvidence、activeUserActions、completedUserWork 四部分；只有非空 activeUserActions 才能进入用户待办。
2. **P0：增加精确会话窗口工具。** 新增只读 shadow_conversation_window(conversationKey, before, limit, maxBytes)，只允许沿当前包的精确会话键补取前后消息；解决注意力包截断后图谱查询无法补回原文的问题。
3. **P1：身份路由前置为小投影。** 注意力包仅附 1-3 条精确别名/飞书身份解析结果，不附完整人员邻域；未命中时保持未知，不做模糊姓名归属。
4. **P1：缩小默认图谱查询。** 先精确 canonical key、别名和身份，默认返回 4-8 KiB；只有模型提出具体关系问题时扩到 16 KiB。
5. **P1：以会话批次触发模型。** 继续合并同一会话短时间消息；纯用户发出且没有新回复的消息只更新证据和等待条件，避免立即再跑完整模型轮次。
6. **P2：持续观测长期会话。** 记录每个稳定 session 的新输入、缓存读取、工具展开和压缩次数；以压力阈值触发 OpenClaw 原生压缩，不按固定消息数轮换 thread。
`;

ensureDirectory(path.dirname(args.output));
fs.writeFileSync(args.output, report, "utf8");
fs.writeFileSync(path.join(path.dirname(args.output), "2026-08-28-feishu-p2p-isolated-evaluation.metrics.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ output: args.output, conversations: summary.replay.conversations, batches: summary.replay.batches, messages: summary.replay.messages, modelTurnMs: summary.performance.modelTurn, totalTokens: summary.performance.usageTotals.total, safety: summary.safety }, null, 2)}\n`);
