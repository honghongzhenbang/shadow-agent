import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openDatabase } from "../src/db.mjs";
import { feishuMessageIdentity } from "../src/feishu-message-identity.mjs";
import { deriveTransportSimulations, TRANSPORT_FAULTS } from "../src/feishu-transport-simulation.mjs";
import { ensureDirectory } from "../src/utils.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const datasetPath = path.join(projectRoot, "runtime", "evaluations", "feishu-dataset-v2", "dataset.private.json");
const outputPath = path.join(projectRoot, "runtime", "evaluations", "feishu-dataset-v2", "transport-cases.private.json");
const reportPath = path.join(projectRoot, "docs", "evaluations", "2026-08-29-feishu-transport-simulations.md");
const perFaultIndex = process.argv.indexOf("--per-fault");
const perFault = perFaultIndex >= 0 ? Number(process.argv[perFaultIndex + 1]) : 3;
const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8").replace(/^\uFEFF/, ""));
const result = deriveTransportSimulations(dataset, { perFault });
const episodeById = new Map(dataset.episodes.map((episode) => [episode.episodeId, episode]));
const verificationRoot = path.join(projectRoot, "runtime", "evaluations", "feishu-dataset-v2", "transport-verification");
ensureDirectory(verificationRoot);

function removeDatabase(databasePath) {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${databasePath}${suffix}`, { force: true });
}

function verifyCase(item) {
  const databasePath = path.join(verificationRoot, `${item.caseId}.sqlite`);
  removeDatabase(databasePath);
  let store = openDatabase(databasePath);
  let source = store.upsertSource({ sourceKey: "transport-simulation", kind: "test", uri: "private-evaluation://transport" });
  let semanticWakes = 0;
  const episode = episodeById.get(item.sourceEpisodeId);
  const messageByKey = new Map(episode.messages.map((message) => [message.messageKey, message]));
  try {
    for (const operation of item.operations) {
      if (operation.operation === "restart") {
        store.close();
        store = openDatabase(databasePath);
        source = store.upsertSource({ sourceKey: "transport-simulation", kind: "test", uri: "private-evaluation://transport" });
        continue;
      }
      if (operation.outcome === "failure") continue;
      const message = messageByKey.get(operation.messageKey);
      const identity = feishuMessageIdentity({
        message_id: operation.messageKey,
        update_time: operation.revision,
      });
      const inserted = store.addEvidence({
        sourceId: source.id,
        kind: "feishu_message",
        occurredAt: message.occurredAt,
        title: "transport simulation",
        content: operation.messageKey,
        sourceLocator: `private-evaluation://transport/${operation.messageKey}`,
        externalId: operation.messageKey,
        fingerprint: identity.fingerprint,
        metadata: { syntheticTransport: true, source: operation.source },
      }).inserted;
      if (inserted) semanticWakes += 1;
    }
    const chronological = store.db.prepare(`
      SELECT external_id, occurred_at FROM evidence
      WHERE kind='feishu_message'
      ORDER BY COALESCE(occurred_at, collected_at), collected_at, id
    `).all();
    const uniqueCount = Number(store.db.prepare("SELECT COUNT(*) AS count FROM evidence WHERE kind='feishu_message'").get().count);
    const expectedCount = item.expected.uniqueMessageKeys.length;
    const chronologicalKeys = chronological.map((row) => row.external_id);
    const sameMessageSet = JSON.stringify([...chronologicalKeys].sort())
      === JSON.stringify([...item.expected.chronologicalMessageKeys].sort());
    const nondecreasingTime = chronological.every((row, index) => (
      index === 0 || Date.parse(row.occurred_at) >= Date.parse(chronological[index - 1].occurred_at)
    ));
    return {
      caseId: item.caseId,
      fault: item.fault,
      passed: uniqueCount === expectedCount
        && semanticWakes === expectedCount
        && sameMessageSet
        && nondecreasingTime,
      uniqueCount,
      semanticWakes,
      expectedCount,
      sameMessageSet,
      nondecreasingTime,
    };
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
}

result.verification = result.cases.map(verifyCase);
result.verificationPassed = result.verification.every((item) => item.passed);
const counts = Object.fromEntries(TRANSPORT_FAULTS.map((fault) => [fault, result.cases.filter((item) => item.fault === fault).length]));
const report = `# 飞书运输故障派生集（2026-08-29）

本数据只从非 holdout 真实 Episode 派生消息键和投递操作，不复制或编造业务正文，不参与语义准确率。

| 故障 | 案例 |
|---|---:|
${Object.entries(counts).map(([fault, count]) => `| ${fault} | ${count} |`).join("\n")}

每个案例只验证同一消息指纹、幂等入库、顺序恢复、重启重放、轮询/实时重叠和失败重试。语义模型不应因同一消息的重复运输而被重复唤醒。

本次使用真实 SQLite Evidence 写入链验证 ${result.verification.length} 个案例，结果：${result.verificationPassed ? "全部通过" : "存在失败"}。
`;
ensureDirectory(path.dirname(outputPath));
ensureDirectory(path.dirname(reportPath));
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
fs.writeFileSync(reportPath, report, "utf8");
process.stdout.write(`${JSON.stringify({ output: outputPath, report: reportPath, cases: result.cases.length, counts, verificationPassed: result.verificationPassed }, null, 2)}\n`);
