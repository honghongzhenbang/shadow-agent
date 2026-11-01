import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { loadConfig } from "../src/config.mjs";
import { sha256 } from "../src/utils.mjs";

export const KNOWLEDGE_QUALITY_AUDIT_VERSION = "knowledge-quality-audit-v2";

const REQUIRED_TABLES = [
  "evidence",
  "graph_episode_annotations",
  "graph_enrichment_queue",
  "graph_facts",
  "graph_evidence_assessments",
  "graph_derivations",
  "graph_relation_types",
];

const ANNOTATION_STATUSES = ["ready", "pending", "leased", "completed", "failed"];
const QUEUE_STATUSES = ["pending", "leased", "cold", "completed", "failed", "review_needed"];
const EPISTEMIC_STATUSES = ["proposed", "supported", "disputed", "refuted"];

export class KnowledgeQualityAuditError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "KnowledgeQualityAuditError";
    this.details = details;
  }
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function statusCounts(database, table, expectedStatuses) {
  const counts = Object.fromEntries(expectedStatuses.map((status) => [status, 0]));
  const other = {};
  for (const row of database.prepare(`
    SELECT COALESCE(NULLIF(TRIM(status), ''), '<empty>') AS status, COUNT(*) AS count
    FROM ${table}
    GROUP BY COALESCE(NULLIF(TRIM(status), ''), '<empty>')
    ORDER BY status
  `).all()) {
    const count = asNumber(row.count);
    if (Object.hasOwn(counts, row.status)) counts[row.status] = count;
    else other[row.status] = count;
  }
  return { ...counts, other };
}

function parseStringArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    if (!Array.isArray(parsed)) return { values: [], valid: false };
    const values = [...new Set(parsed
      .map((item) => String(item ?? "").trim())
      .filter(Boolean))];
    return { values, valid: true };
  } catch {
    return { values: [], valid: false };
  }
}

function existingTables(database) {
  return new Set(database.prepare(`
    SELECT name FROM sqlite_master WHERE type IN ('table', 'view')
  `).all().map((row) => row.name));
}

function validateSchema(database) {
  const present = existingTables(database);
  const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
  if (missing.length) {
    throw new KnowledgeQualityAuditError(
      `Knowledge audit requires the epistemic graph schema; missing: ${missing.join(", ")}`,
      { missingTables: missing },
    );
  }
}

function annotationGroups(database) {
  return database.prepare(`
    SELECT
      COALESCE(e.kind, '<missing>') AS evidence_kind,
      COALESCE(NULLIF(TRIM(a.generated_by), ''), '<empty>') AS generated_by,
      COUNT(*) AS total,
      SUM(CASE WHEN a.status='ready' THEN 1 ELSE 0 END) AS ready,
      SUM(CASE WHEN a.status='pending' THEN 1 ELSE 0 END) AS pending
    FROM graph_episode_annotations a
    LEFT JOIN evidence e ON e.id=a.evidence_id
    GROUP BY COALESCE(e.kind, '<missing>'), COALESCE(NULLIF(TRIM(a.generated_by), ''), '<empty>')
    ORDER BY total DESC, evidence_kind, generated_by
  `).all().map((row) => ({
    evidenceKind: row.evidence_kind,
    generatedBy: row.generated_by,
    total: asNumber(row.total),
    ready: asNumber(row.ready),
    pending: asNumber(row.pending),
  }));
}

function queueGovernanceAudit(database) {
  const activeEvidenceIds = database.prepare(`
    SELECT evidence_id FROM graph_enrichment_queue
    WHERE status IN ('pending','leased','failed')
    ORDER BY evidence_id
  `).all().map((row) => row.evidence_id);
  const coldByKind = database.prepare(`
    SELECT COALESCE(e.kind, '<missing>') AS evidence_kind, q.reason,
      COUNT(*) AS count, MIN(q.queued_at) AS oldest, MAX(q.queued_at) AS newest
    FROM graph_enrichment_queue q
    LEFT JOIN evidence e ON e.id=q.evidence_id
    WHERE q.status='cold'
    GROUP BY COALESCE(e.kind, '<missing>'), q.reason
    ORDER BY count DESC, evidence_kind
  `).all().map((row) => ({
    evidenceKind: row.evidence_kind,
    reason: row.reason,
    count: asNumber(row.count),
    oldest: row.oldest,
    newest: row.newest,
  }));
  return {
    activeReview: { count: activeEvidenceIds.length, evidenceIds: activeEvidenceIds },
    coldInventory: {
      count: coldByKind.reduce((sum, item) => sum + item.count, 0),
      byEvidenceKind: coldByKind,
    },
  };
}

function contentHashAudit(database) {
  const items = [];
  const annotationRows = database.prepare(`
    SELECT a.evidence_id, e.kind AS evidence_kind, a.content_hash AS recorded_hash, e.content
    FROM graph_episode_annotations a
    JOIN evidence e ON e.id=a.evidence_id
    ORDER BY a.evidence_id
  `).all();
  for (const row of annotationRows) {
    const actualHash = sha256(String(row.content ?? ""));
    if (row.recorded_hash !== actualHash) {
      items.push({
        owner: "annotation",
        evidenceId: row.evidence_id,
        evidenceKind: row.evidence_kind,
        recordedHash: row.recorded_hash,
        actualHash,
      });
    }
  }

  const queueRows = database.prepare(`
    SELECT q.evidence_id, e.kind AS evidence_kind, q.content_hash AS recorded_hash, e.content
    FROM graph_enrichment_queue q
    JOIN evidence e ON e.id=q.evidence_id
    ORDER BY q.evidence_id
  `).all();
  for (const row of queueRows) {
    const actualHash = sha256(String(row.content ?? ""));
    if (row.recorded_hash !== actualHash) {
      items.push({
        owner: "queue",
        evidenceId: row.evidence_id,
        evidenceKind: row.evidence_kind,
        recordedHash: row.recorded_hash,
        actualHash,
      });
    }
  }

  const annotationCount = items.filter((item) => item.owner === "annotation").length;
  const queueCount = items.filter((item) => item.owner === "queue").length;
  return {
    total: items.length,
    affectedEvidence: new Set(items.map((item) => item.evidenceId)).size,
    annotationCount,
    queueCount,
    items,
  };
}

function retrievalCardAudit(database) {
  const rows = database.prepare(`
    SELECT a.evidence_id, a.status, a.generated_by, a.summary,
      a.keywords_json, a.retrieval_cues_json, COALESCE(e.kind, '<missing>') AS evidence_kind
    FROM graph_episode_annotations a
    LEFT JOIN evidence e ON e.id=a.evidence_id
    ORDER BY a.evidence_id
  `).all();
  const items = [];
  const counts = {
    missingSummary: 0,
    fewerThanThreeKeywords: 0,
    fewerThanTwoRetrievalCues: 0,
    invalidKeywordsJson: 0,
    invalidRetrievalCuesJson: 0,
  };

  for (const row of rows) {
    const keywords = parseStringArray(row.keywords_json);
    const retrievalCues = parseStringArray(row.retrieval_cues_json);
    const problems = [];
    if (!String(row.summary ?? "").trim()) {
      counts.missingSummary += 1;
      problems.push("missing_summary");
    }
    if (keywords.values.length < 3) {
      counts.fewerThanThreeKeywords += 1;
      problems.push("fewer_than_3_keywords");
    }
    if (retrievalCues.values.length < 2) {
      counts.fewerThanTwoRetrievalCues += 1;
      problems.push("fewer_than_2_retrieval_cues");
    }
    if (!keywords.valid) {
      counts.invalidKeywordsJson += 1;
      problems.push("invalid_keywords_json");
    }
    if (!retrievalCues.valid) {
      counts.invalidRetrievalCuesJson += 1;
      problems.push("invalid_retrieval_cues_json");
    }
    if (problems.length) {
      items.push({
        evidenceId: row.evidence_id,
        evidenceKind: row.evidence_kind,
        generatedBy: row.generated_by,
        status: row.status,
        keywordCount: keywords.values.length,
        retrievalCueCount: retrievalCues.values.length,
        problems,
      });
    }
  }

  return { totalCards: rows.length, affectedCards: items.length, counts, items };
}

function graphReviewAudit(database) {
  const rows = database.prepare(`
    SELECT a.evidence_id, a.generated_by, a.review_status, a.review_outcome,
      COALESCE(e.kind, '<missing>') AS evidence_kind
    FROM graph_episode_annotations a
    LEFT JOIN evidence e ON e.id=a.evidence_id
    WHERE a.status='ready'
    ORDER BY a.evidence_id
  `).all();
  const statusDistribution = {
    completed: 0,
    needs_input: 0,
    pending: 0,
    missing: 0,
    other: {},
  };
  const outcomeDistribution = { facts_recorded: 0, no_durable_facts: 0, none: 0, other: {} };
  const missingOrPending = [];
  for (const row of rows) {
    const status = String(row.review_status ?? "").trim() || "missing";
    const outcome = String(row.review_outcome ?? "").trim() || "none";
    if (Object.hasOwn(statusDistribution, status) && status !== "other") {
      statusDistribution[status] += 1;
    } else {
      statusDistribution.other[status] = (statusDistribution.other[status] ?? 0) + 1;
    }
    if (Object.hasOwn(outcomeDistribution, outcome) && outcome !== "other") {
      outcomeDistribution[outcome] += 1;
    } else {
      outcomeDistribution.other[outcome] = (outcomeDistribution.other[outcome] ?? 0) + 1;
    }
    if (status === "missing" || status === "pending") {
      missingOrPending.push({
        evidenceId: row.evidence_id,
        evidenceKind: row.evidence_kind,
        generatedBy: row.generated_by,
        graphReviewStatus: status,
      });
    }
  }

  const reviewNeeded = database.prepare(`
    SELECT q.evidence_id, COALESCE(e.kind, '<missing>') AS evidence_kind,
      a.review_status AS graph_review_status, a.review_outcome AS graph_review_outcome,
      q.reason, q.last_error
    FROM graph_enrichment_queue q
    LEFT JOIN evidence e ON e.id=q.evidence_id
    LEFT JOIN graph_episode_annotations a ON a.evidence_id=q.evidence_id
    WHERE q.status='review_needed'
    ORDER BY q.priority DESC, q.queued_at, q.evidence_id
  `).all().map((row) => ({
    evidenceId: row.evidence_id,
    evidenceKind: row.evidence_kind,
    graphReviewStatus: row.graph_review_status,
    graphReviewOutcome: row.graph_review_outcome,
    reason: row.reason,
    lastError: row.last_error,
  }));

  return {
    readyCards: rows.length,
    statusDistribution,
    outcomeDistribution,
    missingOrPending: { count: missingOrPending.length, items: missingOrPending },
    reviewNeeded: { count: reviewNeeded.length, items: reviewNeeded },
  };
}

function orphanAudit(database) {
  const annotations = database.prepare(`
    SELECT a.evidence_id, a.status, a.generated_by
    FROM graph_episode_annotations a
    LEFT JOIN evidence e ON e.id=a.evidence_id
    WHERE e.id IS NULL
    ORDER BY a.evidence_id
  `).all().map((row) => ({
    evidenceId: row.evidence_id,
    status: row.status,
    generatedBy: row.generated_by,
  }));
  const queueItems = database.prepare(`
    SELECT q.evidence_id, q.status, q.reason
    FROM graph_enrichment_queue q
    LEFT JOIN evidence e ON e.id=q.evidence_id
    WHERE e.id IS NULL
    ORDER BY q.evidence_id
  `).all().map((row) => ({
    evidenceId: row.evidence_id,
    status: row.status,
    reason: row.reason,
  }));
  return {
    annotations: { count: annotations.length, items: annotations },
    queueItems: { count: queueItems.length, items: queueItems },
  };
}

function activeFactAudit(database) {
  const statusCounts = Object.fromEntries(EPISTEMIC_STATUSES.map((status) => [status, 0]));
  const other = {};
  for (const row of database.prepare(`
    SELECT COALESCE(NULLIF(TRIM(epistemic_status), ''), '<empty>') AS epistemic_status,
      COUNT(*) AS count
    FROM graph_facts
    WHERE status='active'
    GROUP BY COALESCE(NULLIF(TRIM(epistemic_status), ''), '<empty>')
    ORDER BY epistemic_status
  `).all()) {
    const count = asNumber(row.count);
    if (Object.hasOwn(statusCounts, row.epistemic_status)) statusCounts[row.epistemic_status] = count;
    else other[row.epistemic_status] = count;
  }

  const withoutProvenance = database.prepare(`
    SELECT f.id, f.predicate, f.epistemic_status, f.assertion_mode,
      f.subject_entity_id, f.object_entity_id
    FROM graph_facts f
    WHERE f.status='active'
      AND COALESCE(f.assertion_mode, 'observed')<>'structural_route'
      AND NOT EXISTS (
        SELECT 1 FROM graph_evidence_assessments a WHERE a.fact_id=f.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM graph_derivations d WHERE d.conclusion_fact_id=f.id
      )
    ORDER BY f.predicate, f.id
  `).all().map((row) => ({
    id: row.id,
    predicate: row.predicate,
    epistemicStatus: row.epistemic_status,
    assertionMode: row.assertion_mode,
    subjectEntityId: row.subject_entity_id,
    objectEntityId: row.object_entity_id,
  }));

  const structuralRows = database.prepare(`
    SELECT f.id, f.predicate, f.subject_entity_id, f.object_entity_id,
      f.metadata_json,
      CASE
        WHEN NOT json_valid(f.metadata_json) THEN 1
        WHEN COALESCE(json_extract(f.metadata_json, '$.structuralSource.table'), '')='' THEN 1
        WHEN COALESCE(json_extract(f.metadata_json, '$.structuralSource.key'), '')='' THEN 1
        ELSE 0
      END AS missing_source
    FROM graph_facts f
    WHERE f.status='active' AND f.assertion_mode='structural_route'
    ORDER BY f.predicate, f.id
  `).all();
  const missingStructuralSources = structuralRows.filter((row) => Boolean(row.missing_source)).map((row) => ({
    id: row.id,
    predicate: row.predicate,
    subjectEntityId: row.subject_entity_id,
    objectEntityId: row.object_entity_id,
  }));

  return {
    totalActive: Object.values(statusCounts).reduce((sum, count) => sum + count, 0)
      + Object.values(other).reduce((sum, count) => sum + count, 0),
    epistemicStatusCounts: { ...statusCounts, other },
    withoutEvidenceAssessmentOrDerivation: {
      count: withoutProvenance.length,
      items: withoutProvenance,
    },
    structuralRoutes: {
      count: structuralRows.length,
      missingSource: { count: missingStructuralSources.length, items: missingStructuralSources },
    },
  };
}

function relationAudit(database) {
  const rows = database.prepare(`
    SELECT predicate, description, origin, forward_impact_weight,
      reverse_impact_weight, max_impact_hops
    FROM graph_relation_types
    ORDER BY predicate
  `).all();
  const learned = [];
  const anomalies = [];
  for (const row of rows) {
    const forward = Number(row.forward_impact_weight);
    const reverse = Number(row.reverse_impact_weight);
    const maxHops = Number(row.max_impact_hops);
    const item = {
      predicate: row.predicate,
      description: row.description,
      origin: row.origin,
      forwardImpactWeight: forward,
      reverseImpactWeight: reverse,
      maxImpactHops: maxHops,
    };
    if (row.origin === "learned") learned.push(item);

    const problems = [];
    if (!Number.isFinite(forward) || forward < 0 || forward > 1) {
      problems.push("forward_weight_out_of_range");
    }
    if (!Number.isFinite(reverse) || reverse < 0 || reverse > 1) {
      problems.push("reverse_weight_out_of_range");
    }
    if (!Number.isInteger(maxHops) || maxHops < 0) problems.push("invalid_max_impact_hops");
    if (row.origin === "learned" && (forward !== 0 || reverse !== 0)) {
      problems.push("learned_relation_propagates_without_review");
    }
    if (maxHops > 0 && forward === 0 && reverse === 0) {
      problems.push("hop_limit_without_propagation_weight");
    }
    if (problems.length) anomalies.push({ ...item, problems });
  }
  return {
    total: rows.length,
    learned: { count: learned.length, items: learned },
    propagationWeightAnomalies: { count: anomalies.length, items: anomalies },
  };
}

function lifecycleAudit(database) {
  const items = database.prepare(`
    SELECT q.evidence_id, q.status AS queue_status, q.content_hash AS queue_hash,
      a.status AS annotation_status, a.content_hash AS annotation_hash,
      CASE
        WHEN q.status='completed' AND a.evidence_id IS NULL THEN 'completed_queue_without_annotation'
        WHEN q.status='completed' AND a.status<>'ready' THEN 'completed_queue_without_ready_annotation'
        WHEN q.status='completed' AND a.content_hash<>q.content_hash THEN 'completed_hashes_disagree'
        WHEN q.status IN ('pending','leased','failed') AND a.status='ready'
          AND a.content_hash=q.content_hash
          AND NOT (
            q.status='pending'
            AND a.review_status='pending'
          ) THEN 'ready_annotation_with_incomplete_queue'
      END AS problem
    FROM graph_enrichment_queue q
    LEFT JOIN graph_episode_annotations a ON a.evidence_id=q.evidence_id
    WHERE
      (q.status='completed' AND (a.evidence_id IS NULL OR a.status<>'ready' OR a.content_hash<>q.content_hash))
      OR (
        q.status IN ('pending','leased','failed')
        AND a.status='ready'
        AND a.content_hash=q.content_hash
        AND NOT (
          q.status='pending'
          AND a.review_status='pending'
        )
      )
    UNION ALL
    SELECT a.evidence_id, NULL, NULL, a.status, a.content_hash,
      'pending_annotation_without_queue' AS problem
    FROM graph_episode_annotations a
    LEFT JOIN graph_enrichment_queue q ON q.evidence_id=a.evidence_id
    WHERE a.status='pending' AND q.evidence_id IS NULL
    ORDER BY 1, 6
  `).all().map((row) => ({
    evidenceId: row.evidence_id,
    queueStatus: row.queue_status,
    annotationStatus: row.annotation_status,
    problem: row.problem,
  }));
  return { count: items.length, items };
}

function strictAudit({
  queueStatuses,
  queueGovernance,
  contentHashes,
  retrievalCards,
  graphReview,
  orphans,
  activeFacts,
  relations,
  lifecycle,
}) {
  const violations = {
    incompleteEnrichment: queueStatuses.pending + queueStatuses.leased,
    failedEnrichment: queueStatuses.failed,
    contentHashMismatches: contentHashes.total,
    incompleteRetrievalCards: retrievalCards.affectedCards,
    readyCardsWithMissingOrPendingGraphReview: graphReview.missingOrPending.count,
    graphReviewNeeded: graphReview.reviewNeeded.count,
    orphanAnnotations: orphans.annotations.count,
    orphanQueueItems: orphans.queueItems.count,
    activeFactsWithoutEvidenceAssessmentOrDerivation:
      activeFacts.withoutEvidenceAssessmentOrDerivation.count,
    structuralRoutesWithoutSource: activeFacts.structuralRoutes.missingSource.count,
    propagationWeightAnomalies: relations.propagationWeightAnomalies.count,
    lifecycleInconsistencies: lifecycle.count,
  };
  const violationCount = Object.values(violations).reduce((sum, count) => sum + count, 0);
  const affected = new Set();
  for (const evidenceId of queueGovernance.activeReview.evidenceIds) affected.add(`evidence:${evidenceId}`);
  for (const item of contentHashes.items) affected.add(`evidence:${item.evidenceId}`);
  for (const item of retrievalCards.items) affected.add(`evidence:${item.evidenceId}`);
  for (const item of graphReview.missingOrPending.items) affected.add(`evidence:${item.evidenceId}`);
  for (const item of graphReview.reviewNeeded.items) affected.add(`evidence:${item.evidenceId}`);
  for (const item of orphans.annotations.items) affected.add(`evidence:${item.evidenceId}`);
  for (const item of orphans.queueItems.items) affected.add(`evidence:${item.evidenceId}`);
  for (const item of activeFacts.withoutEvidenceAssessmentOrDerivation.items) affected.add(`fact:${item.id}`);
  for (const item of activeFacts.structuralRoutes.missingSource.items) affected.add(`fact:${item.id}`);
  for (const item of lifecycle.items) affected.add(`evidence:${item.evidenceId}`);
  for (const item of relations.propagationWeightAnomalies.items) affected.add(`relation:${item.predicate}`);
  return {
    passed: violationCount === 0,
    violationCount,
    uniqueAffectedObjects: affected.size,
    duplicateCheckCount: Math.max(0, violationCount - affected.size),
    violations,
    policy: {
      pendingAndLeasedAreIncomplete: true,
      disputedAndRefutedFactsAreReportedButNotFailuresByThemselves: true,
      exitCodeOnFailure: 2,
    },
  };
}

export function auditKnowledgeQuality(database, options = {}) {
  validateSchema(database);
  const annotationStatuses = statusCounts(database, "graph_episode_annotations", ANNOTATION_STATUSES);
  const queueStatuses = statusCounts(database, "graph_enrichment_queue", QUEUE_STATUSES);
  const queueGovernance = queueGovernanceAudit(database);
  const contentHashes = contentHashAudit(database);
  const retrievalCards = retrievalCardAudit(database);
  const graphReview = graphReviewAudit(database);
  const orphans = orphanAudit(database);
  const activeFacts = activeFactAudit(database);
  const relations = relationAudit(database);
  const lifecycle = lifecycleAudit(database);
  const strict = strictAudit({
    queueStatuses,
    queueGovernance,
    contentHashes,
    retrievalCards,
    graphReview,
    orphans,
    activeFacts,
    relations,
    lifecycle,
  });

  return {
    schemaVersion: KNOWLEDGE_QUALITY_AUDIT_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    databasePath: options.databasePath ? path.resolve(options.databasePath) : null,
    migrationStatus: {
      ready: annotationStatuses.ready,
      pending: queueStatuses.pending,
      leased: queueStatuses.leased,
      cold: queueStatuses.cold,
      completed: queueStatuses.completed,
      failed: queueStatuses.failed,
      reviewNeeded: queueStatuses.review_needed,
    },
    statusBreakdown: {
      annotations: annotationStatuses,
      enrichmentQueue: queueStatuses,
    },
    annotationsByEvidenceKindAndGeneratedBy: annotationGroups(database),
    queueGovernance,
    contentHashes,
    retrievalCards,
    graphReview,
    orphans,
    activeFacts,
    relations,
    lifecycle,
    strict,
  };
}

export function auditKnowledgeDatabase(databasePath, options = {}) {
  const resolvedPath = path.resolve(databasePath);
  const database = new DatabaseSync(resolvedPath, { readOnly: true });
  try {
    return auditKnowledgeQuality(database, { ...options, databasePath: resolvedPath });
  } finally {
    database.close();
  }
}

export function parseAuditArguments(argv) {
  const result = { strict: false, compact: false, databasePath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--strict") result.strict = true;
    else if (argument === "--compact") result.compact = true;
    else if (argument === "--database") {
      const value = argv[index + 1];
      if (!value) throw new KnowledgeQualityAuditError("--database requires a path");
      result.databasePath = value;
      index += 1;
    } else {
      throw new KnowledgeQualityAuditError(`Unknown argument: ${argument}`);
    }
  }
  return result;
}

export function knowledgeQualityExitCode(report, { strict = false } = {}) {
  return strict && !report.strict.passed ? report.strict.policy.exitCodeOnFailure : 0;
}

export function runKnowledgeQualityAudit(argv = process.argv.slice(2)) {
  const args = parseAuditArguments(argv);
  const databasePath = args.databasePath ?? loadConfig().paths.database;
  const report = auditKnowledgeDatabase(databasePath);
  process.stdout.write(`${JSON.stringify(report, null, args.compact ? 0 : 2)}\n`);
  process.exitCode = knowledgeQualityExitCode(report, args);
  return report;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    runKnowledgeQualityAudit();
  } catch (error) {
    const output = {
      schemaVersion: KNOWLEDGE_QUALITY_AUDIT_VERSION,
      ok: false,
      error: error.message,
      details: error.details ?? {},
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    process.exitCode = 1;
  }
}
