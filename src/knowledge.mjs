import fs from "node:fs";
import path from "node:path";

import { ensureDirectory, nowIso, safeEvidenceText } from "./utils.mjs";

function markdownCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

function writeUtf8(filePath, content) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, content.replace(/\r?\n/g, "\n"), "utf8");
}

export function writeKnowledgeIndexes(store, config) {
  const projects = store.listProjects();
  const tasks = store.openTasks(500);
  const candidates = store.confirmedKnowledge(500);
  const evidence = store.recentEvidence(100);
  const generatedRoot = ensureDirectory(path.join(config.paths.knowledgeRoot, "generated"));

  const projectRows = projects.map((project) => {
    const threadCount = store.db.prepare("SELECT COUNT(*) AS count FROM threads WHERE project_key=?").get(project.project_key).count;
    const evidenceCount = store.db.prepare("SELECT COUNT(*) AS count FROM evidence WHERE project_key=?").get(project.project_key).count;
    return `| ${markdownCell(project.name)} | ${markdownCell(project.root_path)} | ${threadCount} | ${evidenceCount} |`;
  });
  writeUtf8(
    path.join(config.paths.knowledgeRoot, "projects", "index.md"),
    `# 项目索引\n\n更新时间：${nowIso()}\n\n| 项目 | 本机路径 | Codex会话 | 证据 |\n|---|---|---:|---:|\n${projectRows.join("\n")}\n`,
  );

  const taskRows = tasks.map((task) =>
    `| ${task.id} | ${markdownCell(task.priority)} | ${markdownCell(task.status)} | ${markdownCell(task.risk_level)} | ${markdownCell(task.title)} |`,
  );
  writeUtf8(
    path.join(config.paths.knowledgeRoot, "open-loops", "index.md"),
    `# 开放事项\n\n更新时间：${nowIso()}\n\n| ID | 优先级 | 状态 | 风险 | 事项 |\n|---|---|---|---|---|\n${taskRows.join("\n")}\n`,
  );

  const candidateRows = candidates.map((item) =>
    `| ${markdownCell(item.category)} | ${markdownCell(item.subject)} | ${Number(item.confidence).toFixed(2)} | ${markdownCell(item.status)} | ${markdownCell(item.statement)} |`,
  );
  writeUtf8(
    path.join(generatedRoot, "knowledge-candidates.md"),
    `# 候选知识\n\n更新时间：${nowIso()}\n\n| 类型 | 对象 | 置信度 | 状态 | 内容 |\n|---|---|---:|---|---|\n${candidateRows.join("\n")}\n`,
  );

  const evidenceSections = evidence.map((item) =>
    `## ${item.title || item.kind}\n\n- ID: \`${item.id}\`\n- 时间: ${item.occurred_at ?? item.collected_at}\n- 来源: \`${item.source_locator}\`\n- 类型: \`${item.kind}\`\n\n${safeEvidenceText(item.content, 1200)}\n`,
  );
  writeUtf8(
    path.join(generatedRoot, "latest-evidence.md"),
    `# 最近证据\n\n更新时间：${nowIso()}\n\n${evidenceSections.join("\n")}\n`,
  );

  writeUtf8(
    path.join(generatedRoot, "status.json"),
    `${JSON.stringify({ generatedAt: nowIso(), stats: store.stats(), sources: store.sourceStatuses() }, null, 2)}\n`,
  );
}

export function writePatrolReport(config, runId, result) {
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(config.paths.reportRoot, date, `${runId}.md`);
  const tasks = (result.tasks ?? []).map((task) =>
    `- [${task.priority ?? "normal"}] ${task.title}（${task.risk_level ?? "read"}）\n  - ${task.description ?? ""}\n  - 证据：${(task.evidence_ids ?? []).map((id) => `\`${id}\``).join(", ") || "无"}`,
  );
  const knowledge = (result.knowledge_updates ?? []).map((item) =>
    `- ${item.category}/${item.subject}：${item.statement}（置信度 ${item.confidence}）`,
  );
  writeUtf8(
    reportPath,
    `# 主动巡查 ${runId}\n\n## 结论\n\n${result.summary ?? ""}\n\n## 新任务\n\n${tasks.join("\n") || "无。"}\n\n## 候选知识\n\n${knowledge.join("\n") || "无。"}\n\n## 无动作理由\n\n${result.no_action_reason || "不适用。"}\n`,
  );
  return reportPath;
}
