import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { DatabaseSync } from "node:sqlite";

import { logger } from "../logger.mjs";
import { normalizeCodexThreadTitle } from "../codex-thread-title.mjs";
import { adapterSourceMetadata, getSourceAdapter, publicSourceAdapter } from "../source-adapters/index.mjs";
import { codexRolloutEvidence } from "../source-adapters/providers/codex.mjs";
import { isBlockedPath, safeEvidenceText, sha256, splitTextChunks, stableJson } from "../utils.mjs";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function flattenLocalProjects(value) {
  const candidate = Array.isArray(value) ? Object.assign({}, ...value) : value;
  if (!candidate || typeof candidate !== "object") return [];
  return Object.values(candidate).filter((item) => item && typeof item === "object");
}

function projectForPath(projects, targetPath) {
  const normalized = path.resolve(targetPath || "").toLowerCase();
  return projects
    .filter((project) => normalized === project.rootPath.toLowerCase() || normalized.startsWith(`${project.rootPath.toLowerCase()}${path.sep}`))
    .sort((a, b) => b.rootPath.length - a.rootPath.length)[0] ?? null;
}

function listRollouts(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) result.push(fullPath);
    }
  }
  return result;
}

function listMemoryDocuments(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && [".md", ".txt"].includes(path.extname(entry.name).toLowerCase())) result.push(fullPath);
    }
  }
  return result;
}

function collectMemoryDocuments(store, config, metrics) {
  const memoryRoot = path.join(config.paths.codexHome, "memories");
  for (const filePath of listMemoryDocuments(memoryRoot)) {
    if (isBlockedPath(filePath, config.policy.blockedPaths)) continue;
    let stat;
    try {
      stat = fs.statSync(filePath);
      if (stat.size > Math.max(config.collection.maxDocumentBytes, 8 * 1024 * 1024)) continue;
    } catch {
      continue;
    }
    const sourceKey = `codex-memory:${path.resolve(filePath).toLowerCase()}`;
    const source = store.upsertSource({
      sourceKey,
      kind: "codex_memory",
      uri: filePath,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      metadata: adapterSourceMetadata("codex", { documentKind: "memory" }),
    });
    const content = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    const contentHash = sha256(content);
    for (const chunk of splitTextChunks(content, Math.max(2000, config.collection.maxEvidenceChars - 1000))) {
      const evidence = store.addEvidence({
        sourceId: source.id,
        kind: "codex_memory_document",
        occurredAt: stat.mtime.toISOString(),
        title: `${path.relative(memoryRoot, filePath)} [${chunk.index + 1}]`,
        content: safeEvidenceText(chunk.text, config.collection.maxEvidenceChars),
        sourceLocator: `${filePath}#chars=${chunk.start}-${chunk.end}`,
        externalId: `${contentHash}:${chunk.index}`,
        fingerprint: sha256(`codex-memory-v1:${filePath.toLowerCase()}:${contentHash}:${chunk.index}`),
        metadata: { filePath, contentHash, chunkIndex: chunk.index },
      });
      if (evidence.inserted) metrics.evidence += 1;
    }
    store.updateSourceCursor(sourceKey, {
      cursorBytes: stat.size,
      sizeBytes: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
    });
    metrics.memoryDocuments += 1;
  }
}

export async function* readLinesFromOffset(filePath, startOffset = 0, maxLines = Infinity, endOffsetExclusive = Infinity) {
  if (Number.isFinite(endOffsetExclusive) && endOffsetExclusive <= startOffset) return;
  const streamOptions = { start: startOffset };
  if (Number.isFinite(endOffsetExclusive)) streamOptions.end = endOffsetExclusive - 1;
  const stream = fs.createReadStream(filePath, streamOptions);
  let pending = Buffer.alloc(0);
  let absoluteOffset = startOffset;
  let emitted = 0;
  for await (const chunk of stream) {
    const buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let lineStart = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      if (buffer[index] !== 0x0a) continue;
      const lineBuffer = buffer.subarray(lineStart, index);
      const decoder = new StringDecoder("utf8");
      const line = decoder.write(lineBuffer) + decoder.end();
      const consumedBytes = index - lineStart + 1;
      const locatorOffset = absoluteOffset;
      absoluteOffset += consumedBytes;
      lineStart = index + 1;
      emitted += 1;
      yield { line: line.replace(/\r$/, ""), startOffset: locatorOffset, endOffset: absoluteOffset };
      if (emitted >= maxLines) {
        stream.destroy();
        return;
      }
    }
    pending = buffer.subarray(lineStart);
  }
}

function normalizedRolloutPath(value) {
  return path.resolve(String(value ?? "").replace(/^\\\\\?\\/, "")).toLowerCase();
}

export async function collectCodex(store, config, options = {}) {
  const codexHome = config.paths.codexHome;
  const statePath = path.join(codexHome, ".codex-global-state.json");
  const stateDbPath = path.join(codexHome, "state_5.sqlite");
  const metrics = {
    adapter: publicSourceAdapter(getSourceAdapter("codex")),
    projects: 0,
    threads: 0,
    memoryDocuments: 0,
    rolloutFiles: 0,
    lines: 0,
    evidence: 0,
    malformed: 0,
    lineBudgetExhausted: false,
    errors: [],
  };
  if (!fs.existsSync(statePath)) throw new Error(`Codex state file not found: ${statePath}`);
  if (isBlockedPath(statePath, config.policy.blockedPaths)) throw new Error(`Blocked Codex state path: ${statePath}`);

  const globalState = readJson(statePath);
  const projects = [];
  for (const project of flattenLocalProjects(globalState["local-projects"])) {
    for (const rootPathValue of project.rootPaths ?? []) {
      const rootPath = path.resolve(rootPathValue);
      const item = { projectKey: project.id, name: project.name ?? path.basename(rootPath), rootPath };
      projects.push(item);
      store.upsertProject({ ...item, metadata: { createdAt: project.createdAt, updatedAt: project.updatedAt } });
      metrics.projects += 1;
    }
  }

  const threadByRollout = new Map();
  if (fs.existsSync(stateDbPath)) {
    const stateDb = new DatabaseSync(stateDbPath, { readOnly: true });
    try {
      const rows = stateDb.prepare(`
        SELECT id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
          cwd, title, archived, source, model_provider, git_sha, git_branch, git_origin_url,
          preview, name, model, reasoning_effort
        FROM threads
      `).all();
      for (const row of rows) {
        const project = projectForPath(projects, row.cwd);
        const rolloutPath = String(row.rollout_path ?? "").replace(/^\\\\\?\\/, "");
        const thread = {
          id: row.id,
          title: normalizeCodexThreadTitle({
            id: row.id,
            name: row.name,
            title: row.title,
            cwd: row.cwd,
          }, config.codex?.titleMaintenance?.maxThreadTitleChars),
          cwd: row.cwd || "",
          rolloutPath,
          createdAtMs: row.created_at_ms || row.created_at || 0,
          updatedAtMs: row.updated_at_ms || row.updated_at || 0,
          archived: Boolean(row.archived),
          projectKey: project?.projectKey ?? null,
          metadata: {
            source: row.source,
            modelProvider: row.model_provider,
            gitSha: row.git_sha,
            gitBranch: row.git_branch,
            gitOriginUrl: row.git_origin_url,
            preview: safeEvidenceText(row.preview ?? "", 1000),
            model: row.model,
            reasoningEffort: row.reasoning_effort,
          },
        };
        store.upsertThread(thread);
        if (rolloutPath) threadByRollout.set(normalizedRolloutPath(rolloutPath), thread);
        metrics.threads += 1;
      }
    } finally {
      stateDb.close();
    }
  }

  collectMemoryDocuments(store, config, metrics);

  const rolloutRoots = [path.join(codexHome, "sessions")];
  if (config.collection.includeArchivedSessions) rolloutRoots.push(path.join(codexHome, "archived_sessions"));
  let rolloutFiles = rolloutRoots.flatMap(listRollouts)
    .map((filePath) => {
      try {
        return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath));
  if (Number.isFinite(options.maxRollouts)) {
    rolloutFiles = rolloutFiles.slice(0, Math.max(0, Math.floor(options.maxRollouts)));
  }
  const configuredLineBudget = options.maxTotalRolloutLines ?? config.collection.maxRolloutLinesPerCycle;
  let remainingLineBudget = Number.isFinite(configuredLineBudget)
    ? Math.max(0, Math.floor(configuredLineBudget))
    : Infinity;
  const configuredTransactionLineLimit = Number(
    options.maxRolloutLinesPerTransaction
      ?? config.collection.maxRolloutLinesPerTransaction
      ?? 200,
  );
  const transactionLineLimit = Math.max(10, Math.min(
    1000,
    Number.isFinite(configuredTransactionLineLimit) ? configuredTransactionLineLimit : 200,
  ));

  for (let fileIndex = 0; fileIndex < rolloutFiles.length; fileIndex += 1) {
    if (remainingLineBudget <= 0) {
      metrics.lineBudgetExhausted = true;
      break;
    }
    const { filePath } = rolloutFiles[fileIndex];
    const stat = fs.statSync(filePath);
    const sourceKey = `codex-rollout:${normalizedRolloutPath(filePath)}`;
    const knownThread = threadByRollout.get(normalizedRolloutPath(filePath));
    let source = store.upsertSource({
      sourceKey,
      kind: "codex_rollout",
      uri: filePath,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      metadata: adapterSourceMetadata("codex", {
        threadId: knownThread?.id ?? null,
        projectKey: knownThread?.projectKey ?? null,
      }),
    });
    let cursor = Number(source.cursor_bytes ?? 0);
    if (cursor > stat.size) cursor = 0;
    if (cursor === stat.size && Number(source.mtime_ms) === Math.floor(stat.mtimeMs)) continue;

    let threadId = knownThread?.id ?? path.basename(filePath).match(/[0-9a-f]{8}-[0-9a-f-]{27}/i)?.[0] ?? null;
    let projectKey = knownThread?.projectKey ?? null;
    let lastOffset = cursor;
    let pendingEvidence = [];
    let pendingLines = 0;
    const flushBatch = () => {
      if (pendingLines === 0) return;
      const batchEvidence = pendingEvidence;
      const batchOffset = lastOffset;
      const inserted = store.transaction(() => {
        let count = 0;
        for (const evidence of batchEvidence) {
          if (store.addEvidence(evidence).inserted) count += 1;
        }
        store.updateSourceCursor(sourceKey, {
          cursorBytes: batchOffset,
          sizeBytes: stat.size,
          mtimeMs: Math.floor(stat.mtimeMs),
        });
        return count;
      });
      metrics.evidence += inserted;
      pendingEvidence = [];
      pendingLines = 0;
    };
    try {
      const perFileLimit = Math.min(options.maxLinesPerRollout ?? Infinity, remainingLineBudget);
      for await (const lineRecord of readLinesFromOffset(filePath, cursor, perFileLimit, stat.size)) {
        lastOffset = lineRecord.endOffset;
        metrics.lines += 1;
        remainingLineBudget -= 1;
        pendingLines += 1;
        if (lineRecord.line.trim()) {
          let row;
          try {
            row = JSON.parse(lineRecord.line);
          } catch {
            metrics.malformed += 1;
          }
          if (row) {
            if (row.type === "session_meta") {
              threadId = row.payload?.id ?? row.payload?.session_id ?? threadId;
              projectKey = projectForPath(projects, row.payload?.cwd)?.projectKey ?? projectKey;
            }
            const evidence = codexRolloutEvidence(
              row,
              { threadId, projectKey },
              config,
              `${filePath}#byte=${lineRecord.startOffset}`,
            );
            if (evidence) {
              evidence.sourceId = source.id;
              const isMessage = ["codex_user_message", "codex_agent_message"].includes(evidence.kind);
              evidence.fingerprint = sha256(stableJson({
                source: sourceKey,
                kind: evidence.kind,
                externalId: isMessage ? null : evidence.externalId,
                timestamp: isMessage ? String(evidence.occurredAt ?? "").slice(0, 19) : evidence.occurredAt,
                role: evidence.role,
                content: evidence.content,
              }));
              pendingEvidence.push(evidence);
            }
          }
        }
        if (pendingLines >= transactionLineLimit) flushBatch();
      }
      flushBatch();
      metrics.rolloutFiles += 1;
      if (remainingLineBudget <= 0 && (lastOffset < stat.size || fileIndex < rolloutFiles.length - 1)) {
        metrics.lineBudgetExhausted = true;
      }
    } catch (error) {
      try { store.markSourceError(sourceKey, error.message); } catch { /* another short writer may own the lock */ }
      metrics.errors.push({ filePath, error: error.message });
      logger.warn("Codex rollout collection failed", { filePath, error: error.message });
    }
  }

  return { metrics, projects };
}
