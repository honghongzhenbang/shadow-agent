import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function nativeRunAbsent(projectRoot, sessionKey, runId) {
  let db, state;
  try {
    db = new DatabaseSync(path.join(projectRoot, "runtime/openclaw-poc/state/agents/main/agent/openclaw-agent.sqlite"), { readOnly: true });
    state = new DatabaseSync(path.join(projectRoot, "runtime/openclaw-poc/state/state/openclaw.sqlite"), { readOnly: true });
    db.exec("PRAGMA busy_timeout=1000");
    state.exec("PRAGMA busy_timeout=1000");
    if (db.prepare("SELECT 1 FROM trajectory_runtime_events WHERE run_id=? LIMIT 1").get(runId)) return false;
    if (db.prepare("SELECT 1 FROM session_pending_inputs WHERE run_id=? LIMIT 1").get(runId)) return false;
    if (state.prepare("SELECT 1 FROM worker_session_placements WHERE turn_claim_run_id=? LIMIT 1").get(runId)) return false;
    return true;
  } catch { return false; }
  finally { db?.close(); state?.close(); }
}

// Gateway's wait cache is transient. Its exact-run native trajectory is the
// durable fallback, never a session's latest text or a Workboard status guess.
export function readNativeTerminal(projectRoot, sessionKey, runId) {
  const filename = path.join(projectRoot, "runtime/openclaw-poc/state/agents/main/agent/openclaw-agent.sqlite");
  if (!fs.existsSync(filename)) return null;
  let db;
  try {
    db = new DatabaseSync(filename, { readOnly: true });
    db.exec("PRAGMA busy_timeout=1000");
    const rows = db.prepare(`SELECT session_id, seq,
      json_extract(event_json,'$.type') AS type,
      json_extract(event_json,'$.ts') AS ts,
      json_extract(event_json,'$.data.turnId') AS turn_id,
      json_extract(event_json,'$.data.status') AS status,
      json_extract(event_json,'$.data.timedOut') AS timed_out,
      json_extract(event_json,'$.data.aborted') AS aborted,
      json_extract(event_json,'$.data.yieldDetected') AS yielded,
      json_extract(event_json,'$.data.promptError') AS prompt_error,
      json_extract(event_json,'$.modelId') AS model,
      json_extract(event_json,'$.data.usage') AS usage,
      substr(json_extract(event_json,'$.data.assistantTexts'),1,131072) AS texts
      FROM trajectory_runtime_events WHERE run_id=?
        AND json_extract(event_json,'$.sessionKey')=?
        AND json_extract(event_json,'$.type') IN ('model.completed','session.ended')
      ORDER BY created_at DESC, seq DESC LIMIT 4`).all(runId, sessionKey);
    const end = rows.find(row => row.type === "session.ended");
    if (!end || !Number.isFinite(Date.parse(end.ts))) return null;
    const nativeProof = { source: "trajectory_runtime_events", runId, sessionKey, sessionId: end.session_id, turnId: end.turn_id, endSeq: end.seq };
    if (["interrupted", "error", "failed", "aborted"].includes(end.status) || end.timed_out || end.prompt_error) {
      return { status: "error", endedAt: Date.parse(end.ts), nativeProof,
        error: `Native run ended: ${end.status}${end.timed_out ? " (timed out)" : ""}` };
    }
    if (end.status !== "success" || end.yielded) return null;
    const model = rows.find(row => row.type === "model.completed" && row.session_id === end.session_id
      && row.turn_id && row.turn_id === end.turn_id && row.seq < end.seq);
    if (!model || model.timed_out || model.aborted || model.yielded || model.prompt_error) return null;
    const texts = JSON.parse(model.texts || "[]");
    const text = Array.isArray(texts) ? texts.filter(value => typeof value === "string").join("\n\n").trim() : "";
    if (!text || !Number.isFinite(Date.parse(end.ts))) return null;
    const usage = JSON.parse(model.usage || "{}");
    const tools = db.prepare(`SELECT COUNT(*) AS n FROM trajectory_runtime_events WHERE run_id=? AND session_id=?
      AND json_extract(event_json,'$.type')='tool.call' AND seq<?`).get(runId, end.session_id, end.seq);
    return { status: "ok", endedAt: Date.parse(end.ts), terminalReply: { disposition: "visible", text },
      nativeMetrics: { model: model.model, inputTokens: usage.input ?? 0, outputTokens: usage.output ?? 0,
        cacheReadTokens: usage.cacheRead ?? 0, cacheWriteTokens: usage.cacheWrite ?? 0,
        totalTokens: usage.total ?? 0, toolCalls: tools.n },
      nativeProof };
  } catch { return null; }
  finally { db?.close(); }
}
