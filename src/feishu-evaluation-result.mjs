const INGRESS_DECISIONS = new Set(["ignore", "evidence_only", "wake_existing", "wake_new", "review_reply"]);
const CONVERSATION_ASSESSMENTS = new Set(["user_owned", "user_involved", "background", "uncertain"]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireArray(response, key, errors) {
  if (!Array.isArray(response?.[key])) errors.push(`${key} must be an array`);
}

export function validateEvaluationResponse(response) {
  const errors = [];
  if (!isObject(response)) return { valid: false, errors: ["response must be an object"] };
  if (!INGRESS_DECISIONS.has(response.ingressDecision)) {
    errors.push("ingressDecision is invalid");
  }
  if (!CONVERSATION_ASSESSMENTS.has(response.conversationAssessment)) {
    errors.push("conversationAssessment is invalid");
  }
  for (const key of [
    "relationshipFactsUsed",
    "verifiedFacts",
    "activeUserActions",
    "completedUserWork",
    "waitingOnOthers",
    "knowledgeUpdates",
    "uncertainties",
  ]) requireArray(response, key, errors);
  if (Array.isArray(response.activeUserActions)) {
    for (const [index, action] of response.activeUserActions.entries()) {
      if (!isObject(action)) {
        errors.push(`activeUserActions[${index}] must be an object`);
        continue;
      }
      for (const key of ["title", "owner", "evidence", "confidence"]) {
        if (action[key] == null || action[key] === "") errors.push(`activeUserActions[${index}].${key} is required`);
      }
    }
  }
  if (!isObject(response.reply)) {
    errors.push("reply must be an object");
  } else {
    if (typeof response.reply.needed !== "boolean") errors.push("reply.needed must be boolean");
    if (typeof response.reply.reason !== "string") errors.push("reply.reason must be string");
    if (typeof response.reply.draft !== "string") errors.push("reply.draft must be string");
  }
  if (!isObject(response.continuation)) {
    errors.push("continuation must be an object");
  } else {
    if (typeof response.continuation.needed !== "boolean") errors.push("continuation.needed must be boolean");
    if (typeof response.continuation.kind !== "string") errors.push("continuation.kind must be string");
    if (typeof response.continuation.reason !== "string") errors.push("continuation.reason must be string");
  }
  return { valid: errors.length === 0, errors };
}
