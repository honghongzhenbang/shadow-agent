import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const PROJECTION_EPOCH = "shadow-session-contract-v1";
const PROJECTION_TEXT = [
  "# Shadow Agent stable session contract",
  "",
  "You are the sole OpenClaw controller for this logical session. Workboard is the task-state authority; Evidence Log preserves raw material; the knowledge graph stores durable facts, retrieval routes, and revisable relations.",
  "Treat conversation, message, task, project, person, and responsibility links as evidence-backed soft relations. A conversation or project hint is never task ownership. Preserve one action owner for each active task.",
  "Do not scan full history or preload project archives. For automatic attention, lease one bounded shadow_attention_packet for the supplied sessionKey. Use only its changes and candidate cards. If one exact collaboration stream lacks local context, use shadow_conversation_window with provider plus streamId and a small byte budget. For primary evidence, select Collaboration or Execution before expanding provider records; otherwise resolve one concrete ambiguity through shadow_context_resolve or a source locator.",
  "Raw messages and tool traces stay outside this bootstrap. Dynamic duties, pending counts, watches, task state, and project facts belong to current-turn tools so ordinary data changes never rotate the native Codex thread.",
  "External writes use the configured reliable authorization path. Finish every leased change with shadow_context_ack using the same lease owner.",
].join("\n");
const PROJECTION_FINGERPRINT = createHash("sha256")
  .update(`${PROJECTION_EPOCH}\n${PROJECTION_TEXT}`, "utf8")
  .digest("hex");

function estimateTokens(messages, addition = "") {
  const messageChars = (messages ?? []).reduce((total, message) => total + JSON.stringify(message).length, 0);
  return Math.ceil((messageChars + addition.length) / 4);
}

export function buildSessionBootstrap() {
  return {
    epoch: PROJECTION_EPOCH,
    fingerprint: PROJECTION_FINGERPRINT,
    text: PROJECTION_TEXT,
  };
}

export function createShadowContextEngine(_config, delegateCompaction) {
  if (typeof delegateCompaction !== "function") throw new Error("A runtime compaction delegate is required.");
  return {
    info: {
      id: "shadow-work",
      name: "Shadow Agent Progressive Context",
      version: "4.27.0",
      ownsCompaction: false,
      transcriptSemantics: {
        currentTurnFence: "before-current-turn-entry-v1",
        turnAdvancementIdempotency: "atomic-idempotent-v1",
      },
      hostRequirements: {
        "agent-run": {
          requiredCapabilities: ["assemble-before-prompt", "thread-bootstrap-projection"],
          unsupportedMessage: "Shadow Agent requires persistent thread bootstrap projection.",
        },
        "manual-compact": { requiredCapabilities: ["compact"] },
      },
    },
    async ingest() {
      // Evidence collectors, not the context engine, own raw-message persistence.
      return { ingested: false };
    },
    async assemble({ messages }) {
      const bootstrap = buildSessionBootstrap();
      return {
        messages,
        estimatedTokens: estimateTokens(messages, bootstrap.text),
        promptAuthority: "preassembly_may_overflow",
        systemPromptAddition: bootstrap.text,
        contextProjection: {
          mode: "thread_bootstrap",
          epoch: bootstrap.epoch,
          fingerprint: bootstrap.fingerprint,
        },
      };
    },
    async commitTurn({ advancementKey, admission, terminal, messages, sessionId, sessionKey }) {
      const database = new DatabaseSync(path.resolve(_config.databasePath));
      try {
        database.exec("PRAGMA busy_timeout=5000");
        database.exec(`
          CREATE TABLE IF NOT EXISTS context_engine_turn_commits (
            advancement_key TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            session_key TEXT,
            admission_json TEXT NOT NULL,
            terminal_json TEXT NOT NULL,
            messages_sha256 TEXT NOT NULL,
            message_count INTEGER NOT NULL,
            committed_at TEXT NOT NULL
          ) STRICT
        `);
        const messageHash = createHash("sha256").update(JSON.stringify(messages), "utf8").digest("hex");
        const inserted = database.prepare(`
          INSERT OR IGNORE INTO context_engine_turn_commits(
            advancement_key, session_id, session_key, admission_json, terminal_json,
            messages_sha256, message_count, committed_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          advancementKey,
          sessionId,
          sessionKey ?? null,
          JSON.stringify(admission),
          JSON.stringify(terminal),
          messageHash,
          messages.length,
          new Date().toISOString(),
        );
        if (inserted.changes === 1) return { status: "committed" };
        const existing = database.prepare(`
          SELECT session_id, messages_sha256, message_count
          FROM context_engine_turn_commits
          WHERE advancement_key=?
        `).get(advancementKey);
        if (existing?.session_id !== sessionId
          || existing?.messages_sha256 !== messageHash
          || Number(existing?.message_count) !== messages.length) {
          throw new Error(`Context-engine advancement key collision: ${advancementKey}`);
        }
        return { status: "duplicate" };
      } finally {
        database.close();
      }
    },
    async compact(params) {
      return delegateCompaction(params);
    },
  };
}
