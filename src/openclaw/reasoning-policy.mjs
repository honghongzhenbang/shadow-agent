const DEFAULTS = Object.freeze({
  message_triage: "medium",
  direct_input: "high",
  task_review: "high",
  knowledge_curation: "high",
  reminder: "low",
});

const LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

export function thinkingForTask(config, taskType) {
  const level = config.reasoning?.byTask?.[taskType]
    ?? DEFAULTS[taskType]
    ?? config.reasoning?.default
    ?? "medium";
  if (!LEVELS.has(level)) throw new Error(`Invalid thinking level for ${taskType}: ${level}`);
  return level;
}

export function attentionTaskType(pending = {}) {
  if (Number(pending.has_knowledge_work)) return "knowledge_curation";
  if (Number(pending.has_task_work)) return "task_review";
  return "message_triage";
}
