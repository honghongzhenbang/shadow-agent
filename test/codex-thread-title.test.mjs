import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  codexDigestTitle,
  isAgentGeneratedCodexThread,
  normalizeCodexThreadTitle,
} from "../src/codex-thread-title.mjs";
import { inspectShadowStoredTitles } from "../src/codex-title-maintenance.mjs";

test("OpenClaw assembled prompts use the current request as a bounded title", () => {
  const title = [
    "OpenClaw assembled context for this turn:",
    "<conversation_context>",
    "x".repeat(20_000),
    "</conversation_context>",
    "Current user request:",
    "核对固件版本显示修复结果并给出下一步",
    "后续约束不进入标题",
  ].join("\n");
  assert.equal(normalizeCodexThreadTitle({ id: "thread-1", title }), "核对固件版本显示修复结果并给出下一步");
});

test("legacy Shadow prompts and digest titles stay bounded and searchable", () => {
  const threadTitle = normalizeCodexThreadTitle({
    id: "thread-legacy",
    title: `你是一个持续工作的个人影子 Agent。\n${"历史证据".repeat(5000)}`,
  });
  assert.equal(threadTitle, "Shadow Agent 主动巡检");
  const digestTitle = codexDigestTitle(`${"激光跟踪软件".repeat(100)}`, 11, 80);
  assert.ok(Array.from(digestTitle).length <= 80);
  assert.match(digestTitle, /摘要 12$/);
});

test("legacy worker prompts prefer an explicit task and old evidence prompts use the latest request", () => {
  assert.equal(normalizeCodexThreadTitle({
    id: "legacy-task",
    title: "你正在替用户执行影子 Agent 已发现的一项低风险任务。\n\n任务：整理验收缺口和最小修复清单\n说明：只读核验",
  }), "整理验收缺口和最小修复清单");
  assert.equal(normalizeCodexThreadTitle({
    id: "legacy-evidence",
    title: "旧上下文\\n- [aaaa @ 2026-08-01] ## My request for Codex: 第一项\\n- [bbbb @ 2026-08-02] ## My request for Codex: 核对最终提交状态\\n- [cccc @ 2026-08-03] trailing",
  }), "核对最终提交状态");
});

test("agent ownership is recognized by marker or configured workspace", () => {
  assert.equal(isAgentGeneratedCodexThread({ title: "Current user request:\n测试", cwd: "D:/work" }), true);
  assert.equal(isAgentGeneratedCodexThread(
    { title: "旧版提示", cwd: "C:/Users/demo/Documents/Codex/shadow-agent" },
    ["C:/Users/demo/Documents/Codex/shadow-agent"],
  ), true);
  assert.equal(isAgentGeneratedCodexThread({ title: "普通用户任务", cwd: "D:/work" }, []), false);
});

test("historical Shadow digest titles are found even after the main title is already short", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-title-"));
  const databasePath = path.join(root, "shadow.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT);
    CREATE TABLE evidence (id TEXT PRIMARY KEY, kind TEXT, thread_id TEXT, title TEXT);
    CREATE INDEX evidence_thread_idx ON evidence(thread_id);
  `);
  database.prepare("INSERT INTO threads(id,title,cwd) VALUES(?,?,?)").run("t-1", "短标题", "D:/work");
  database.prepare("INSERT INTO evidence(id,kind,thread_id,title) VALUES(?,?,?,?)")
    .run("e-1", "codex_thread_digest", "t-1", "旧标题".repeat(500));
  database.close();

  try {
    const inspection = inspectShadowStoredTitles(databasePath, {
      maxThreadTitleChars: 160,
      maxDigestTitleChars: 200,
    });
    assert.equal(inspection.candidates.length, 1);
    assert.equal(inspection.candidates[0].newTitle, "短标题");
    assert.equal(inspection.digestRows, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
