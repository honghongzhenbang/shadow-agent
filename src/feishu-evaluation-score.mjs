import { validateEvaluationResponse } from "./feishu-evaluation-result.mjs";

function ratio(value, total) {
  return total ? value / total : 0;
}

export function scoreEvaluationRun(run, gold) {
  const labels = new Map((gold.labels ?? []).map((label) => [label.episodeId, label]));
  const items = [];
  for (const conversation of run.conversations ?? []) {
    const label = labels.get(conversation.episodeId);
    if (!label) continue;
    const batch = conversation.batches?.at(-1);
    const response = batch?.response;
    const validation = validateEvaluationResponse(response);
    const expectedContinuation = label.continuation?.kind !== "none";
    const predictedActionCount = Array.isArray(response?.activeUserActions) ? response.activeUserActions.length : 0;
    const expectedActionCount = Array.isArray(label.activeUserActions) ? label.activeUserActions.length : 0;
    items.push({
      episodeId: conversation.episodeId,
      stratum: label.stratum,
      split: label.split,
      schemaValid: validation.valid,
      schemaErrors: validation.errors,
      ingressExact: response?.ingressDecision === label.ingressDecision,
      assessmentExact: response?.conversationAssessment === label.conversationAssessment,
      actionCountExact: predictedActionCount === expectedActionCount,
      falsePositiveActions: expectedActionCount === 0 ? predictedActionCount : 0,
      missedActions: expectedActionCount > predictedActionCount ? expectedActionCount - predictedActionCount : 0,
      replyExact: response?.reply?.needed === label.reply?.needed,
      continuationExact: response?.continuation?.needed === expectedContinuation,
    });
  }
  const count = items.length;
  const sum = (key) => items.filter((item) => item[key] === true).length;
  return {
    schema: "shadow-agent/feishu-evaluation-score/v2",
    runSchema: run.schema,
    reviewedEpisodes: labels.size,
    scoredEpisodes: count,
    metrics: {
      schemaValid: { count: sum("schemaValid"), rate: ratio(sum("schemaValid"), count) },
      ingressExact: { count: sum("ingressExact"), rate: ratio(sum("ingressExact"), count) },
      assessmentExact: { count: sum("assessmentExact"), rate: ratio(sum("assessmentExact"), count) },
      actionCountExact: { count: sum("actionCountExact"), rate: ratio(sum("actionCountExact"), count) },
      replyExact: { count: sum("replyExact"), rate: ratio(sum("replyExact"), count) },
      continuationExact: { count: sum("continuationExact"), rate: ratio(sum("continuationExact"), count) },
      falsePositiveActions: items.reduce((sumValue, item) => sumValue + item.falsePositiveActions, 0),
      missedActions: items.reduce((sumValue, item) => sumValue + item.missedActions, 0),
    },
    items,
  };
}
