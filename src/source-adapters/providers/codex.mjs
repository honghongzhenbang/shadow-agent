import { defineSourceAdapter } from "../contracts.mjs";
import { safeEvidenceText, safeTraceText } from "../../utils.mjs";

export const codexSourceAdapter = defineSourceAdapter({
  provider: "codex",
  family: "execution",
  displayName: "Codex",
  accountScope: "local-user",
  capabilities: {
    subscribeEvents: false,
    readDelta: true,
    historyBackfill: true,
    readWindow: true,
    resolveArtifact: true,
    resumeSession: true,
    observeTools: true,
    sendMessage: false,
    sendAsUser: false,
  },
  sourceKinds: ["codex_rollout", "codex_memory"],
  evidenceKinds: [
    "codex_session_meta",
    "codex_user_message",
    "codex_agent_message",
    "codex_turn_summary",
    "codex_compaction_summary",
    "codex_tool_call",
    "codex_tool_output",
    "codex_tool_result",
    "codex_patch_result",
    "codex_memory_document",
  ],
});

const CODEX_EVENT_KINDS = Object.freeze({
  codex_session_meta: "session_metadata",
  codex_user_message: "user_intent",
  codex_agent_message: "assistant_result",
  codex_turn_summary: "turn_summary",
  codex_compaction_summary: "compaction",
  codex_tool_call: "tool_call",
  codex_tool_output: "tool_result",
  codex_tool_result: "tool_result",
  codex_patch_result: "file_change",
  codex_memory_document: "memory_document",
});

function parseMetadata(value) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

export function codexCanonicalSourceRecord({ source, evidence, thread = null }) {
  if (!CODEX_EVENT_KINDS[evidence.kind]) return null;
  const metadata = parseMetadata(evidence.metadata_json ?? evidence.metadata);
  const threadMetadata = parseMetadata(thread?.metadata_json ?? thread?.metadata);
  const sessionId = evidence.thread_id ?? metadata.threadId ?? null;
  return {
    observation: {
      schemaVersion: 2,
      provider: codexSourceAdapter.provider,
      sourceFamily: codexSourceAdapter.family,
      accountScope: parseMetadata(source.metadata_json)?.sourceAdapter?.accountScope ?? codexSourceAdapter.accountScope,
      sourceObjectId: evidence.external_id ?? evidence.id,
      eventId: metadata.eventId ?? evidence.external_id ?? null,
      streamId: sessionId,
      parentId: metadata.parentSessionId ?? null,
      causationId: metadata.causationId ?? metadata.callId ?? null,
      cursor: source.cursor_bytes ?? null,
      visibility: metadata.visibility ?? "private",
      eventKind: CODEX_EVENT_KINDS[evidence.kind],
      providerPayloadRef: evidence.source_locator,
    },
    execution: {
      sessionId,
      parentSessionId: metadata.parentSessionId ?? null,
      workspace: metadata.cwd ?? thread?.cwd ?? null,
      repository: metadata.repository ?? metadata.repoPath ?? threadMetadata.gitOriginUrl ?? null,
      branch: metadata.branch ?? threadMetadata.gitBranch ?? null,
      commit: metadata.commit ?? threadMetadata.gitSha ?? null,
      runId: metadata.runId ?? null,
      turnId: metadata.turnId ?? metadata.window_id ?? null,
      eventSeq: metadata.eventSeq ?? null,
      status: evidence.kind === "codex_patch_result"
        ? metadata.success === true ? "succeeded" : metadata.success === false ? "failed" : metadata.status ?? null
        : metadata.status ?? null,
      toolName: metadata.tool_name ?? null,
      artifactRefs: metadata.artifactRefs ?? metadata.changes ?? [],
      modelProvider: metadata.modelProvider ?? threadMetadata.modelProvider ?? null,
      model: metadata.model ?? threadMetadata.model ?? null,
      reasoningEffort: metadata.reasoningEffort ?? threadMetadata.reasoningEffort ?? null,
    },
  };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return safeEvidenceText(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      return part.text ?? part.input_text ?? part.output_text ?? part.content ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

export function stripCodexAmbientContext(text) {
  return String(text ?? "")
    .replace(/<in-app-browser-context[\s\S]*?<\/in-app-browser-context>\s*/gi, "")
    .trim();
}

function isSystemNoise(text) {
  const trimmed = String(text ?? "").trim();
  return /^<(heartbeat|codex_internal_context|permissions instructions|environment_context)\b/i.test(trimmed);
}

export function codexRolloutEvidence(row, context, config, locator) {
  const payload = row.payload ?? {};
  const occurredAt = row.timestamp ?? payload.timestamp ?? null;
  const maxChars = config.collection.maxEvidenceChars;
  const maxTraceChars = config.collection.maxRawTraceChars ?? 2600;
  const common = {
    occurredAt,
    projectKey: context.projectKey,
    threadId: context.threadId,
    sourceLocator: locator,
  };

  if (row.type === "session_meta") {
    return {
      ...common,
      kind: "codex_session_meta",
      title: "Codex session metadata",
      content: safeEvidenceText({ cwd: payload.cwd, source: payload.source, model_provider: payload.model_provider }, maxChars),
      externalId: payload.id ?? payload.session_id,
      metadata: { cwd: payload.cwd, originator: payload.originator, source: payload.source },
    };
  }

  if (row.type === "event_msg" && payload.type === "user_message") {
    const message = stripCodexAmbientContext(payload.message);
    if (!message || isSystemNoise(message)) return null;
    return {
      ...common,
      kind: "codex_user_message",
      role: "user",
      title: "User request",
      content: safeEvidenceText(message, maxChars),
      externalId: payload.client_id ?? null,
    };
  }

  if (row.type === "event_msg" && payload.type === "agent_message") {
    if (!payload.message) return null;
    return {
      ...common,
      kind: "codex_agent_message",
      role: "assistant",
      title: "Codex response",
      content: safeEvidenceText(payload.message, maxChars),
      metadata: { phase: payload.phase ?? null },
    };
  }

  if (row.type === "turn_context" && payload.summary) {
    return {
      ...common,
      kind: "codex_turn_summary",
      title: "Codex turn summary",
      content: safeEvidenceText(payload.summary, maxChars),
      metadata: { cwd: payload.cwd, model: payload.model },
    };
  }

  if (row.type === "compacted" && payload.message) {
    return {
      ...common,
      kind: "codex_compaction_summary",
      title: "Codex compaction summary",
      content: safeEvidenceText(payload.message, maxChars),
      metadata: { window_id: payload.window_id ?? null },
    };
  }

  if (row.type === "event_msg" && payload.type === "patch_apply_end") {
    return {
      ...common,
      kind: "codex_patch_result",
      title: payload.success ? "Patch applied" : "Patch failed",
      content: safeTraceText({ success: payload.success, status: payload.status, changes: payload.changes, stdout: payload.stdout, stderr: payload.stderr }, maxTraceChars),
      externalId: payload.call_id,
      metadata: { success: Boolean(payload.success), status: payload.status ?? null, changes: payload.changes ?? null },
    };
  }

  if (row.type === "event_msg" && payload.type === "mcp_tool_call_end") {
    return {
      ...common,
      kind: "codex_tool_result",
      title: `Tool result: ${payload.invocation?.name ?? "mcp"}`,
      content: safeTraceText({ invocation: payload.invocation, result: payload.result }, maxTraceChars),
      externalId: payload.call_id,
      metadata: { duration: payload.duration ?? null, tool_name: payload.invocation?.name ?? null },
    };
  }

  if (row.type === "response_item" && ["custom_tool_call", "function_call"].includes(payload.type)) {
    return {
      ...common,
      kind: "codex_tool_call",
      title: `Tool call: ${payload.name ?? "unknown"}`,
      content: safeTraceText(payload.input ?? payload.arguments ?? "", maxTraceChars),
      externalId: payload.call_id ?? payload.id,
      metadata: { tool_name: payload.name ?? null, callId: payload.call_id ?? payload.id ?? null },
    };
  }

  if (row.type === "response_item" && ["custom_tool_call_output", "function_call_output"].includes(payload.type)) {
    return {
      ...common,
      kind: "codex_tool_output",
      title: "Tool output",
      content: safeTraceText(payload.output ?? "", maxTraceChars),
      externalId: payload.call_id ?? payload.id,
      metadata: { callId: payload.call_id ?? payload.id ?? null },
    };
  }

  if (row.type === "response_item" && payload.type === "message") {
    const text = stripCodexAmbientContext(contentText(payload.content));
    if (!text || isSystemNoise(text)) return null;
    return {
      ...common,
      kind: payload.role === "user" ? "codex_user_message" : "codex_agent_message",
      role: payload.role ?? null,
      title: payload.role === "user" ? "User request" : "Codex response",
      content: safeEvidenceText(text, maxChars),
      externalId: payload.id,
    };
  }

  return null;
}
