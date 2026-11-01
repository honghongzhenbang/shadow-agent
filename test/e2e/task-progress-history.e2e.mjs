import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";
import { openDatabase } from "../../src/db.mjs";
import { taskConversationPage } from "../../src/pet-conversations.mjs";
import { mergeTaskConversationPage } from "../../src/task-progress-presentation.mjs";

// Replay only the explicitly supplied export. Never open its production DB paths.
const input = fs.realpathSync(process.argv[2]);
const bytes = fs.readFileSync(input);
const hash = value => createHash("sha256").update(value).digest("hex");
const sample = JSON.parse(bytes);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tempParent = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(tempParent, "n1-renderer-"));
const store = openDatabase(path.join(root, "isolated.sqlite"));
const output = path.join(project, "runtime", "experiments", "n1-presentation", `history-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
let electron;
try {
  // Keep original foreign IDs without fabricating their evidence in this disposable replay DB.
  store.db.exec("PRAGMA foreign_keys = OFF");
  const knownColumns = new Set(store.db.prepare("PRAGMA table_info(context_changes)").all().map(row => row.name));
  for (const row of sample.changes) {
    const columns = Object.keys(row);
    assert.ok(columns.every(key => knownColumns.has(key)), "Export schema must be recognized without dropping fields");
    store.db.prepare(`INSERT INTO context_changes (${columns.map(key => `"${key}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
      .run(...columns.map(key => row[key]));
  }
  store.db.exec("PRAGMA query_only = ON");
  const cards = sample.workboard.cards.map(card => ({ ...card, metadata: { comments: sample.workboard.comments
    .filter(comment => comment.card_id === card.id).map(comment => ({ ...comment, createdAt: comment.created_at })) },
    events: (sample.workboard.events ?? []).filter(event => event.card_id === card.id)
      .map(event => ({ ...event, at: event.at ?? event.created_at })) }));
  const totalBefore = store.db.prepare("SELECT total_changes() AS n").get().n;
  const proof = { input, sha256: hash(bytes), observedAt: sample.observedAt,
    proof: "real exported history replay through actual hidden Electron/preload; no model or production service",
    coverage: sample.coverage ?? { scope: "exported sample only", missingWorkboardEvents: !Array.isArray(sample.workboard.events),
      note: sample.note, noClaimOfCompleteHistory: true },
    inputEvents: sample.changes.length, inputComments: sample.workboard.comments.length, tasks: [] };
  for (const card of cards) {
    let state;
    do {
      state = mergeTaskConversationPage(state, taskConversationPage(store, card, { limit: 4, before: state?.before }), { older: !!state });
    } while (state.hasMore);
    const stable = JSON.stringify(state.messages);
    state = mergeTaskConversationPage(state, taskConversationPage(store, card));
    assert.equal(JSON.stringify(state.messages), stable, "Refreshing after full pagination must not duplicate or lose rows");
    const rows = sample.changes.filter(row => JSON.parse(row.metadata_json).taskId === card.id).sort((a, b) => a.seq - b.seq);
    const readback = [];
    for (let offset = 0; offset < rows.length; offset += 100) readback.push(...taskConversationPage(store, card, {
      view: "audit", sequences: rows.slice(offset, offset + 100).map(row => row.seq) }).audit);
    assert.deepEqual(readback.map(row => ({ ...row })), rows);
    const groups = state.messages.filter(message => message.aggregation).map(message => message.aggregation);
    const folded = new Set(groups.flatMap(group => group.sequences));
    const changes = rows.filter(row => {
      const m = JSON.parse(row.metadata_json);
      return m.userText || (m.taskCheckpoint && m.taskCheckpoint.resultState !== "unchanged");
    });
    assert.ok(changes.every(row => !folded.has(row.seq)), "Changed results and independent user events must remain outside groups");
    const userIds = rows.filter(row => JSON.parse(row.metadata_json).userText).map(row => {
      const m = JSON.parse(row.metadata_json);
      return `operation:${m.operationId ?? row.seq}`;
    });
    assert.ok(userIds.every(id => state.messages.some(message => message.id === id)));
    proof.tasks.push({ taskId: card.id, title: card.title, rawEvents: rows.length,
      rawTimelineItems: state.rawMessages.size, visibleItems: state.messages.length,
      foldedRows: groups.reduce((sum, group) => sum + group.count - 1, 0),
      groups: groups.map(group => ({ count: group.count, sequences: group.sequences, eventIds: group.eventIds })),
      preservedChanges: changes.map(row => ({ seq: row.seq, eventId: row.event_key, resultState: JSON.parse(row.metadata_json).taskCheckpoint?.resultState })),
      preservedUserIds: userIds, auditReadbackExact: true });
  }
  assert.equal(store.db.prepare("SELECT total_changes() AS n").get().n, totalBefore);
  fs.writeFileSync(path.join(root, "cards.json"), JSON.stringify(cards));
  const env = { ...process.env, N1_E2E_ROOT: root, N1_E2E_HISTORY: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  electron = await _electron.launch({ executablePath: path.join(project, "node_modules", "electron", "dist", "electron.exe"),
    args: [path.join(project, "test", "e2e", "task-progress-electron.mjs")], env });
  const page = await electron.firstWindow();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.waitForFunction(() => document.getElementById("contextStatus")?.dataset.state === "online");
  await page.locator("#mascot").dispatchEvent("dblclick");
  for (const task of proof.tasks) {
    await page.locator(`.task-link[data-task-id="${task.taskId}"]`).click();
    await page.waitForFunction(id => document.getElementById("taskConversationMessages").dataset.key === id, task.taskId);
    assert.equal(await page.locator("#taskConversationMessages > .conversation-message").count(), task.visibleItems);
    for (const id of task.preservedUserIds) assert.equal(await page.locator(`[data-message-id="${id}"]`).count(), 1);
    for (const change of task.preservedChanges) {
      if (change.resultState) assert.equal(await page.locator(`[data-message-id="checkpoint:${change.seq}"]`).count(), 1);
    }
    task.uiVisibleItems = await page.locator("#taskConversationMessages > .conversation-message").count();
    await page.locator("#detailBackButton").click();
  }
  const target = proof.tasks.find(task => task.groups.length) ?? proof.tasks[0];
  await page.locator(`.task-link[data-task-id="${target.taskId}"]`).click();
  const messages = page.locator("#taskConversationMessages > .conversation-message");
  await page.waitForFunction(() => document.querySelectorAll("#taskConversationMessages > .conversation-message").length > 0);
  const more = page.locator("#taskConversationMore");
  for (let pages = 0; await more.isVisible(); pages++) {
    assert.ok(pages < 1000, "Pagination must terminate");
    const fingerprint = await page.locator("#taskConversationMessages").getAttribute("data-fingerprint");
    await more.click();
    await page.waitForFunction(previous => document.getElementById("taskConversationMore").hidden
      || document.getElementById("taskConversationMessages").dataset.fingerprint !== previous, fingerprint);
  }
  assert.equal(await messages.count(), target.visibleItems);
  const reviews = page.locator("#taskConversationMessages .progress-review");
  assert.equal(await reviews.count(), target.groups.length);
  await page.locator(".detail-content").evaluate(element => { element.scrollTop = 0; });
  if (target.groups.length) await reviews.first().evaluate(element => element.closest("article").scrollIntoView({ block: "start" }));
  await page.screenshot({ path: path.join(output, "history-collapsed.png"), fullPage: true });
  if (target.groups.length) {
    await reviews.first().locator(":scope > summary").click();
    const count = target.groups[0].count;
    const originals = reviews.first().locator(".progress-review-original");
    await page.waitForFunction(() => document.querySelectorAll(".progress-review-original").length > 0);
    while (await originals.count() < count) {
      const previous = await originals.count();
      await reviews.first().getByRole("button", { name: "查看更多原件", exact: true }).click();
      await page.waitForFunction(n => document.querySelectorAll(".progress-review-original").length > n, previous);
    }
    assert.equal(await originals.count(), count);
    assert.equal(await originals.evaluateAll(items => new Set(items.map(item => item.dataset.eventSeq)).size), count);
    await originals.first().locator("details > summary").click();
    const raw = JSON.parse(await originals.first().locator("pre").textContent());
    assert.deepEqual(raw, sample.changes.find(row => row.seq === raw.seq));
    await reviews.first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, "history-expanded.png"), fullPage: true });
    await reviews.first().locator(":scope > summary").click();
  }
  await page.setViewportSize({ width: 360, height: 720 });
  await page.locator(".detail-content").evaluate(element => { element.scrollTop = 0; });
  if (target.groups.length) await reviews.first().evaluate(element => element.closest("article").scrollIntoView({ block: "start" }));
  await page.screenshot({ path: path.join(output, "history-compact.png"), fullPage: true });
  assert.equal(await page.locator("#taskConversationMessages").evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
  assert.deepEqual(errors, []);
  assert.equal(hash(fs.readFileSync(input)), proof.sha256);
  proof.sourceUnchanged = true;
  proof.pageErrors = errors;
  proof.screenshots = output;
  fs.writeFileSync(path.join(output, "proof.private.json"), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
} finally {
  await electron?.close();
  store.close();
  assert.equal(path.dirname(fs.realpathSync(root)), tempParent);
  fs.rmSync(root, { recursive: true, force: true });
}
