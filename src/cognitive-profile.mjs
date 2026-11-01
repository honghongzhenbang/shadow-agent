import fs from "node:fs";
import path from "node:path";

import {
  assessFactEvidence,
  assertGraphFact,
  upsertGraphEntity,
} from "./graph-model.mjs";
import { nowIso, sha256, stableJson } from "./utils.mjs";

const SECRET_KEY_PATTERN = /(?:password|passwd|secret|access.?token|refresh.?token|api.?key|private.?key)/i;

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function rejectSecretFields(value, trail = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretFields(item, [...trail, String(index)]));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new Error(`Secret-bearing field is not allowed in a cognitive profile: ${[...trail, key].join(".")}`);
    }
    rejectSecretFields(child, [...trail, key]);
  }
}

export function validateCognitiveProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error("Cognitive profile must be an object.");
  if (profile.exampleOnly === true) throw new Error("Example profile is not user knowledge. Replace its sample content and remove exampleOnly before import.");
  if (Number(profile.version) !== 1) throw new Error("Cognitive profile version must be 1.");
  rejectSecretFields(profile);
  const entities = Array.isArray(profile.entities) ? profile.entities : [];
  const relations = Array.isArray(profile.relations) ? profile.relations : [];
  if (!entities.length) throw new Error("Cognitive profile must contain at least one entity.");
  const canonicalKeys = new Set();
  for (const [index, entity] of entities.entries()) {
    const canonicalKey = requiredText(entity.canonicalKey, `entities[${index}].canonicalKey`);
    requiredText(entity.type, `entities[${index}].type`);
    requiredText(entity.name, `entities[${index}].name`);
    if (canonicalKeys.has(canonicalKey)) throw new Error(`Duplicate entity canonicalKey: ${canonicalKey}`);
    canonicalKeys.add(canonicalKey);
  }
  for (const [index, relation] of relations.entries()) {
    requiredText(relation.subject, `relations[${index}].subject`);
    requiredText(relation.predicate, `relations[${index}].predicate`);
    const hasObject = Boolean(String(relation.object ?? "").trim());
    const hasValue = Object.hasOwn(relation, "objectValue");
    if (hasObject === hasValue) {
      throw new Error(`relations[${index}] must define exactly one of object or objectValue.`);
    }
    if (relation.confidence !== undefined) {
      const confidence = Number(relation.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw new Error(`relations[${index}].confidence must be between 0 and 1.`);
      }
    }
  }
  return {
    title: String(profile.title ?? "人工认知路由资料").trim() || "人工认知路由资料",
    entities,
    relations,
  };
}

export function importCognitiveProfile(store, profile, options = {}) {
  const validated = validateCognitiveProfile(profile);
  if (options.dryRun) {
    return {
      dryRun: true,
      title: validated.title,
      entities: validated.entities.length,
      relations: validated.relations.length,
    };
  }
  const sourceLocator = options.sourceLocator ?? "manual://cognitive-profile";
  const createdBy = options.createdBy ?? "manual-cognitive-profile";
  const profileScope = `cognitive-profile:${sha256(sourceLocator).slice(0, 24)}`;
  const observedAt = options.occurredAt ?? nowIso();
  const source = store.upsertSource({
    sourceKey: `manual-cognitive-profile:${sourceLocator}`,
    kind: "manual_knowledge",
    uri: sourceLocator,
    metadata: { structured: true, schemaVersion: 1 },
  });
  const content = JSON.stringify(profile, null, 2);
  const evidence = store.addEvidence({
    sourceId: source.id,
    kind: "manual_knowledge",
    title: validated.title,
    content,
    sourceLocator,
    externalId: options.externalId ?? null,
    occurredAt: observedAt,
    metadata: {
      structuredProfile: true,
      schemaVersion: 1,
      profileScope,
      entityCount: validated.entities.length,
      relationCount: validated.relations.length,
    },
  });
  const writeGraph = () => {
    const previousFacts = store.db.prepare(`
      SELECT DISTINCT fact.id, fact.metadata_json
      FROM graph_facts fact
      JOIN graph_evidence_assessments assessment ON assessment.fact_id=fact.id
      JOIN evidence ON evidence.id=assessment.evidence_id
      WHERE fact.status='active'
        AND assessment.assessed_by=?
        AND evidence.source_locator=?
    `).all(createdBy, sourceLocator);
    const previousEntities = store.db.prepare(`
      SELECT DISTINCT entity.id
      FROM graph_entities entity
      JOIN graph_entity_evidence link ON link.entity_id=entity.id
      JOIN evidence ON evidence.id=link.evidence_id
      WHERE entity.status='active' AND evidence.source_locator=?
    `).all(sourceLocator);
    const entities = new Map();
    for (const item of validated.entities) {
      const entity = upsertGraphEntity(store.db, {
        canonicalKey: item.canonicalKey,
        type: item.type,
        name: item.name,
        summary: item.summary ?? "",
        aliases: item.aliases ?? [],
        projectKey: item.projectKey,
        status: item.status ?? "active",
        metadata: {
          ...(item.metadata ?? {}),
          sourceKind: "manual-cognitive-profile",
          cognitiveProfileScope: profileScope,
        },
        presentationPriority: 90,
        observedAt,
      });
      entities.set(item.canonicalKey, entity);
      store.db.prepare(`
        INSERT OR IGNORE INTO graph_entity_evidence(entity_id, evidence_id, relation, observed_at)
        VALUES(?, ?, 'supported_by', ?)
      `).run(entity.id, evidence.id, observedAt);
    }
    const facts = [];
    for (const relation of validated.relations) {
      const scopeKey = relation.scopeKey ? `${profileScope}:${relation.scopeKey}` : profileScope;
      // A confirmed current profile can reintroduce a retired route. Preserve the
      // old interval, and reuse the current occurrence on subsequent imports.
      const subjectId = entities.get(relation.subject)?.id
        ?? store.db.prepare("SELECT id FROM graph_entities WHERE id=? OR canonical_key=?").get(relation.subject, relation.subject)?.id;
      const objectId = relation.object ? (entities.get(relation.object)?.id
        ?? store.db.prepare("SELECT id FROM graph_entities WHERE id=? OR canonical_key=?").get(relation.object, relation.object)?.id) : null;
      const current = store.db.prepare(`SELECT valid_from FROM graph_facts
        WHERE subject_entity_id=? AND predicate=? AND scope_key=? AND status='active'
          AND object_entity_id IS ? AND object_value IS ?
          AND (valid_from IS NULL OR julianday(valid_from)<=julianday(?))
          AND (valid_to IS NULL OR julianday(valid_to)>julianday(?))
        ORDER BY valid_from DESC LIMIT 1`).get(subjectId ?? null, relation.predicate, scopeKey, objectId ?? null,
        relation.objectValue === undefined ? null : stableJson(relation.objectValue), observedAt, observedAt);
      const fact = assertGraphFact(store.db, {
        subject: relation.subject,
        predicate: relation.predicate,
        objectEntity: relation.object,
        objectValue: relation.objectValue,
        scopeKey,
        validFrom: relation.validFrom ?? current?.valid_from ?? observedAt,
        validTo: relation.validTo,
        confidence: relation.confidence ?? 0.9,
        assertionMode: "observed",
        epistemicStatus: "supported",
        createdBy,
        observedAt,
        metadata: {
          ...(relation.metadata ?? {}),
          notes: relation.notes ?? "",
          cognitiveProfileScope: profileScope,
          cognitiveProfileSource: sourceLocator,
          cognitiveProfileEvidenceId: evidence.id,
        },
      });
      assessFactEvidence(store.db, {
        factId: fact.id,
        evidenceId: evidence.id,
        stance: "supports",
        basis: "record",
        directness: "direct",
        method: "document_record",
        environment: "local",
        outcome: "observed",
        confidence: relation.confidence ?? 0.9,
        notes: relation.notes ?? "由用户维护的结构化认知路由资料。",
        assessedBy: createdBy,
      });
      facts.push(fact);
    }
    const currentFactIds = new Set(facts.map((fact) => fact.id));
    let supersededRelations = 0;
    for (const previous of previousFacts) {
      if (currentFactIds.has(previous.id)) continue;
      store.db.prepare(`
        UPDATE graph_evidence_assessments
        SET valid_until=?
        WHERE fact_id=? AND assessed_by=? AND (valid_until IS NULL OR valid_until>?)
          AND evidence_id IN (SELECT id FROM evidence WHERE source_locator=?)
      `).run(observedAt, previous.id, createdBy, observedAt, sourceLocator);
      const activeSupport = Number(store.db.prepare(`
        SELECT COUNT(*) AS count
        FROM graph_evidence_assessments assessment
        WHERE assessment.fact_id=? AND assessment.stance='supports'
          AND (assessment.valid_until IS NULL OR assessment.valid_until>?)
      `).get(previous.id, observedAt)?.count ?? 0);
      const legacySupport = Number(store.db.prepare(`
        SELECT COUNT(*) AS count
        FROM graph_fact_evidence link
        JOIN evidence ON evidence.id=link.evidence_id
        WHERE link.fact_id=? AND evidence.source_locator<>?
      `).get(previous.id, sourceLocator)?.count ?? 0);
      const derivationSupport = Number(store.db.prepare(`
        SELECT COUNT(*) AS count FROM graph_derivations WHERE conclusion_fact_id=?
      `).get(previous.id)?.count ?? 0);
      if (activeSupport || legacySupport || derivationSupport) continue;
      const metadata = {
        ...parseStoredJson(previous.metadata_json),
        cognitiveProfileRemovedAt: observedAt,
        cognitiveProfileRemovedByEvidenceId: evidence.id,
      };
      const result = store.db.prepare(`
        UPDATE graph_facts
        SET status='superseded', valid_to=?, updated_at=?, metadata_json=?
        WHERE id=? AND status='active'
      `).run(observedAt, observedAt, stableJson(metadata), previous.id);
      supersededRelations += Number(result.changes ?? 0);
    }

    const currentEntityIds = new Set([...entities.values()].map((entity) => entity.id));
    let inactivatedEntities = 0;
    for (const previous of previousEntities) {
      if (currentEntityIds.has(previous.id)) continue;
      const otherEvidence = Number(store.db.prepare(`
        SELECT COUNT(*) AS count
        FROM graph_entity_evidence link
        JOIN evidence ON evidence.id=link.evidence_id
        WHERE link.entity_id=? AND evidence.source_locator<>?
      `).get(previous.id, sourceLocator)?.count ?? 0);
      const activeFacts = Number(store.db.prepare(`
        SELECT COUNT(*) AS count FROM graph_facts
        WHERE status='active' AND (subject_entity_id=? OR object_entity_id=?)
      `).get(previous.id, previous.id)?.count ?? 0);
      if (otherEvidence || activeFacts) continue;
      const result = store.db.prepare(`
        UPDATE graph_entities SET status='inactive', updated_at=?
        WHERE id=? AND status='active'
      `).run(observedAt, previous.id);
      inactivatedEntities += Number(result.changes ?? 0);
    }
    return { entities: [...entities.values()], facts, supersededRelations, inactivatedEntities };
  };
  const imported = options.transaction === false ? writeGraph() : store.transaction(writeGraph);
  return {
    dryRun: false,
    evidenceId: evidence.id,
    evidenceInserted: evidence.inserted,
    entities: imported.entities.length,
    relations: imported.facts.length,
    supersededRelations: imported.supersededRelations,
    inactivatedEntities: imported.inactivatedEntities,
    profileScope,
  };
}

function parseStoredJson(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function readCognitiveProfile(filePath) {
  const resolved = path.resolve(filePath);
  const profile = JSON.parse(fs.readFileSync(resolved, "utf8").replace(/^\uFEFF/, ""));
  return { profile, resolved };
}
