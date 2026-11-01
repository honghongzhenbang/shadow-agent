import { loadConfig } from "../src/config.mjs";
import { openDatabaseReadOnly } from "../src/db.mjs";
import { readCognitiveProfile } from "../src/cognitive-profile.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--file" || args[1].startsWith("--")) {
  throw new Error("Required: --file STRUCTURED_PROFILE.json");
}
const { profile, resolved } = readCognitiveProfile(args[1]);
const documentKey = profile.entities.find(entity => entity.type === "Document")?.canonicalKey;
if (!documentKey) throw new Error("The profile must identify its source Document.");
const store = openDatabaseReadOnly(loadConfig().paths.database);
try {
  const document = store.db.prepare(`
    SELECT canonical_key, name, status
    FROM graph_entities
    WHERE canonical_key=?
  `).get(documentKey) ?? null;
  const latestEvidence = store.db.prepare(`
    SELECT id, title, source_locator
    FROM evidence
    WHERE kind='manual_knowledge' AND source_locator=?
    ORDER BY collected_at DESC LIMIT 1
  `).get(resolved) ?? null;
  const expertRelations = latestEvidence ? Number(store.db.prepare(`
    SELECT COUNT(DISTINCT fact.id) AS count
    FROM graph_facts fact
    JOIN graph_evidence_assessments assessment ON assessment.fact_id=fact.id
    WHERE fact.status='active' AND fact.predicate='EXPERT_IN'
      AND assessment.evidence_id=? AND assessment.valid_until IS NULL
  `).get(latestEvidence.id)?.count ?? 0) : 0;
  const activeRelations = latestEvidence ? Number(store.db.prepare(`
    SELECT COUNT(DISTINCT fact.id) AS count
    FROM graph_facts fact
    JOIN graph_evidence_assessments assessment ON assessment.fact_id=fact.id
    WHERE fact.status='active' AND assessment.evidence_id=? AND assessment.valid_until IS NULL
  `).get(latestEvidence.id)?.count ?? 0) : 0;
  const profileAssessments = Number(store.db.prepare(`
    SELECT COUNT(DISTINCT fact_id) AS count
    FROM graph_evidence_assessments
    WHERE assessed_by='manual-cognitive-profile' AND valid_until IS NULL
  `).get()?.count ?? 0);
  const expertTotal = Number(store.db.prepare(`
    SELECT COUNT(*) AS count FROM graph_facts
    WHERE status='active' AND predicate='EXPERT_IN'
  `).get()?.count ?? 0);
  process.stdout.write(`${JSON.stringify({ document, latestEvidence: latestEvidence ? { title: latestEvidence.title, source: latestEvidence.source_locator } : null, expertRelations, activeRelations, profileAssessments, expertTotal }, null, 2)}\n`);
} finally {
  store.close();
}
