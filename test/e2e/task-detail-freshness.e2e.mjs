import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";
import { openDatabase } from "../../src/db.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "n1-renderer-freshness-"));
const store = openDatabase(path.join(root, "isolated.sqlite"));
store.close();
fs.writeFileSync(path.join(root, "cards.json"), "[]");
const evidence = path.join(project, "runtime", "pet-evidence", `detail-freshness-${Date.now()}`);
fs.mkdirSync(evidence, { recursive: true });
const env = { ...process.env, N1_E2E_ROOT: root };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({
  executablePath: path.join(project, "node_modules", "electron", "dist", "electron.exe"),
  args: [path.join(project, "test", "e2e", "task-progress-electron.mjs")], env,
});

try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.waitForFunction(() => document.getElementById("contextStatus")?.dataset.state === "online");
  await app.evaluate(({ ipcMain }) => {
    const state = globalThis.freshness = { requests: [], held: [], hold: null, fail: false, cards: {} };
    for (const id of ["fresh-a", "fresh-b"]) {
      state.cards[id] = {
        task: { id, title: id, status: "blocked", handling_lane: "user", user_action: { request: `${id} latest preview` } },
        actions: [], evidence: [],
        conversation: { messages: Array.from({ length: 12 }, (_, index) => ({
          id: `${id}-${index}`, role: "assistant", text: `${id} old reply ${index}\n\n${"Historical details. ".repeat(20)}`,
          at: new Date(Date.UTC(2026, 9, 29, 0, index)).toISOString(),
        })), before: null, hasMore: false },
      };
    }
    const handle = (channel, fn) => { ipcMain.removeHandler(`pet:${channel}`); ipcMain.handle(`pet:${channel}`, fn); };
    handle("snapshot", () => ({ runtime: { phase: "idle", lastHeartbeat: new Date().toISOString() },
      openclaw: { connected: false }, feishu: {}, running: [], failed: [], queued: [],
      needsUser: Object.values(state.cards).map(item => item.task), completed: [], maintenance: [] }));
    handle("main-conversation", () => ({ messages: [], before: null, hasMore: false }));
    handle("task-details", async (_event, id, options) => {
      state.requests.push({ kind: "details", id, options });
      const result = structuredClone(state.cards[id]);
      if (state.hold === id) await new Promise(resolve => state.held.push(resolve));
      if (state.fail) throw new Error("isolated detail read failure");
      return result;
    });
    handle("task-conversation", (_event, id) => {
      state.requests.push({ kind: "conversation", id });
      return { ...state.cards[id].conversation, task: state.cards[id].task };
    });
  });
  await page.reload();
  await page.waitForFunction(() => document.getElementById("contextStatus")?.dataset.state === "online");
  await page.locator("#mascot").dispatchEvent("dblclick");
  await page.locator("#workHomeTab").click();
  await page.locator("#userQueueTab").click();
  const open = id => page.locator(`#queuedList [data-task-id="${id}"]`).click();
  const back = () => page.locator("#detailBackButton").click();
  const messages = page.locator("#taskConversationMessages");
  const rendered = id => page.waitForFunction(value => document.getElementById("taskConversationMessages").dataset.key === value, id);
  const release = () => app.evaluate(() => {
    const state = globalThis.freshness;
    state.hold = null;
    state.held.splice(0).forEach(resolve => resolve());
  });

  await open("fresh-a");
  await rendered("fresh-a");
  await page.locator(".detail-content").evaluate(element => { element.scrollTop = 0; });
  await back();
  await app.evaluate(() => {
    const state = globalThis.freshness;
    state.cards["fresh-a"].conversation.messages.push({ id: "fresh-a-new", role: "assistant", text: "NEW confirmed reply",
      at: "2026-10-29T01:00:00.000Z" });
    state.cards["fresh-a"].task.user_action.request = "NEW confirmed reply";
    state.hold = "fresh-a";
  });
  await page.waitForFunction(() => document.querySelector('[data-task-id="fresh-a"] small')?.textContent.includes("NEW confirmed reply"));
  await open("fresh-a");
  assert.doesNotMatch(await messages.textContent(), /old reply/, "opening must not display the previous conversation while waiting");
  assert.equal(await page.locator("#taskConversationMore").isVisible(), false);
  assert.equal(await page.locator("#confirmDoneButton").isDisabled(), true);
  await page.screenshot({ path: path.join(evidence, "loading.png") });
  await release();
  await rendered("fresh-a");
  assert.match(await messages.textContent(), /NEW confirmed reply/);
  assert.equal(await page.locator(".detail-content").evaluate(element =>
    element.scrollHeight - element.scrollTop - element.clientHeight < 45), true, "reopening must show the latest message");
  assert.equal(await app.evaluate(() => globalThis.freshness.requests.filter(item => item.kind === "details").at(-1).options?.preferCached), true);
  await page.screenshot({ path: path.join(evidence, "latest.png") });

  await back();
  await app.evaluate(() => { globalThis.freshness.hold = "fresh-a"; });
  await open("fresh-a");
  await back();
  await open("fresh-b");
  await rendered("fresh-b");
  await release();
  await page.waitForTimeout(100);
  assert.doesNotMatch(await messages.textContent(), /fresh-a|NEW confirmed reply/, "a late response must not replace the selected card");
  assert.equal(await page.locator("#detailTitle").textContent(), "fresh-b");

  await back();
  await app.evaluate(() => { globalThis.freshness.hold = "fresh-b"; globalThis.freshness.fail = true; });
  await open("fresh-b");
  assert.doesNotMatch(await messages.textContent(), /old reply/);
  await release();
  await page.waitForFunction(() => document.getElementById("detailTitle").textContent === "详情加载失败");
  assert.doesNotMatch(await messages.textContent(), /old reply/);
  assert.match(await messages.textContent(), /读取失败/);
  await app.evaluate(() => { globalThis.freshness.fail = false; });
  await rendered("fresh-b");
  assert.match(await messages.textContent(), /fresh-b old reply/);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ["pending content cleared", "overview snapshot requested", "latest message visible on reopen",
    "late response ignored", "failure visible without stale content", "poll retry recovers"], evidence }));
} finally {
  await app.close();
  const resolved = fs.realpathSync(root);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith("n1-renderer-freshness-"));
  fs.rmSync(resolved, { recursive: true, force: true });
}
