import fs from "node:fs";
import path from "node:path";

import { isBlockedPath, safeEvidenceText, sha256, splitTextChunks } from "../utils.mjs";

export async function collectImports(store, config) {
  const allowed = new Set(config.collection.documentExtensions.map((item) => item.toLowerCase()));
  const metrics = { roots: 0, files: 0, evidence: 0, errors: [] };
  for (const rootPath of config.paths.inboxRoots) {
    fs.mkdirSync(rootPath, { recursive: true });
    const source = store.upsertSource({
      sourceKey: `import-root:${rootPath.toLowerCase()}`,
      kind: "import_root",
      uri: rootPath,
      metadata: {},
    });
    const stack = [rootPath];
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch (error) {
        metrics.errors.push({ current, error: error.message });
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (path.resolve(fullPath).toLowerCase().split(path.sep).includes("private-profile")) continue;
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (!entry.isFile() || entry.name === ".gitkeep" || isBlockedPath(fullPath, config.policy.blockedPaths)) continue;
        const stat = fs.statSync(fullPath);
        const extension = path.extname(entry.name).toLowerCase();
        metrics.files += 1;
        if (!allowed.has(extension) || stat.size > config.collection.maxDocumentBytes) {
          store.upsertArtifact({
            sourceId: source.id,
            artifactPath: fullPath,
            kind: "unsupported_import",
            sizeBytes: stat.size,
            mtimeMs: Math.floor(stat.mtimeMs),
            metadata: { extension },
          });
          continue;
        }
        try {
          const content = fs.readFileSync(fullPath, "utf8").replace(/^\uFEFF/, "");
          const contentHash = sha256(content);
          const artifact = store.upsertArtifact({
            sourceId: source.id,
            artifactPath: fullPath,
            kind: "import_document",
            sizeBytes: stat.size,
            mtimeMs: Math.floor(stat.mtimeMs),
            contentHash,
            metadata: { extension },
          });
          for (const chunk of splitTextChunks(content, Math.max(2000, config.collection.maxEvidenceChars - 1000))) {
            const evidence = store.addEvidence({
              sourceId: source.id,
              kind: "import_document",
              occurredAt: stat.mtime.toISOString(),
              title: `${path.relative(rootPath, fullPath)} [${chunk.index + 1}]`,
              content: safeEvidenceText(chunk.text, config.collection.maxEvidenceChars),
              sourceLocator: `${fullPath}#chars=${chunk.start}-${chunk.end}`,
              externalId: `${contentHash}:${chunk.index}`,
              fingerprint: sha256(`import-v2:${fullPath.toLowerCase()}:${contentHash}:${chunk.index}`),
              metadata: { fullPath, rootPath, chunkIndex: chunk.index },
            });
            if (evidence.inserted) metrics.evidence += 1;
          }
        } catch (error) {
          metrics.errors.push({ fullPath, error: error.message });
        }
      }
    }
    metrics.roots += 1;
  }
  return metrics;
}
