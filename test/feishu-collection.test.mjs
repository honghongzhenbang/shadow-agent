import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../src/db.mjs";
import { collectFeishu, recordFeishuCollectionHealth } from "../src/collectors/feishu.mjs";

const config = { feishu: { enabled: true, cliPath: process.execPath, initialLookbackDays: 2, pageLimit: 1 },
  collection: { maxEvidenceChars: 4000 } };
const onlyMessages = { approvals: false, tasks: false, drive: false };
const json = data => ({ stdout: JSON.stringify({ data }), stderr: "" });
const messageTime = new Date().toISOString();
const message = id => ({ message_id: id, chat_id: "chat", chat_type: "p2p", create_time: messageTime,
  sender: { id: "someone", name: "colleague" }, content: "Please review this document" });

test("failed auth verification does not block a refreshable business read or fabricate login tasks", async () => {
  const store = openDatabase(":memory:");
  try {
    const result = await collectFeishu(store, config, { ...onlyMessages, runLark: async (_config, args) => {
      if (args[0] === "auth") throw new Error("status subprocess unavailable");
      return json({ messages: [], has_more: false });
    } });
    assert.equal(result.authenticated, true);
    assert.deepEqual(result.successfulSections, ["messages"]);
    assert.equal(recordFeishuCollectionHealth(store, "messages", result), "ready");
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM tasks").get().n, 0);
  } finally { store.close(); }
});

test("failed or skipped collection never advances successful health or message coverage", async () => {
  const store = openDatabase(":memory:");
  try {
    const before = "2026-10-16T00:00:00.000Z";
    store.setSetting("feishu.last_message_time", before);
    store.setSetting("runtime:feishu:quick:messages:lastSuccessAt", before);
    const result = await collectFeishu(store, config, { ...onlyMessages, runLark: async () => { throw new Error("read permission denied"); } });
    assert.equal(result.authenticated, false);
    assert.equal(recordFeishuCollectionHealth(store, "messages", result), "error");
    assert.equal(store.getSetting("runtime:feishu:quick:messages:lastSuccessAt"), before);
    assert.equal(store.getSetting("feishu.last_message_time"), before);
    const skipped = await collectFeishu(store, { ...config, feishu: { ...config.feishu, enabled: false } });
    assert.equal(recordFeishuCollectionHealth(store, "messages", skipped), "skipped");
    assert.equal(store.getSetting("runtime:feishu:quick:messages:lastSuccessAt"), before);
  } finally { store.close(); }
});

test("fixed message window resumes its next page and advances coverage only when exhausted", async () => {
  const store = openDatabase(":memory:");
  try {
    const before = new Date(Date.now() - 86_400_000).toISOString();
    store.setSetting("feishu.last_message_time", before);
    const calls = [];
    let page = 0;
    const runLark = async (_config, args) => {
      if (args[0] === "auth") return { stdout: JSON.stringify({ identities: { user: { status: "needs_refresh", openId: "self" } } }) };
      calls.push(args);
      if (++page === 1) return json({ messages: [message("one")], has_more: true, page_token: "next" });
      return json({ messages: [message("one"), message("two")], has_more: false });
    };
    const first = await collectFeishu(store, config, { ...onlyMessages, runLark });
    assert.equal(first.messageWindowComplete, false);
    assert.equal(store.getSetting("feishu.last_message_time"), before);
    const checkpoint = JSON.parse(store.getSetting("feishu.messages_scan"));
    assert.equal(checkpoint.pageToken, "next");
    // A fresh call depends only on the persisted checkpoint, not process-local state.
    const second = await collectFeishu(store, config, { ...onlyMessages, runLark });
    assert.equal(second.messageWindowComplete, true);
    assert.equal(second.newMessages.length, 1);
    assert.equal(store.getSetting("feishu.last_message_time"), checkpoint.end);
    assert.equal(store.getSetting("feishu.messages_scan"), "");
    assert.equal(calls[0].find(x => x.startsWith("--end=")), calls[1].find(x => x.startsWith("--end=")));
    assert.ok(calls[1].includes("--page-token=next"));
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM evidence WHERE kind='feishu_message'").get().n, 2);
  } finally { store.close(); }
});

for (const [name, payload] of [
  ["malformed response", {}],
  ["missing continuation token", { messages: [], has_more: true }],
]) test(`${name} preserves coverage and cannot report a successful empty read`, async () => {
  const store = openDatabase(":memory:");
  try {
    const before = "2026-10-16T00:00:00.000Z";
    store.setSetting("feishu.last_message_time", before);
    const result = await collectFeishu(store, config, { ...onlyMessages, runLark: async () => json(payload) });
    assert.equal(recordFeishuCollectionHealth(store, "messages", result), "error");
    assert.equal(store.getSetting("feishu.last_message_time"), before);
  } finally { store.close(); }
});
