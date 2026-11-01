import assert from "node:assert/strict";
import test from "node:test";

import { scoreEvaluationRun } from "../src/feishu-evaluation-score.mjs";

function response(overrides = {}) {
  return {
    ingressDecision: "evidence_only",
    conversationAssessment: "background",
    relationshipFactsUsed: [],
    verifiedFacts: [],
    activeUserActions: [],
    completedUserWork: [],
    waitingOnOthers: [],
    reply: { needed: false, reason: "No reply.", draft: "" },
    continuation: { needed: false, kind: "", reason: "No continuation." },
    knowledgeUpdates: [],
    uncertainties: [],
    ...overrides,
  };
}

test("evaluation scorer compares only frozen reviewed episodes", () => {
  const gold = {
    labels: [{
      episodeId: "episode-1",
      stratum: "negative",
      split: "development",
      ingressDecision: "ignore",
      conversationAssessment: "background",
      activeUserActions: [],
      reply: { needed: false },
      continuation: { kind: "none" },
    }],
  };
  const run = {
    schema: "run/v2",
    conversations: [
      { episodeId: "episode-1", batches: [{ response: response({ ingressDecision: "ignore" }) }] },
      { episodeId: "not-reviewed", batches: [{ response: response({ activeUserActions: [{ title: "noise" }] }) }] },
    ],
  };
  const result = scoreEvaluationRun(run, gold);
  assert.equal(result.scoredEpisodes, 1);
  assert.equal(result.metrics.ingressExact.rate, 1);
  assert.equal(result.metrics.falsePositiveActions, 0);
});

test("evaluation scorer exposes false actions and schema drift", () => {
  const invalid = response({
    activeUserActions: [{ title: "错误任务", owner: "当前用户", evidence: "仅被提及", confidence: 0.5 }],
    uncertainties: "unknown",
  });
  const result = scoreEvaluationRun({
    schema: "run/v2",
    conversations: [{ episodeId: "episode-1", batches: [{ response: invalid }] }],
  }, {
    labels: [{
      episodeId: "episode-1",
      stratum: "negative",
      split: "development",
      ingressDecision: "evidence_only",
      conversationAssessment: "background",
      activeUserActions: [],
      reply: { needed: false },
      continuation: { kind: "none" },
    }],
  });
  assert.equal(result.metrics.schemaValid.rate, 0);
  assert.equal(result.metrics.falsePositiveActions, 1);
  assert.equal(result.metrics.actionCountExact.rate, 0);
});
