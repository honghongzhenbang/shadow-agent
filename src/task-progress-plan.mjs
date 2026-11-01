const FIELDS = ["outcome", "successCriteria", "authorizedScope", "approach", "nextAction", "stopCondition", "whyNow"];

export const progressPlanSchema = {
  type: "object", additionalProperties: false,
  required: ["expectedRevision", ...FIELDS],
  properties: {
    expectedRevision: { type: "integer", minimum: 0 },
    ...Object.fromEntries(FIELDS.map((name) => [name, { type: "string", minLength: 3, maxLength: 600 }])),
  },
};

export function reviseProgressPlan(previous, input, now = new Date().toISOString()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid progress plan");
  if (Object.keys(input).some((key) => !["expectedRevision", ...FIELDS].includes(key))) throw new Error("Unknown progress plan field");
  const revision = previous?.revision ?? 0;
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== revision) {
    throw new Error(`Progress plan changed; read revision ${revision} before revising`);
  }
  const result = { revision: revision + 1, updatedAt: now };
  for (const field of FIELDS) {
    if (typeof input[field] !== "string" || input[field].trim().length < 3 || input[field].length > 600) {
      throw new Error(`Progress plan ${field} must be 3-600 characters`);
    }
    result[field] = input[field].trim();
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 6000) throw new Error("Progress plan exceeds 6 KiB");
  return result;
}

export function compactProgressPlan(plan) {
  if (!plan) return null;
  return {
    revision: plan.revision,
    outcome: plan.outcome?.slice(0, 160),
    nextAction: plan.nextAction?.slice(0, 160),
    whyNow: plan.whyNow?.slice(0, 120),
    stopCondition: plan.stopCondition?.slice(0, 120),
  };
}
