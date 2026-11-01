import { sha256, stableJson, truncateUtf8 } from "./utils.mjs";

export const KNOWLEDGE_ENTRY_VERSION = 1;
export const ENTRY_KINDS = ["git_repository_snapshot", "git_history_digest", "project_document_digest", "project_document"];
export const DOCUMENT_CATALOG_LEAVES_SQL = `SELECT e.id,e.kind,e.source_id,e.project_key,e.source_locator,e.metadata_json
  FROM evidence_links l CROSS JOIN evidence e ON e.id=l.child_evidence_id
  WHERE l.parent_evidence_id=? AND l.relation='summarizes' AND e.kind='project_document'`;
const parse = value => { try { return JSON.parse(value || "{}"); } catch { return {}; } };
const normalizePath = value => String(value ?? "").replaceAll("\\", "/").toLowerCase();
const repoExpression = "lower(replace(COALESCE(CASE WHEN json_valid(metadata_json) THEN COALESCE(json_extract(metadata_json,'$.repoPath'),json_extract(metadata_json,'$.rootPath')) END, source_locator), char(92), '/'))";
const documentExpression = `lower(replace(COALESCE(
  CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'$.fullPath') END,
  CASE WHEN instr(source_locator,'#chars=')>0 THEN substr(source_locator,1,instr(source_locator,'#chars=')-1) ELSE source_locator END
), char(92), '/'))`;

export function initializeKnowledgeEntries(database) {
  database.exec(`CREATE INDEX IF NOT EXISTS evidence_repository_entry_idx ON evidence(kind, ${repoExpression})
    WHERE kind IN ('git_repository_snapshot','git_history_digest');
    CREATE INDEX IF NOT EXISTS evidence_document_entry_idx ON evidence(kind, source_id, ${documentExpression})
    WHERE kind='project_document';`);
}

export function entryTarget(evidence) {
  const metadata = parse(evidence.metadata_json);
  if (["git_repository_snapshot", "git_history_digest"].includes(evidence.kind)) {
    const locator = metadata.repoPath ?? metadata.rootPath ?? evidence.source_locator;
    return { kind: "repository", key: normalizePath(locator), locator };
  }
  if (evidence.kind === "project_document") {
    const locator = metadata.fullPath ?? evidence.source_locator?.replace(/#chars=.*$/, "");
    return { kind: "document", key: `${evidence.source_id}:${normalizePath(locator)}`, locator,
      sourceId: evidence.source_id, pathKey: normalizePath(locator) };
  }
  if (evidence.kind === "project_document_digest") {
    return { kind: "document-set", key: evidence.project_key ?? evidence.id, projectKey: evidence.project_key, evidenceId: evidence.id };
  }
  return null;
}

export function collectEntryTargets(rows) {
  const targets = new Map();
  for (const row of rows) {
    const target = entryTarget(row);
    if (target?.key) targets.set(`${target.kind}:${target.key}`, target);
  }
  return [...targets.values()];
}

// Promote documents already selected by the document catalog, not every JSON/log
// that a historical filesystem scan happened to capture. Original evidence stays searchable.
export function maintainedEntryRows(database, incoming) {
  const rows = incoming ? incoming.filter(row => ENTRY_KINDS.includes(row.kind)) : database.prepare(`SELECT id,kind,source_id,project_key,source_locator,metadata_json
    FROM evidence WHERE kind IN ('git_repository_snapshot','git_history_digest','project_document_digest') ORDER BY rowid`).all();
  if (!rows.length) return [];
  const result = rows.filter(row => row.kind !== "project_document");
  const projects = [...new Set(rows.filter(row => ["project_document_digest", "project_document"].includes(row.kind)).map(row => row.project_key))];
  for (const project of projects) {
    const digests = database.prepare(`SELECT * FROM evidence WHERE kind='project_document_digest' AND project_key IS ?
      AND NOT EXISTS(SELECT 1 FROM evidence_links l WHERE l.child_evidence_id=evidence.id AND l.relation='supersedes')
      ORDER BY collected_at DESC, rowid DESC`).all(project);
    for (const digest of currentRows(digests, "digestHash")) {
      // Keep the exact parent lookup outermost even with old SQLite statistics.
      result.push(...database.prepare(DOCUMENT_CATALOG_LEAVES_SQL).all(digest.id));
    }
  }
  const known = incoming && !projects.length ? [] : database.prepare(`SELECT metadata_json, project_key FROM graph_entities WHERE type='Document'
    AND json_extract(metadata_json,'$.knowledgeEntry.kind')='document'
    ${incoming ? `AND project_key IN (${projects.map(() => "?").join(",")})` : ''}`).all(...(incoming ? projects : []));
  for (const row of known) {
    const metadata = parse(row.metadata_json);
    if (!incoming || projects.includes(row.project_key)) result.push({ kind: "project_document",
      source_id: metadata.sourceId, project_key: row.project_key, source_locator: metadata.fullPath,
      metadata_json: stableJson({ fullPath: metadata.fullPath }) });
  }
  return result;
}

function currentRows(rows, versionKey) {
  if (!rows.length) return [];
  const version = parse(rows[0].metadata_json)[versionKey];
  // A versionless legacy record is a standalone observation, not an inferred generation.
  if (!version) return [rows[0]];
  const chunks = new Map();
  for (const row of rows) {
    const metadata = parse(row.metadata_json);
    if (metadata[versionKey] !== version) continue;
    const index = Number(metadata.chunkIndex ?? 0);
    if (!chunks.has(index)) chunks.set(index, row);
  }
  return [...chunks.entries()].sort(([a], [b]) => a - b).map(([, row]) => row);
}

function boundedExcerpt(rows, bytes) {
  let remaining = bytes;
  const parts = [];
  for (const row of rows) {
    if (remaining < 128) break;
    const text = truncateUtf8(row.content || "", remaining);
    parts.push(text);
    remaining -= Buffer.byteLength(text, "utf8") + 1;
  }
  return parts.join("\n");
}

function finish(input, sources, details) {
  const text = truncateUtf8(input.summary, 10000);
  const sourceIds = sources.map(row => row.id).sort();
  return { input: { ...input, summary: text, metadata: { ...input.metadata,
    knowledgeEntry: { version: KNOWLEDGE_ENTRY_VERSION, ...details, searchText: text,
      sourceCount: sources.length, revision: sha256(stableJson({ sourceIds, text, details })) } } }, sources };
}

export function buildKnowledgeEntry(database, target) {
  if (target.kind === "repository") {
    const rows = database.prepare(`SELECT rowid AS entry_rowid, * FROM evidence
      WHERE kind IN ('git_repository_snapshot','git_history_digest') AND ${repoExpression}=?
        AND NOT EXISTS(SELECT 1 FROM evidence_links l WHERE l.child_evidence_id=evidence.id AND l.relation='supersedes')
      ORDER BY collected_at DESC, rowid DESC`).all(target.key);
    const snapshot = rows.filter(row => row.kind === "git_repository_snapshot").sort((a, b) =>
      String(b.occurred_at ?? b.collected_at).localeCompare(String(a.occurred_at ?? a.collected_at))
      || b.entry_rowid - a.entry_rowid)[0];
    const histories = currentRows(rows.filter(row => row.kind === "git_history_digest"), "digestHash");
    const first = snapshot ?? histories[0];
    if (!first) return null;
    const previous = database.prepare(`SELECT canonical_key FROM graph_entities WHERE type='Repository'
      AND lower(replace(COALESCE(json_extract(metadata_json,'$.repoPath'),''),char(92),'/'))=? LIMIT 1`).get(target.key);
    const historyText = boundedExcerpt(histories, 6000);
    return finish({ canonicalKey: previous?.canonical_key ?? `repository:${String(target.locator).toLowerCase()}`,
      type: "Repository", name: target.locator.split(/[\\/]/).filter(Boolean).at(-1),
      summary: `Repository: ${target.locator}\nCurrent checkout observation:\n${snapshot ? truncateUtf8(snapshot.content, 2000) : 'Not collected'}\nHistorical lookup clues (not proof of current code):\n${historyText || 'Not collected'}\nHistory chunks: ${histories.length}; excerpt is bounded; follow source links for full history.`,
      aliases: [target.locator], projectKey: first.project_key, observedAt: first.collected_at,
      metadata: { repoPath: target.locator, sourceKind: "repository_entry" } },
    [...(snapshot ? [snapshot] : []), ...histories], { kind: target.kind, snapshotEvidenceId: snapshot?.id ?? null,
      historyGeneration: parse(histories[0]?.metadata_json).digestHash ?? null, historyChunks: histories.length });
  }
  if (target.kind === "document") {
    const rows = database.prepare(`SELECT rowid AS entry_rowid, * FROM evidence WHERE kind='project_document'
      AND source_id=? AND ${documentExpression}=?
      AND NOT EXISTS(SELECT 1 FROM evidence_links l WHERE l.child_evidence_id=evidence.id AND l.relation='supersedes')
      ORDER BY COALESCE(occurred_at,collected_at) DESC, collected_at DESC, rowid DESC`).all(target.sourceId, target.pathKey);
    const chunks = currentRows(rows, "contentHash");
    if (!chunks.length) return null;
    const first = chunks[0];
    const metadata = parse(first.metadata_json);
    return finish({ canonicalKey: `document:local:${sha256(target.key).slice(0, 32)}`, type: "Document",
      name: target.locator, summary: `Local document: ${target.locator}\n${boundedExcerpt(chunks, 6000)}\nChunks: ${chunks.length}; bounded excerpt; read the file or linked evidence for details.`,
      aliases: [target.locator, target.locator.split(/[\\/]/).at(-1)], projectKey: first.project_key,
      observedAt: first.occurred_at ?? first.collected_at,
      metadata: { sourceKind: "project_document", sourceLocator: target.locator, fullPath: target.locator, sourceId: target.sourceId } },
    chunks, { kind: target.kind, contentHash: metadata.contentHash ?? null, chunks: chunks.length });
  }
  const rows = target.projectKey
    ? database.prepare(`SELECT rowid AS entry_rowid, * FROM evidence WHERE kind='project_document_digest' AND project_key=?
        AND NOT EXISTS(SELECT 1 FROM evidence_links l WHERE l.child_evidence_id=evidence.id AND l.relation='supersedes')
        ORDER BY collected_at DESC, rowid DESC`).all(target.projectKey)
    : database.prepare("SELECT * FROM evidence WHERE id=?").all(target.evidenceId);
  const chunks = currentRows(rows, "digestHash");
  if (!chunks.length) return null;
  const metadata = parse(chunks[0].metadata_json);
  return finish({ canonicalKey: `document-set:${target.key}`, type: "DocumentSet",
    name: `${target.projectKey ?? 'Unassigned'} project documents`,
    summary: `Project document directory: ${target.projectKey ?? 'Unassigned'}\nIndexed documents: ${metadata.selectedDocuments ?? 'unknown'}; catalogued documents: ${metadata.cataloguedDocuments ?? 'unknown'}; index chunks: ${chunks.length}.\nEach collected local file has a Document entry. Follow source links for the complete directory.`,
    projectKey: target.projectKey, observedAt: chunks[0].collected_at, metadata: { sourceKind: "project_document_digest" } },
  chunks, { kind: target.kind, digestHash: metadata.digestHash ?? null, chunks: chunks.length });
}
