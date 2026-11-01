import fs from "node:fs";
import path from "node:path";

import { logger } from "../logger.mjs";
import { runCommand } from "../process.mjs";
import { isBlockedPath, safeEvidenceText, sha256, splitTextChunks, stableJson } from "../utils.mjs";

function isSensitiveFile(filePath) {
  const lower = filePath.toLowerCase();
  const base = path.basename(lower);
  return base === ".env" || base === "auth.json" || /(^|[._-])(secret|credential|private[-_]?key)([._-]|$)/i.test(base);
}

function isNestedProjectRoot(candidate, currentRoot, allRoots) {
  const normalized = path.resolve(candidate).toLowerCase();
  if (normalized === path.resolve(currentRoot).toLowerCase()) return false;
  return allRoots.some((root) => path.resolve(root).toLowerCase() === normalized);
}

function documentExtensionSet(config) {
  return new Set(config.collection.documentExtensions.map((item) => item.toLowerCase()));
}

function gitSafeRemote(value) {
  return String(value ?? "").replace(/:\/\/[^/@\s]+@/g, "://[REDACTED]@");
}

async function git(repoPath, args, timeoutMs = 30000) {
  const result = await runCommand("git", ["-C", repoPath, ...args], { timeoutMs });
  return result.stdout.trim();
}

async function collectRepository(store, source, project, repoPath, config, metrics) {
  try {
    const [head, branch, status, remote, commits] = await Promise.all([
      git(repoPath, ["rev-parse", "HEAD"]).catch(() => ""),
      git(repoPath, ["branch", "--show-current"]).catch(() => ""),
      git(repoPath, ["status", "--porcelain=v2", "--branch"]).catch(() => ""),
      git(repoPath, ["remote", "get-url", "origin"]).catch(() => ""),
      git(repoPath, [
        "log",
        "--all",
        `-n${config.collection.gitCommitLimit}`,
        "--date=iso-strict",
        "--pretty=format:%H%x1f%aI%x1f%an%x1f%s",
      ]).catch(() => ""),
    ]);
    const snapshotContent = safeEvidenceText({
      repository: repoPath,
      head,
      branch,
      remote: gitSafeRemote(remote),
      status,
    }, config.collection.maxEvidenceChars);
    const snapshot = store.addEvidence({
      sourceId: source.id,
      kind: "git_repository_snapshot",
      occurredAt: new Date().toISOString(),
      projectKey: project.project_key,
      title: `Repository snapshot: ${path.basename(repoPath)}`,
      content: snapshotContent,
      sourceLocator: repoPath,
      externalId: head || null,
      fingerprint: sha256(stableJson({ repoPath, head, branch, status })),
      metadata: { repoPath, branch, head, remote: gitSafeRemote(remote) },
    });
    if (snapshot.inserted) metrics.evidence += 1;

    for (const line of commits.split(/\r?\n/).filter(Boolean)) {
      const [commitSha, authoredAt, author, subject] = line.split("\x1f");
      if (!commitSha) continue;
      const inserted = store.addEvidence({
        sourceId: source.id,
        kind: "git_commit",
        occurredAt: authoredAt || null,
        projectKey: project.project_key,
        title: subject || "Git commit",
        content: safeEvidenceText({ repository: repoPath, commit: commitSha, author, subject }, config.collection.maxEvidenceChars),
        sourceLocator: `${repoPath}#commit=${commitSha}`,
        externalId: commitSha,
        fingerprint: sha256(`git:${repoPath.toLowerCase()}:${commitSha}`),
        metadata: { repoPath, author, branch },
      });
      if (inserted.inserted) metrics.evidence += 1;
      metrics.commits += 1;
    }
    metrics.repositories += 1;
  } catch (error) {
    metrics.errors.push({ repoPath, error: error.message });
    logger.warn("Git repository collection failed", { repoPath, error: error.message });
  }
}

export async function collectProjects(store, config, options = {}) {
  const projects = store.db.prepare("SELECT * FROM projects ORDER BY LENGTH(root_path) DESC").all();
  const allRoots = projects.map((project) => project.root_path);
  const docExtensions = documentExtensionSet(config);
  const metrics = { projects: 0, files: 0, documents: 0, repositories: 0, commits: 0, evidence: 0, errors: [] };
  const maxFiles = options.maxProjectFiles ?? config.collection.maxProjectFiles;

  for (const project of projects) {
    const rootPath = project.root_path;
    if (path.resolve(rootPath).toLowerCase().split(path.sep).includes("private-profile")) continue;
    if (!fs.existsSync(rootPath) || isBlockedPath(rootPath, config.policy.blockedPaths)) continue;
    const stat = fs.statSync(rootPath);
    const sourceKey = `project-root:${rootPath.toLowerCase()}`;
    const source = store.upsertSource({
      sourceKey,
      kind: "project_root",
      uri: rootPath,
      sizeBytes: 0,
      mtimeMs: stat.mtimeMs,
      metadata: { projectKey: project.project_key, name: project.name },
    });
    const stack = [{ directory: rootPath, depth: 0 }];
    const repositories = new Set();
    let projectFileCount = 0;

    while (stack.length && projectFileCount < maxFiles) {
      const { directory, depth } = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch (error) {
        metrics.errors.push({ directory, error: error.message });
        continue;
      }
      const hasGit = entries.some((entry) => entry.name === ".git" && (entry.isDirectory() || entry.isFile()));
      if (hasGit) repositories.add(directory);

      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (entry.name.toLowerCase() === "private-profile" || config.collection.ignoredDirectories.includes(entry.name)) continue;
          if (depth >= config.collection.projectScanDepth) continue;
          if (isNestedProjectRoot(fullPath, rootPath, allRoots)) continue;
          stack.push({ directory: fullPath, depth: depth + 1 });
          continue;
        }
        if (!entry.isFile() || isSensitiveFile(fullPath) || isBlockedPath(fullPath, config.policy.blockedPaths)) continue;
        projectFileCount += 1;
        metrics.files += 1;
        let fileStat;
        try {
          fileStat = fs.statSync(fullPath);
        } catch {
          continue;
        }
        const extension = path.extname(entry.name).toLowerCase();
        const isDocument = docExtensions.has(extension) && fileStat.size <= config.collection.maxDocumentBytes;
        let content = null;
        let contentHash = null;
        if (isDocument) {
          try {
            content = fs.readFileSync(fullPath, "utf8").replace(/^\uFEFF/, "");
            contentHash = sha256(content);
          } catch {
            content = null;
          }
        }
        const artifact = store.upsertArtifact({
          sourceId: source.id,
          artifactPath: fullPath,
          kind: isDocument ? "document" : "file",
          sizeBytes: fileStat.size,
          mtimeMs: Math.floor(fileStat.mtimeMs),
          contentHash,
          metadata: { extension, projectKey: project.project_key },
        });
        if (isDocument && content !== null) {
          for (const chunk of splitTextChunks(content, Math.max(2000, config.collection.maxEvidenceChars - 1000))) {
            const evidence = store.addEvidence({
              sourceId: source.id,
              kind: "project_document",
              occurredAt: fileStat.mtime.toISOString(),
              projectKey: project.project_key,
              title: `${path.relative(rootPath, fullPath)} [${chunk.index + 1}]`,
              content: safeEvidenceText(chunk.text, config.collection.maxEvidenceChars),
              sourceLocator: `${fullPath}#chars=${chunk.start}-${chunk.end}`,
              externalId: `${contentHash}:${chunk.index}`,
              fingerprint: sha256(`project-document-v2:${fullPath.toLowerCase()}:${contentHash}:${chunk.index}`),
              metadata: { fullPath, sizeBytes: fileStat.size, contentHash, chunkIndex: chunk.index, chunkStart: chunk.start, chunkEnd: chunk.end },
            });
            if (evidence.inserted) metrics.evidence += 1;
          }
          metrics.documents += 1;
        }
      }
    }

    for (const repoPath of repositories) {
      await collectRepository(store, source, project, repoPath, config, metrics);
    }
    store.updateSourceCursor(sourceKey, {
      cursorBytes: projectFileCount,
      sizeBytes: projectFileCount,
      mtimeMs: Math.floor(stat.mtimeMs),
    });
    metrics.projects += 1;
  }

  return metrics;
}
