import { currentFactTrust } from "../../../src/graph-model.mjs";
import { isEffectiveAt } from "../../../src/knowledge-policy.mjs";

const ROUTING_PREDICATES = new Set([
  "RESPONSIBLE_FOR",
  "HAS_RESPONSIBLE_PARTY",
  "EXPERT_IN",
  "MAINTAINS",
  "MAINTAINED_BY",
  "DOCUMENTED_IN",
  "IMPLEMENTED_IN",
  "DISCUSSED_IN",
  "QUERY_VIA",
  "CONTACT_VIA",
  "CAN_ANSWER",
  "CAN_HELP_WITH",
  "OWNS",
  "CONTRIBUTES_TO",
  "LEADS",
  "FALLBACK_TO",
]);

const RETRIEVAL_TYPES = new Set([
  "InformationSource",
  "CodeLocation",
  "Document",
  "Repository",
  "CodeRepository",
  "CommunicationChannel",
  "Procedure",
  "Skill",
]);

const ASKABLE_TYPES = new Set(["Person", "Team", "Role"]);

const ROUTING_SEED_TYPE_PRIORITY = new Map([
  ["KnowledgeTopic", 90],
  ["Responsibility", 85],
  ["ResponsibilityArea", 85],
  ["Project", 80],
  ["Person", 75],
  ["Role", 70],
  ["Document", 55],
  ["CommunicationChannel", 45],
  ["Conversation", 10],
  ["Message", -30],
  ["Session", -40],
]);

const ROUTING_PREDICATE_PRIORITY = new Map([
  ["OWNS", 90],
  ["RESPONSIBLE_FOR", 80],
  ["HAS_RESPONSIBLE_PARTY", 80],
  ["EXPERT_IN", 75],
  ["CAN_HELP_WITH", 70],
  ["CAN_ANSWER", 70],
  ["MAINTAINS", 65],
  ["MAINTAINED_BY", 65],
  ["LEADS", 60],
  ["CONTRIBUTES_TO", 35],
]);

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

function unique(values, key) {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

const GENERIC_ASCII_TERMS = new Set([
  "about", "and", "for", "from", "how", "route", "the", "this", "topic", "what", "where", "who", "with",
]);

function termDescriptors(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  const descriptors = [];
  for (const term of normalized.match(/[a-z0-9_][a-z0-9_.-]{1,}/g) ?? []) {
    if (!GENERIC_ASCII_TERMS.has(term)) descriptors.push({ value: term, kind: "ascii", weight: 2, primary: true });
  }
  for (const sequence of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    descriptors.push({ value: sequence, kind: "han", weight: Math.min(8, sequence.length), primary: true });
    for (let index = 0; index < sequence.length - 1; index += 1) {
      descriptors.push({ value: sequence.slice(index, index + 2), kind: "han", weight: 1, primary: false });
    }
  }
  const seen = new Set();
  return descriptors.filter((item) => {
    const key = `${item.kind}:${item.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => Number(right.primary) - Number(left.primary)).slice(0, 24);
}

function termsFor(value) {
  return termDescriptors(value).map((item) => item.value);
}

function routingQuery(value) {
  return String(value ?? "")
    .replace(/(?:应该)?找谁|谁负责|负责人是谁|问谁|谁能处理|谁能帮忙/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/项目$/u, "")
    .trim() || String(value ?? "").trim();
}

function compactText(value, maxChars = 800) {
  const text = String(value ?? "");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...[truncated]`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function relevance(text, descriptors) {
  const normalized = String(text ?? "").toLowerCase();
  let score = 0;
  let matches = 0;
  let primaryMatches = 0;
  let primaryAsciiMatches = 0;
  let primaryHanMatches = 0;
  for (const descriptor of descriptors) {
    const matched = descriptor.kind === "ascii"
      ? new RegExp(`(^|[^a-z0-9_.-])${escapeRegExp(descriptor.value)}($|[^a-z0-9_.-])`, "i").test(normalized)
      : normalized.includes(descriptor.value);
    if (!matched) continue;
    score += descriptor.weight;
    matches += 1;
    if (descriptor.primary) {
      primaryMatches += 1;
      if (descriptor.kind === "ascii") primaryAsciiMatches += 1;
      else primaryHanMatches += 1;
    }
  }
  const asciiCount = descriptors.filter((item) => item.kind === "ascii").length;
  const hanBigrams = descriptors.filter((item) => item.kind === "han" && !item.primary).length;
  const relevant = primaryHanMatches > 0
    || (asciiCount === 1 && primaryAsciiMatches === 1)
    || (asciiCount > 1 && primaryAsciiMatches >= 2)
    || (hanBigrams > 0 && matches >= Math.min(3, hanBigrams));
  return { score, matches, primaryMatches, relevant };
}

export function findSeeds(database, query, projectKey, limit = 12) {
  if (!String(query ?? "").trim() && !projectKey) return [];
  const seedQuery = routingQuery(query);
  const identity = database.prepare(`
    SELECT * FROM graph_entities WHERE status='active' AND (id=? OR canonical_key=?) ORDER BY id LIMIT ?
  `).all(query, query, limit);
  if (identity.length) return identity.map((row) => ({ ...row, route_exact_match: true }));
  const descriptors = termDescriptors(seedQuery).slice(0, 12);
  const terms = descriptors.map((item) => item.value).slice(0, 12);
  const rows = [];
  const candidateLimit = Math.max(96, limit * 12);
  rows.push(...database.prepare(`
    SELECT e.*, GROUP_CONCAT(a.alias, ' ') AS matched_aliases, 1 AS exact_match
    FROM graph_entities e LEFT JOIN graph_aliases a ON a.entity_id=e.id
    WHERE e.status='active' AND (
      e.name=? COLLATE NOCASE OR a.alias=? COLLATE NOCASE
      OR CASE WHEN json_valid(e.metadata_json) THEN json_extract(e.metadata_json, '$.repoPath') END=?
      OR CASE WHEN json_valid(e.metadata_json) THEN json_extract(e.metadata_json, '$.path') END=?
      OR CASE WHEN json_valid(e.metadata_json) THEN json_extract(e.metadata_json, '$.commit') END=?
    )
    GROUP BY e.id
    ORDER BY CASE WHEN e.type IN ('Session', 'Message', 'Conversation') THEN 1 ELSE 0 END, e.id LIMIT ?
  `).all(seedQuery, seedQuery, query, query, query, candidateLimit));
  // Reserve candidates for named entities before a bounded history search can crowd them out.
  const names = descriptors.filter(item => item.primary).map(item => item.value);
  if (names.length) {
    const placeholders = names.map(() => "?").join(",");
    rows.push(...database.prepare(`
      SELECT e.*, GROUP_CONCAT(a.alias, ' ') AS matched_aliases, 1 AS named_match
      FROM graph_entities e LEFT JOIN graph_aliases a ON a.entity_id=e.id
      WHERE e.status='active' AND (e.name COLLATE NOCASE IN (${placeholders})
        OR a.alias COLLATE NOCASE IN (${placeholders}))
      GROUP BY e.id
      ORDER BY CASE WHEN e.type IN ('Session', 'Message', 'Conversation') THEN 1 ELSE 0 END, e.id LIMIT ?
    `).all(...names, ...names, candidateLimit));
  }
  if (terms.length) {
    const expression = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    try {
      rows.push(...database.prepare(`
        SELECT e.* FROM graph_entity_fts fts
        JOIN graph_entities e ON e.id=fts.entity_id
        WHERE graph_entity_fts MATCH ? AND e.status='active'
        ORDER BY bm25(graph_entity_fts), e.id LIMIT ?
      `).all(expression, candidateLimit));
    } catch { /* literal lookup below remains available */ }
    const clauses = terms.map(() => "(e.name LIKE ? OR e.summary LIKE ? OR a.alias LIKE ?)").join(" OR ");
    const params = terms.flatMap((term) => [`%${term}%`, `%${term}%`, `%${term}%`]);
    rows.push(...database.prepare(`
      SELECT e.*, GROUP_CONCAT(a.alias, ' ') AS matched_aliases FROM graph_entities e
      LEFT JOIN graph_aliases a ON a.entity_id=e.id
      WHERE e.status='active' AND (${clauses})
      GROUP BY e.id
      ORDER BY CASE WHEN e.type IN ('Session', 'Message', 'Conversation') THEN 1 ELSE 0 END,
        e.updated_at DESC, e.id LIMIT ?
    `).all(...params, candidateLimit));
  }
  if (projectKey) {
    rows.push(...database.prepare(`
      SELECT * FROM graph_entities
      WHERE status='active' AND (project_key=? OR canonical_key=? OR name=?)
      ORDER BY updated_at DESC LIMIT 4
    `).all(projectKey, `project:${projectKey}`, projectKey).map((row) => ({ ...row, explicit_project_seed: 1 })));
  }
  const exactIds = new Set(rows.filter((row) => row.exact_match).map((row) => row.id));
  const namedIds = new Set(rows.filter((row) => row.named_match).map((row) => row.id));
  const ranked = unique(rows, (row) => row.id)
    .map((row) => ({
      ...row,
      route_exact_match: exactIds.has(row.id),
      route_relevance: row.explicit_project_seed || exactIds.has(row.id) || namedIds.has(row.id)
        ? { score: 1000, relevant: true }
        : relevance([row.name, row.summary, row.canonical_key, row.matched_aliases].filter(Boolean).join("\n"), descriptors),
      route_priority: (() => {
        const metadata = parseJson(row.metadata_json);
        const exactName = exactIds.has(row.id) ? 1000 : 0;
        return exactName
          + (namedIds.has(row.id) ? 200 : 0)
          + Number(metadata.presentationPriority ?? 0)
          + Number(ROUTING_SEED_TYPE_PRIORITY.get(row.type) ?? 30);
      })(),
    }))
    .filter((row) => row.route_relevance.relevant
      || (row.route_priority >= 150 && row.route_relevance.score >= 2))
    .sort((left, right) => right.route_priority - left.route_priority
      || right.route_relevance.score - left.route_relevance.score
      || String(left.id).localeCompare(String(right.id)));
  const selected = [];
  const selectedIds = new Set();
  for (const candidate of ranked.filter((row) => row.route_exact_match)) {
    selected.push(candidate);
    selectedIds.add(candidate.id);
    if (selected.length >= limit) return selected;
  }
  for (const descriptor of descriptors.filter((item) => item.primary)) {
    const descriptorTerms = termDescriptors(descriptor.value);
    const candidate = ranked
      .map((row) => {
        const text = [row.name, row.summary, row.canonical_key, row.matched_aliases].filter(Boolean).join("\n");
        return { row, descriptorScore: relevance(text, descriptorTerms).score };
      })
      .filter((item) => item.descriptorScore > 0)
      .sort((left, right) => right.descriptorScore - left.descriptorScore
        || right.row.route_priority - left.row.route_priority)[0]?.row;
    if (candidate && !selectedIds.has(candidate.id)) {
      selected.push(candidate);
      selectedIds.add(candidate.id);
    }
  }
  for (const candidate of ranked) {
    if (selectedIds.has(candidate.id)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.id);
    if (selected.length >= limit) break;
  }
  return selected.slice(0, limit);
}

function factCandidates(database, seeds, routing, { asOf, scopeKey }, limit = 80) {
  if (!seeds.length) return [];
  const placeholders = seeds.map(() => "?").join(",");
  const predicates = [...ROUTING_PREDICATES];
  const rows = database.prepare(`
    SELECT f.id, f.predicate, f.object_value, f.confidence, f.observed_at,
      f.valid_from, f.valid_to, f.scope_key, f.epistemic_status, f.assertion_mode,
      subject.id AS subject_id, subject.canonical_key AS subject_key,
      subject.type AS subject_type, subject.name AS subject_name,
      subject.summary AS subject_summary, subject.metadata_json AS subject_metadata_json,
      object.id AS object_id, object.canonical_key AS object_key,
      object.type AS object_type, object.name AS object_name,
      object.summary AS object_summary, object.metadata_json AS object_metadata_json,
      support.id AS assessment_id, support.evidence_id, support.level AS evidence_level,
      support.confidence AS evidence_confidence, support.assessed_at, support.valid_until,
      support_evidence.title AS evidence_title, support_evidence.kind AS evidence_kind,
      support_evidence.source_locator, support_evidence.occurred_at AS evidence_occurred_at,
      support_annotation.review_status AS support_review_status,
      support_annotation.review_outcome AS support_review_outcome
    FROM graph_facts f
    JOIN graph_entities subject ON subject.id=f.subject_entity_id
    LEFT JOIN graph_entities object ON object.id=f.object_entity_id
    LEFT JOIN graph_evidence_assessments support ON support.id=(
      SELECT assessment.id FROM graph_evidence_assessments assessment
      LEFT JOIN graph_episode_annotations candidate_annotation
        ON candidate_annotation.evidence_id=assessment.evidence_id
      WHERE assessment.fact_id=f.id AND assessment.stance='supports'
        AND (assessment.valid_until IS NULL OR julianday(assessment.valid_until)>julianday(?))
        AND NOT EXISTS (
          SELECT 1 FROM evidence_links replacement
          WHERE replacement.child_evidence_id=assessment.evidence_id
            AND replacement.relation='supersedes'
            AND replacement.created_at<=?
        )
      ORDER BY CASE
        WHEN COALESCE(candidate_annotation.review_status, 'evidence_assessed')
          IN ('completed', 'evidence_assessed') THEN 0 ELSE 1 END,
        assessment.level DESC, assessment.assessed_at DESC LIMIT 1
    )
    LEFT JOIN evidence support_evidence ON support_evidence.id=support.evidence_id
    LEFT JOIN graph_episode_annotations support_annotation ON support_annotation.evidence_id=support.evidence_id
    WHERE f.status IN ('active', 'superseded')
      AND (f.status<>'superseded' OR f.valid_to IS NOT NULL)
      AND (f.valid_from IS NULL OR julianday(f.valid_from)<=julianday(?))
      AND (f.valid_to IS NULL OR julianday(f.valid_to)>julianday(?))
      AND (? IS NULL OR f.scope_key=?)
      AND f.predicate ${routing ? "IN" : "NOT IN"} (${predicates.map(() => "?").join(",")})
      AND (f.subject_entity_id IN (${placeholders}) OR f.object_entity_id IN (${placeholders}))
    ORDER BY COALESCE(support.level, 0) DESC, f.confidence DESC, f.observed_at DESC, f.id
    LIMIT ?
  `).all(asOf, asOf, asOf, asOf, scopeKey, scopeKey, ...predicates,
    ...seeds.map((seed) => seed.id), ...seeds.map((seed) => seed.id), limit);
  // Trust is a time-sensitive projection; queries never repair the persisted cache.
  return rows.filter((row) => isEffectiveAt(row, asOf))
    .map((row) => ({ ...row, epistemic_status: currentFactTrust(database, row.id, { asOf }) }))
    .filter((row) => row.epistemic_status !== "refuted");
}

function factReviewStatus(row) {
  if (row.support_review_status) return row.support_review_status;
  return row.evidence_id ? "evidence_assessed" : "pending_evidence";
}

function factEvidence(row) {
  if (!row.evidence_id) return null;
  return {
    id: row.evidence_id,
    title: row.evidence_title,
    kind: row.evidence_kind,
    assessmentId: row.assessment_id,
    level: Number(row.evidence_level ?? 0),
    confidence: Number(row.evidence_confidence ?? 0),
    assessedAt: row.assessed_at,
    validUntil: row.valid_until,
  };
}

function factSource(row) {
  if (!row.evidence_id) return null;
  return {
    evidenceId: row.evidence_id,
    locator: row.source_locator,
    occurredAt: row.evidence_occurred_at,
  };
}

function verifiedFact(row) {
  return row.epistemic_status === "supported"
    && Boolean(row.evidence_id)
    && Number(row.evidence_level) >= 2
    && ["completed", "evidence_assessed"].includes(factReviewStatus(row));
}

function compactFact(row, kind = "fact") {
  const evidenceReviewStatus = factReviewStatus(row);
  return {
    kind,
    id: row.id,
    statement: compactText(`${row.subject_name} ${row.predicate} ${row.object_name ?? row.object_value ?? ""}`.trim()),
    predicate: row.predicate,
    scopeKey: row.scope_key,
    epistemicStatus: row.epistemic_status,
    evidenceLevel: Number(row.evidence_level ?? 0),
    confidence: Number(row.confidence),
    validFrom: row.valid_from,
    validTo: row.valid_to,
    observedAt: row.observed_at,
    evidence: factEvidence(row),
    source: factSource(row),
    evidenceReviewStatus,
    reviewOutcome: row.support_review_outcome ?? null,
    reviewStatus: kind === "fact_conflict"
      ? "disputed"
      : kind === "fact_pending_review" ? "pending_fact_review" : evidenceReviewStatus,
  };
}

function compactEntity(row, side) {
  const prefix = side === "subject" ? "subject" : "object";
  if (!row[`${prefix}_id`]) return null;
  return {
    id: row[`${prefix}_id`],
    canonicalKey: row[`${prefix}_key`],
    type: row[`${prefix}_type`],
    name: row[`${prefix}_name`],
    summary: row[`${prefix}_summary`],
    metadata: parseJson(row[`${prefix}_metadata_json`]),
  };
}

function locatorFor(entity, fact) {
  const metadata = entity?.metadata ?? {};
  const objectValue = parseJson(fact.object_value, fact.object_value);
  return metadata.locator ?? metadata.path ?? metadata.repoPath ?? metadata.url ?? metadata.sourceLocator
    ?? (typeof objectValue === "string" ? objectValue : objectValue?.locator ?? objectValue?.path ?? objectValue?.repoPath ?? objectValue?.url)
    ?? entity?.canonicalKey;
}

function routeInterval(fact) {
  return {
    factId: fact.id,
    scopeKey: fact.scope_key,
    validFrom: fact.valid_from,
    validTo: fact.valid_to,
    observedAt: fact.observed_at,
  };
}

function codeLocator(entity) {
  if (!["Repository", "CodeRepository", "CodeLocation"].includes(entity.type)) return {};
  const metadata = entity.metadata ?? {};
  return Object.fromEntries(["repoPath", "relativePath", "commit", "ref", "executionHost"]
    .map((key) => [key, metadata[key] ?? null]));
}

function contactsFor(database, people, context) {
  if (!people.length) return new Map();
  const rows = factCandidates(database, people, true, context, 80)
    .filter((row) => row.predicate === "CONTACT_VIA" && verifiedFact(row));
  const output = new Map();
  for (const row of rows) {
    if (output.has(row.subject_id)) continue;
    const metadata = parseJson(row.object_metadata_json);
    const objectValue = parseJson(row.object_value, row.object_value);
    output.set(row.subject_id, {
      id: row.object_id,
      canonicalKey: row.object_key,
      type: row.object_type,
      name: row.object_name,
      ...routeInterval(row),
      locator: metadata.locator ?? metadata.openId ?? metadata.chatId ?? objectValue,
      conversationKey: metadata.conversationKey ?? metadata.chatId
        ?? (typeof objectValue === "object" ? objectValue?.conversationKey ?? objectValue?.chatId : null)
        ?? null,
      evidence: factEvidence(row),
      source: factSource(row),
      reviewStatus: factReviewStatus(row),
    });
  }
  return output;
}

function searchKnowledge(database, query, limit = 4) {
  const descriptors = termDescriptors(query).slice(0, 12);
  const terms = descriptors.map((item) => item.value).slice(0, 12);
  if (!terms.length) return [];
  const candidateLimit = Math.max(limit * 4, 24);
  const expression = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
  let rows = [];
  try {
    rows = database.prepare(`
      SELECT annotation.evidence_id, annotation.title, annotation.summary,
        annotation.keywords_json, annotation.retrieval_cues_json, annotation.salience,
        annotation.updated_at, annotation.status, annotation.review_status, annotation.review_outcome,
        evidence.source_locator, evidence.occurred_at, evidence.kind AS evidence_kind,
        bm25(graph_episode_fts) AS rank
      FROM graph_episode_fts
      JOIN graph_episode_annotations annotation ON annotation.rowid=graph_episode_fts.rowid
      JOIN evidence ON evidence.id=annotation.evidence_id
      WHERE graph_episode_fts MATCH ? AND annotation.status<>'superseded'
        AND NOT EXISTS (
          SELECT 1 FROM evidence_links replacement
          WHERE replacement.child_evidence_id=annotation.evidence_id
            AND replacement.relation='supersedes'
        )
      ORDER BY annotation.salience DESC, rank LIMIT ?
    `).all(expression, candidateLimit);
  } catch { /* bounded literal lookup below remains available */ }
  // unicode61 can find the ASCII half while missing the Chinese phrase entirely.
  if (!rows.length || descriptors.some((item) => item.kind === "han")) {
    const clauses = terms.map(() => `(
      annotation.title LIKE ? OR annotation.keywords_json LIKE ? OR annotation.retrieval_cues_json LIKE ?
    )`).join(" OR ");
    const params = terms.flatMap((term) => Array(3).fill(`%${term}%`));
    rows.push(...database.prepare(`
      SELECT annotation.evidence_id, annotation.title, annotation.summary,
        annotation.keywords_json, annotation.retrieval_cues_json, annotation.salience,
        annotation.updated_at, annotation.status, annotation.review_status, annotation.review_outcome,
        evidence.source_locator, evidence.occurred_at, evidence.kind AS evidence_kind,
        1000000.0 AS rank
      FROM graph_episode_annotations annotation
      JOIN evidence ON evidence.id=annotation.evidence_id
      WHERE annotation.status<>'superseded' AND (${clauses})
        AND NOT EXISTS (
          SELECT 1 FROM evidence_links replacement
          WHERE replacement.child_evidence_id=annotation.evidence_id
            AND replacement.relation='supersedes'
        )
      ORDER BY annotation.salience DESC, annotation.updated_at DESC LIMIT ?
    `).all(...params, candidateLimit));
  }
  return unique(rows, (row) => row.evidence_id)
    .map((row) => ({
      row,
      match: relevance([
        row.title, row.summary, row.keywords_json, row.retrieval_cues_json,
      ].filter(Boolean).join("\n"), descriptors),
    }))
    .filter((item) => item.match.relevant)
    .sort((left, right) => right.match.score - left.match.score
      || Number(right.row.salience ?? 0) - Number(left.row.salience ?? 0)
      || String(left.row.evidence_id).localeCompare(String(right.row.evidence_id)))
    .slice(0, limit)
    .map(({ row }) => {
      const reviewStatus = row.review_status;
      return {
        kind: "knowledge_source",
        evidenceId: row.evidence_id,
        title: compactText(row.title, 300),
        summary: compactText(row.summary, 1200),
        evidence: { id: row.evidence_id, title: compactText(row.title, 300), kind: row.evidence_kind },
        source: { evidenceId: row.evidence_id, locator: compactText(row.source_locator, 1000), occurredAt: row.occurred_at },
        locator: compactText(row.source_locator, 1000),
        occurredAt: row.occurred_at,
        reviewStatus,
        reviewOutcome: row.review_outcome,
      };
    });
}

function trimResult(result, maxBytes, maxRenderedBytes) {
  const keys = ["reviewPending", "conflicts", "known", "retrievable", "askable"];
  const aliases = { known: "verifiedFacts", retrievable: "retrievalRoutes", askable: "askablePeople" };
  const measure = value => {
    for (let i = 0; i < 3; i++) value.bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    return value.bytes;
  };
  if (maxRenderedBytes != null && !Number.isFinite(maxRenderedBytes)) throw new Error("maxBytes rendering limit must be finite.");
  const fits = value => measure(value) <= maxBytes && (maxRenderedBytes == null
    || Buffer.byteLength(JSON.stringify(value, null, 2), "utf8") <= maxRenderedBytes);
  result.truncated = false;
  result.omittedByByteBudget = {};
  result.retrievalScope = "bounded_candidates_not_exhaustive";
  result.bytes = 0;
  // Test each oversized entry independently before evicting lower-ranked usable entries.
  const fitsAlone = (key, item) => {
    const single = { ...result, omittedByByteBudget: { ...result.omittedByByteBudget }, bytes: 0 };
    for (const name of keys) {
      single[name] = name === key ? [item] : [];
      if (aliases[name]) single[aliases[name]] = single[name];
      const omitted = (single.omittedByByteBudget[name] ?? 0) + result[name].length - single[name].length;
      if (omitted) single.omittedByByteBudget[name] = omitted;
    }
    single.truncated = Object.values(single.omittedByByteBudget).some(count => count > 0);
    Object.assign(single, routeResultGuidance(single));
    return fits(single);
  };
  for (const key of keys) {
    while (!fits(result) && result[key].length) {
      const oversized = result[key].findIndex(item => !fitsAlone(key, item));
      result[key].splice(oversized < 0 ? result[key].length - 1 : oversized, 1);
      result.omittedByByteBudget[key] = (result.omittedByByteBudget[key] ?? 0) + 1;
      result.truncated = true;
      Object.assign(result, routeResultGuidance(result));
    }
  }
  if (!fits(result)) {
    throw new Error("maxBytes cannot fit routing metadata; shorten query, projectKey, scopeKey or sessionKey, or increase maxBytes up to 32768.");
  }
  return result;
}

export function resolveCognitiveRoute(database, options = {}) {
  const query = String(options.query ?? "").trim();
  if (!query) throw new Error("query is required for cognitive routing.");
  const requestedTime = new Date(options.asOf ?? Date.now());
  if (!Number.isFinite(requestedTime.getTime())) throw new Error("asOf must be a valid date-time.");
  const asOf = requestedTime.toISOString();
  const context = { asOf, scopeKey: options.scopeKey ?? null };
  const requestedBytes = Number(options.maxBytes ?? 16384);
  if (!Number.isFinite(requestedBytes)) throw new Error("maxBytes must be finite.");
  const maxBytes = Math.max(4096, Math.min(32768, requestedBytes));
  const seeds = findSeeds(database, query, options.projectKey);
  const routingCandidates = factCandidates(database, seeds, true, context, 240);
  const directCandidates = factCandidates(database, seeds, false, context, 24);
  const routingFacts = routingCandidates.filter(verifiedFact);
  const seedIds = new Set(seeds.map((seed) => seed.id));
  const exactSeedIds = new Set(seeds.filter((seed) => seed.route_exact_match).map((seed) => seed.id));
  const normalizedQuery = routingQuery(query).toLowerCase();
  const queryDescriptors = termDescriptors(normalizedQuery).slice(0, 12);
  const retrieval = [];
  const people = [];
  for (const fact of routingFacts) {
    const subject = compactEntity(fact, "subject");
    const object = compactEntity(fact, "object");
    for (const entity of [subject, object].filter(Boolean)) {
      if (RETRIEVAL_TYPES.has(entity.type)
        && !(entity.type === "CommunicationChannel" && fact.predicate === "CONTACT_VIA")) {
        retrieval.push({
          entityId: entity.id,
          name: entity.name,
          type: entity.type,
          locator: locatorFor(entity, fact),
          ...codeLocator(entity),
          ...routeInterval(fact),
          via: fact.predicate,
          evidenceLevel: Number(fact.evidence_level),
          confidence: Number(fact.confidence),
          evidence: factEvidence(fact),
          source: factSource(fact),
          reviewStatus: factReviewStatus(fact),
        });
      }
      if (ASKABLE_TYPES.has(entity.type)) {
        const counterpart = entity.id === subject?.id ? object : subject;
        const relationTouchesSeed = seedIds.has(subject?.id) || seedIds.has(object?.id);
        if (relationTouchesSeed || ASKABLE_TYPES.has(subject?.type)) {
          const aboutName = counterpart?.name ?? query;
          const aboutMatch = relevance(aboutName, queryDescriptors);
          people.push({
            ...entity,
            ...routeInterval(fact),
            via: fact.predicate,
            about: aboutName,
            routingScore: (String(aboutName).trim().toLowerCase() === normalizedQuery ? 1000 : 0)
              + aboutMatch.score * 10
              + Number(ROUTING_PREDICATE_PRIORITY.get(fact.predicate) ?? 20),
            evidenceLevel: Number(fact.evidence_level),
            confidence: Number(fact.confidence),
            evidence: factEvidence(fact),
            source: factSource(fact),
            reviewStatus: factReviewStatus(fact),
          });
        }
      }
    }
  }
  for (const seed of seeds) {
    const entity = {
      id: seed.id,
      canonicalKey: seed.canonical_key,
      type: seed.type,
      name: seed.name,
      summary: seed.summary,
      metadata: parseJson(seed.metadata_json),
    };
    if (RETRIEVAL_TYPES.has(entity.type) && !retrieval.some((item) => item.entityId === entity.id)) retrieval.push({
      entityId: entity.id,
      name: entity.name,
      type: entity.type,
      locator: locatorFor(entity, {}),
      ...codeLocator(entity),
      via: "DIRECT_MATCH",
      evidenceLevel: null,
      confidence: 1,
      evidence: null,
      source: { evidenceId: null, locator: locatorFor(entity, {}) },
      reviewStatus: "route_only",
    });
    if (ASKABLE_TYPES.has(entity.type)) people.push({
      ...entity,
      via: "DIRECT_MATCH",
      about: query,
      evidence: null,
      source: { evidenceId: null, locator: entity.canonicalKey },
      reviewStatus: "route_only",
    });
  }
  const retrievalPriority = new Map([
    ["CodeLocation", 0],
    ["Repository", 1],
    ["CodeRepository", 1],
    ["Document", 2],
    ["InformationSource", 3],
    ["Procedure", 4],
    ["Skill", 5],
    ["CommunicationChannel", 6],
  ]);
  const retrievable = unique(
    retrieval.filter((item) => item.locator),
    (item) => `${item.entityId}:${item.scopeKey ?? ""}:${JSON.stringify(item.locator)}`,
  ).sort((left, right) =>
    Number(exactSeedIds.has(right.entityId)) - Number(exactSeedIds.has(left.entityId))
      || (retrievalPriority.get(left.type) ?? 99) - (retrievalPriority.get(right.type) ?? 99)
      || Number(right.evidenceLevel ?? -1) - Number(left.evidenceLevel ?? -1)
      || String(left.entityId).localeCompare(String(right.entityId)))
    .slice(0, 10);
  const peopleById = new Map();
  for (const person of people) {
    const items = peopleById.get(person.id) ?? [];
    if (!items.some((item) => item.via === person.via && item.about === person.about && item.scopeKey === person.scopeKey)) items.push(person);
    peopleById.set(person.id, items);
  }
  const askablePeople = [...peopleById.values()]
    .map((items) => {
      const rankedItems = [...items].sort((left, right) => Number(right.routingScore ?? 0) - Number(left.routingScore ?? 0));
      return {
        ...rankedItems[0],
        routingScore: rankedItems.slice(0, 3).reduce((sum, item) => sum + Number(item.routingScore ?? 0), 0),
        matchedRoutes: rankedItems.slice(0, 5).map((item) => ({
          via: item.via, about: item.about, factId: item.factId, scopeKey: item.scopeKey,
          validFrom: item.validFrom, validTo: item.validTo, observedAt: item.observedAt,
        })),
      };
    })
    .sort((left, right) => Number(right.routingScore ?? 0) - Number(left.routingScore ?? 0)
      || String(left.id).localeCompare(String(right.id)))
    .slice(0, 8);
  const contacts = contactsFor(database, askablePeople, context);
  const askable = askablePeople.map((person) => ({
    entityId: person.id,
    canonicalKey: person.canonicalKey,
    name: person.name,
    type: person.type,
    about: person.about,
    via: person.via,
    scopeKey: person.scopeKey ?? null,
    validFrom: person.validFrom ?? null,
    validTo: person.validTo ?? null,
    observedAt: person.observedAt ?? null,
    matchedRoutes: person.matchedRoutes,
    evidence: person.evidence ?? null,
    source: person.source ?? null,
    reviewStatus: person.reviewStatus ?? "route_only",
    contact: contacts.get(person.id) ?? null,
    requiresAuthorization: "send_external_message",
    questionDraft: `想确认“${query}”。我已检查现有知识入口，但还缺少明确结论或依据。请告知结论、对应文档/代码位置以及后续责任人。`,
    afterAuthorizedSend: {
      action: "create_condition_watch_from_send_receipt",
      conditionText: `${person.name} 对“${query}”给出回复或新依据`,
      selector: {
        conversationKeys: contacts.get(person.id)?.conversationKey
          ? [String(contacts.get(person.id).conversationKey)]
          : [],
        externalIds: [],
        containsAny: termsFor(query).slice(0, 8),
      },
      requiresBindingAfterSend: true,
      note: "授权发送后，用发送回执中的真实 conversation key/chat_id 与 message_id 收紧监视条件。",
    },
  }));
  const knowledgeMatches = searchKnowledge(database, query, 8);
  const verifiedFacts = directCandidates.filter(verifiedFact).slice(0, 6).map((row) => compactFact(row));
  const reviewPending = [
    ...knowledgeMatches.filter((item) => ["pending", "needs_input"].includes(item.reviewStatus)),
    ...[...routingCandidates, ...directCandidates]
      .filter((row) => row.assertion_mode !== "structural_route")
      .filter((row) => row.epistemic_status !== "disputed" && !verifiedFact(row))
      .map((row) => compactFact(row, "fact_pending_review")),
  ].slice(0, 8);
  const conflicts = [...routingCandidates, ...directCandidates]
    .filter((row) => row.epistemic_status === "disputed")
    .map((row) => compactFact(row, "fact_conflict"))
    .slice(0, 6);
  retrievable.push(...knowledgeMatches
    .filter((item) => item.reviewStatus === "completed")
    .map((item) => ({
      entityId: null,
      name: item.title,
      type: "KnowledgeSource",
      locator: item.locator,
      via: "REVIEWED_KNOWLEDGE",
      evidenceLevel: null,
      confidence: null,
      evidence: item.evidence,
      source: item.source,
      reviewStatus: item.reviewStatus,
      reviewOutcome: item.reviewOutcome,
    })));
  const known = verifiedFacts;
  const { outcome, steps } = routeResultGuidance({ known, reviewPending, conflicts, retrievable, askable });
  const result = {
    query,
    asOf,
    scopeKey: context.scopeKey,
    temporalSemantics: "valid_time_with_available_evidence_not_knowledge_time_replay",
    projectKey: options.projectKey ?? null,
    sessionKey: options.sessionKey ?? null,
    outcome,
    verifiedFacts,
    reviewPending,
    conflicts,
    retrievalRoutes: retrievable,
    askablePeople: askable,
    known,
    retrievable,
    askable,
    steps,
    nonBlockingFallback: {
      action: "update_workboard_and_continue",
      note: "若本轮仍无法确认，记录已尝试路径、缺失信息和下一次检查条件；不要静默阻塞，也不要把推测写成事实。",
    },
    policy: {
      graphStores: "稳定事实和认知路标",
      evidenceLogStores: "原始消息、文件与工具结果",
      externalMessageMode: "authorization_required",
      externalMessage: "必须获得授权后发送",
    },
  };
  return trimResult(result, maxBytes, options.maxRenderedBytes);
}

function routeResultGuidance({ known, reviewPending, conflicts, retrievable, askable, omittedByByteBudget }) {
  const steps = [];
  if (known.length) steps.push({ order: steps.length + 1, action: "review_known", reason: "已有摘要或证据支持的事实" });
  if (reviewPending.length) steps.push({ order: steps.length + 1, action: "review_pending", reason: "召回到了待复核材料，不能当作已验证事实" });
  if (conflicts.length) steps.push({ order: steps.length + 1, action: "resolve_conflict", reason: "存在争议事实，需要核对证据后再采用" });
  if (retrievable.length) steps.push({ order: steps.length + 1, action: "retrieve", reason: "按路标读取原文、代码或专用系统" });
  if (askable.length) steps.push({
    order: steps.length + 1,
    action: "ask_after_authorization",
    reason: "现有证据不足时向对应责任人求证，并持续等待回复",
  });
  if (!steps.length) steps.push({
    order: 1,
    action: "discover_route",
    reason: Object.values(omittedByByteBudget ?? {}).some(count => count > 0)
      ? "候选因预算省略，并非没有知识；请收窄查询或提高 maxBytes。"
      : "当前图谱没有可靠路标；先检索项目目录/飞书，再让用户补充责任人或入口",
  });
  return { outcome: known.length ? "known" : retrievable.length ? "retrievable" : askable.length ? "askable" : "unresolved_with_next_step", steps };
}
