import assert from "node:assert/strict";
import test from "node:test";

import { validateEvaluationResponse } from "../src/feishu-evaluation-result.mjs";

function validResponse() {
  return {
    ingressDecision: "evidence_only",
    conversationAssessment: "background",
    relationshipFactsUsed: [],
    verifiedFacts: [],
    activeUserActions: [],
    completedUserWork: [],
    waitingOnOthers: [],
    reply: { needed: false, reason: "No reply is needed.", draft: "" },
    continuation: { needed: false, kind: "", reason: "No continuation is needed." },
    knowledgeUpdates: [],
    uncertainties: [],
  };
}

test("evaluation response validator distinguishes valid JSON from valid schema", () => {
  assert.deepEqual(validateEvaluationResponse(validResponse()), { valid: true, errors: [] });
  const invalid = validResponse();
  invalid.uncertainties = "unknown";
  invalid.continuation = false;
  const result = validateEvaluationResponse(invalid);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("; "), /uncertainties must be an array/);
  assert.match(result.errors.join("; "), /continuation must be an object/);
});

test("evaluation response validator requires auditable active actions", () => {
  const response = validResponse();
  response.activeUserActions = [{ title: "完成接口", owner: "当前用户" }];
  const result = validateEvaluationResponse(response);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("; "), /evidence is required/);
  assert.match(result.errors.join("; "), /confidence is required/);
});
