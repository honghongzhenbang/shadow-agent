import fs from "node:fs";

import { nowIso, sha256, stableJson, truncateUtf8, entrySearchSummary } from "./utils.mjs";
import {
  deriveFactTrust,
  isEffectiveAt,
  normalizeEvidenceStance,
  reviewStateFromLegacy,
  validateSupersession,
} from "./knowledge-policy.mjs";

export const EPISTEMIC_GRAPH_VERSION = "epistemic-context-v4";
export const KNOWLEDGE_ANNOTATION_VERSION = 1;

export const EVIDENCE_LEVELS = Object.freeze({
  0: { code: "E0", name: "推测", description: "仅有假设、模型推断或待验证关联，没有直接来源。" },
  1: { code: "E1", name: "陈述", description: "来自人员陈述、二手材料或摘要，尚未核对原始对象。" },
  2: { code: "E2", name: "实物证据", description: "已直接检查源代码、提交、文档、消息、记录或结构化数据。" },
  3: { code: "E3", name: "受控执行", description: "已在本地或仿真环境完成构建、静态检查、单元测试或可复现实验。" },
  4: { code: "E4", name: "集成验证", description: "已在目标集成环境、硬件在环或端到端链路完成验证。" },
  5: { code: "E5", name: "现场确认", description: "已在真实现场或生产环境观察，并在明确范围内获得责任人验收。" },
});

const GRAPH_MODEL_SCHEMA = `
CREATE TABLE IF NOT EXISTS graph_entity_types (
  type TEXT PRIMARY KEY,
  parent_type TEXT,
  top_class TEXT NOT NULL DEFAULT 'Entity',
  description TEXT NOT NULL DEFAULT '',
  aliases_json TEXT NOT NULL DEFAULT '[]',
  origin TEXT NOT NULL DEFAULT 'learned',
  schema_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS graph_entity_types_parent_idx
  ON graph_entity_types(parent_type, top_class);

CREATE TABLE IF NOT EXISTS graph_relation_types (
  predicate TEXT PRIMARY KEY,
  inverse_predicate TEXT,
  description TEXT NOT NULL DEFAULT '',
  aliases_json TEXT NOT NULL DEFAULT '[]',
  symmetric INTEGER NOT NULL DEFAULT 0,
  transitive INTEGER NOT NULL DEFAULT 0,
  functional INTEGER NOT NULL DEFAULT 0,
  temporal INTEGER NOT NULL DEFAULT 1,
  forward_impact_weight REAL NOT NULL DEFAULT 0,
  reverse_impact_weight REAL NOT NULL DEFAULT 0,
  max_impact_hops INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'learned',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS graph_evidence_assessments (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  fact_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  stance TEXT NOT NULL DEFAULT 'supports',
  level INTEGER NOT NULL DEFAULT 0,
  basis TEXT NOT NULL DEFAULT 'inference',
  directness TEXT NOT NULL DEFAULT 'inferred',
  method TEXT NOT NULL DEFAULT 'inference',
  environment TEXT NOT NULL DEFAULT 'unknown',
  outcome TEXT NOT NULL DEFAULT 'inconclusive',
  confidence REAL NOT NULL DEFAULT 0.5,
  scope_json TEXT NOT NULL DEFAULT '{}',
  assessed_by TEXT NOT NULL,
  assessed_at TEXT NOT NULL,
  valid_until TEXT,
  notes TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(fact_id) REFERENCES graph_facts(id) ON DELETE CASCADE,
  FOREIGN KEY(evidence_id) REFERENCES evidence(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS graph_evidence_assessments_fact_idx
  ON graph_evidence_assessments(fact_id, stance, level DESC, assessed_at DESC);
CREATE INDEX IF NOT EXISTS graph_evidence_assessments_evidence_idx
  ON graph_evidence_assessments(evidence_id, assessed_at DESC);

CREATE TABLE IF NOT EXISTS graph_derivations (
  id TEXT PRIMARY KEY,
  conclusion_fact_id TEXT NOT NULL,
  rule_key TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  derived_by TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(conclusion_fact_id) REFERENCES graph_facts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS graph_derivations_conclusion_idx
  ON graph_derivations(conclusion_fact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS graph_derivation_inputs (
  derivation_id TEXT NOT NULL,
  input_fact_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(derivation_id, input_fact_id),
  FOREIGN KEY(derivation_id) REFERENCES graph_derivations(id) ON DELETE CASCADE,
  FOREIGN KEY(input_fact_id) REFERENCES graph_facts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS graph_fact_conflicts (
  id TEXT PRIMARY KEY,
  left_fact_id TEXT NOT NULL,
  right_fact_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(left_fact_id, right_fact_id),
  FOREIGN KEY(left_fact_id) REFERENCES graph_facts(id) ON DELETE CASCADE,
  FOREIGN KEY(right_fact_id) REFERENCES graph_facts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS graph_episode_annotations (
  evidence_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  keywords_json TEXT NOT NULL DEFAULT '[]',
  retrieval_cues_json TEXT NOT NULL DEFAULT '[]',
  scope_json TEXT NOT NULL DEFAULT '{}',
  salience REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'pending',
  review_status TEXT NOT NULL DEFAULT 'pending',
  review_outcome TEXT,
  content_hash TEXT NOT NULL,
  annotation_version INTEGER NOT NULL DEFAULT 1,
  generated_by TEXT NOT NULL DEFAULT 'system',
  generated_at TEXT,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(evidence_id) REFERENCES evidence(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS graph_episode_annotations_status_idx
  ON graph_episode_annotations(status, salience DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS graph_episode_annotations_review_identity_idx
  ON graph_episode_annotations(
    json_extract(metadata_json, '$.graphReview.reviewIdentity'),
    CAST(json_extract(metadata_json, '$.graphReview.reviewVersion') AS INTEGER) DESC,
    updated_at DESC, evidence_id
  );

CREATE VIRTUAL TABLE IF NOT EXISTS graph_episode_fts USING fts5(
  evidence_id UNINDEXED,
  title,
  summary,
  keywords,
  retrieval_cues,
  tokenize='unicode61'
);

CREATE TABLE IF NOT EXISTS graph_enrichment_queue (
  evidence_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  queued_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_until TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  last_error TEXT,
  extractor_version INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(evidence_id) REFERENCES evidence(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS graph_enrichment_queue_order_idx
  ON graph_enrichment_queue(status, priority DESC, queued_at, evidence_id);
`;

const MINIMAL_ENTITY_TYPES = [
  { type: "Entity", topClass: "Entity", description: "具有相对稳定身份的物理、数字或概念对象。" },
  { type: "Activity", topClass: "Activity", description: "在一段时间内使用、改变或生成实体的活动。" },
  { type: "Agent", topClass: "Agent", description: "对活动或实体承担责任的人、组织或软件代理。" },
];

const MINIMAL_RELATIONS = [
  { predicate: "RELATED_TO", description: "尚未获得更精确语义的中性关联。" },
];

const KNOWLEDGE_EPISODE_KINDS = [
  "codex_thread_digest",
  "git_history_digest",
  "git_repository_snapshot",
  "project_document_digest",
  "codex_memory_document",
  "manual_knowledge",
  "import_document",
  "feishu_approval_task",
  "feishu_task",
  "feishu_document_content",
  "shadow_agent_task_result",
];

const ACTIVE_REVIEW_KINDS = new Set([
  "import_document",
  "feishu_approval_task",
  "feishu_task",
]);

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

function clamp(value, minimum = 0, maximum = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.max(minimum, Math.min(maximum, number));
}

function normalizePredicate(value) {
  const predicate = String(value ?? "").trim().replace(/[\s-]+/g, "_").toLocaleUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,79}$/.test(predicate)) {
    throw new Error(`Invalid graph predicate: ${value}`);
  }
  return predicate;
}

function ensureColumn(database, table, name, definition) {
  const columns = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  if (!columns.has(name)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    return true;
  }
  return false;
}

function entityId(canonicalKey) {
  return sha256(`graph-entity:${canonicalKey}`).slice(0, 32);
}

function factId(fingerprint) {
  return sha256(`graph-fact:${fingerprint}`).slice(0, 32);
}

function refreshEntitySearch(database, id) {
  const entity = database.prepare("SELECT rowid, id, name, summary, metadata_json FROM graph_entities WHERE id=?").get(id);
  if (!entity) return;
  const aliases = database.prepare("SELECT alias FROM graph_aliases WHERE entity_id=? ORDER BY alias").all(id)
    .map((row) => row.alias).join(" ");
  database.prepare("DELETE FROM graph_entity_fts WHERE rowid=?").run(entity.rowid);
  database.prepare("INSERT INTO graph_entity_fts(rowid, entity_id, name, summary, aliases) VALUES(?, ?, ?, ?, ?)")
    .run(entity.rowid, entity.id, entity.name, entrySearchSummary(entity), aliases);
}

function refreshEpisodeSearch(database, evidenceId) {
  const row = database.prepare(`
    SELECT annotation.rowid, annotation.*
    FROM graph_episode_annotations annotation WHERE annotation.evidence_id=?
  `).get(evidenceId);
  if (!row) return;
  database.prepare("DELETE FROM graph_episode_fts WHERE rowid=?").run(row.rowid);
  database.prepare(`
    INSERT INTO graph_episode_fts(rowid, evidence_id, title, summary, keywords, retrieval_cues)
    VALUES(?, ?, ?, ?, ?, ?)
  `).run(
    row.rowid,
    row.evidence_id,
    row.title,
    row.summary,
    parseJson(row.keywords_json, []).join(" "),
    parseJson(row.retrieval_cues_json, []).join(" "),
  );
}

function provisionalRetrievalCues(kind) {
  if (kind === "manual_knowledge") return ["我明确说过什么", "人工补充的知识", "这个决定或事实是什么", "这条知识从哪里输入"];
  if (kind === "codex_thread_digest") return ["以前做过什么", "哪个 Codex 会话", "任务过程和结论", "为什么这样修改"];
  if (["git_history_digest", "git_repository_snapshot"].includes(kind)) return ["提交来自哪里", "commit 和分支历史", "代码变更记录", "谁在何时提交"];
  if (kind.includes("document")) return ["文档里怎么规定", "方案和规范是什么", "根据哪个文档", "文档最近内容"];
  if (kind.startsWith("feishu_")) return ["飞书里谁说过", "飞书任务和审批", "消息决定和后续", "飞书文档内容"];
  if (kind === "shadow_agent_task_result") return ["Agent 做过什么", "任务执行结果和证据", "上次处理状态"];
  return ["已有知识和来源", "这件事以前怎么处理", "相关证据是什么"];
}

function provisionalKeywords(evidence) {
  const values = [evidence.kind, evidence.project_key, evidence.thread_id, evidence.title]
    .map((value) => String(value ?? "").trim()).filter(Boolean);
  const technical = String(evidence.content ?? "").match(/\b(?:[0-9a-f]{7,40}|[A-Za-z][A-Za-z0-9_.:/-]{2,80})\b/g) ?? [];
  return [...new Set([...values, ...technical.slice(0, 20)])].slice(0, 30);
}

export function deriveEvidenceLevel(profile = {}) {
  const method = String(profile.method ?? "").toLocaleLowerCase();
  const basis = String(profile.basis ?? "").toLocaleLowerCase();
  const environment = String(profile.environment ?? "unknown").toLocaleLowerCase();

  if (["field_test", "production_observation", "target_acceptance"].includes(method)) return 5;
  if (method === "human_acceptance" && ["target", "field", "production"].includes(environment)) return 5;
  if (["integration_test", "end_to_end_test", "hardware_in_loop", "target_environment_test"].includes(method)) return 4;
  if (["build", "unit_test", "simulation", "local_execution", "reproducible_experiment"].includes(method)) return 3;
  if (["source_inspection", "git_diff", "static_analysis", "document_record", "api_record", "message_record"].includes(method)) return 2;
  if (["statement", "secondary_report", "llm_summary", "human_confirmation"].includes(method)) return 1;
  if (["field", "production"].includes(environment) && basis === "observation") return 5;
  if (["integration", "target"].includes(environment) && ["execution", "observation"].includes(basis)) return 4;
  if (["local", "simulation"].includes(environment) && basis === "execution") return 3;
  if (["artifact", "record"].includes(basis)) return 2;
  if (["report", "statement"].includes(basis)) return 1;
  return 0;
}

export function registerEntityType(database, input) {
  const type = String(input.type ?? "").trim();
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(type)) throw new Error(`Invalid graph entity type: ${type}`);
  const timestamp = nowIso();
  database.prepare(`
    INSERT INTO graph_entity_types(
      type, parent_type, top_class, description, aliases_json, origin, schema_json, created_at, updated_at, metadata_json
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(type) DO UPDATE SET
      parent_type=COALESCE(excluded.parent_type, graph_entity_types.parent_type),
      top_class=excluded.top_class,
      description=CASE WHEN excluded.description<>'' THEN excluded.description ELSE graph_entity_types.description END,
      aliases_json=CASE WHEN excluded.aliases_json<>'[]' THEN excluded.aliases_json ELSE graph_entity_types.aliases_json END,
      origin=CASE WHEN graph_entity_types.origin='core' THEN graph_entity_types.origin ELSE excluded.origin END,
      schema_json=CASE WHEN excluded.schema_json<>'{}' THEN excluded.schema_json ELSE graph_entity_types.schema_json END,
      updated_at=excluded.updated_at,
      metadata_json=excluded.metadata_json
  `).run(
    type,
    input.parentType ?? null,
    input.topClass ?? "Entity",
    truncateUtf8(input.description ?? "", 4000),
    stableJson(input.aliases ?? []),
    input.origin ?? "learned",
    stableJson(input.schema ?? {}),
    timestamp,
    timestamp,
    stableJson(input.metadata ?? {}),
  );
  return type;
}

export function registerRelationType(database, input) {
  const predicate = normalizePredicate(input.predicate);
  const timestamp = nowIso();
  database.prepare(`
    INSERT INTO graph_relation_types(
      predicate, inverse_predicate, description, aliases_json, symmetric, transitive, functional, temporal,
      forward_impact_weight, reverse_impact_weight, max_impact_hops, origin,
      created_at, updated_at, metadata_json
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(predicate) DO UPDATE SET
      inverse_predicate=COALESCE(excluded.inverse_predicate, graph_relation_types.inverse_predicate),
      description=CASE WHEN excluded.description<>'' THEN excluded.description ELSE graph_relation_types.description END,
      aliases_json=CASE WHEN excluded.aliases_json<>'[]' THEN excluded.aliases_json ELSE graph_relation_types.aliases_json END,
      symmetric=excluded.symmetric,
      transitive=excluded.transitive,
      functional=excluded.functional,
      temporal=excluded.temporal,
      forward_impact_weight=excluded.forward_impact_weight,
      reverse_impact_weight=excluded.reverse_impact_weight,
      max_impact_hops=excluded.max_impact_hops,
      origin=CASE WHEN graph_relation_types.origin='core' THEN graph_relation_types.origin ELSE excluded.origin END,
      updated_at=excluded.updated_at,
      metadata_json=excluded.metadata_json
  `).run(
    predicate,
    input.inversePredicate ? normalizePredicate(input.inversePredicate) : null,
    truncateUtf8(input.description ?? "", 4000),
    stableJson(input.aliases ?? []),
    Number(Boolean(input.symmetric)),
    Number(Boolean(input.transitive)),
    Number(Boolean(input.functional)),
    input.temporal === false ? 0 : 1,
    clamp(input.forwardImpactWeight ?? 0),
    clamp(input.reverseImpactWeight ?? 0),
    Math.max(0, Math.min(8, Number(input.maxImpactHops ?? 0) || 0)),
    input.origin ?? "learned",
    timestamp,
    timestamp,
    stableJson(input.metadata ?? {}),
  );
  return predicate;
}

export function registerOntologyPackage(database, ontology, origin = "configured") {
  if (!ontology || typeof ontology !== "object") throw new Error("Ontology package must be an object");
  for (const input of ontology.entityTypes ?? []) registerEntityType(database, { ...input, origin: input.origin ?? origin });
  for (const input of ontology.relationTypes ?? []) registerRelationType(database, { ...input, origin: input.origin ?? origin });
  return {
    id: ontology.id ?? "anonymous",
    version: ontology.version ?? 1,
    entityTypes: ontology.entityTypes?.length ?? 0,
    relationTypes: ontology.relationTypes?.length ?? 0,
  };
}

export function loadOntologyFile(database, filePath) {
  const content = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return registerOntologyPackage(database, JSON.parse(content), `file:${filePath}`);
}

export function upsertKnowledgeAnnotation(database, input) {
  const evidence = database.prepare("SELECT * FROM evidence WHERE id=?").get(input.evidenceId);
  if (!evidence) throw new Error(`Unknown evidence: ${input.evidenceId}`);
  const contentHash = input.contentHash ?? sha256(evidence.content ?? "");
  const timestamp = nowIso();
  database.prepare(`
    INSERT INTO graph_episode_annotations(
      evidence_id, title, summary, keywords_json, retrieval_cues_json, scope_json,
      salience, status, content_hash, annotation_version, generated_by,
      generated_at, updated_at, metadata_json
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(evidence_id) DO UPDATE SET
      title=excluded.title, summary=excluded.summary,
      keywords_json=excluded.keywords_json, retrieval_cues_json=excluded.retrieval_cues_json,
      scope_json=excluded.scope_json, salience=excluded.salience, status=excluded.status,
      content_hash=excluded.content_hash, annotation_version=excluded.annotation_version,
      generated_by=excluded.generated_by, generated_at=excluded.generated_at,
      updated_at=excluded.updated_at, metadata_json=excluded.metadata_json
  `).run(
    evidence.id,
    truncateUtf8(input.title ?? evidence.title ?? evidence.kind, 2000),
    truncateUtf8(input.summary ?? "", 8000),
    stableJson([...new Set(input.keywords ?? [])].slice(0, 80)),
    stableJson([...new Set(input.retrievalCues ?? [])].slice(0, 40)),
    stableJson(input.scope ?? {}),
    clamp(input.salience ?? 0.5),
    input.status ?? "ready",
    contentHash,
    input.annotationVersion ?? KNOWLEDGE_ANNOTATION_VERSION,
    input.generatedBy ?? "system",
    input.generatedAt ?? timestamp,
    timestamp,
    stableJson(input.metadata ?? {}),
  );
  refreshEpisodeSearch(database, evidence.id);
  if ((input.status ?? "ready") === "ready") {
    database.prepare(`
      UPDATE graph_enrichment_queue SET status='completed', completed_at=?, lease_owner=NULL,
        lease_until=NULL, last_error=NULL, extractor_version=? WHERE evidence_id=?
    `).run(timestamp, input.annotationVersion ?? KNOWLEDGE_ANNOTATION_VERSION, evidence.id);
  }
  return { evidenceId: evidence.id, contentHash, status: input.status ?? "ready" };
}

export function enqueueKnowledgeBackfill(database, options = {}) {
  const limit = Math.max(1, Math.min(5000, Number(options.limit ?? 500) || 500));
  const placeholders = KNOWLEDGE_EPISODE_KINDS.map(() => "?").join(",");
  const rows = database.prepare(`
    SELECT evidence.* FROM evidence
    LEFT JOIN graph_episode_annotations annotation ON annotation.evidence_id=evidence.id
    LEFT JOIN graph_enrichment_queue queue ON queue.evidence_id=evidence.id
    WHERE evidence.kind IN (${placeholders})
      AND annotation.evidence_id IS NULL
      AND queue.evidence_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM evidence_links newer
        WHERE newer.child_evidence_id=evidence.id AND newer.relation='supersedes'
      )
      AND (
        evidence.kind NOT IN ('codex_thread_digest','git_history_digest','project_document_digest')
        OR (json_valid(evidence.metadata_json) AND COALESCE(json_extract(evidence.metadata_json, '$.chunkIndex'), 0)=0)
      )
    ORDER BY
      CASE evidence.kind
        WHEN 'import_document' THEN 0
        WHEN 'feishu_task' THEN 1
        WHEN 'feishu_approval_task' THEN 1
        WHEN 'feishu_message' THEN 2
        WHEN 'feishu_document_content' THEN 2
        WHEN 'codex_thread_digest' THEN 3
        WHEN 'git_history_digest' THEN 4
        WHEN 'project_document_digest' THEN 5
        ELSE 6
      END,
      COALESCE(evidence.occurred_at, evidence.collected_at) DESC
    LIMIT ?
  `).all(...KNOWLEDGE_EPISODE_KINDS, limit);
  const priorityFor = (kind) => {
    if (kind === "import_document") return 100;
    if (["feishu_task", "feishu_approval_task"].includes(kind)) return 95;
    if (["feishu_message", "feishu_document_content"].includes(kind)) return 85;
    if (kind === "codex_thread_digest") return 75;
    if (["git_history_digest", "git_repository_snapshot"].includes(kind)) return 70;
    return 60;
  };
  const timestamp = nowIso();
  for (const evidence of rows) {
    const contentHash = sha256(evidence.content ?? "");
    const queueStatus = ACTIVE_REVIEW_KINDS.has(evidence.kind) ? "pending" : "cold";
    const governanceTier = queueStatus === "pending" ? "active_review" : "cold_inventory";
    upsertKnowledgeAnnotation(database, {
      evidenceId: evidence.id,
      title: evidence.title || evidence.kind,
      summary: truncateUtf8(evidence.content ?? "", 1600),
      keywords: provisionalKeywords(evidence),
      retrievalCues: provisionalRetrievalCues(evidence.kind),
      scope: { projectKey: evidence.project_key, threadId: evidence.thread_id, sourceKind: evidence.kind },
      salience: priorityFor(evidence.kind) / 100,
      status: "pending",
      contentHash,
      generatedBy: "deterministic-backfill",
      metadata: { provisional: true },
    });
    database.prepare(`
      INSERT INTO graph_enrichment_queue(
        evidence_id, content_hash, priority, reason, status, queued_at,
        extractor_version, metadata_json
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(evidence_id) DO UPDATE SET
        content_hash=excluded.content_hash, priority=MAX(graph_enrichment_queue.priority, excluded.priority),
        reason=excluded.reason,
        status=CASE WHEN graph_enrichment_queue.content_hash<>excluded.content_hash THEN excluded.status ELSE graph_enrichment_queue.status END,
        queued_at=CASE WHEN graph_enrichment_queue.content_hash<>excluded.content_hash THEN excluded.queued_at ELSE graph_enrichment_queue.queued_at END
    `).run(
      evidence.id,
      contentHash,
      priorityFor(evidence.kind),
      options.reason ?? "legacy-knowledge-backfill",
      queueStatus,
      timestamp,
      KNOWLEDGE_ANNOTATION_VERSION,
      stableJson({ governanceTier }),
    );
    restoreAssessedProfileReview(database, evidence.id);
  }
  return { queued: rows.length, limit };
}

export function restoreAssessedProfileReview(database, evidenceId, { dryRun = false, asOf = nowIso() } = {}) {
  const source = database.prepare(`
    SELECT e.metadata_json AS evidence_metadata, e.content, a.* FROM evidence e
    JOIN graph_episode_annotations a ON a.evidence_id=e.id WHERE e.id=?
  `).get(evidenceId);
  if (!source || source.generated_by !== "deterministic-backfill" || source.review_status !== "pending"
    || source.content_hash !== sha256(source.content ?? "") || !parseJson(source.evidence_metadata).structuredProfile) {
    return { evidenceId, eligible: false, reason: "not_unchanged_assessed_profile_backfill" };
  }
  const queue = database.prepare("SELECT status FROM graph_enrichment_queue WHERE evidence_id=?").get(evidenceId);
  if (queue && !["pending", "cold", "completed"].includes(queue.status)) {
    return { evidenceId, eligible: false, reason: "review_owned_by_another_workflow" };
  }
  const facts = database.prepare(`
    SELECT DISTINCT f.id FROM graph_facts f
    JOIN graph_evidence_assessments a ON a.fact_id=f.id
    WHERE a.evidence_id=? AND a.stance='supports' AND a.level>=2 AND a.directness='direct'
      AND a.method='document_record' AND (a.valid_until IS NULL OR julianday(a.valid_until)>julianday(?))
      AND json_valid(f.metadata_json) AND json_extract(f.metadata_json, '$.cognitiveProfileEvidenceId')=?
      AND NOT EXISTS (SELECT 1 FROM evidence_links link WHERE link.child_evidence_id=a.evidence_id AND link.relation='supersedes')
  `).all(evidenceId, asOf, evidenceId).map((row) => row.id);
  if (!facts.length) return { evidenceId, eligible: false, reason: "no_matching_profile_assessments" };
  const result = { evidenceId, eligible: true, factIds: facts, before: source.review_status, after: "completed", dryRun };
  if (dryRun) return result;
  const metadata = parseJson(source.metadata_json);
  metadata.graphReview = { status: "completed", outcome: "facts_recorded", factIds: facts,
    rationale: "Preserve explicit structured-profile assessments during mechanical indexing.", reviewedBy: "assessed-profile-review-repair", reviewedAt: asOf };
  database.exec("SAVEPOINT assessed_profile_review");
  try {
    database.prepare(`UPDATE graph_episode_annotations SET review_status='completed', review_outcome='facts_recorded',
      metadata_json=?, updated_at=? WHERE evidence_id=?`).run(stableJson(metadata), asOf, evidenceId);
    database.prepare(`UPDATE graph_enrichment_queue SET status='completed', completed_at=?, lease_owner=NULL,
      lease_until=NULL, last_error=NULL WHERE evidence_id=? AND status IN ('pending','cold','completed')`).run(asOf, evidenceId);
    database.exec("RELEASE assessed_profile_review");
  } catch (error) {
    database.exec("ROLLBACK TO assessed_profile_review");
    database.exec("RELEASE assessed_profile_review");
    throw error;
  }
  return result;
}

export function backfillGraphReviewState(database, options = {}) {
  const limit = Math.max(1, Math.min(5000, Number(options.limit ?? 500) || 500));
  const rows = database.prepare(`
    SELECT annotation.evidence_id, annotation.metadata_json,
      queue.priority, queue.reason, queue.status AS queue_status
    FROM graph_episode_annotations annotation
    LEFT JOIN graph_enrichment_queue queue ON queue.evidence_id=annotation.evidence_id
    WHERE annotation.status='ready' AND annotation.review_status='pending'
      AND json_valid(annotation.metadata_json)
      AND json_type(CASE WHEN json_valid(annotation.metadata_json) THEN annotation.metadata_json ELSE '{}' END, '$.graphReview') IS NULL
      AND (queue.status IS NULL OR queue.status IN ('pending','cold','completed'))
      AND queue.lease_owner IS NULL AND queue.lease_until IS NULL
    ORDER BY annotation.salience DESC, annotation.updated_at, annotation.evidence_id
    LIMIT ?
  `).all(limit);
  const timestamp = nowIso();
  let factsRecorded = 0;
  let requeued = 0;
  for (const row of rows) {
    const factIds = database.prepare(`
      SELECT DISTINCT fact_id FROM graph_evidence_assessments
      WHERE evidence_id=? AND stance='supports'
      ORDER BY fact_id
    `).all(row.evidence_id).map((item) => item.fact_id);
    const metadata = parseJson(row.metadata_json);
    if (factIds.length) {
      metadata.graphReview = {
        status: "completed",
        outcome: "facts_recorded",
        rationale: "由迁移程序根据该证据已有的事实评价恢复语义复核状态。",
        factIds,
        reviewedBy: "graph-review-backfill",
        reviewedAt: timestamp,
      };
      database.prepare("UPDATE graph_episode_annotations SET review_status='completed', review_outcome='facts_recorded', metadata_json=?, updated_at=? WHERE evidence_id=?")
        .run(stableJson(metadata), timestamp, row.evidence_id);
      database.prepare(`
        INSERT INTO graph_enrichment_queue(
          evidence_id, content_hash, priority, reason, status, queued_at,
          completed_at, extractor_version, metadata_json
        )
        SELECT evidence_id, content_hash, ?, 'graph-review-restored', 'completed', ?, ?,
          annotation_version, ? FROM graph_episode_annotations WHERE evidence_id=?
        ON CONFLICT(evidence_id) DO UPDATE SET
          status='completed', completed_at=excluded.completed_at,
          lease_owner=NULL, lease_until=NULL, last_error=NULL,
          metadata_json=excluded.metadata_json
      `).run(
        Math.max(50, Number(row.priority ?? 50)),
        timestamp,
        timestamp,
        stableJson({ graphReviewStatus: "completed", graphReviewOutcome: "facts_recorded", restoredFactIds: factIds }),
        row.evidence_id,
      );
      factsRecorded += 1;
      continue;
    }

    metadata.graphReview = {
      status: "pending",
      outcome: null,
      rationale: "历史流程只完成了召回卡，尚未明确是否存在长期实体和关系。",
      reviewedBy: "graph-review-backfill",
      reviewedAt: timestamp,
    };
    database.prepare("UPDATE graph_episode_annotations SET review_status='pending', review_outcome=NULL, metadata_json=?, updated_at=? WHERE evidence_id=?")
      .run(stableJson(metadata), timestamp, row.evidence_id);
    database.prepare(`
      INSERT INTO graph_enrichment_queue(
        evidence_id, content_hash, priority, reason, status, queued_at,
        extractor_version, metadata_json
      )
      SELECT evidence_id, content_hash, ?, 'missing-graph-review', 'pending', ?,
        annotation_version, ? FROM graph_episode_annotations WHERE evidence_id=?
      ON CONFLICT(evidence_id) DO UPDATE SET
        priority=MAX(graph_enrichment_queue.priority, excluded.priority),
        reason='missing-graph-review', status='pending', queued_at=excluded.queued_at,
        lease_owner=NULL, lease_until=NULL, completed_at=NULL, last_error=NULL,
        metadata_json=excluded.metadata_json
    `).run(
      Math.max(85, Number(row.priority ?? 50)),
      timestamp,
      stableJson({ graphReviewStatus: "pending", migratedFromStatus: row.queue_status ?? null }),
      row.evidence_id,
    );
    requeued += 1;
  }
  return { reviewed: rows.length, factsRecorded, requeued, limit };
}

export function initializeEpistemicGraph(database) {
  database.exec(GRAPH_MODEL_SCHEMA);
  ensureColumn(database, "graph_entity_types", "aliases_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, "graph_relation_types", "aliases_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, "graph_facts", "scope_key", "TEXT NOT NULL DEFAULT 'global'");
  ensureColumn(database, "graph_facts", "assertion_mode", "TEXT NOT NULL DEFAULT 'observed'");
  ensureColumn(database, "graph_facts", "epistemic_status", "TEXT NOT NULL DEFAULT 'supported'");
  ensureColumn(database, "graph_facts", "created_by", "TEXT NOT NULL DEFAULT 'system'");
  ensureColumn(database, "graph_facts", "supersedes_fact_id", "TEXT");
  const reviewStatusAdded = ensureColumn(database, "graph_episode_annotations", "review_status", "TEXT NOT NULL DEFAULT 'pending'");
  const reviewOutcomeAdded = ensureColumn(database, "graph_episode_annotations", "review_outcome", "TEXT");
  if (reviewStatusAdded || reviewOutcomeAdded) {
    const rows = database.prepare("SELECT evidence_id, metadata_json FROM graph_episode_annotations").all();
    const update = database.prepare("UPDATE graph_episode_annotations SET review_status=?, review_outcome=? WHERE evidence_id=?");
    for (const row of rows) {
      const state = reviewStateFromLegacy(parseJson(row.metadata_json)?.graphReview?.status);
      update.run(state.status, state.outcome, row.evidence_id);
    }
  }
  for (const type of MINIMAL_ENTITY_TYPES) registerEntityType(database, { ...type, origin: "core" });
  for (const relation of MINIMAL_RELATIONS) registerRelationType(database, { ...relation, origin: "core" });
  const routingMigration = "migration:cognitive-routing:v4";
  const migrated = database.prepare("SELECT value FROM settings WHERE key=?").get(routingMigration)?.value === "done";
  if (!migrated) {
    database.exec(`
      DELETE FROM graph_enrichment_queue
      WHERE evidence_id IN (SELECT id FROM evidence WHERE kind='feishu_message')
        AND status<>'completed';
      DELETE FROM graph_episode_annotations
      WHERE evidence_id IN (SELECT id FROM evidence WHERE kind='feishu_message')
        AND status='pending' AND generated_by='deterministic-backfill';
      DELETE FROM graph_entity_evidence
      WHERE relation='supported_by'
        AND entity_id IN (SELECT id FROM graph_entities WHERE type='Conversation')
        AND evidence_id IN (SELECT id FROM evidence WHERE kind='feishu_message');
      UPDATE graph_entities
      SET summary='可持续查询的会话入口；消息正文保存在 Evidence Log。', updated_at=datetime('now')
      WHERE type='Conversation'
        AND json_valid(metadata_json)
        AND json_extract(metadata_json, '$.sourceKind')='feishu_message';
    `);
    database.prepare(`
      INSERT INTO settings(key, value, updated_at) VALUES(?, 'done', ?)
      ON CONFLICT(key) DO UPDATE SET value='done', updated_at=excluded.updated_at
    `).run(routingMigration, nowIso());
  }
}

function ensureEntityType(database, type) {
  if (!database.prepare("SELECT 1 FROM graph_entity_types WHERE type=?").get(type)) {
    registerEntityType(database, {
      type,
      parentType: "Entity",
      topClass: "Entity",
      description: "由知识抽取过程发现的开放类型；待后续补充更精确的父类型。",
      origin: "learned",
    });
  }
}

function ensureRelationType(database, predicate) {
  const normalized = normalizePredicate(predicate);
  if (!database.prepare("SELECT 1 FROM graph_relation_types WHERE predicate=?").get(normalized)) {
    registerRelationType(database, {
      predicate: normalized,
      description: "由知识抽取过程发现的开放关系；默认不参与影响传播。",
      origin: "learned",
    });
  }
  return normalized;
}

export function upsertGraphEntity(database, input) {
  const canonicalKey = truncateUtf8(String(input.canonicalKey ?? "").trim(), 1000);
  if (!canonicalKey) throw new Error("Graph entity canonicalKey is required");
  const type = String(input.type ?? "Entity").trim();
  ensureEntityType(database, type);
  const id = entityId(canonicalKey);
  const existing = database.prepare("SELECT * FROM graph_entities WHERE canonical_key=?").get(canonicalKey);
  const observedAt = input.observedAt ?? nowIso();
  const existingMetadata = parseJson(existing?.metadata_json);
  const incomingMetadata = input.metadata ?? {};
  const incomingPresentationPriority = Number(
    input.presentationPriority ?? incomingMetadata.presentationPriority ?? (incomingMetadata.sourceKind ? 10 : 50),
  );
  const existingPresentationPriority = Number(existingMetadata.presentationPriority ?? 0);
  const preservePresentation = Boolean(existing) && existingPresentationPriority > incomingPresentationPriority;
  const name = truncateUtf8(
    preservePresentation ? existing.name : (input.name ?? existing?.name ?? canonicalKey),
    2000,
  );
  const summary = truncateUtf8(
    preservePresentation ? existing.summary : (input.summary ?? existing?.summary ?? ""),
    12000,
  );
  const metadata = {
    ...existingMetadata,
    ...incomingMetadata,
    presentationPriority: Math.max(existingPresentationPriority, incomingPresentationPriority),
  };
  database.prepare(`
    INSERT INTO graph_entities(
      id, canonical_key, type, name, summary, project_key, status,
      first_seen_at, last_seen_at, updated_at, metadata_json
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(canonical_key) DO UPDATE SET
      type=excluded.type, name=excluded.name, summary=excluded.summary,
      project_key=COALESCE(excluded.project_key, graph_entities.project_key),
      status=excluded.status, last_seen_at=excluded.last_seen_at,
      updated_at=excluded.updated_at, metadata_json=excluded.metadata_json
  `).run(
    id,
    canonicalKey,
    type,
    name,
    summary,
    input.projectKey ?? existing?.project_key ?? null,
    input.status ?? existing?.status ?? "active",
    existing?.first_seen_at ?? observedAt,
    observedAt,
    nowIso(),
    stableJson(metadata),
  );
  for (const alias of [...new Set([name, ...(input.aliases ?? [])].map((value) => truncateUtf8(String(value ?? "").trim(), 2000)).filter(Boolean))]) {
    const aliasKey = sha256(`${id}:${alias.toLocaleLowerCase()}`).slice(0, 32);
    database.prepare(`
      INSERT INTO graph_aliases(alias_key, entity_id, alias, kind, created_at)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(alias_key) DO UPDATE SET entity_id=excluded.entity_id, alias=excluded.alias
    `).run(aliasKey, id, alias, alias === name ? "name" : "alias", nowIso());
  }
  refreshEntitySearch(database, id);
  return { id, canonicalKey, inserted: !existing };
}

function resolveEntityId(database, reference, label) {
  if (!reference) throw new Error(`${label} entity is required`);
  if (typeof reference === "string") {
    return database.prepare("SELECT id FROM graph_entities WHERE id=? OR canonical_key=?").get(reference, reference)?.id
      ?? (() => { throw new Error(`Unknown ${label} entity: ${reference}`); })();
  }
  if (reference.id) return resolveEntityId(database, reference.id, label);
  return upsertGraphEntity(database, reference).id;
}

function factObjectKey(objectEntityId, objectValue) {
  return objectEntityId ?? stableJson(objectValue ?? null);
}

export function currentFactTrust(database, factIdValue, { asOf = nowIso() } = {}) {
  const fact = database.prepare("SELECT id, status FROM graph_facts WHERE id=?").get(factIdValue);
  if (!fact) throw new Error(`Unknown fact: ${factIdValue}`);
  const assessments = database.prepare(`
    SELECT assessment.stance, assessment.level, assessment.valid_until,
      EXISTS(
        SELECT 1 FROM evidence_links replacement
        WHERE replacement.child_evidence_id=assessment.evidence_id
          AND replacement.relation='supersedes' AND replacement.created_at<=?
      ) AS superseded
    FROM graph_evidence_assessments assessment
    WHERE assessment.fact_id=?
  `).all(asOf, factIdValue);
  const hasOpenConflict = Boolean(database.prepare(`
    SELECT 1 FROM graph_fact_conflicts conflict
    JOIN graph_facts left_fact ON left_fact.id=conflict.left_fact_id
    JOIN graph_facts right_fact ON right_fact.id=conflict.right_fact_id
    WHERE conflict.status='open' AND (left_fact_id=? OR right_fact_id=?)
      AND (left_fact.valid_from IS NULL OR julianday(left_fact.valid_from)<=julianday(?))
      AND (left_fact.valid_to IS NULL OR julianday(left_fact.valid_to)>julianday(?))
      AND (right_fact.valid_from IS NULL OR julianday(right_fact.valid_from)<=julianday(?))
      AND (right_fact.valid_to IS NULL OR julianday(right_fact.valid_to)>julianday(?)) LIMIT 1
  `).get(factIdValue, factIdValue, asOf, asOf, asOf, asOf));
  return deriveFactTrust(assessments, { hasOpenConflict, asOf });
}

export function recomputeFactTrust(database, factIdValue, options = {}) {
  const trust = currentFactTrust(database, factIdValue, options);
  database.prepare("UPDATE graph_facts SET epistemic_status=?, updated_at=? WHERE id=?")
    .run(trust, nowIso(), factIdValue);
  return trust;
}

function supersessionCreatesCycle(database, newFactId, oldFactId) {
  return Boolean(database.prepare(`
    WITH RECURSIVE chain(id) AS (
      SELECT supersedes_fact_id FROM graph_facts WHERE id=? AND supersedes_fact_id IS NOT NULL
      UNION
      SELECT fact.supersedes_fact_id FROM graph_facts fact
      JOIN chain ON fact.id=chain.id
      WHERE fact.supersedes_fact_id IS NOT NULL
    ) SELECT 1 FROM chain WHERE id=? LIMIT 1
  `).get(oldFactId, newFactId));
}

export function assertGraphFact(database, input) {
  const subjectEntityId = resolveEntityId(database, input.subject, "subject");
  const objectEntityId = input.objectEntity ? resolveEntityId(database, input.objectEntity, "object") : null;
  if (!objectEntityId && input.objectValue === undefined) throw new Error("Fact requires objectEntity or objectValue");
  const predicate = ensureRelationType(database, input.predicate);
  const scopeKey = truncateUtf8(input.scopeKey ?? "global", 500);
  const objectKey = factObjectKey(objectEntityId, input.objectValue);
  const legacyFingerprint = sha256(`${subjectEntityId}:${predicate}:${objectKey}`);
  const claimFingerprint = scopeKey === "global"
    ? legacyFingerprint
    : sha256(`${subjectEntityId}:${predicate}:${objectKey}:scope:${scopeKey}`);
  const original = database.prepare("SELECT * FROM graph_facts WHERE fingerprint=?").get(claimFingerprint);
  let fingerprint = claimFingerprint;
  if (input.validFrom && !Number.isFinite(Date.parse(input.validFrom))) throw new Error("Invalid fact validFrom");
  if (input.validTo && !Number.isFinite(Date.parse(input.validTo))) throw new Error("Invalid fact validTo");
  if (input.validFrom && input.validTo && Date.parse(input.validTo) < Date.parse(input.validFrom)) throw new Error("Fact validTo precedes validFrom");
  // A later occurrence of an ended claim is not a resurrection of the old fact ID.
  if (original?.valid_to && input.validFrom && Date.parse(input.validFrom) >= Date.parse(original.valid_to)) {
    fingerprint = sha256(`${claimFingerprint}:occurrence:${new Date(input.validFrom).toISOString()}`);
  } else if (original?.status === "superseded" && !input.supersedesFactId && !input.validFrom) {
    const sourceIds = [...new Set(input.sourceEvidenceIds ?? [])];
    const replay = sourceIds.length ? database.prepare(`
      SELECT f.fingerprint FROM graph_facts f JOIN graph_fact_evidence e ON e.fact_id=f.id
      WHERE f.subject_entity_id=? AND f.predicate=? AND f.scope_key=?
        AND f.object_entity_id IS ? AND f.object_value IS ?
        AND e.evidence_id IN (${sourceIds.map(() => "?").join(",")})
      ORDER BY f.observed_at DESC LIMIT 1
    `).get(subjectEntityId, predicate, scopeKey, objectEntityId, input.objectValue === undefined ? null : stableJson(input.objectValue), ...sourceIds) : null;
    const current = replay ?? database.prepare(`
      SELECT fingerprint, valid_from, valid_to FROM graph_facts
      WHERE subject_entity_id=? AND predicate=? AND scope_key=? AND status='active'
        AND object_entity_id IS ? AND object_value IS ? ORDER BY valid_from DESC
    `).all(subjectEntityId, predicate, scopeKey, objectEntityId, input.objectValue === undefined ? null : stableJson(input.objectValue))
      .find((row) => isEffectiveAt(row));
    if (current) fingerprint = current.fingerprint;
  }
  const id = factId(fingerprint);
  const existing = database.prepare("SELECT * FROM graph_facts WHERE fingerprint=?").get(fingerprint);
  const observedAt = input.observedAt ?? nowIso();
  const relation = database.prepare("SELECT * FROM graph_relation_types WHERE predicate=?").get(predicate);
  const assertionMode = input.assertionMode ?? "observed";
  let epistemicStatus = existing?.epistemic_status ?? "proposed";

  database.prepare(`
    INSERT INTO graph_facts(
      id, fingerprint, subject_entity_id, predicate, object_entity_id, object_value,
      status, confidence, valid_from, valid_to, observed_at, updated_at, metadata_json,
      scope_key, assertion_mode, epistemic_status, created_by, supersedes_fact_id
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fingerprint) DO UPDATE SET
      confidence=MAX(graph_facts.confidence, excluded.confidence),
      valid_from=COALESCE(graph_facts.valid_from, excluded.valid_from),
      observed_at=excluded.observed_at,
      updated_at=excluded.updated_at, metadata_json=excluded.metadata_json,
      assertion_mode=excluded.assertion_mode, epistemic_status=excluded.epistemic_status,
      created_by=excluded.created_by
  `).run(
    id,
    fingerprint,
    subjectEntityId,
    predicate,
    objectEntityId,
    input.objectValue === undefined ? null : stableJson(input.objectValue),
    input.status ?? "active",
    clamp(input.confidence ?? 1),
    input.validFrom ?? observedAt,
    input.validTo ?? null,
    observedAt,
    nowIso(),
    stableJson({ ...parseJson(existing?.metadata_json), ...(input.metadata ?? {}), claimFingerprint }),
    scopeKey,
    assertionMode,
    epistemicStatus,
    input.createdBy ?? "system",
    null,
  );

  let supersession = null;
  if (input.supersedesFactId) {
    const oldFact = database.prepare("SELECT * FROM graph_facts WHERE id=?").get(input.supersedesFactId);
    const newFact = database.prepare("SELECT * FROM graph_facts WHERE id=?").get(id);
    const alreadyApplied = newFact.supersedes_fact_id === input.supersedesFactId && oldFact?.status === "superseded";
    supersession = alreadyApplied ? { allowed: true, problems: [], action: "supersede", alreadyApplied: true } : validateSupersession({
      oldFact,
      newFact,
      provenanceCount: (input.sourceEvidenceIds?.length ?? 0) + (input.derivationFactIds?.length ?? 0),
      reason: input.supersessionReason ?? input.metadata?.supersessionReason,
      relationToExisting: input.relationToExisting ?? "same_claim",
      cycleDetected: oldFact ? supersessionCreatesCycle(database, id, oldFact.id) : false,
    });
    if (supersession.allowed && !alreadyApplied) {
      if (Date.parse(input.validFrom ?? observedAt) < Date.parse(oldFact.valid_from)) {
        throw new Error("Supersession cannot end a fact before its validFrom");
      }
      database.prepare(`
        UPDATE graph_facts SET status='superseded', valid_to=?, updated_at=?
        WHERE id=? AND status='active'
      `).run(input.validFrom ?? observedAt, nowIso(), input.supersedesFactId);
      database.prepare("UPDATE graph_facts SET supersedes_fact_id=?, updated_at=? WHERE id=?")
        .run(input.supersedesFactId, nowIso(), id);
      const metadata = parseJson(database.prepare("SELECT metadata_json FROM graph_facts WHERE id=?").get(id).metadata_json);
      delete metadata.supersessionReview;
      database.prepare("UPDATE graph_facts SET metadata_json=? WHERE id=?").run(stableJson(metadata), id);
    } else if (!supersession.allowed && supersession.problems.length === 1
      && supersession.problems[0] === "self_supersession") {
      // An identical fact is retained, not a distinct unresolved replacement.
      // Preserve any earlier revision review; this request cannot resolve it.
      supersession = { ...supersession, action: "retain_existing_fact" };
    } else if (!supersession.allowed) {
      const currentMetadata = parseJson(database.prepare("SELECT metadata_json FROM graph_facts WHERE id=?").get(id)?.metadata_json);
      currentMetadata.supersessionReview = {
        status: "needs_input",
        targetFactId: input.supersedesFactId,
        problems: supersession.problems,
        reason: input.supersessionReason ?? input.metadata?.supersessionReason ?? "",
        recordedAt: nowIso(),
      };
      database.prepare("UPDATE graph_facts SET metadata_json=?, updated_at=? WHERE id=?")
        .run(stableJson(currentMetadata), nowIso(), id);
    }
  }

  if (relation?.functional && !supersession?.allowed) {
    const conflicts = database.prepare(`
      SELECT id FROM graph_facts
      WHERE subject_entity_id=? AND predicate=? AND scope_key=? AND status IN ('active','superseded') AND id<>?
        AND NOT (object_entity_id IS ? AND object_value IS ?)
        AND (valid_to IS NULL OR julianday(valid_to)>julianday(?))
        AND (? IS NULL OR valid_from IS NULL OR julianday(valid_from)<julianday(?))
    `).all(subjectEntityId, predicate, scopeKey, id, objectEntityId,
      input.objectValue === undefined ? null : stableJson(input.objectValue),
      input.validFrom ?? existing?.valid_from ?? observedAt, input.validTo ?? existing?.valid_to ?? null, input.validTo ?? existing?.valid_to ?? null);
    if (conflicts.length) {
      epistemicStatus = "disputed";
      database.prepare("UPDATE graph_facts SET epistemic_status='disputed' WHERE id=?").run(id);
      for (const conflict of conflicts) {
        database.prepare("UPDATE graph_facts SET epistemic_status='disputed' WHERE id=?").run(conflict.id);
        const pair = [id, conflict.id].sort();
        const conflictId = sha256(`graph-conflict:${pair.join(":")}`).slice(0, 32);
        database.prepare(`
          INSERT OR IGNORE INTO graph_fact_conflicts(
            id, left_fact_id, right_fact_id, reason, status, detected_at, metadata_json
          ) VALUES(?, ?, ?, ?, 'open', ?, '{}')
        `).run(conflictId, pair[0], pair[1], `同一作用域内的单值关系 ${predicate} 出现不同对象`, nowIso());
      }
    }
  }
  return { id, inserted: !existing, epistemicStatus, supersession };
}

export function assessFactEvidence(database, input) {
  if (!database.prepare("SELECT 1 FROM graph_facts WHERE id=?").get(input.factId)) throw new Error(`Unknown fact: ${input.factId}`);
  if (!database.prepare("SELECT 1 FROM evidence WHERE id=?").get(input.evidenceId)) throw new Error(`Unknown evidence: ${input.evidenceId}`);
  const stance = normalizeEvidenceStance(input.stance ?? "supports");
  const level = deriveEvidenceLevel(input);
  const assessedAt = input.assessedAt ?? nowIso();
  const fingerprint = sha256(stableJson({
    factId: input.factId,
    evidenceId: input.evidenceId,
    stance,
    method: input.method ?? "inference",
    environment: input.environment ?? "unknown",
    scope: input.scope ?? {},
    assessedBy: input.assessedBy ?? "system",
  }));
  const id = sha256(`graph-evidence-assessment:${fingerprint}`).slice(0, 32);
  const existing = database.prepare("SELECT valid_until FROM graph_evidence_assessments WHERE fingerprint=?").get(fingerprint);
  database.prepare(`
    INSERT INTO graph_evidence_assessments(
      id, fingerprint, fact_id, evidence_id, stance, level, basis, directness, method,
      environment, outcome, confidence, scope_json, assessed_by, assessed_at,
      valid_until, notes, metadata_json
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fingerprint) DO UPDATE SET
      level=excluded.level, basis=excluded.basis, directness=excluded.directness,
      outcome=excluded.outcome, confidence=excluded.confidence,
      assessed_at=excluded.assessed_at, valid_until=excluded.valid_until,
      notes=excluded.notes, metadata_json=excluded.metadata_json
  `).run(
    id,
    fingerprint,
    input.factId,
    input.evidenceId,
    stance,
    level,
    input.basis ?? "inference",
    input.directness ?? (level >= 2 ? "direct" : level === 1 ? "indirect" : "inferred"),
    input.method ?? "inference",
    input.environment ?? "unknown",
    input.outcome ?? (stance === "contradicts" ? "contradicted" : "observed"),
    clamp(input.confidence ?? (0.5 + level * 0.08)),
    stableJson(input.scope ?? {}),
    input.assessedBy ?? "system",
    assessedAt,
    input.validUntil === undefined ? (existing?.valid_until ?? null) : input.validUntil,
    truncateUtf8(input.notes ?? "", 4000),
    stableJson(input.metadata ?? {}),
  );
  database.prepare(`
    INSERT OR IGNORE INTO graph_fact_evidence(fact_id, evidence_id, observed_at)
    VALUES(?, ?, ?)
  `).run(input.factId, input.evidenceId, assessedAt);
  const epistemicStatus = recomputeFactTrust(database, input.factId);
  return { id, level, code: EVIDENCE_LEVELS[level].code, epistemicStatus };
}

function linkEntityEvidence(database, entityIdValue, evidenceId, relation = "supported_by") {
  const evidence = database.prepare("SELECT occurred_at, collected_at FROM evidence WHERE id=?").get(evidenceId);
  if (!evidence) throw new Error(`Unknown evidence: ${evidenceId}`);
  database.prepare(`
    INSERT OR IGNORE INTO graph_entity_evidence(entity_id, evidence_id, relation, observed_at)
    VALUES(?, ?, ?, ?)
  `).run(entityIdValue, evidenceId, relation, evidence.occurred_at ?? evidence.collected_at ?? nowIso());
}

export function applyKnowledgeBundle(database, bundle) {
  const createdBy = String(bundle.createdBy ?? "codex").trim();
  if (!createdBy) throw new Error("Knowledge bundle createdBy is required");
  const entities = new Map();
  const facts = [];
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const input of bundle.entities ?? []) {
      const entity = upsertGraphEntity(database, input);
      entities.set(input.canonicalKey, entity.id);
    }
    for (const input of bundle.facts ?? []) {
      const sourceEvidenceIds = [...new Set(input.sourceEvidenceIds ?? [])];
      const derivationFactIds = [...new Set(input.derivationFactIds ?? [])];
      if (!sourceEvidenceIds.length && !derivationFactIds.length) {
        throw new Error(`Fact ${input.predicate} has no source evidence or derivation inputs`);
      }
      for (const evidenceId of sourceEvidenceIds) {
        if (!database.prepare("SELECT 1 FROM evidence WHERE id=?").get(evidenceId)) throw new Error(`Unknown evidence: ${evidenceId}`);
      }
      for (const sourceFactId of derivationFactIds) {
        if (!database.prepare("SELECT 1 FROM graph_facts WHERE id=?").get(sourceFactId)) throw new Error(`Unknown derivation fact: ${sourceFactId}`);
      }
      const assessments = sourceEvidenceIds.map((evidenceId) => {
        const configured = (input.evidenceAssessments ?? []).find((item) => item.evidenceId === evidenceId) ?? {};
        return { evidenceId, ...configured };
      });
      const assertionMode = input.assertionMode ?? (derivationFactIds.length ? "derived" : "inferred");
      const fact = assertGraphFact(database, {
        ...input,
        subject: typeof input.subject === "string" && entities.has(input.subject) ? entities.get(input.subject) : input.subject,
        objectEntity: typeof input.objectEntity === "string" && entities.has(input.objectEntity) ? entities.get(input.objectEntity) : input.objectEntity,
        assertionMode,
        sourceEvidenceIds,
        derivationFactIds,
        createdBy,
      });
      for (const assessment of assessments) {
        assessFactEvidence(database, {
          ...assessment,
          factId: fact.id,
          assessedBy: assessment.assessedBy ?? createdBy,
        });
        const stored = database.prepare("SELECT subject_entity_id, object_entity_id FROM graph_facts WHERE id=?").get(fact.id);
        linkEntityEvidence(database, stored.subject_entity_id, assessment.evidenceId, "mentioned_by");
        if (stored.object_entity_id) linkEntityEvidence(database, stored.object_entity_id, assessment.evidenceId, "mentioned_by");
      }
      if (derivationFactIds.length) {
        for (const inputFactId of derivationFactIds) {
          if (!database.prepare("SELECT 1 FROM graph_facts WHERE id=?").get(inputFactId)) throw new Error(`Unknown derivation fact: ${inputFactId}`);
        }
        const derivationId = sha256(`graph-derivation:${fact.id}:${stableJson(derivationFactIds.sort())}:${input.ruleKey ?? "codex_reasoning"}`).slice(0, 32);
        database.prepare(`
          INSERT OR REPLACE INTO graph_derivations(
            id, conclusion_fact_id, rule_key, rationale, derived_by, confidence, created_at, metadata_json
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          derivationId,
          fact.id,
          input.ruleKey ?? "codex_reasoning",
          truncateUtf8(input.rationale ?? "", 6000),
          createdBy,
          clamp(input.confidence ?? 0.6),
          nowIso(),
          stableJson(input.derivationMetadata ?? {}),
        );
        const statement = database.prepare(`
          INSERT OR IGNORE INTO graph_derivation_inputs(derivation_id, input_fact_id, ordinal)
          VALUES(?, ?, ?)
        `);
        derivationFactIds.forEach((inputFactId, index) => statement.run(derivationId, inputFactId, index));
      }
      fact.epistemicStatus = recomputeFactTrust(database, fact.id);
      facts.push(fact);
    }
    database.exec("COMMIT");
    return { entities: [...entities.entries()].map(([canonicalKey, id]) => ({ canonicalKey, id })), facts };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function evidenceFactor(level) {
  return [0.45, 0.55, 0.70, 0.82, 0.92, 1][Math.max(0, Math.min(5, Number(level) || 0))];
}

export function traceGraphImpact(database, input) {
  const maxDepth = Math.max(1, Math.min(8, Number(input.maxDepth ?? 3) || 3));
  const minConfidence = clamp(input.minConfidence ?? 0.1);
  const seeds = [...new Set((input.seedEntityIds ?? []).map((reference) => resolveEntityId(database, reference, "seed")))];
  if (!seeds.length) throw new Error("At least one seed entity is required");
  const best = new Map(seeds.map((id) => [id, 1]));
  const paths = [];
  const unmodeled = new Map();
  let frontier = seeds.map((id) => ({ entityId: id, confidence: 1, path: [], visited: new Set([id]) }));

  for (let depth = 0; depth < maxDepth && frontier.length; depth += 1) {
    const next = [];
    for (const state of frontier) {
      const rows = database.prepare(`
        SELECT f.*, r.forward_impact_weight, r.reverse_impact_weight, r.max_impact_hops,
          COALESCE((
            SELECT MAX(a.level) FROM graph_evidence_assessments a
            WHERE a.fact_id=f.id AND a.stance='supports'
          ), 0) AS evidence_level
        FROM graph_facts f
        JOIN graph_relation_types r ON r.predicate=f.predicate
        WHERE f.status='active' AND f.epistemic_status<>'refuted'
          AND (f.subject_entity_id=? OR f.object_entity_id=?)
      `).all(state.entityId, state.entityId);
      for (const row of rows) {
        const directions = [];
        if (row.subject_entity_id === state.entityId && row.object_entity_id && row.forward_impact_weight > 0) {
          directions.push({ target: row.object_entity_id, direction: "forward", weight: row.forward_impact_weight });
        }
        if (row.object_entity_id === state.entityId && row.reverse_impact_weight > 0) {
          directions.push({ target: row.subject_entity_id, direction: "reverse", weight: row.reverse_impact_weight });
        }
        if (!directions.length && row.object_entity_id) {
          const otherEntityId = row.subject_entity_id === state.entityId ? row.object_entity_id : row.subject_entity_id;
          const key = `${row.id}:${state.entityId}:${otherEntityId}`;
          unmodeled.set(key, {
            factId: row.id,
            predicate: row.predicate,
            fromEntityId: state.entityId,
            candidateEntityId: otherEntityId,
            reason: "该关系已入图但没有确定性影响传播语义，应交给 Codex 结合上下文判断。",
          });
        }
        for (const direction of directions) {
          if (state.visited.has(direction.target)) continue;
          if (row.max_impact_hops > 0 && depth + 1 > row.max_impact_hops) continue;
          const confidence = state.confidence
            * clamp(row.confidence ?? 1)
            * clamp(direction.weight)
            * evidenceFactor(row.evidence_level);
          if (confidence < minConfidence) continue;
          const step = {
            factId: row.id,
            predicate: row.predicate,
            fromEntityId: state.entityId,
            toEntityId: direction.target,
            direction: direction.direction,
            relationWeight: direction.weight,
            evidenceLevel: Number(row.evidence_level),
            confidence,
          };
          const path = [...state.path, step];
          paths.push({ seedEntityId: path[0]?.fromEntityId ?? state.entityId, impactedEntityId: direction.target, confidence, path });
          if (confidence > (best.get(direction.target) ?? 0)) {
            best.set(direction.target, confidence);
            next.push({ entityId: direction.target, confidence, path, visited: new Set([...state.visited, direction.target]) });
          }
        }
      }
    }
    frontier = next;
  }

  const entityIds = [...new Set(paths.map((item) => item.impactedEntityId))];
  const entities = entityIds.length
    ? database.prepare(`SELECT id, canonical_key, type, name, summary, status FROM graph_entities WHERE id IN (${entityIds.map(() => "?").join(",")})`)
      .all(...entityIds)
    : [];
  const entityMap = new Map(entities.map((entity) => [entity.id, entity]));
  return {
    seeds,
    maxDepth,
    minConfidence,
    unmodeledEdges: [...unmodeled.values()],
    impacts: paths
      .map((item) => ({ ...item, entity: entityMap.get(item.impactedEntityId) ?? null }))
      .sort((left, right) => right.confidence - left.confidence || left.path.length - right.path.length),
  };
}

export function epistemicGraphStats(database) {
  const scalar = (sql) => Number(database.prepare(sql).get()?.value ?? 0);
  return {
    version: EPISTEMIC_GRAPH_VERSION,
    entityTypes: scalar("SELECT COUNT(*) AS value FROM graph_entity_types"),
    relationTypes: scalar("SELECT COUNT(*) AS value FROM graph_relation_types"),
    evidenceAssessments: scalar("SELECT COUNT(*) AS value FROM graph_evidence_assessments"),
    derivations: scalar("SELECT COUNT(*) AS value FROM graph_derivations"),
    openConflicts: scalar("SELECT COUNT(*) AS value FROM graph_fact_conflicts WHERE status='open'"),
    knowledgeUnits: scalar("SELECT COUNT(*) AS value FROM graph_episode_annotations WHERE status='ready'"),
    provisionalKnowledgeUnits: scalar("SELECT COUNT(*) AS value FROM graph_episode_annotations WHERE status='pending'"),
    enrichmentPending: scalar("SELECT COUNT(*) AS value FROM graph_enrichment_queue WHERE status='pending' OR (status='leased' AND lease_until<datetime('now'))"),
    enrichmentCold: scalar("SELECT COUNT(*) AS value FROM graph_enrichment_queue WHERE status='cold'"),
    enrichmentReviewNeeded: scalar("SELECT COUNT(*) AS value FROM graph_enrichment_queue WHERE status='review_needed'"),
    graphReviewFactsRecorded: scalar("SELECT COUNT(*) AS value FROM graph_episode_annotations WHERE status='ready' AND review_status='completed' AND review_outcome='facts_recorded'"),
    graphReviewNoDurableFacts: scalar("SELECT COUNT(*) AS value FROM graph_episode_annotations WHERE status='ready' AND review_status='completed' AND review_outcome='no_durable_facts'"),
    graphReviewPending: scalar("SELECT COUNT(*) AS value FROM graph_episode_annotations WHERE status='ready' AND review_status IN ('pending','needs_input')"),
  };
}
