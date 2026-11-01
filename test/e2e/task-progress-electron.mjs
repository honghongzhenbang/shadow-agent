import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { app, BrowserWindow, ipcMain, session } from "electron";
import { taskConversationPage } from "../../src/pet-conversations.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const root = fs.realpathSync(process.env.N1_E2E_ROOT);
assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
assert.ok(path.basename(root).startsWith("n1-renderer-"));
app.setPath("userData", path.join(root, "electron-user-data"));
app.commandLine.appendSwitch("disable-background-networking");
const store = { db: new DatabaseSync(path.join(root, "isolated.sqlite"), { readOnly: true }) };
store.db.exec("PRAGMA query_only = ON");
const cards = new Map(JSON.parse(fs.readFileSync(path.join(root, "cards.json"), "utf8")).map(card => [card.id, card]));
globalThis.n1Requests = [];
let failAudit = process.env.N1_E2E_HISTORY !== "1";
function handle(channel, fn) {
  ipcMain.handle(`pet:${channel}`, (_event, ...args) => {
    globalThis.n1Requests.push({ channel, args });
    return fn(...args);
  });
}
handle("snapshot", () => ({ runtime: { phase: "idle", lastHeartbeat: new Date().toISOString() },
  openclaw: { connected: false, supervisorPhase: "disabled" }, feishu: {},
  running: [], failed: [], queued: [], needsUser: [], completed: [], maintenance: [] }));
handle("main-conversation", () => ({ messages: [{ id: "task-links", role: "assistant", text: "N1 fixture",
  at: "2026-10-22T00:00:00.000Z", tasks: [...cards.values()].map(({ id, title }) => ({ id, title })) }], before: null, hasMore: false }));
handle("task-details", id => {
  const card = cards.get(id);
  return { task: { ...card, description: card.notes ?? "Isolated renderer fixture" }, actions: [], evidence: [], conversation: taskConversationPage(store, card) };
});
handle("task-conversation", (id, options) => {
  if (options.view === "audit" && failAudit) { failAudit = false; throw new Error("isolated read failure"); }
  return taskConversationPage(store, cards.get(id), options);
});
handle("set-expanded", value => value);
handle("set-pinned", value => value);
handle("hide", () => {});
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => callback({ cancel: true }));
  const window = new BrowserWindow({ show: false, width: 1000, height: 850,
    paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false, preload: path.join(project, "desktop", "preload.cjs") } });
  await window.loadFile(path.join(project, "desktop", "index.html"));
}).catch(error => { console.error(error); app.exit(1); });
app.on("will-quit", () => store.db.close());
