import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, _electron } from "playwright";
import { openDatabase } from "../../src/db.mjs";
import { taskConversationPage } from "../../src/pet-conversations.mjs";
import { recordAgentOperation } from "../../src/agent-operations.mjs";
import { addReview } from "../task-progress-fixture.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const electronMode = process.argv.includes("--electron");
const tempParent = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(tempParent, "n1-renderer-"));
const store = openDatabase(path.join(root, "isolated.sqlite"));
const evidence = path.join(project, "runtime", "experiments", "n1-presentation", new Date().toISOString().replaceAll(":", "-"));
fs.mkdirSync(evidence, { recursive: true });
const executablePath = [process.env.N1_CHROMIUM, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe"].find(file => file && fs.existsSync(file));
if (!electronMode && !executablePath) throw new Error("An installed Chromium browser is required; no browser download is performed");
const cards = new Map(["n1-main", "n1-pages"].map(id => [id, { id, title: id, status: "todo", metadata: { comments: [] }, events: [] }]));
for (let i = 0; i < 10; i++) addReview(store, "n1-main", i);
for (let i = 0; i < 105; i++) addReview(store, "n1-pages", i);
let failAudit = true;
const requests = [];
const errors = [];
let browser;
let electron;
let page;
try {
  if (electronMode) {
    fs.writeFileSync(path.join(root, "cards.json"), JSON.stringify([...cards.values()]));
    const env = { ...process.env, N1_E2E_ROOT: root };
    delete env.ELECTRON_RUN_AS_NODE;
    electron = await _electron.launch({ executablePath: path.join(project, "node_modules", "electron", "dist", "electron.exe"),
      args: [path.join(project, "test", "e2e", "task-progress-electron.mjs")], env });
    page = await electron.firstWindow();
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  } else {
  browser = await chromium.launch({ executablePath, headless: true,
    args: ["--allow-file-access-from-files", "--disable-background-networking", "--disable-component-update", "--no-first-run"] });
  const context = await browser.newContext({ viewport: { width: 1000, height: 850 } });
  await context.route(/^https?:/, route => route.abort());
  page = await context.newPage();
  await page.exposeBinding("n1Read", (_source, method, args) => {
    requests.push({ method, args });
    if (method === "snapshot") return { runtime: { phase: "idle", lastHeartbeat: new Date().toISOString() },
      openclaw: { connected: false, supervisorPhase: "disabled" }, feishu: {},
      running: [], failed: [], queued: [], needsUser: [], completed: [], maintenance: [] };
    if (method === "mainConversation") return { messages: [{ id: "task-links", role: "assistant", text: "N1 fixture",
      at: "2026-10-22T00:00:00.000Z", tasks: [...cards.values()].map(({ id, title }) => ({ id, title })) }], before: null, hasMore: false };
    if (method === "taskDetails") {
      const card = cards.get(args[0]);
      return { task: { ...card, description: "Isolated renderer fixture" }, actions: [], evidence: [], conversation: taskConversationPage(store, card) };
    }
    if (method === "taskConversation") {
      const [id, options] = args;
      if (options.view === "audit" && failAudit) { failAudit = false; throw new Error("isolated read failure"); }
      return taskConversationPage(store, cards.get(id), options);
    }
    throw new Error(`Unexpected bridge call: ${method}`);
  });
  await page.addInitScript(() => {
    window.shadowPet = {
      snapshot: () => window.n1Read("snapshot", []),
      mainConversation: options => window.n1Read("mainConversation", [options]),
      taskDetails: id => window.n1Read("taskDetails", [id]),
      taskConversation: (id, options) => window.n1Read("taskConversation", [id, options]),
      setExpanded: () => {}, onExpanded: () => {}, hide: () => {}, setPinned: async value => value,
    };
  });
  await page.goto(pathToFileURL(path.join(project, "desktop", "index.html")).href);
  }
  page.on("pageerror", error => errors.push(error.message));
  await page.waitForFunction(() => document.getElementById("contextStatus")?.dataset.state === "online");
  await page.locator("#mascot").dispatchEvent("dblclick");
  assert.equal(await page.locator("#pet").getAttribute("data-expanded"), "true");
  await page.locator('.task-link[data-task-id="n1-main"]').click();
  const reviews = page.locator("#taskConversationMessages .progress-review");
  const messages = page.locator("#taskConversationMessages > .conversation-message");
  await page.waitForFunction(() => document.querySelector(".progress-review")?.dataset.count === "10");
  assert.equal(await messages.count(), 1);
  assert.equal(await reviews.locator(".progress-review-times").isVisible(), true);
  await reviews.locator(":scope > summary").click();
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".progress-review-original").length === 10);
  await reviews.locator(".progress-review-original details summary").first().click();
  assert.match(await reviews.locator("pre").first().textContent(), /metadata_json/);
  addReview(store, "n1-main", 10);
  await page.waitForFunction(() => document.querySelector(".progress-review")?.dataset.count === "11");
  await page.waitForFunction(() => document.querySelectorAll(".progress-review-original").length === 11);
  assert.equal(await messages.count(), 1);
  assert.equal(await reviews.getAttribute("open"), "");
  store.db.prepare("UPDATE context_changes SET ack_note=? WHERE seq=1").run("Updated original audit field");
  await reviews.locator(":scope > summary").click();
  await reviews.locator(":scope > summary").click();
  await page.waitForFunction(() => document.querySelector(".progress-review-original pre")?.textContent.includes("Updated original audit field"));
  addReview(store, "n1-main", 11, m => { m.taskCheckpoint.resultState = "progressed"; m.taskCheckpoint.resultSummary = "Actual fixture change"; });
  for (let i = 0; i < 2; i++) recordAgentOperation(store, { operationId: `repeat-${i}`, action: "task_message", card: cards.get("n1-main"),
    taskId: "n1-main", targetType: "workboard_task", targetId: "n1-main", metadata: { userText: "Repeated user instruction" } });
  await page.waitForFunction(() => document.querySelectorAll('#taskConversationMessages > [data-role="user"]').length === 2);
  assert.equal(await messages.count(), 4);
  await page.screenshot({ path: path.join(evidence, "desktop.png"), fullPage: true });
  await reviews.locator(":scope > summary").click();
  await page.locator(".detail-content").evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: path.join(evidence, "desktop-overview.png"), fullPage: true });
  await page.locator("#detailBackButton").click();
  await page.locator('.task-link[data-task-id="n1-pages"]').click();
  await page.waitForFunction(() => document.querySelector(".progress-review")?.dataset.count === "40");
  await page.locator("#taskConversationMore").click();
  await page.waitForFunction(() => document.querySelector(".progress-review")?.dataset.count === "80");
  await reviews.locator(":scope > summary").click();
  await page.waitForFunction(() => document.querySelectorAll(".progress-review-original").length === 20);
  await page.locator("#taskConversationMore").click();
  await page.waitForFunction(() => document.querySelector(".progress-review")?.dataset.count === "105");
  assert.equal(await messages.count(), 1);
  assert.equal(await reviews.getAttribute("open"), "");
  while (await reviews.locator(".progress-review-original").count() < 105) {
    const previous = await reviews.locator(".progress-review-original").count();
    await reviews.getByRole("button", { name: "查看更多原件", exact: true }).click();
    await page.waitForFunction(count => document.querySelectorAll(".progress-review-original").length > count, previous);
  }
  assert.equal(await reviews.locator(".progress-review-original").count(), 105);
  const unique = await reviews.locator(".progress-review-original").evaluateAll(items => new Set(items.map(item => item.dataset.eventSeq)).size);
  assert.equal(unique, 105);
  await page.setViewportSize({ width: 360, height: 720 });
  await reviews.locator(":scope > summary").click();
  await page.locator(".detail-content").evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: path.join(evidence, "compact.png"), fullPage: true });
  const overflow = await page.locator("#taskConversationMessages").evaluate(el => el.scrollWidth > el.clientWidth + 1);
  assert.equal(overflow, false);
  assert.equal(await messages.count(), 1);
  assert.deepEqual(errors, []);
  if (electron) requests.push(...await electron.evaluate(() => globalThis.n1Requests.map(r => ({
    method: r.channel === "task-conversation" ? "taskConversation" : r.channel, args: r.args }))));
  assert.ok(requests.filter(r => r.method === "taskConversation" && r.args[1].view === "audit").every(r => r.args[1].sequences.length <= 100));
  console.log(JSON.stringify({ proof: "isolated actual renderer, synthetic existing checkpoint fields", engine: electronMode ? "hidden Electron + actual sandboxed preload" : "headless Chromium + mock bridge", passed: true,
    initialReviews: 10, refreshedReviews: 11, pagedReviews: 105, distinctRepeatedUsers: 2,
    screenshots: evidence, bridgeCalls: requests.length, pageErrors: errors }));
} catch (error) {
  console.error(JSON.stringify({ errors, document: await page?.evaluate(() => ({ hidden: document.hidden,
    expanded: document.getElementById("pet")?.dataset.expanded, body: document.body.innerText.slice(0, 1500) })).catch(() => null),
    requests: electron ? await electron.evaluate(() => globalThis.n1Requests).catch(() => []) : requests }));
  throw error;
} finally {
  await electron?.close();
  await browser?.close();
  store.close();
  assert.equal(path.dirname(fs.realpathSync(root)), tempParent);
  fs.rmSync(root, { recursive: true, force: true });
}
