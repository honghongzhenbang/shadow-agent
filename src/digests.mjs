import path from "node:path";

import { codexDigestTitle, normalizeCodexThreadTitle } from "./codex-thread-title.mjs";
import { safeEvidenceText, sha256, splitTextChunks, stableJson } from "./utils.mjs";

const THREAD_DIGEST_VERSION = 1;
const PROJECT_DIGEST_VERSION = 1;

function uniqueByContent(rows, limit = Infinity) {
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const fingerprint = sha256(String(row.content ?? ""));
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    result.push(row);
    if (result.length >= limit) break;
  }
  return result;
}

function evidenceLine(row, maxChars = 1800) {
  const time = row.occurred_at ?? row.collected_at ?? "unknown";
  return `- [${row.id} @ ${time}] ${safeEvidenceText(row.content, maxChars).replace(/\r?\n/g, " ")}`;
}

function threadDigestText(thread, groups) {
  const title = normalizeCodexThreadTitle({ id: thread.id, title: thread.title });
  const sections = [
    `# Codex 会话证据汇总`,
    `- thread_id: ${thread.id}`,
    `- title: ${title || "未命名"}`,
    `- cwd: ${thread.cwd || "未知"}`,
    `- rollout: ${thread.rollout_path || "未知"}`,
    `- project_key: ${thread.project_key || "未归类"}`,
    "",
    "## 用户消息",
    groups.user.length ? groups.user.map((row) => evidenceLine(row, 2400)).join("\n") : "无。",
    "",
    "## Codex关键回复与总结",
    groups.agent.length ? groups.agent.map((row) => evidenceLine(row, 1800)).join("\n") : "无。",
    "",
    "## 补丁和文件变更结果",
    groups.patch.length ? groups.patch.map((row) => evidenceLine(row, 1200)).join("\n") : "无。",
    "",
    "## 工具调用统计",
    groups.tools.length ? groups.tools.map((row) => `- ${row.tool_name || "unknown"}: ${row.count}`).join("\n") : "无。",
    "",
    "## 失败或异常工具输出",
    groups.failures.length ? groups.failures.map((row) => evidenceLine(row, 1000)).join("\n") : "无。",
  ];
  return sections.join("\n");
}

function collectThreadDigest(store, config, source, threadId) {
  const metrics = { threads: 0, skipped: 0, chunks: 0, evidence: 0, links: 0, archived: 0, deleted: 0 };
  const thread = store.db.prepare(`
    SELECT t.*, COUNT(e.id) AS digest_input_count, MAX(e.collected_at) AS digest_input_max
    FROM threads t
    JOIN evidence e ON e.thread_id=t.id
      AND e.kind IN (
        'codex_user_message','codex_agent_message','codex_turn_summary','codex_compaction_summary',
        'codex_patch_result','codex_tool_call','codex_tool_output','codex_tool_result'
      )
    WHERE t.id=?
    GROUP BY t.id
  `).get(threadId);
  if (!thread) {
    metrics.skipped += 1;
    return metrics;
  }
  const userQuery = store.db.prepare(`
    SELECT * FROM evidence WHERE thread_id=? AND kind='codex_user_message'
    ORDER BY COALESCE(occurred_at,collected_at), id
  `);
  const agentQuery = store.db.prepare(`
    SELECT * FROM evidence WHERE thread_id=? AND kind IN ('codex_agent_message','codex_turn_summary','codex_compaction_summary')
    ORDER BY COALESCE(occurred_at,collected_at) DESC, id DESC
  `);
  const patchQuery = store.db.prepare(`
    SELECT * FROM evidence WHERE thread_id=? AND kind='codex_patch_result'
    ORDER BY COALESCE(occurred_at,collected_at) DESC, id DESC LIMIT 80
  `);
  const toolQuery = store.db.prepare(`
    SELECT COALESCE(json_extract(metadata_json,'$.tool_name'),'unknown') AS tool_name, COUNT(*) AS count
    FROM evidence WHERE thread_id=? AND kind='codex_tool_call'
    GROUP BY tool_name ORDER BY count DESC LIMIT 40
  `);
  const failureQuery = store.db.prepare(`
    SELECT * FROM evidence
    WHERE thread_id=? AND kind IN ('codex_tool_output','codex_tool_result')
      AND (
        content LIKE '%Exit code: 1%' OR content LIKE '%isError%true%' OR
        content LIKE '%"success":false%' OR content LIKE '%timed out%' OR content LIKE '%Traceback%'
      )
    ORDER BY COALESCE(occurred_at,collected_at) DESC, id DESC LIMIT 30
  `);

  const settingKey = `digest:thread:${thread.id}`;
    const userAttentionKey = `digest:thread:user-input:${thread.id}`;
    const priorDigestCollectedAt = store.db.prepare(`
      SELECT MAX(collected_at) AS value FROM evidence
      WHERE kind='codex_thread_digest' AND thread_id=?
    `).get(thread.id)?.value ?? null;
    const userRows = uniqueByContent(userQuery.all(thread.id));
    const userInputSignature = sha256(stableJson(userRows.map((row) => row.id)));
    const priorUserInputSignature = store.getSetting(userAttentionKey);
    const hasNewUserInput = priorUserInputSignature
      ? priorUserInputSignature !== userInputSignature
      : !priorDigestCollectedAt || userRows.some((row) => String(row.collected_at ?? "") > priorDigestCollectedAt);
    const signatureInput = {
      count: thread.digest_input_count,
      maxCollectedAt: thread.digest_input_max,
      title: thread.title,
      cwd: thread.cwd,
      projectKey: thread.project_key,
    };
    const inputSignature = sha256(stableJson({ version: THREAD_DIGEST_VERSION, ...signatureInput }));
    const legacySignature = sha256(stableJson({ ...signatureInput, updatedAtMs: thread.updated_at_ms }));
    const storedSignature = store.getSetting(settingKey);
    if (storedSignature === inputSignature || storedSignature === legacySignature) {
      if (storedSignature !== inputSignature) store.setSetting(settingKey, inputSignature);
      metrics.skipped += 1;
      return metrics;
    }
    const groups = {
      user: userRows,
      agent: uniqueByContent(agentQuery.all(thread.id), 60),
      patch: uniqueByContent(patchQuery.all(thread.id), 40),
      tools: toolQuery.all(thread.id),
      failures: uniqueByContent(failureQuery.all(thread.id), 20),
    };
    const linkedIds = [...new Set([
      ...groups.user.map((row) => row.id),
      ...groups.agent.map((row) => row.id),
      ...groups.patch.map((row) => row.id),
      ...groups.failures.map((row) => row.id),
    ])];
    const text = threadDigestText(thread, groups);
    const digestHash = sha256(text);
    let firstDigestEvidenceId = null;
    for (const chunk of splitTextChunks(text, Math.max(4000, config.collection.maxEvidenceChars - 1000))) {
      const result = store.addEvidence({
        sourceId: source.id,
        kind: "codex_thread_digest",
        occurredAt: thread.updated_at_ms ? new Date(Number(thread.updated_at_ms)).toISOString() : null,
        projectKey: thread.project_key,
        threadId: thread.id,
        title: codexDigestTitle(
          thread.title || thread.id,
          chunk.index,
          config.codex?.titleMaintenance?.maxDigestTitleChars,
        ),
        content: safeEvidenceText(chunk.text, config.collection.maxEvidenceChars),
        sourceLocator: `shadow-agent://thread-digest/${thread.id}#chars=${chunk.start}-${chunk.end}`,
        externalId: `${thread.id}:${digestHash}:${chunk.index}`,
        fingerprint: sha256(`thread-digest-v1:${thread.id}:${digestHash}:${chunk.index}`),
        metadata: {
          threadId: thread.id,
          digestHash,
          chunkIndex: chunk.index,
          rawEvidenceCount: linkedIds.length,
          userInputSignature,
          userInputCount: userRows.length,
          attentionWorthy: hasNewUserInput,
        },
      });
      firstDigestEvidenceId ??= result.id;
      if (result.inserted) metrics.evidence += 1;
      const idsInChunk = linkedIds.filter((id) => chunk.text.includes(id));
      store.linkEvidence(result.id, idsInChunk, "summarizes");
      metrics.links += idsInChunk.length;
      metrics.chunks += 1;
    }
    const finalized = store.finalizeThreadDigestGeneration(thread.id, digestHash, firstDigestEvidenceId);
    metrics.archived += finalized.archived;
    metrics.deleted += finalized.deleted;
    store.setSetting(settingKey, inputSignature);
    store.setSetting(userAttentionKey, userInputSignature);
  metrics.threads += 1;
  return metrics;
}

function collectGitDigest(store, config, source, repoPath) {
  const metrics = { repositories: 0, skipped: 0, chunks: 0, evidence: 0, links: 0 };
  const commits = store.db.prepare(`
    SELECT * FROM evidence
    WHERE kind='git_commit'
      AND CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'$.repoPath') END=?
    ORDER BY occurred_at DESC, id
  `).all(repoPath);
  if (!commits.length) {
    metrics.skipped += 1;
    return metrics;
  }
  const group = {
    repoPath,
    projectKey: commits[0].project_key,
    commits: commits.map((commit) => ({ ...commit, metadata: JSON.parse(commit.metadata_json || "{}") })),
  };
    const settingKey = `digest:git:${sha256(group.repoPath.toLowerCase())}`;
    const inputSignature = sha256(stableJson({
      count: group.commits.length,
      evidenceIds: group.commits.map((commit) => commit.id),
      projectKey: group.projectKey,
    }));
    if (store.getSetting(settingKey) === inputSignature) {
      metrics.skipped += 1;
      return metrics;
    }
    const lines = [
      "# Git历史证据汇总",
      `- repository: ${group.repoPath}`,
      `- project_key: ${group.projectKey ?? "未归类"}`,
      "",
      ...group.commits.map((commit) =>
        `- [${commit.id}] ${commit.occurred_at ?? "unknown"} ${commit.external_id ?? ""} ${commit.metadata.author ?? ""}: ${commit.title}`,
      ),
    ];
    const text = lines.join("\n");
    const digestHash = sha256(text);
    let firstDigestEvidenceId = null;
    for (const chunk of splitTextChunks(text, Math.max(4000, config.collection.maxEvidenceChars - 1000))) {
      const result = store.addEvidence({
        sourceId: source.id,
        kind: "git_history_digest",
        occurredAt: group.commits[0]?.occurred_at ?? null,
        projectKey: group.projectKey,
        title: `${path.basename(group.repoPath)} Git history [${chunk.index + 1}]`,
        content: safeEvidenceText(chunk.text, config.collection.maxEvidenceChars),
        sourceLocator: `shadow-agent://git-digest/${sha256(group.repoPath).slice(0, 16)}#chars=${chunk.start}-${chunk.end}`,
        externalId: `${digestHash}:${chunk.index}`,
        fingerprint: sha256(`git-digest-v1:${group.repoPath.toLowerCase()}:${digestHash}:${chunk.index}`),
        metadata: { repoPath: group.repoPath, digestHash, chunkIndex: chunk.index, commitCount: group.commits.length },
      });
      firstDigestEvidenceId ??= result.id;
      if (result.inserted) metrics.evidence += 1;
      const idsInChunk = group.commits.map((item) => item.id).filter((id) => chunk.text.includes(id));
      store.linkEvidence(result.id, idsInChunk, "summarizes");
      metrics.links += idsInChunk.length;
      metrics.chunks += 1;
    }
    const supersededIds = store.db.prepare(`
      SELECT id FROM evidence
      WHERE kind='git_history_digest'
        AND json_extract(metadata_json,'$.repoPath')=?
        AND COALESCE(json_extract(metadata_json,'$.digestHash'),'') <> ?
    `).all(group.repoPath, digestHash).map((row) => row.id);
    if (firstDigestEvidenceId && supersededIds.length) {
      store.linkEvidence(firstDigestEvidenceId, supersededIds, "supersedes");
    }
    store.setSetting(settingKey, inputSignature);
  metrics.repositories += 1;
  return metrics;
}

function documentScore(fullPath) {
  const normalized = String(fullPath ?? "").replaceAll("\\", "/").toLowerCase();
  const base = path.basename(normalized);
  let score = 0;
  if (/^(readme|agents|claude)(\.|$)/i.test(base)) score += 160;
  if (/(^|\/)(docs?|design|spec|requirements?|方案|设计|需求|文档)(\/|$)/i.test(normalized)) score += 90;
  if (/(architecture|design|spec|requirement|proposal|plan|summary|report|decision|todo|roadmap|架构|设计|方案|需求|总结|报告|决策|计划)/i.test(normalized)) score += 70;
  if (/\.(md|rst|adoc|txt)$/i.test(base)) score += 45;
  if (/(^|\/)(test-results?|e2e-artifacts?|coverage|logs?|generated|fixtures?|vendor|third_party)(\/|$)/i.test(normalized)) score -= 150;
  if (/\.(json|csv|html)$/i.test(base)) score -= 35;
  return score;
}

function collectProjectDocumentDigest(store, config, source, projectKey) {
  const metrics = { projects: 0, skipped: 0, documents: 0, chunks: 0, evidence: 0, links: 0 };
  const rowsQuery = store.db.prepare(`
    SELECT * FROM evidence
    WHERE kind='project_document' AND project_key=?
    ORDER BY COALESCE(occurred_at,collected_at) DESC, collected_at DESC, id
  `);
  const projectQuery = store.db.prepare("SELECT * FROM projects WHERE project_key=? LIMIT 1");

  const rows = rowsQuery.all(projectKey);
  if (!rows.length) {
    metrics.skipped += 1;
    return metrics;
  }
  const summary = {
    project_key: projectKey,
    input_count: rows.length,
    input_max: rows.reduce((latest, row) => String(row.collected_at ?? "") > latest ? String(row.collected_at) : latest, ""),
  };
  const settingKey = `digest:project-documents:${summary.project_key}`;
    const signature = sha256(stableJson({
      version: PROJECT_DIGEST_VERSION,
      count: summary.input_count,
      maxCollectedAt: summary.input_max,
      limit: config.collection.projectDigestDocumentLimit,
      excerptChars: config.collection.projectDigestExcerptChars,
    }));
    if (store.getSetting(settingKey) === signature) {
      metrics.skipped += 1;
      return metrics;
    }

    const files = new Map();
    for (const row of rows) {
      const metadata = JSON.parse(row.metadata_json || "{}");
      const fullPath = metadata.fullPath ?? row.source_locator.replace(/#chars=.*$/, "");
      const fileKey = fullPath.toLowerCase();
      const contentHash = metadata.contentHash ?? row.external_id?.split(":")[0] ?? "";
      if (!files.has(fileKey)) {
        files.set(fileKey, { fullPath, contentHash, occurredAt: row.occurred_at, chunks: new Map() });
      }
      const file = files.get(fileKey);
      if (file.contentHash !== contentHash) continue;
      const chunkIndex = Number(metadata.chunkIndex ?? 0);
      if (!file.chunks.has(chunkIndex)) file.chunks.set(chunkIndex, row);
    }

    const selected = [...files.values()]
      .map((file) => ({ ...file, score: documentScore(file.fullPath) }))
      .sort((a, b) => b.score - a.score || String(b.occurredAt ?? "").localeCompare(String(a.occurredAt ?? "")) || a.fullPath.localeCompare(b.fullPath))
      .slice(0, config.collection.projectDigestDocumentLimit);
    const project = projectQuery.get(summary.project_key);
    const lines = [
      "# 项目文档证据索引",
      `- project_key: ${summary.project_key}`,
      `- project_name: ${project?.name ?? "未知"}`,
      `- root_path: ${project?.root_path ?? "未知"}`,
      `- indexed_documents: ${selected.length}`,
      `- catalogued_documents: ${files.size}`,
      `- omitted_low_signal_documents: ${Math.max(0, files.size - selected.length)}`,
      "",
      "## 高信号文档与摘要",
    ];
    const linkedIds = [];
    for (const file of selected) {
      const chunks = [...file.chunks.entries()].sort(([a], [b]) => a - b).map(([, row]) => row);
      linkedIds.push(...chunks.map((row) => row.id));
      const excerpt = safeEvidenceText(
        chunks.map((row) => row.content).join("\n"),
        config.collection.projectDigestExcerptChars,
      ).replace(/\r?\n/g, " ");
      lines.push(`- [${chunks[0]?.id ?? "unknown"}] ${file.fullPath} @ ${file.occurredAt ?? "unknown"} :: ${excerpt}`);
    }

    const text = lines.join("\n");
    const digestHash = sha256(text);
    let firstDigestEvidenceId = null;
    for (const chunk of splitTextChunks(text, Math.max(4000, config.collection.maxEvidenceChars - 1000))) {
      const result = store.addEvidence({
        sourceId: source.id,
        kind: "project_document_digest",
        occurredAt: summary.input_max,
        projectKey: summary.project_key,
        title: `${project?.name ?? summary.project_key} document index [${chunk.index + 1}]`,
        content: safeEvidenceText(chunk.text, config.collection.maxEvidenceChars),
        sourceLocator: `shadow-agent://project-document-digest/${summary.project_key}#chars=${chunk.start}-${chunk.end}`,
        externalId: `${summary.project_key}:${digestHash}:${chunk.index}`,
        fingerprint: sha256(`project-document-digest-v${PROJECT_DIGEST_VERSION}:${summary.project_key}:${digestHash}:${chunk.index}`),
        metadata: { projectKey: summary.project_key, digestHash, chunkIndex: chunk.index, selectedDocuments: selected.length, cataloguedDocuments: files.size },
      });
      firstDigestEvidenceId ??= result.id;
      if (result.inserted) metrics.evidence += 1;
      const idsInChunk = linkedIds.filter((id) => chunk.text.includes(id));
      store.linkEvidence(result.id, idsInChunk, "summarizes");
      metrics.links += idsInChunk.length;
      metrics.chunks += 1;
    }
    const supersededIds = store.db.prepare(`
      SELECT id FROM evidence
      WHERE kind='project_document_digest' AND project_key=?
        AND COALESCE(json_extract(metadata_json,'$.digestHash'),'') <> ?
    `).all(summary.project_key, digestHash).map((row) => row.id);
    if (firstDigestEvidenceId && supersededIds.length) {
      store.linkEvidence(firstDigestEvidenceId, supersededIds, "supersedes");
    }
    store.setSetting(settingKey, signature);
  metrics.projects += 1;
  metrics.documents += selected.length;
  return metrics;
}

export function buildDigests(store, config) {
  const source = store.upsertSource({
    sourceKey: "shadow-agent:digests",
    kind: "shadow_agent_digest",
    uri: "shadow-agent://digests",
  });
  const result = {
    queue: { selected: 0, processed: 0, failed: 0, remaining: 0, errors: [] },
    threads: { threads: 0, skipped: 0, chunks: 0, evidence: 0, links: 0, archived: 0, deleted: 0 },
    git: { repositories: 0, skipped: 0, chunks: 0, evidence: 0, links: 0 },
    projectDocuments: { projects: 0, skipped: 0, documents: 0, chunks: 0, evidence: 0, links: 0 },
  };
  const targets = store.pendingDigestTargets(
    config.collection.digestTargetsPerCollection ?? 30,
    { threadQuietSeconds: config.collection.digestThreadQuietSeconds ?? 120 },
  );
  result.queue.selected = targets.length;
  const mergeMetrics = (destination, values) => {
    for (const [key, value] of Object.entries(values)) destination[key] = (destination[key] ?? 0) + value;
  };
  for (const target of targets) {
    try {
      if (target.entity_type === "thread") {
        mergeMetrics(result.threads, collectThreadDigest(store, config, source, target.entity_key));
      } else if (target.entity_type === "git") {
        mergeMetrics(result.git, collectGitDigest(store, config, source, target.entity_key));
      } else if (target.entity_type === "project_documents") {
        mergeMetrics(result.projectDocuments, collectProjectDocumentDigest(store, config, source, target.entity_key));
      }
      store.completeDigestTarget(target.entity_type, target.entity_key);
      result.queue.processed += 1;
    } catch (error) {
      store.failDigestTarget(target.entity_type, target.entity_key, error.message);
      result.queue.failed += 1;
      result.queue.errors.push({ entityType: target.entity_type, entityKey: target.entity_key, error: error.message });
    }
  }
  result.queue.remaining = store.digestQueueCount();
  return result;
}
