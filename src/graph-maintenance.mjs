import { randomUUID } from "node:crypto";

import { nowIso, stableJson } from "./utils.mjs";
import { currentFactTrust } from "./graph-model.mjs";

const NEEDS_REVIEW = "needs_review";
const PROTECTED_STATUSES = new Set(["refuted", "disputed"]);

const MAINTENANCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS graph_maintenance_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  options_json TEXT NOT NULL DEFAULT '{}',
  stats_json TEXT NOT NULL DEFAULT '{}',
  error TEXT
);

CREATE INDEX IF NOT EXISTS graph_maintenance_runs_started_idx
  ON graph_maintenance_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS graph_fact_status_history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  action TEXT NOT NULL,
  previous_epistemic_status TEXT NOT NULL,
  new_epistemic_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(run_id) REFERENCES graph_maintenance_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY(fact_id) REFERENCES graph_facts(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS graph_fact_status_history_fact_idx
  ON graph_fact_status_history(fact_id, changed_at DESC, seq DESC);
`;

const REQUIRED_COLUMNS = Object.freeze({
  graph_facts: ["id", "status", "epistemic_status", "assertion_mode", "updated_at", "metadata_json"],
  graph_fact_evidence: ["fact_id", "evidence_id"],
  graph_evidence_assessments: ["fact_id", "evidence_id", "stance", "level"],
  evidence_links: ["parent_evidence_id", "child_evidence_id", "relation"],
  graph_derivations: ["id", "conclusion_fact_id"],
  graph_derivation_inputs: ["derivation_id", "input_fact_id"],
});

function parseJson(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function tableColumns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function assertGraphSchema(database) {
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const found = tableColumns(database, table);
    if (!found.size) throw new Error(`Graph maintenance requires table ${table}`);
    const missing = columns.filter((column) => !found.has(column));
    if (missing.length) throw new Error(`Graph maintenance requires ${table}.${missing.join(`, ${table}.`)}`);
  }
}

function resolveTimestamp(options) {
  const raw = typeof options.now === "function" ? options.now() : (options.now ?? nowIso());
  const timestamp = new Date(raw);
  if (Number.isNaN(timestamp.getTime())) throw new Error(`Invalid graph maintenance timestamp: ${raw}`);
  return timestamp.toISOString();
}

function sorted(values) {
  return [...new Set(values)].sort();
}

function maintenanceSignature(value) {
  if (!value || typeof value !== "object") return "";
  return stableJson({
    state: value.state ?? null,
    reason: value.reason ?? null,
    reasons: value.reasons ?? [],
    supersededEvidenceIds: value.supersededEvidenceIds ?? [],
    activeEvidenceIds: value.activeEvidenceIds ?? [],
    invalidInputFactIds: value.invalidInputFactIds ?? [],
    recoveredTo: value.recoveredTo ?? null,
    highestActiveEvidenceLevel: value.highestActiveEvidenceLevel ?? null,
  });
}

function appendMaintenanceMetadata(metadata, maintenance) {
  const previous = metadata.graphMaintenance;
  if (previous && maintenanceSignature(previous) !== maintenanceSignature(maintenance)) {
    const history = Array.isArray(metadata.graphMaintenanceHistory)
      ? [...metadata.graphMaintenanceHistory]
      : [];
    history.push(previous);
    metadata.graphMaintenanceHistory = history;
  }
  metadata.graphMaintenance = maintenance;
  return metadata;
}

function loadSupportState(database, asOf) {
  const rows = database.prepare(`
    WITH supporting_evidence AS (
      SELECT fact_id, evidence_id, MAX(level) AS level,
        MIN(CASE WHEN valid_until IS NULL OR julianday(valid_until)>julianday(?) THEN 0 ELSE 1 END) AS expired
      FROM graph_evidence_assessments
      WHERE stance='supports'
      GROUP BY fact_id, evidence_id

      UNION ALL

      SELECT legacy.fact_id, legacy.evidence_id, 0 AS level, 0 AS expired
      FROM graph_fact_evidence legacy
      WHERE NOT EXISTS (
        SELECT 1 FROM graph_evidence_assessments assessment
        WHERE assessment.fact_id=legacy.fact_id
          AND assessment.evidence_id=legacy.evidence_id
      )
    )
    SELECT support.fact_id, support.evidence_id,
      MAX(support.level) AS level,
      MAX(CASE WHEN replacement.child_evidence_id IS NULL THEN support.expired ELSE 1 END) AS superseded,
      MAX(support.expired) AS expired
    FROM supporting_evidence support
    LEFT JOIN evidence_links replacement
      ON replacement.child_evidence_id=support.evidence_id
     AND replacement.relation='supersedes'
    GROUP BY support.fact_id, support.evidence_id
    ORDER BY support.fact_id, support.evidence_id
  `).all(asOf);
  const byFact = new Map();
  for (const row of rows) {
    const support = byFact.get(row.fact_id) ?? [];
    support.push({
      evidenceId: row.evidence_id,
      level: Math.max(0, Math.min(5, Number(row.level) || 0)),
      superseded: Boolean(row.superseded),
      expired: Boolean(row.expired),
    });
    byFact.set(row.fact_id, support);
  }
  return { rows, byFact };
}

function loadDerivations(database) {
  const rows = database.prepare(`
    SELECT derivation.conclusion_fact_id, input.input_fact_id
    FROM graph_derivations derivation
    JOIN graph_derivation_inputs input ON input.derivation_id=derivation.id
    ORDER BY derivation.conclusion_fact_id, input.ordinal, input.input_fact_id
  `).all();
  const inputsByConclusion = new Map();
  const dependentsByInput = new Map();
  for (const row of rows) {
    const inputs = inputsByConclusion.get(row.conclusion_fact_id) ?? new Set();
    inputs.add(row.input_fact_id);
    inputsByConclusion.set(row.conclusion_fact_id, inputs);

    const dependents = dependentsByInput.get(row.input_fact_id) ?? new Set();
    dependents.add(row.conclusion_fact_id);
    dependentsByInput.set(row.input_fact_id, dependents);
  }
  return { rows, inputsByConclusion, dependentsByInput };
}

function supportSummary(supports) {
  const active = supports.filter((item) => !item.superseded);
  const superseded = supports.filter((item) => item.superseded);
  return {
    count: supports.length,
    active,
    superseded,
    highestActiveLevel: active.length ? Math.max(...active.map((item) => item.level)) : null,
  };
}

function currentDerivedTrust(database, factId, asOf) {
  return currentFactTrust(database, factId, { asOf });
}

function updateFactMetadata(database, change) {
  database.prepare(`
    UPDATE graph_facts
    SET epistemic_status=?, metadata_json=?, updated_at=?
    WHERE id=?
  `).run(change.to, change.metadataJson, change.changedAt, change.factId);
}

function insertHistory(database, runId, change) {
  database.prepare(`
    INSERT INTO graph_fact_status_history(
      run_id, fact_id, action, previous_epistemic_status,
      new_epistemic_status, reason, changed_at, details_json
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    change.factId,
    change.action,
    change.from,
    change.to,
    change.reason,
    change.changedAt,
    stableJson(change.details),
  );
}

export function initializeGraphMaintenance(database) {
  if (!database?.prepare || !database?.exec) throw new TypeError("A synchronous SQLite database is required");
  assertGraphSchema(database);
  database.exec(MAINTENANCE_SCHEMA);
  return {
    initialized: true,
    tables: ["graph_maintenance_runs", "graph_fact_status_history"],
  };
}

export function propagateKnowledgeStaleness(database, options = {}) {
  initializeGraphMaintenance(database);
  const startedAt = resolveTimestamp(options);
  const runId = String(options.runId ?? randomUUID());
  const dryRun = Boolean(options.dryRun);
  const recordNoop = Boolean(options.recordNoop);
  const facts = database.prepare(`
    SELECT id, status, epistemic_status, assertion_mode, updated_at, metadata_json
    FROM graph_facts
    ORDER BY id
  `).all();
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  const supportState = loadSupportState(database, startedAt);
  const derivations = loadDerivations(database);

  const supportByFact = new Map();
  const directStale = new Set();
  const protectedFacts = new Set();
  let evidenceFactsKeptFresh = 0;
  for (const fact of facts) {
    const summary = supportSummary(supportState.byFact.get(fact.id) ?? []);
    supportByFact.set(fact.id, summary);
    if (fact.status !== "active") continue;
    if (summary.superseded.length && summary.active.length) evidenceFactsKeptFresh += 1;
    if (summary.count && !summary.active.length) directStale.add(fact.id);
    if (PROTECTED_STATUSES.has(fact.epistemic_status)) protectedFacts.add(fact.id);
  }

  // Invalidity is monotonic within one run. Review need lives in metadata; the
  // persisted trust value remains one of proposed/supported/disputed/refuted.
  const invalid = new Set();
  const invalidDepth = new Map();
  const queue = [];
  for (const fact of facts) {
    const maintenance = parseJson(fact.metadata_json).graphMaintenance;
    const baseInvalid = fact.status !== "active"
      || PROTECTED_STATUSES.has(fact.epistemic_status)
      || directStale.has(fact.id);
    if (!baseInvalid) continue;
    invalid.add(fact.id);
    invalidDepth.set(fact.id, 0);
    queue.push(fact.id);
  }

  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const inputFactId = queue[queueIndex];
    queueIndex += 1;
    const nextDepth = (invalidDepth.get(inputFactId) ?? 0) + 1;
    for (const conclusionId of derivations.dependentsByInput.get(inputFactId) ?? []) {
      if (invalid.has(conclusionId)) continue;
      invalid.add(conclusionId);
      invalidDepth.set(conclusionId, nextDepth);
      queue.push(conclusionId);
    }
  }

  const invalidInputsByConclusion = new Map();
  for (const [conclusionId, inputIds] of derivations.inputsByConclusion) {
    const badInputs = [...inputIds].filter((inputId) => {
      const input = factsById.get(inputId);
      return !input
        || input.status !== "active"
        || invalid.has(inputId);
    });
    if (badInputs.length) invalidInputsByConclusion.set(conclusionId, sorted(badInputs));
  }

  const changes = [];
  let protectedManualStatuses = 0;
  for (const fact of facts) {
    if (fact.status !== "active") continue;
    const support = supportByFact.get(fact.id);
    const invalidInputs = invalidInputsByConclusion.get(fact.id) ?? [];
    const staleReasons = [];
    if (directStale.has(fact.id)) staleReasons.push(support.superseded.some((item) => item.expired)
      ? "all_supporting_evidence_inactive" : "all_supporting_evidence_superseded");
    if (invalidInputs.length) staleReasons.push("derived_input_invalid");

    if (PROTECTED_STATUSES.has(fact.epistemic_status)) {
      if (staleReasons.length || support.active.length) protectedManualStatuses += 1;
      continue;
    }

    const metadata = parseJson(fact.metadata_json);
    const previousMaintenance = metadata.graphMaintenance;
    if (staleReasons.length) {
      const maintenance = {
        state: NEEDS_REVIEW,
        reason: staleReasons[0],
        reasons: staleReasons,
        changedAt: startedAt,
        runId,
        previousEpistemicStatus: previousMaintenance?.state === NEEDS_REVIEW
          ? (previousMaintenance.previousEpistemicStatus ?? fact.epistemic_status)
          : fact.epistemic_status,
        supersededEvidenceIds: sorted(support.superseded.map((item) => item.evidenceId)),
        activeEvidenceIds: sorted(support.active.map((item) => item.evidenceId)),
        invalidInputFactIds: invalidInputs,
        highestActiveEvidenceLevel: support.highestActiveLevel,
      };
      const sameMaintenance = maintenanceSignature(previousMaintenance) === maintenanceSignature(maintenance);
      if (fact.epistemic_status === "proposed" && sameMaintenance) continue;
      appendMaintenanceMetadata(metadata, maintenance);
      changes.push({
        factId: fact.id,
        action: fact.epistemic_status === "proposed" ? "metadata_updated" : "marked_needs_review",
        from: fact.epistemic_status,
        to: "proposed",
        reason: maintenance.reason,
        changedAt: startedAt,
        metadataJson: stableJson(metadata),
        details: {
          reasons: staleReasons,
          supersededEvidenceIds: maintenance.supersededEvidenceIds,
          activeEvidenceIds: maintenance.activeEvidenceIds,
          invalidInputFactIds: invalidInputs,
          propagationDepth: invalidDepth.get(fact.id) ?? 0,
        },
      });
      continue;
    }

    const recoverableReview = previousMaintenance?.state === NEEDS_REVIEW
      && (support.active.length > 0 || derivations.inputsByConclusion.has(fact.id));
    if (!recoverableReview) continue;
    const recoveredStatus = currentDerivedTrust(database, fact.id, startedAt);
    const maintenance = {
      state: "recovered",
      reason: support.active.length ? "fresh_supporting_evidence" : "derivation_inputs_recovered",
      reasons: [],
      changedAt: startedAt,
      runId,
      previousEpistemicStatus: fact.epistemic_status,
      recoveredTo: recoveredStatus,
      supersededEvidenceIds: sorted(support.superseded.map((item) => item.evidenceId)),
      activeEvidenceIds: sorted(support.active.map((item) => item.evidenceId)),
      invalidInputFactIds: [],
      highestActiveEvidenceLevel: support.highestActiveLevel,
    };
    appendMaintenanceMetadata(metadata, maintenance);
    changes.push({
      factId: fact.id,
      action: "recovered",
      from: fact.epistemic_status,
      to: recoveredStatus,
      reason: maintenance.reason,
      changedAt: startedAt,
      metadataJson: stableJson(metadata),
      details: {
        activeEvidenceIds: maintenance.activeEvidenceIds,
        highestActiveEvidenceLevel: support.highestActiveLevel,
      },
    });
  }

  const transitions = changes.map(({ metadataJson, ...change }) => change);
  const stats = {
    runId,
    dryRun,
    persisted: !dryRun && (changes.length > 0 || recordNoop),
    startedAt,
    completedAt: options.now ? startedAt : nowIso(),
    scanned: {
      facts: facts.length,
      activeFacts: facts.filter((fact) => fact.status === "active").length,
      supportingAssessments: supportState.rows.length,
      factsWithSupportingEvidence: supportByFact.size
        ? [...supportByFact.values()].filter((item) => item.count > 0).length
        : 0,
      derivationConclusions: derivations.inputsByConclusion.size,
      derivationInputs: derivations.rows.length,
    },
    evidence: {
      fullySupersededFacts: directStale.size,
      keptFreshByAlternativeEvidence: evidenceFactsKeptFresh,
    },
    derivation: {
      invalidConclusions: invalidInputsByConclusion.size,
      recursivelyInvalidConclusions: [...invalidInputsByConclusion.keys()]
        .filter((factId) => (invalidDepth.get(factId) ?? 0) >= 2).length,
      maximumPropagationDepth: Math.max(0, ...invalidDepth.values()),
    },
    changes: {
      markedNeedsReview: changes.filter((change) => change.action === "marked_needs_review").length,
      metadataUpdated: changes.filter((change) => change.action === "metadata_updated").length,
      recoveredSupported: changes.filter((change) => change.action === "recovered" && change.to === "supported").length,
      recoveredProposed: changes.filter((change) => change.action === "recovered" && change.to === "proposed").length,
      protectedManualStatuses,
      total: changes.length,
    },
    transitions,
  };

  // Materialization runs frequently. Keep no-op checks cheap and observable in
  // the return value without filling the audit tables with empty heartbeat runs.
  if (dryRun || (!changes.length && !recordNoop)) return stats;

  const auditOptions = {
    dryRun: false,
    requestedRunId: options.runId ?? null,
    requestedTimestamp: options.now ? startedAt : null,
  };
  database.prepare(`
    INSERT INTO graph_maintenance_runs(
      id, kind, status, started_at, options_json, stats_json
    ) VALUES(?, 'knowledge_staleness', 'running', ?, ?, '{}')
  `).run(runId, startedAt, stableJson(auditOptions));

  database.exec("SAVEPOINT graph_maintenance_propagation");
  try {
    for (const change of changes) {
      updateFactMetadata(database, change);
      insertHistory(database, runId, change);
    }
    database.prepare(`
      UPDATE graph_maintenance_runs
      SET status='completed', completed_at=?, stats_json=?
      WHERE id=?
    `).run(stats.completedAt, stableJson(stats), runId);
    database.exec("RELEASE SAVEPOINT graph_maintenance_propagation");
    return stats;
  } catch (error) {
    database.exec("ROLLBACK TO SAVEPOINT graph_maintenance_propagation");
    database.exec("RELEASE SAVEPOINT graph_maintenance_propagation");
    database.prepare(`
      UPDATE graph_maintenance_runs
      SET status='failed', completed_at=?, error=?
      WHERE id=?
    `).run(nowIso(), String(error?.stack ?? error), runId);
    throw error;
  }
}
