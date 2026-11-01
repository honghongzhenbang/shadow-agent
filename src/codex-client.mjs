import fs from "node:fs";

import { Codex } from "@openai/codex-sdk";

import { logger } from "./logger.mjs";
import { safeEvidenceText } from "./utils.mjs";

function existingDirectories(values) {
  return [...new Set(values.filter((value) => value && fs.existsSync(value)))];
}

function compactToolResult(value) {
  if (!value || typeof value !== "object") return safeEvidenceText(value, 1800);
  const content = Array.isArray(value.content)
    ? value.content.map((item) => item?.type === "text"
      ? { type: "text", text: safeEvidenceText(item.text, 1200) }
      : { type: item?.type ?? "unknown" })
    : undefined;
  return safeEvidenceText({
    ...(content ? { content } : {}),
    ...(value.structuredContent ? { structuredContent: value.structuredContent } : {}),
    ...(value.isError ? { isError: true } : {}),
  }, 2200);
}

export function compactCodexItems(items = []) {
  return items.slice(0, 50).map((item, index) => {
    const base = { index: index + 1, type: item.type, status: item.status ?? null };
    switch (item.type) {
      case "command_execution":
        return {
          ...base,
          command: safeEvidenceText(item.command, 1200),
          output: safeEvidenceText(item.aggregated_output, 2200),
          exitCode: item.exit_code,
        };
      case "file_change":
        return { ...base, changes: (item.changes ?? []).slice(0, 30) };
      case "mcp_tool_call":
        return {
          ...base,
          tool: `${item.server}.${item.tool}`,
          arguments: safeEvidenceText(item.arguments, 1600),
          result: compactToolResult(item.result),
          error: safeEvidenceText(item.error, 1200),
        };
      case "web_search":
        return { ...base, query: safeEvidenceText(item.query, 1000) };
      case "todo_list":
        return { ...base, items: (item.items ?? []).slice(0, 30) };
      case "reasoning":
        return { ...base, text: safeEvidenceText(item.text, 1600) };
      case "error":
        return { ...base, message: safeEvidenceText(item.message, 1600) };
      default:
        return null;
    }
  }).filter(Boolean);
}

export class CodexRunner {
  constructor(config) {
    this.config = config;
    this.client = new Codex();
  }

  async run(prompt, options = {}) {
    const timeoutMs = (options.timeoutMinutes ?? this.config.codex.timeoutMinutes) * 60 * 1000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Codex timed out after ${timeoutMs} ms`)), timeoutMs);
    const threadOptions = {
      workingDirectory: options.workingDirectory ?? this.config.codex.workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode: options.sandbox ?? this.config.codex.sandbox,
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      additionalDirectories: existingDirectories(options.additionalDirectories ?? []),
      ...(options.reasoningEffort ? { modelReasoningEffort: options.reasoningEffort } : {}),
      ...(options.model ?? this.config.codex.model ? { model: options.model ?? this.config.codex.model } : {}),
    };
    logger.info("Codex run started", {
      workingDirectory: threadOptions.workingDirectory,
      sandboxMode: threadOptions.sandboxMode,
      additionalDirectoryCount: threadOptions.additionalDirectories.length,
      reasoningEffort: threadOptions.modelReasoningEffort ?? null,
    });
    try {
      const thread = this.client.startThread(threadOptions);
      const result = await thread.run(prompt, {
        outputSchema: options.outputSchema,
        signal: controller.signal,
      });
      logger.info("Codex run completed", { threadId: thread.id, usage: result.usage });
      return { threadId: thread.id, finalResponse: result.finalResponse, usage: result.usage, items: result.items };
    } finally {
      clearTimeout(timer);
    }
  }
}
