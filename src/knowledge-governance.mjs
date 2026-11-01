import { registerRelationType } from "./graph-model.mjs";
import { nowIso, sha256, stableJson } from "./utils.mjs";

const COLD_INVENTORY_KINDS = Object.freeze([
  "codex_memory_document",
  "codex_thread_digest",
  "git_history_digest",
  "git_repository_snapshot",
  "project_document_digest",
  "feishu_document_content",
  "shadow_agent_task_result",
  "manual_knowledge",
]);

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

function graphFactId(subjectEntityId, predicate, objectEntityId) {
  const fingerprint = sha256(`${subjectEntityId}:${predicate}:${objectEntityId}`);
  return { fingerprint, id: sha256(`graph-fact:${fingerprint}`).slice(0, 32) };
}

function scalar(database, sql, ...params) {
  return Number(database.prepare(sql).get(...params)?.value ?? 0);
}

export function inspectKnowledgeGovernance(database) {
  const placeholders = COLD_INVENTORY_KINDS.map(() => "?").join(",");
  return {
    smokeArtifacts: scalar(database, `
      SELECT COUNT(*) AS value
      FROM evidence e
      JOIN graph_episode_annotations a ON a.evidence_id=e.id
      WHERE e.kind='manual_knowledge'
        AND a.generated_by='unified-direct-input-smoke'
        AND e.title='V4.9 统一输入任务建卡冒烟测试'
        AND e.source_locator LIKE 'shadow-agent://smoke/%'
    `),
    coldCandidates: scalar(database, `
      SELECT COUNT(*) AS value
      FROM graph_enrichment_queue q
      JOIN evidence e ON e.id=q.evidence_id
      JOIN graph_episode_annotations a ON a.evidence_id=q.evidence_id
      WHERE q.status='pending' AND q.attempts=0
        AND a.generated_by='deterministic-backfill'
        AND e.kind IN (${placeholders})
    `, ...COLD_INVENTORY_KINDS),
    legacyTracksProjectRoutes: scalar(database, `
      SELECT COUNT(*) AS value FROM graph_facts f
      WHERE f.status='active' AND f.predicate='TRACKS_PROJECT' AND f.created_by='system'
        AND NOT EXISTS (SELECT 1 FROM graph_evidence_assessments a WHERE a.fact_id=f.id)
        AND NOT EXISTS (SELECT 1 FROM graph_derivations d WHERE d.conclusion_fact_id=f.id)
    `),
    structuralBelongsToCandidates: scalar(database, `
      SELECT COUNT(*) AS value FROM graph_facts f
      WHERE f.status='active' AND f.predicate='BELONGS_TO' AND f.created_by='system'
        AND COALESCE(f.assertion_mode, 'observed')<>'structural_route'
        AND NOT EXISTS (SELECT 1 FROM graph_evidence_assessments a WHERE a.fact_id=f.id)
        AND NOT EXISTS (SELECT 1 FROM graph_derivations d WHERE d.conclusion_fact_id=f.id)
    `),
    invalidWorkspaceRoutes: scalar(database, `
      SELECT COUNT(*) AS value
      FROM graph_facts f
      JOIN graph_entities project ON project.id=f.object_entity_id
      WHERE f.status='active' AND f.predicate='HAS_LOCAL_WORKSPACE'
        AND f.created_by='system'
        AND NOT EXISTS (
          SELECT 1 FROM projects p WHERE p.project_key=project.project_key
        )
    `),
    activeReview: scalar(database, `
      SELECT COUNT(*) AS value FROM graph_enrichment_queue
      WHERE status IN ('pending','leased','failed','review_needed')
    `),
    coldInventory: scalar(database, "SELECT COUNT(*) AS value FROM graph_enrichment_queue WHERE status='cold'"),
    manualReviewWakeCandidates: scalar(database, `
      SELECT COUNT(*) AS value
      FROM graph_enrichment_queue q
      JOIN evidence e ON e.id=q.evidence_id
      JOIN graph_episode_annotations a ON a.evidence_id=q.evidence_id
      WHERE q.status='pending' AND e.kind='manual_knowledge'
        AND a.generated_by NOT IN ('deterministic-backfill','unified-direct-input-smoke')
        AND NOT EXISTS (
          SELECT 1 FROM context_changes c
          WHERE c.event_key='knowledge-governance-review:' || q.evidence_id
        )
    `),
  };
}

function structuralSource(row) {
  if (row.subject_type === "Session" && row.subject_key.startsWith("session:")) {
    return { table: "threads", key: row.subject_key.slice("session:".length) };
  }
  if (row.subject_type === "HistoricalTask" && row.subject_key.startsWith("legacy-task:")) {
    return { table: "tasks", key: row.subject_key.slice("legacy-task:".length) };
  }
  if (row.evidence_id) return { table: "evidence", key: row.evidence_id };
  return { table: "graph_entities", key: row.subject_key };
}

export function applyKnowledgeGovernance(database, options = {}) {
  const deleteSmokeArtifacts = options.deleteSmokeArtifacts !== false;
  const timestamp = options.timestamp ?? nowIso();
  const before = inspectKnowledgeGovernance(database);
  const deletedSmokeEvidenceIds = [];
  const coldEvidenceIds = [];
  const supersededTrackFactIds = [];
  const structuralFactIds = [];
  const supersededWorkspaceFactIds = [];
  const workspaceFactIds = [];
  const scheduledManualReviewEvidenceIds = [];
  const ownsTransaction = options.transaction !== false;
  if (ownsTransaction) database.exec("BEGIN IMMEDIATE");
  try {
    if (deleteSmokeArtifacts) {
      const smokeRows = database.prepare(`
        SELECT e.id
        FROM evidence e
        JOIN graph_episode_annotations a ON a.evidence_id=e.id
        WHERE e.kind='manual_knowledge'
          AND a.generated_by='unified-direct-input-smoke'
          AND e.title='V4.9 统一输入任务建卡冒烟测试'
          AND e.source_locator LIKE 'shadow-agent://smoke/%'
        ORDER BY e.id
      `).all();
      for (const row of smokeRows) {
        database.prepare("DELETE FROM context_changes WHERE evidence_id=?").run(row.id);
        database.prepare("DELETE FROM evidence WHERE id=?").run(row.id);
        deletedSmokeEvidenceIds.push(row.id);
      }
    }

    const placeholders = COLD_INVENTORY_KINDS.map(() => "?").join(",");
    const coldRows = database.prepare(`
      SELECT q.evidence_id
      FROM graph_enrichment_queue q
      JOIN evidence e ON e.id=q.evidence_id
      JOIN graph_episode_annotations a ON a.evidence_id=q.evidence_id
      WHERE q.status='pending' AND q.attempts=0
        AND a.generated_by='deterministic-backfill'
        AND e.kind IN (${placeholders})
      ORDER BY q.evidence_id
    `).all(...COLD_INVENTORY_KINDS);
    const coldUpdate = database.prepare(`
      UPDATE graph_enrichment_queue SET status='cold',
        metadata_json=json_set(
          CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
          '$.governanceTier', 'cold_inventory', '$.classifiedAt', ?
        )
      WHERE evidence_id=? AND status='pending'
    `);
    for (const row of coldRows) {
      coldUpdate.run(timestamp, row.evidence_id);
      coldEvidenceIds.push(row.evidence_id);
    }

    const trackRows = database.prepare(`
      SELECT f.id FROM graph_facts f
      WHERE f.status='active' AND f.predicate='TRACKS_PROJECT' AND f.created_by='system'
        AND NOT EXISTS (SELECT 1 FROM graph_evidence_assessments a WHERE a.fact_id=f.id)
        AND NOT EXISTS (SELECT 1 FROM graph_derivations d WHERE d.conclusion_fact_id=f.id)
      ORDER BY f.id
    `).all();
    const supersedeTrack = database.prepare(`
      UPDATE graph_facts SET status='superseded', valid_to=?, updated_at=?,
        metadata_json=json_set(
          CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
          '$.governance.supersededReason', 'local_workspace_is_not_responsibility',
          '$.governance.supersededAt', ?
        ) WHERE id=?
    `);
    for (const row of trackRows) {
      supersedeTrack.run(timestamp, timestamp, timestamp, row.id);
      supersededTrackFactIds.push(row.id);
    }

    const belongsRows = database.prepare(`
      SELECT f.id, f.metadata_json, subject.type AS subject_type,
        subject.canonical_key AS subject_key,
        (SELECT ge.evidence_id FROM graph_entity_evidence ge
          WHERE ge.entity_id=f.subject_entity_id ORDER BY ge.observed_at DESC LIMIT 1) AS evidence_id
      FROM graph_facts f
      JOIN graph_entities subject ON subject.id=f.subject_entity_id
      WHERE f.status='active' AND f.predicate='BELONGS_TO' AND f.created_by='system'
        AND COALESCE(f.assertion_mode, 'observed')<>'structural_route'
        AND NOT EXISTS (SELECT 1 FROM graph_evidence_assessments a WHERE a.fact_id=f.id)
        AND NOT EXISTS (SELECT 1 FROM graph_derivations d WHERE d.conclusion_fact_id=f.id)
      ORDER BY f.id
    `).all();
    const updateStructural = database.prepare(`
      UPDATE graph_facts SET assertion_mode='structural_route', epistemic_status='proposed',
        metadata_json=?, updated_at=? WHERE id=?
    `);
    for (const row of belongsRows) {
      updateStructural.run(stableJson({
        ...parseJson(row.metadata_json),
        structuralSource: structuralSource(row),
        responsibilitySemantics: false,
      }), timestamp, row.id);
      structuralFactIds.push(row.id);
    }

    const invalidWorkspaceRows = database.prepare(`
      SELECT f.id
      FROM graph_facts f
      JOIN graph_entities project ON project.id=f.object_entity_id
      WHERE f.status='active' AND f.predicate='HAS_LOCAL_WORKSPACE'
        AND f.created_by='system'
        AND NOT EXISTS (
          SELECT 1 FROM projects p WHERE p.project_key=project.project_key
        )
      ORDER BY f.id
    `).all();
    const supersedeWorkspace = database.prepare(`
      UPDATE graph_facts SET status='superseded', valid_to=?, updated_at=?,
        metadata_json=json_set(
          CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
          '$.governance.supersededReason', 'no_local_project_registry_entry',
          '$.governance.supersededAt', ?
        ) WHERE id=?
    `);
    for (const row of invalidWorkspaceRows) {
      supersedeWorkspace.run(timestamp, timestamp, timestamp, row.id);
      supersededWorkspaceFactIds.push(row.id);
    }

    registerRelationType(database, {
      predicate: "HAS_LOCAL_WORKSPACE",
      description: "主体在本机具有可查询的项目工作区入口；仅用于导航，不表示职责、所有权或当前任务。",
      origin: "core",
      metadata: { governance: "structural_route" },
    });
    const self = database.prepare("SELECT id FROM graph_entities WHERE canonical_key='person:self'").get();
    if (self) {
      const projects = database.prepare(`
        SELECT entity.id, entity.canonical_key, entity.project_key
        FROM graph_entities entity
        JOIN projects project ON project.project_key=entity.project_key
        WHERE entity.type='Project' AND entity.status='active'
        ORDER BY entity.canonical_key
      `).all();
      const upsertWorkspace = database.prepare(`
        INSERT INTO graph_facts(
          id, fingerprint, subject_entity_id, predicate, object_entity_id, object_value,
          status, confidence, valid_from, valid_to, observed_at, updated_at, metadata_json,
          scope_key, assertion_mode, epistemic_status, created_by, supersedes_fact_id
        ) VALUES(?, ?, ?, 'HAS_LOCAL_WORKSPACE', ?, NULL, 'active', 1, ?, NULL, ?, ?, ?,
          'global', 'structural_route', 'proposed', 'system', NULL)
        ON CONFLICT(fingerprint) DO UPDATE SET
          status='active', valid_to=NULL, updated_at=excluded.updated_at,
          metadata_json=excluded.metadata_json, assertion_mode='structural_route',
          epistemic_status='proposed', created_by='system'
      `);
      for (const project of projects) {
        const identity = graphFactId(self.id, "HAS_LOCAL_WORKSPACE", project.id);
        upsertWorkspace.run(
          identity.id,
          identity.fingerprint,
          self.id,
          project.id,
          timestamp,
          timestamp,
          timestamp,
          stableJson({
            structuralSource: { table: "projects", key: project.project_key ?? project.canonical_key },
            responsibilitySemantics: false,
          }),
        );
        workspaceFactIds.push(identity.id);
      }
    }

    const reviewRows = database.prepare(`
      SELECT q.evidence_id, e.title, e.project_key, e.thread_id
      FROM graph_enrichment_queue q
      JOIN evidence e ON e.id=q.evidence_id
      JOIN graph_episode_annotations a ON a.evidence_id=q.evidence_id
      WHERE q.status='pending' AND e.kind='manual_knowledge'
        AND a.generated_by NOT IN ('deterministic-backfill','unified-direct-input-smoke')
        AND NOT EXISTS (
          SELECT 1 FROM context_changes c
          WHERE c.event_key='knowledge-governance-review:' || q.evidence_id
        )
      ORDER BY q.priority DESC, q.queued_at, q.evidence_id
    `).all();
    const insertReviewChange = database.prepare(`
      INSERT INTO context_changes(
        event_key, coalesce_key, kind, evidence_id, project_key, session_key,
        priority, status, not_before, occurred_at, created_at, summary, metadata_json
      ) VALUES(?, NULL, 'knowledge_review_due', ?, ?, ?,
        'high', 'pending', ?, ?, ?, ?, ?)
      ON CONFLICT(event_key) DO NOTHING
    `);
    for (const row of reviewRows) {
      insertReviewChange.run(
        `knowledge-governance-review:${row.evidence_id}`,
        row.evidence_id,
        row.project_key,
        row.thread_id,
        timestamp,
        timestamp,
        timestamp,
        `人工反馈等待语义复核：${String(row.title ?? row.evidence_id).slice(0, 500)}`,
        stableJson({
          evidenceIds: [row.evidence_id],
          governanceTier: "active_review",
          requiredAction: "lease_exact_evidence_and_complete_graph_review",
        }),
      );
      scheduledManualReviewEvidenceIds.push(row.evidence_id);
    }
    if (ownsTransaction) database.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction) database.exec("ROLLBACK");
    throw error;
  }
  return {
    before,
    actions: {
      deletedSmokeEvidenceIds,
      coldEvidenceIds,
      supersededTrackFactIds,
      structuralFactIds,
      supersededWorkspaceFactIds,
      workspaceFactIds,
      scheduledManualReviewEvidenceIds,
    },
    after: inspectKnowledgeGovernance(database),
  };
}
