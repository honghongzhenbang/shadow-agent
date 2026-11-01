export const FACT_LIFECYCLE_STATUSES = Object.freeze(["active", "superseded"]);
export const FACT_TRUST_STATUSES = Object.freeze(["proposed", "supported", "disputed", "refuted"]);
export const EVIDENCE_STANCES = Object.freeze(["supports", "contradicts"]);
export const REVIEW_STATUSES = Object.freeze(["pending", "completed", "needs_input"]);
export const REVIEW_OUTCOMES = Object.freeze(["facts_recorded", "no_durable_facts"]);

export function normalizeEvidenceStance(value = "supports") {
  const stance = String(value || "supports").trim();
  if (!EVIDENCE_STANCES.includes(stance)) {
    throw new Error(`Fact evidence stance must be supports or contradicts; use entity evidence links for ${stance || "empty"}`);
  }
  return stance;
}

export function isEffectiveAt(interval = {}, asOf = new Date().toISOString()) {
  const time = Date.parse(asOf);
  if (!Number.isFinite(time)) throw new Error(`Invalid knowledge query time: ${asOf}`);
  const from = interval.valid_from ?? interval.validFrom;
  const to = interval.valid_to ?? interval.validTo ?? interval.valid_until ?? interval.validUntil;
  return (!from || (Number.isFinite(Date.parse(from)) && Date.parse(from) <= time))
    && (!to || (Number.isFinite(Date.parse(to)) && time < Date.parse(to)));
}

export function deriveFactTrust(assessments = [], { hasOpenConflict = false, asOf = new Date().toISOString() } = {}) {
  if (hasOpenConflict) return "disputed";
  const active = assessments.filter((item) => !item.superseded && isEffectiveAt(item, asOf));
  const supports = active.filter((item) => item.stance === "supports");
  const contradictions = active.filter((item) => item.stance === "contradicts");
  if (supports.length && contradictions.length) return "disputed";
  const strongestSupport = supports.length ? Math.max(...supports.map((item) => Number(item.level) || 0)) : -1;
  const strongestContradiction = contradictions.length
    ? Math.max(...contradictions.map((item) => Number(item.level) || 0))
    : -1;
  if (strongestContradiction >= 2) return "refuted";
  if (strongestSupport >= 2) return "supported";
  return "proposed";
}

export function reviewStateFromLegacy(value) {
  const legacy = String(value ?? "pending");
  if (legacy === "linked") return { status: "completed", outcome: "facts_recorded" };
  if (legacy === "no_durable_facts") return { status: "completed", outcome: "no_durable_facts" };
  if (legacy === "needs_followup") return { status: "needs_input", outcome: null };
  return { status: "pending", outcome: null };
}

export function validateSupersession({ oldFact, newFact, provenanceCount = 0, reason, relationToExisting = "same_claim", cycleDetected = false }) {
  const problems = [];
  if (!oldFact) problems.push("target_missing");
  if (oldFact?.status !== "active") problems.push("target_not_active");
  if (oldFact?.id && oldFact.id === newFact?.id) problems.push("self_supersession");
  if (cycleDetected) problems.push("cycle_detected");
  if (Number(provenanceCount) < 1) problems.push("missing_provenance");
  if (String(reason ?? "").trim().length < 3) problems.push("missing_reason");
  if (relationToExisting !== "same_claim") problems.push("not_same_claim");
  if (oldFact && newFact) {
    if (oldFact.subject_entity_id !== newFact.subject_entity_id) problems.push("different_subject");
    if (oldFact.predicate !== newFact.predicate) problems.push("different_predicate");
    if ((oldFact.scope_key ?? "global") !== (newFact.scope_key ?? "global")) problems.push("different_scope");
  }
  return {
    allowed: problems.length === 0,
    problems: [...new Set(problems)],
    action: problems.length ? "preserve_both_and_review" : "supersede",
  };
}
