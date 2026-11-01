import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readCognitiveProfile } from "../src/cognitive-profile.mjs";
import {
  auditEvaluationDataset,
  episodeSuitability,
} from "../src/feishu-evaluation-dataset.mjs";
import { ensureDirectory, sha256 } from "../src/utils.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function argumentsFrom(argv) {
  const result = {
    dataset: path.join(projectRoot, "runtime", "evaluations", "feishu-dataset-v2", "dataset.private.json"),
    capture: path.join(projectRoot, "runtime", "evaluations", "feishu-dataset-v2", "capture.private.json"),
    output: path.join(projectRoot, "runtime", "evaluations", "feishu-dataset-v2", "suitability-audit.private.json"),
    review: path.join(projectRoot, "runtime", "evaluations", "feishu-dataset-v2", "review-queue.private.json"),
    report: path.join(projectRoot, "docs", "evaluations", "2026-08-29-feishu-dataset-suitability.md"),
    perStratum: 5,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dataset") result.dataset = path.resolve(argv[++index]);
    else if (argument === "--capture") result.capture = path.resolve(argv[++index]);
    else if (argument === "--output") result.output = path.resolve(argv[++index]);
    else if (argument === "--review") result.review = path.resolve(argv[++index]);
    else if (argument === "--report") result.report = path.resolve(argv[++index]);
    else if (argument === "--per-stratum") result.perStratum = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function knownConversationNames(profile) {
  const personKeys = new Set(profile.entities
    .filter((entity) => entity.type === "Person")
    .map((entity) => entity.canonicalKey));
  const identityKeys = new Set(profile.relations
    .filter((relation) => relation.predicate === "IDENTIFIED_BY" && personKeys.has(relation.subject))
    .map((relation) => relation.object));
  return new Set(profile.entities
    .filter((entity) => entity.type === "Person" || identityKeys.has(entity.canonicalKey))
    .flatMap((entity) => [entity.name, ...(entity.aliases ?? [])])
    .filter(Boolean));
}

function stableOrder(episodes, salt) {
  return [...episodes].sort((left, right) => (
    sha256(`${salt}:${left.episodeId}`).localeCompare(sha256(`${salt}:${right.episodeId}`))
  ));
}

function reviewQueue(dataset, perStratum) {
  const candidates = dataset.episodes.filter((episode) => episode.split !== "holdout");
  const strata = [
    ["mixed_human_bot_context", (_episode, use) => use.eligibility.mixedHumanBotContext],
    ["bot_realtime_event", (episode) => episode.ingressModes.includes("bot_realtime_event_eligible")],
    ["group_mention_self", (episode) => episode.ingressModes.includes("group_mention_self")],
    ["p2p_reply_candidate", (episode, use) => episode.chatMode === "p2p" && use.eligibility.replyDrafting],
    ["ownership_task_candidate", (_episode, use) => use.eligibility.ownershipAndTask],
    ["continuous_conversation", (_episode, use) => use.eligibility.continuity],
    ["group_background_negative", (_episode, use) => use.eligibility.negativeControl],
    ["outbound_waiting", (episode) => episode.messages.at(-1)?.sentBySelf === true],
    ["attachment_reference", (episode) => episode.ingressModes.includes("attachment_reference")],
    ["edited_or_deleted", (episode) => episode.ingressModes.includes("message_edited") || episode.ingressModes.includes("message_deleted")],
    ["sparse_ambiguous", (_episode, use) => use.issues.includes("singleton") || use.issues.includes("insufficient_text")],
  ];
  const selectedIds = new Set();
  const selected = [];
  const coverage = {};
  for (const [name, predicate] of strata) {
    const matches = candidates.filter((episode) => predicate(episode, episodeSuitability(episode, dataset.options)));
    coverage[name] = matches.length;
    let taken = 0;
    for (const episode of stableOrder(matches, name)) {
      if (selectedIds.has(episode.episodeId)) continue;
      selectedIds.add(episode.episodeId);
      selected.push({
        stratum: name,
        suitability: episodeSuitability(episode, dataset.options),
        episode,
      });
      taken += 1;
      if (taken >= perStratum) break;
    }
  }
  return { coverage, selected };
}

function percent(value, total) {
  return total ? `${((value / total) * 100).toFixed(1)}%` : "0.0%";
}

const args = argumentsFrom(process.argv.slice(2));
const dataset = readJson(args.dataset);
const capture = fs.existsSync(args.capture) ? readJson(args.capture) : null;
const audit = auditEvaluationDataset(dataset);
const { profile } = readCognitiveProfile(path.join(projectRoot, "docs", "knowledge", "structured", "team-cognitive-profile.v1.json"));
const knownNames = knownConversationNames(profile);
const p2pEpisodes = dataset.episodes.filter((episode) => episode.chatMode === "p2p");
const p2pConversations = new Map();
for (const episode of p2pEpisodes) p2pConversations.set(episode.conversationKey, episode.title);
const profileCoverage = {
  knownP2pConversations: [...p2pConversations.values()].filter((title) => knownNames.has(title)).length,
  totalP2pConversations: p2pConversations.size,
};
const review = reviewQueue(dataset, Math.max(1, args.perStratum));
const captureConversations = capture?.conversations?.length ?? audit.conversations;
const captureMessages = capture?.conversations?.reduce((sum, item) => sum + item.messages.length, 0) ?? audit.messages;
const gates = {
  structuralIntegrity: audit.labelability.emptyEpisodes === 0
    && (audit.suitability.issues.missing_timestamp ?? 0) === 0,
  triggerRouting: audit.suitability.eligibility.triggerRouting >= 200
    && audit.suitability.eligibility.negativeControl >= 50,
  ownershipAndTask: audit.suitability.eligibility.ownershipAndTask >= 80,
  replyDrafting: audit.suitability.eligibility.replyDrafting >= 40,
  continuity: audit.suitability.eligibility.continuity >= 40,
  mixedHumanBotContext: audit.suitability.eligibility.mixedHumanBotContext >= 40,
  frozenHoldout: Number(audit.splits.holdout ?? 0) >= 50,
};
const result = {
  schema: "shadow-agent/feishu-evaluation-suitability/v2",
  generatedAt: new Date().toISOString(),
  inputs: {
    dataset: path.basename(args.dataset),
    capture: capture ? path.basename(args.capture) : null,
  },
  capture: {
    conversations: captureConversations,
    messages: captureMessages,
    failures: capture?.failures?.length ?? 0,
  },
  audit,
  profileCoverage,
  gates,
  review: {
    holdoutExcluded: true,
    coverage: review.coverage,
    selected: review.selected.map((item) => ({
      stratum: item.stratum,
      episodeId: item.episode.episodeId,
      split: item.episode.split,
      issues: item.suitability.issues,
    })),
  },
  syntheticPolicy: {
    realDataIsPrimary: true,
    syntheticBusinessContentCountsTowardAccuracy: false,
    semanticCoverageGaps: audit.coverageGaps,
    transportFaultsToDeriveFromRealEpisodes: [
      "duplicate_delivery",
      "out_of_order_delivery",
      "restart_replay",
      "polling_realtime_overlap",
      "transient_failure_retry",
    ],
  },
};

const report = `# 飞书真实评测数据适用性审计（2026-08-29）

## 结论

本次只读抓取形成 ${captureConversations} 个会话、${captureMessages} 条消息和 ${audit.episodes} 个 Episode。真实数据可作为触发路由、任务归属、回复草拟和持续会话的主体样本，但必须按用途分层；单边、过短和附件主导 Episode 不能直接充当回复质量金标准。

模拟数据不替代真实业务样本。只对真实数据难稳定复现的重复投递、乱序、重启重放、轮询与实时事件重叠、瞬时失败重试进行运输故障派生；业务语义模拟仅在真实覆盖缺口确认后单列使用，不计入真实准确率。

## 数据规模与用途

| 指标 | 数量 | 占 Episode |
|---|---:|---:|
| 会话 / 消息 / Episode | ${captureConversations} / ${captureMessages} / ${audit.episodes} | - |
| 可用于触发路由 | ${audit.suitability.eligibility.triggerRouting} | ${percent(audit.suitability.eligibility.triggerRouting, audit.episodes)} |
| 可用于任务归属复核 | ${audit.suitability.eligibility.ownershipAndTask} | ${percent(audit.suitability.eligibility.ownershipAndTask, audit.episodes)} |
| 可用于回复草拟复核 | ${audit.suitability.eligibility.replyDrafting} | ${percent(audit.suitability.eligibility.replyDrafting, audit.episodes)} |
| 可用于持续会话复核 | ${audit.suitability.eligibility.continuity} | ${percent(audit.suitability.eligibility.continuity, audit.episodes)} |
| 真人与机器人混合原文窗口 | ${audit.suitability.eligibility.mixedHumanBotContext} | ${percent(audit.suitability.eligibility.mixedHumanBotContext, audit.episodes)} |
| 群背景负样本 | ${audit.suitability.eligibility.negativeControl} | ${percent(audit.suitability.eligibility.negativeControl, audit.episodes)} |
| development / validation / holdout | ${audit.splits.development ?? 0} / ${audit.splits.validation ?? 0} / ${audit.splits.holdout ?? 0} | - |

## 质量缺口

| 缺口 | 数量 |
|---|---:|
| 单边 Episode | ${audit.suitability.issues.one_sided ?? 0} |
| 单消息 Episode | ${audit.suitability.issues.singleton ?? 0} |
| 有效文字不足 | ${audit.suitability.issues.insufficient_text ?? 0} |
| 未知发送者 | ${audit.suitability.issues.unknown_sender ?? 0} |
| 超过单 Episode 字节预算 | ${audit.suitability.issues.oversized_single_message ?? 0} |
| 触及每会话抓取上限 | ${audit.suitability.issues.capture_boundary_risk ?? 0} |

P2P 人员档案精确覆盖 ${profileCoverage.knownP2pConversations}/${profileCoverage.totalP2pConversations}。${audit.coverageGaps.length
  ? `当前真实覆盖缺口为：${audit.coverageGaps.join("、")}。这些缺口先核对飞书 API 字段和抓取方式，再决定是否补模拟语义样本。`
  : "当前声明的业务进入模式均有真实样本，不生成模拟业务语料。"}

## 使用门槛

| 门槛 | 结果 |
|---|---|
${Object.entries(gates).map(([name, passed]) => `| ${name} | ${passed ? "通过" : "未通过"} |`).join("\n")}

抽样复核队列只从 development 和 validation 选取，holdout 不进入提示词调优。mixed_human_bot_context 直接使用同一 Episode 中首写脱敏后的真人消息正文、机器人文本/卡片正文和发送者类型，不以摘要替代。私聊名称、正文、人员和完整 Episode 仅保存在 Git 忽略的 runtime 私有目录；仓库报告只保存匿名聚合指标。
`;

ensureDirectory(path.dirname(args.output));
ensureDirectory(path.dirname(args.review));
ensureDirectory(path.dirname(args.report));
fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
fs.writeFileSync(args.review, `${JSON.stringify({
  schema: "shadow-agent/feishu-evaluation-review-queue/v2",
  generatedAt: result.generatedAt,
  holdoutExcluded: true,
  selected: review.selected,
}, null, 2)}\n`, "utf8");
fs.writeFileSync(args.report, report, "utf8");
process.stdout.write(`${JSON.stringify({
  output: args.output,
  review: args.review,
  report: args.report,
  capture: result.capture,
  episodes: audit.episodes,
  suitability: audit.suitability,
  coverageGaps: audit.coverageGaps,
  profileCoverage,
  gates,
  reviewSelected: review.selected.length,
}, null, 2)}\n`);
