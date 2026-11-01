import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { scoreEvaluationRun } from "../src/feishu-evaluation-score.mjs";
import { ensureDirectory } from "../src/utils.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function argumentsFrom(argv) {
  const result = {
    run: null,
    labels: path.join(projectRoot, "runtime", "evaluations", "feishu-dataset-v2", "gold-labels.codex.private.json"),
    output: null,
    report: path.join(projectRoot, "docs", "evaluations", "2026-08-29-feishu-episode-baseline.md"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--run") result.run = path.resolve(argv[++index]);
    else if (argument === "--labels") result.labels = path.resolve(argv[++index]);
    else if (argument === "--output") result.output = path.resolve(argv[++index]);
    else if (argument === "--report") result.report = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!result.run) throw new Error("--run is required.");
  result.output ??= path.join(result.run, "score.private.json");
  return result;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function stats(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  return {
    count: sorted.length,
    average: sorted.length ? Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length) : 0,
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
  };
}

function percent(metric) {
  return `${(Number(metric?.rate ?? 0) * 100).toFixed(1)}%`;
}

function trajectorySummary(runRoot) {
  const sessionRoot = path.join(runRoot, "openclaw-state", "agents", "main", "sessions");
  const files = fs.existsSync(sessionRoot)
    ? fs.readdirSync(sessionRoot).filter((name) => name.endsWith(".trajectory.jsonl"))
    : [];
  const entries = files.flatMap((name) => fs.readFileSync(path.join(sessionRoot, name), "utf8")
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)));
  const completed = entries.filter((entry) => entry.type === "model.completed");
  const calls = entries.filter((entry) => entry.type === "tool.call");
  const results = entries.filter((entry) => entry.type === "tool.result");
  const usage = completed.map((entry) => entry.data?.usage ?? {});
  return {
    modelTurns: completed.length,
    distinctThreads: new Set(completed.map((entry) => entry.data?.threadId).filter(Boolean)).size,
    usage: {
      input: usage.reduce((sum, item) => sum + Number(item.input ?? 0), 0),
      output: usage.reduce((sum, item) => sum + Number(item.output ?? 0), 0),
      cacheRead: usage.reduce((sum, item) => sum + Number(item.cacheRead ?? 0), 0),
      total: usage.reduce((sum, item) => sum + Number(item.total ?? 0), 0),
    },
    toolCalls: Object.fromEntries([...new Set(calls.map((entry) => entry.data?.name).filter(Boolean))]
      .sort().map((name) => [name, calls.filter((entry) => entry.data?.name === name).length])),
    toolFailures: results.filter((entry) => entry.data?.success === false).length,
  };
}

function safetySummary(runRoot) {
  const database = new DatabaseSync(path.join(runRoot, "shadow-evaluation.sqlite"), { readOnly: true });
  try {
    const count = (table) => Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0);
    return {
      outboundDrafts: count("outbound_message_drafts"),
      controllerOutbox: count("controller_outbox"),
      reminders: count("reminders"),
      conditionWatches: count("condition_watches"),
    };
  } finally {
    database.close();
  }
}

const args = argumentsFrom(process.argv.slice(2));
const run = readJson(path.join(args.run, "result.private.json"));
const gold = readJson(args.labels);
const isolatedConfigPath = path.join(args.run, "openclaw-state", "openclaw.json");
const isolatedConfig = fs.existsSync(isolatedConfigPath) ? readJson(isolatedConfigPath) : {};
if (gold.holdoutReviewed === true || gold.labels?.some((label) => label.split === "holdout")) {
  throw new Error("Gold labels must not expose holdout during development evaluation.");
}
const score = scoreEvaluationRun(run, gold);
const batches = (run.conversations ?? []).flatMap((conversation) => conversation.batches ?? []);
score.performance = {
  modelTurnMs: stats(batches.map((batch) => Number(batch.modelTurnMs))),
  promptBytes: stats(batches.map((batch) => Number(batch.promptBytes))),
  evidenceBytes: stats(batches.map((batch) => Number(batch.evidenceBytes))),
  modelTurns: batches.length,
  messages: (run.conversations ?? []).reduce((sum, conversation) => sum + Number(conversation.replayedMessageCount ?? 0), 0),
  gatewayStartupMs: Number(run.timings?.gatewayStartupMs ?? 0),
};
score.trajectory = trajectorySummary(args.run);
score.safety = safetySummary(args.run);
score.runtime = {
  model: isolatedConfig.agents?.defaults?.model?.primary ?? isolatedConfig.agents?.defaults?.model ?? "unknown",
  thinking: isolatedConfig.agents?.defaults?.thinkingDefault ?? "unknown",
};
const mismatches = score.items.filter((item) => !(
  item.schemaValid
  && item.ingressExact
  && item.assessmentExact
  && item.actionCountExact
  && item.replyExact
  && item.continuationExact
));
const externalSideEffects = Object.values(score.safety).reduce((sum, value) => sum + value, 0);

const report = `# 飞书真实 Episode 隔离基线（2026-08-29）

## 结论

本报告只比较 Codex 预先复核的 development/validation 标签，不读取 holdout。完整消息、标签和模型输出保存在 Git 忽略的 runtime 私有目录；下表不包含姓名、会话键、正文或资源定位。

| 指标 | 结果 |
|---|---:|
| 已复核 / 本次评分 Episode | ${score.reviewedEpisodes} / ${score.scoredEpisodes} |
| Schema 合法 | ${percent(score.metrics.schemaValid)} |
| 进入决策完全一致 | ${percent(score.metrics.ingressExact)} |
| 对话归属完全一致 | ${percent(score.metrics.assessmentExact)} |
| 当前动作数量一致 | ${percent(score.metrics.actionCountExact)} |
| 回复必要性一致 | ${percent(score.metrics.replyExact)} |
| 继续条件一致 | ${percent(score.metrics.continuationExact)} |
| 误建当前用户动作 / 漏掉动作 | ${score.metrics.falsePositiveActions} / ${score.metrics.missedActions} |

## 性能

| 指标 | 结果 |
|---|---:|
| 消息 / 模型回合 | ${score.performance.messages} / ${score.performance.modelTurns} |
| 模型 / 思考等级 | ${score.runtime.model} / ${score.runtime.thinking} |
| 单回合模型耗时平均 / 范围 | ${(score.performance.modelTurnMs.average / 1000).toFixed(1)} s / ${(score.performance.modelTurnMs.min / 1000).toFixed(1)}-${(score.performance.modelTurnMs.max / 1000).toFixed(1)} s |
| 提示词平均 | ${score.performance.promptBytes.average} bytes |
| Episode 证据平均 | ${score.performance.evidenceBytes.average} bytes |
| 隔离网关启动 | ${(score.performance.gatewayStartupMs / 1000).toFixed(1)} s |
| 新输入 / 输出 / 缓存读取 Token | ${score.trajectory.usage.input} / ${score.trajectory.usage.output} / ${score.trajectory.usage.cacheRead} |
| 总 Token / 独立线程 | ${score.trajectory.usage.total} / ${score.trajectory.distinctThreads} |
| 工具调用 / 失败 | ${Object.values(score.trajectory.toolCalls).reduce((sum, value) => sum + value, 0)} / ${score.trajectory.toolFailures} |
| 外发草稿、Outbox、提醒、条件跟踪写入 | ${externalSideEffects} |

## 差异

${mismatches.length
  ? `共 ${mismatches.length} 条存在评分差异：${mismatches.map((item) => `${item.stratum}（${[
    !item.schemaValid ? "schema" : null,
    !item.ingressExact ? "进入决策" : null,
    !item.assessmentExact ? "归属" : null,
    !item.actionCountExact ? "动作数量" : null,
    !item.replyExact ? "回复" : null,
    !item.continuationExact ? "继续条件" : null,
  ].filter(Boolean).join("、")}）`).join("；")}。差异保留供复核，不在看到模型结果后修改 gold。`
  : "本次已评分项目没有差异。"}

本结果只是小样本基线。只有扩大到全部已复核分层样本并确认 validation 不退化后，才能评价方案质量；不得据此推断 1480 个 Episode 的总体准确率。
`;

ensureDirectory(path.dirname(args.output));
ensureDirectory(path.dirname(args.report));
fs.writeFileSync(args.output, `${JSON.stringify(score, null, 2)}\n`, "utf8");
fs.writeFileSync(args.report, report, "utf8");
process.stdout.write(`${JSON.stringify({ output: args.output, report: args.report, ...score.metrics, performance: score.performance }, null, 2)}\n`);
