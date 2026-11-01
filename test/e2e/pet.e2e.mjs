import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "playwright";
import { openDatabase } from "../../src/db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const executablePath = path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe");
const mainPath = path.join(projectRoot, "desktop", "main.mjs");
const evidenceRoot = path.join(projectRoot, "runtime", "pet-evidence");
fs.mkdirSync(evidenceRoot, { recursive: true });
const e2eDatabase = path.join(evidenceRoot, "pet-e2e.sqlite");
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${e2eDatabase}${suffix}`, { force: true });
const e2eStore = openDatabase(e2eDatabase);
e2eStore.createConditionWatch({
  idempotencyKey: "pet-e2e-condition",
  title: "等待测试结果",
  conditionText: "测试结果已生成",
  selector: { kinds: ["shadow_agent_task_result"] },
  sessionKey: "agent:main:pet-e2e",
});
const candidateWatch = e2eStore.createConditionWatch({
  idempotencyKey: "pet-e2e-condition-candidate",
  title: "等待外部回复核对",
  conditionText: "对方明确回复联调结果",
  selector: { kinds: ["feishu_message"] },
  taskId: "pet-e2e-blocked-agent",
  sessionKey: "agent:main:pet-e2e",
});
const candidateSource = e2eStore.upsertSource({ sourceKey: "pet-e2e-candidate", kind: "test", uri: "test://pet-e2e-candidate" });
const candidateEvidence = e2eStore.addEvidence({
  sourceId: candidateSource.id,
  kind: "feishu_message",
  title: "候选回复",
  content: "我们已经处理了一部分，还需要核对是否满足原条件。",
  sourceLocator: "test://pet-e2e-candidate/reply",
});
e2eStore.updateConditionWatch(candidateWatch.id, {
  status: "candidate",
  candidateEvidenceIds: [candidateEvidence.id],
  candidateAt: new Date().toISOString(),
  lastCheckedAt: new Date().toISOString(),
});
e2eStore.setSetting("runtime:context:phase", "idle");
e2eStore.setSetting("runtime:context:detail", "E2E 上下文采集在线");
e2eStore.setSetting("runtime:context:lastHeartbeat", new Date().toISOString());
const snoozeReminder = e2eStore.createReminder({
  idempotencyKey: "pet-e2e-reminder-snooze",
  title: "核对实时提醒界面",
  message: "这是隔离数据库中的界面测试提醒",
  dueAt: new Date(Date.now() - 60_000).toISOString(),
  status: "delivered",
  sourceLocator: "test://pet-e2e",
});
e2eStore.updateReminder(snoozeReminder.id, { status: "delivered", deliveredAt: new Date().toISOString() });
const editReminder = e2eStore.createReminder({
  idempotencyKey: "pet-e2e-reminder-edit",
  title: "等待修改的提醒",
  message: "验证提醒编辑入口",
  dueAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  status: "scheduled",
  sourceLocator: "test://pet-e2e",
});
const cancelReminder = e2eStore.createReminder({
  idempotencyKey: "pet-e2e-reminder-cancel",
  title: "等待取消的提醒",
  message: "验证提醒取消入口",
  dueAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
  status: "scheduled",
  sourceLocator: "test://pet-e2e",
});
const approveOutbound = e2eStore.createOutboundDraft({
  idempotencyKey: "pet-e2e-outbound-approve",
  messageKind: "question",
  taskId: "pet-e2e-blocked-agent",
  recipientName: "示例人员29",
  recipientOpenId: "ou_pet_e2e_approve",
  content: "请确认灰度测试问题。",
  reason: "验证宠物中的修改与人工确认发送流程",
  sourceLocator: "test://pet-e2e/outbound-approve",
  reviewContext: {
    summary: "接口联调仍缺少维护人确认，Agent 建议发起询问。",
    recentMessages: [
      { direction: "incoming", senderName: "示例人员29", content: "这个接口边界你确认了吗？", occurredAt: new Date(Date.now() - 120_000).toISOString() },
      { direction: "outgoing", senderName: "Shadow Agent", content: "我先核对实现和文档。", occurredAt: new Date(Date.now() - 60_000).toISOString() },
    ],
    trigger: { direction: "incoming", senderName: "示例人员29", content: "确认后告诉我结论。", occurredAt: new Date().toISOString(), messageId: "om_pet_context" },
  },
});
const cancelOutbound = e2eStore.createOutboundDraft({
  idempotencyKey: "pet-e2e-outbound-cancel",
  messageKind: "reply",
  recipientName: "yipeng zhang",
  replyToMessageId: "om_pet_e2e_source",
  content: "这条草稿将被取消。",
  reason: "验证人工取消不会进入发送队列",
  sourceLocator: "test://pet-e2e/outbound-cancel",
});
e2eStore.close();

const app = await electron.launch({
  executablePath,
  args: [mainPath],
  cwd: projectRoot,
  env: { ...process.env, SHADOW_PET_E2E: "1", SHADOW_AGENT_DATABASE: e2eDatabase },
});

const closureStopLabels = {
  stopped: "执行已确认停止",
  not_running: "执行：未在运行",
  pending: "执行停止待确认",
  unconfirmed: "执行停止未确认",
};

async function assertTerminalClosureButtons(page) {
  for (const selector of ["#confirmDoneButton", "#terminateTaskButton"]) {
    assert.equal(await page.locator(selector).isDisabled(), true, selector);
  }
}

async function verifyNativeTaskClosure(page) {
  const operationCount = () => {
    const store = openDatabase(e2eDatabase);
    try {
      return store.db.prepare("SELECT COUNT(*) AS count FROM context_changes WHERE kind='human_agent_operation'").get().count;
    } finally { store.close(); }
  };
  await page.locator("#workHomeTab").click();
  for (const { id, queue, outcome, note } of [
    { id: "pet-e2e-blocked-user", queue: "user", outcome: "done", note: "人工验收完成\n保留关闭备注" },
    { id: "pet-e2e-blocked-agent", queue: "agent", outcome: "cancelled", note: "" },
  ]) {
    await page.locator(`#${queue}QueueTab`).click();
    await page.locator(`#queuedList [data-task-id="${id}"]`).click();
    await page.waitForFunction(() => !document.getElementById("confirmDoneButton").disabled);
    const draft = `尚未发送的任务消息：${id}`;
    await page.locator("#nextStepInput").fill(draft);
    const command = outcome === "done" ? "#confirmDoneButton" : "#terminateTaskButton";
    const before = operationCount();
    await page.locator(command).click();
    await page.evaluate(() => {
      document.getElementById("confirmDoneButton").click();
      document.getElementById("terminateTaskButton").click();
    });
    assert.equal(await page.locator("#taskClosureDialog[open]").count(), 1);
    assert.equal(await page.locator("#taskClosureDialog").getAttribute("data-card-id"), id);
    assert.equal(await page.locator("#taskClosureTaskName").textContent(), await page.locator("#detailTitle").textContent());
    assert.equal(await page.locator('#taskClosureForm input[name="outcome"]:checked').inputValue(), outcome);
    assert.equal(await page.locator("#taskClosureNote").getAttribute("maxlength"), "4000");
    await page.locator("#taskClosureNote").fill("取消后不会写入");
    await page.locator("#cancelTaskClosureButton").click();
    await page.locator(command).click();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#taskClosureDialog").isVisible(), false);
    assert.equal(operationCount(), before, "dismissing closure must not write an operation");
    assert.equal(await page.locator("#nextStepInput").inputValue(), draft);
    await page.locator(command).click();
    await page.locator("#taskClosureNote").fill(note);
    await page.locator("#confirmTaskClosureButton").click();
    await page.waitForFunction(() => !document.getElementById("taskClosureDialog").open);
    await assertTerminalClosureButtons(page);
    assert.equal(await page.locator("#nextStepInput").inputValue(), draft);
    // Verify the projected UI contract, not native Workboard move statuses.
    const details = await page.evaluate((cardId) => window.shadowPet.taskDetails(cardId), id);
    assert.equal(details.task.status, outcome);
    assert.equal(details.task.closure.outcome, outcome);
    assert.equal(details.task.closure.note, note);
    assert.equal(details.task.closure.status, "applied");
    assert.match(details.task.closure.operationId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
    assert.ok(details.task.executionStop?.status in closureStopLabels);
    assert.ok((await page.locator("#taskClosureStatus").textContent()).includes(closureStopLabels[details.task.executionStop.status]));
    assert.equal(await page.locator("#taskClosureRecordNote").textContent(), note || "无备注");
    await page.locator("#detailBackButton").click();
    const historyRow = page.locator(`#completedList [data-task-id="${id}"]`);
    await historyRow.waitFor();
    assert.match(await historyRow.textContent(), outcome === "done" ? /已完成/ : /已终止/);
    await historyRow.click();
    await page.waitForSelector("#taskClosureStatus:not([hidden])");
    await assertTerminalClosureButtons(page);
    assert.equal(await page.locator("#taskClosureRecordNote").textContent(), note || "无备注");
    await page.locator("#detailBackButton").click();
  }
}

async function verifyTaskClosureUiContract(page, verifyCompactLayout) {
  const seed = await page.evaluate(async () => ({
    snapshot: await window.shadowPet.snapshot(),
    details: await window.shadowPet.taskDetails("pet-e2e-created-task"),
  }));
  // This final suite replaces IPC handlers only in the isolated E2E process.
  // Real backend writes are tested above; these fixtures exercise UI failure/race states.
  await app.evaluate(({ ipcMain }, { snapshot, details }) => {
    const state = globalThis.__petClosureUi = { calls: [], cards: {}, stop: "not_running", queued: false };
    for (const name of ["done-empty", "done-note", "terminate-empty", "terminate-note", "queued", "retry", "stale", "other", "race", "archived"]) {
      const id = `closure-ui-${name}`;
      state.cards[id] = {
        ...structuredClone(details), operation: undefined, actions: [], evidence: [], linkedConditions: [],
        task: { ...details.task, id, title: `关闭测试 ${name}`, status: name === "archived" ? "archived" : "ready", closure: null, executionStop: null },
        conversation: { taskId: id, messages: [], before: null, hasMore: false },
        workboard: { cardId: id },
      };
    }
    const replace = (channel, handler) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler); };
    replace("pet:snapshot", () => {
      const tasks = Object.values(state.cards).map((item) => item.task);
      const completed = tasks.filter((task) => ["done", "cancelled", "archived"].includes(task.status));
      const queued = tasks.filter((task) => !completed.includes(task));
      return { ...snapshot, running: [], needsUser: [], queued, completed,
        counts: { ...snapshot.counts, queued: queued.length, needsUser: 0 } };
    });
    replace("pet:task-details", async (_event, id) => {
      const result = structuredClone(state.cards[id]);
      if (state.holdDetails === id) await new Promise((resolve) => { (state.heldReads ??= []).push(resolve); });
      return result;
    });
    replace("pet:task-conversation", (_event, id) => ({ ...state.cards[id].conversation, task: state.cards[id].task }));
    replace("pet:confirm-task-done", () => { throw new Error("UI must use closeTask"); });
    replace("pet:close-task", async (_event, id, input) => {
      state.calls.push({ id, ...input });
      if (state.failNext) { state.failNext = false; throw new Error("模拟关闭失败"); }
      if (state.holdClose) await new Promise((resolve) => { state.releaseClose = resolve; });
      const item = state.cards[id];
      item.task.closure = { ...input, status: state.queued ? "queued" : "applied" };
      item.task.executionStop = { status: state.stop, ...(state.stop === "unconfirmed" ? { error: "执行器尚未确认" } : {}) };
      if (!state.queued) item.task.status = input.outcome;
      return { ...item, operation: { queued: state.queued, executionStop: item.task.executionStop } };
    });
  }, seed);
  await page.reload();
  await page.locator("#attentionBadge").click();
  await page.locator("#agentQueueTab").click();
  const openTask = async (name) => {
    if (await page.locator("#detailView").isVisible()) await page.locator("#detailBackButton").click();
    await page.locator(`[data-task-id="closure-ui-${name}"]`).first().click();
    await page.waitForFunction((title) => document.getElementById("detailTitle").textContent === title, `关闭测试 ${name}`);
  };
  const callCount = () => app.evaluate(() => globalThis.__petClosureUi.calls.length);
  const waitForFixture = (key) => app.evaluate(async (_electron, field) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const value = globalThis.__petClosureUi[field];
      if (Array.isArray(value) ? value.length > 0 : Boolean(value)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Closure fixture timed out: ${field}`);
  }, key);
  const releaseClose = () => app.evaluate(() => {
    const state = globalThis.__petClosureUi;
    state.holdClose = false;
    const resolve = state.releaseClose;
    delete state.releaseClose;
    resolve();
  });
  const submitClosure = async (outcome, note = "") => {
    await page.locator(outcome === "done" ? "#confirmDoneButton" : "#terminateTaskButton").click();
    await page.locator("#taskClosureNote").fill(note);
    await page.locator("#confirmTaskClosureButton").click();
    await page.waitForFunction(() => !document.getElementById("taskClosureDialog").open);
  };

  for (const [name, outcome, note, stop] of [
    ["done-empty", "done", "", "not_running"],
    ["done-note", "done", "已验收\n<em>按原文保留备注</em>", "stopped"],
    ["terminate-empty", "cancelled", "", "pending"],
    ["terminate-note", "cancelled", "不再推进本任务", "unconfirmed"],
  ]) {
    await app.evaluate((_electron, value) => { globalThis.__petClosureUi.stop = value; }, stop);
    await openTask(name);
    await page.locator("#nextStepInput").fill(`保留消息 ${name}`);
    await submitClosure(outcome, note);
    await assertTerminalClosureButtons(page);
    assert.equal(await page.locator("#nextStepInput").inputValue(), `保留消息 ${name}`);
    assert.equal(await page.locator("#taskClosureRecordNote").textContent(), note || "无备注");
    assert.equal(await page.locator("#taskClosureRecordNote em").count(), 0);
    const result = await page.locator("#taskClosureStatus").textContent();
    assert.ok(result.includes(closureStopLabels[stop]));
    if (stop !== "stopped") assert.doesNotMatch(result, /执行已确认停止/);
    if (stop === "unconfirmed") assert.match(result, /执行器尚未确认/);
    const call = await app.evaluate(() => globalThis.__petClosureUi.calls.at(-1));
    assert.deepEqual({ id: call.id, outcome: call.outcome, note: call.note }, { id: `closure-ui-${name}`, outcome, note });
    assert.match(call.operationId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
  }

  await openTask("queued");
  await app.evaluate(() => { Object.assign(globalThis.__petClosureUi, { queued: true, stop: "pending" }); });
  await submitClosure("cancelled", "等待同步的终止备注");
  const queuedCalls = await app.evaluate(() => globalThis.__petClosureUi.calls.filter((call) => call.id === "closure-ui-queued"));
  assert.equal(queuedCalls.length, 1);
  assert.match(queuedCalls[0].operationId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
  const queuedClosure = {
    outcome: "cancelled", note: "等待同步的终止备注", status: "queued", operationId: queuedCalls[0].operationId,
  };
  assert.deepEqual(await page.evaluate(async () => (await window.shadowPet.taskDetails("closure-ui-queued")).task.closure), queuedClosure);
  await assertTerminalClosureButtons(page);
  assert.match(await page.locator("#taskClosureStatus").textContent(), /终止确认已保存，等待后台同步.*执行停止待确认/);
  assert.doesNotMatch(await page.locator("#detailBadges").textContent(), /已终止/);
  await page.reload();
  await page.locator("#attentionBadge").click();
  await page.locator("#agentQueueTab").click();
  await openTask("queued");
  await assertTerminalClosureButtons(page);
  assert.equal(await page.locator("#taskClosureRecordNote").textContent(), "等待同步的终止备注");
  assert.deepEqual(await page.evaluate(async () => (await window.shadowPet.taskDetails("closure-ui-queued")).task.closure), queuedClosure);
  await app.evaluate(() => {
    const state = globalThis.__petClosureUi;
    state.queued = false;
    const task = state.cards["closure-ui-queued"].task;
    task.status = "cancelled";
    task.closure.status = "applied";
    task.executionStop = { status: "stopped" };
  });
  await page.waitForFunction(() => document.getElementById("taskClosureStatus").textContent.includes("任务已终止；执行已确认停止"));
  assert.equal(await page.locator("#taskClosureRecordNote").textContent(), queuedClosure.note);
  assert.deepEqual(await page.evaluate(async () => (await window.shadowPet.taskDetails("closure-ui-queued")).task.closure), {
    ...queuedClosure, status: "applied",
  });
  assert.deepEqual(await app.evaluate(() => globalThis.__petClosureUi.calls.filter((call) => call.id === "closure-ui-queued")), queuedCalls,
    "reload and queued-to-applied refresh must retain the original closure operation without resubmitting");
  await openTask("archived");
  await assertTerminalClosureButtons(page);
  const beforeArchived = await callCount();
  await page.locator("#taskClosureForm").evaluate((form) => form.requestSubmit());
  assert.equal(await callCount(), beforeArchived);

  await openTask("retry");
  await page.locator("#nextStepInput").fill("失败后仍保留任务消息");
  await page.locator("#confirmDoneButton").click();
  await page.locator("#taskClosureCancelled").check();
  assert.equal(await page.locator("#confirmTaskClosureButton span").textContent(), "确认终止");
  const longNote = "备".repeat(4000);
  await page.locator("#taskClosureNote").fill(longNote);
  await verifyCompactLayout("pet-task-closure", ["#confirmTaskClosureButton", "#cancelTaskClosureButton"]);
  await app.evaluate(() => { globalThis.__petClosureUi.failNext = true; });
  await page.locator("#confirmTaskClosureButton").click();
  await page.waitForFunction(() => document.getElementById("taskClosureError").textContent.includes("模拟关闭失败"));
  assert.equal(await page.locator("#taskClosureNote").inputValue(), longNote);
  assert.equal(await page.locator("#nextStepInput").inputValue(), "失败后仍保留任务消息");
  await app.evaluate(() => { globalThis.__petClosureUi.holdClose = true; });
  const beforeRetry = await callCount();
  await page.locator("#confirmTaskClosureButton").click();
  await page.waitForFunction(() => document.getElementById("confirmTaskClosureButton").disabled);
  await page.locator("#taskClosureForm").evaluate((form) => { form.requestSubmit(); form.requestSubmit(); });
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#taskClosureDialog").isVisible(), true);
  assert.equal(await page.locator("#cancelTaskClosureButton").isDisabled(), true);
  assert.equal(await page.locator("#taskClosureNote").isDisabled(), true);
  await waitForFixture("releaseClose");
  assert.equal(await callCount(), beforeRetry + 1, "double submit must issue only one IPC write");
  await releaseClose();
  await page.waitForFunction(() => !document.getElementById("taskClosureDialog").open);
  const retries = await app.evaluate(() => globalThis.__petClosureUi.calls.slice(-2));
  assert.equal(retries[0].operationId, retries[1].operationId);
  assert.equal(retries[1].outcome, "cancelled");

  await openTask("stale");
  await page.locator("#confirmDoneButton").click();
  const beforeStale = await callCount();
  await app.evaluate(() => { globalThis.__petClosureUi.holdDetails = "closure-ui-stale"; });
  await page.locator("#confirmTaskClosureButton").click();
  await waitForFixture("heldReads");
  // Force navigation as an external UI event while preflight is waiting.
  await page.locator('[data-task-id="closure-ui-other"]').first().evaluate((button) => button.click());
  await page.waitForFunction(() => document.getElementById("detailTitle").textContent === "关闭测试 other");
  await app.evaluate(() => {
    const state = globalThis.__petClosureUi;
    state.holdDetails = null;
    for (const resolve of state.heldReads ?? []) resolve();
    state.heldReads = [];
  });
  await page.locator("#taskClosureForm").evaluate((form) => form.requestSubmit());
  await openTask("stale");
  await page.waitForFunction(() => !document.getElementById("confirmDoneButton").disabled);
  assert.equal(await callCount(), beforeStale, "stale selection must never confirm the previous card");
  assert.equal(await page.locator("#taskClosureDialog").isVisible(), false);
  await page.locator("#confirmDoneButton").click();
  await page.locator("#taskClosureNote").fill("外部结束后仍保留备注");
  await app.evaluate(() => { globalThis.__petClosureUi.cards["closure-ui-stale"].task.status = "archived"; });
  await page.locator("#taskClosureForm").evaluate((form) => form.requestSubmit());
  await page.waitForSelector("#taskClosureError:not([hidden])");
  await assertTerminalClosureButtons(page);
  assert.equal(await page.locator("#taskClosureNote").inputValue(), "外部结束后仍保留备注");
  assert.equal(await callCount(), beforeStale, "preflight must reject an externally closed task");
  await page.locator("#cancelTaskClosureButton").click();
  await openTask("other");
  await page.locator("#nextStepInput").fill("另一任务的草稿");

  await openTask("race");
  await page.locator("#terminateTaskButton").click();
  await app.evaluate(() => { globalThis.__petClosureUi.holdClose = true; });
  await page.locator("#confirmTaskClosureButton").click();
  await waitForFixture("releaseClose");
  await page.locator('[data-task-id="closure-ui-other"]').first().evaluate((button) => button.click());
  await page.waitForFunction(() => document.getElementById("detailTitle").textContent === "关闭测试 other");
  await releaseClose();
  await page.locator('#completedList [data-task-id="closure-ui-race"]').waitFor({ state: "attached" });
  assert.equal(await page.locator("#detailTitle").textContent(), "关闭测试 other");
  assert.equal(await page.locator("#nextStepInput").inputValue(), "另一任务的草稿");
  assert.equal(await page.locator("#confirmDoneButton").isDisabled(), false);
  assert.equal(await page.locator("#taskClosureStatus").isVisible(), false);
  await openTask("terminate-note");
  await assertTerminalClosureButtons(page);
  assert.match(await page.locator("#detailBadges").textContent(), /已终止/);
  assert.equal(await page.locator("#taskClosureRecordNote").textContent(), "不再推进本任务");
}

try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector("#attentionBadge");
  await page.waitForTimeout(800);
  assert.equal(await page.locator("#pet").getAttribute("data-expanded"), "false");

  const hitAudit = {};
  const hitTarget = async (selector) => page.locator(selector).evaluate((element, requestedSelector) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      selector: requestedSelector,
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      hitId: hit?.id || null,
      hitButtonId: hit?.closest("button")?.id || null,
      hitButtonClass: hit?.closest("button")?.className || null,
    };
  }, selector);
  const verifyCompactLayout = async (name, selectors) => {
    const previous = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setResizable(true);
      win.setSize(360, 620);
    });
    await page.waitForFunction(() => window.innerWidth <= 361 && window.innerHeight <= 621);
    const layout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight }));
    assert.ok(layout.scrollWidth <= layout.width && layout.scrollHeight <= layout.height, JSON.stringify(layout));
    for (const selector of selectors) {
      const hit = await hitTarget(selector);
      assert.equal(hit.hitButtonId, selector.slice(1), `${name}: ${selector} is obstructed`);
      hitAudit[`${name}:${selector}`] = hit;
    }
    await page.screenshot({ path: path.join(evidenceRoot, `${name}-compact.png`), omitBackground: true });
    await app.evaluate(({ BrowserWindow }, bounds) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setBounds(bounds);
      win.setResizable(false);
    }, previous);
  };

  hitAudit.attentionBadge = await hitTarget("#attentionBadge");
  assert.equal(hitAudit.attentionBadge.hitButtonId, "attentionBadge");
  await page.locator("#attentionBadge").click();
  await page.waitForFunction(() => document.getElementById("pet")?.dataset.expanded === "true");
  assert.equal(await page.locator("#serviceStatus .service-status-item").count(), 3);
  for (const selector of ["#openclawStatus", "#contextStatus", "#feishuStatus"]) {
    assert.match(await page.locator(selector).getAttribute("data-state"), /online|warning|error/);
    assert.ok((await page.locator(selector).getAttribute("title")).length > 3);
  }
  await page.waitForFunction(() => document.getElementById("trackingCount")?.textContent === "1");
  assert.equal(await page.locator("#trackingTitle").textContent(), "持续跟踪");
  assert.match(await page.locator("#trackingDetail").textContent(), /1 项正在等待外部变化/);
  hitAudit.trackingStrip = await hitTarget("#trackingStrip");
  assert.equal(hitAudit.trackingStrip.hitButtonId, "trackingStrip");
  await page.locator("#trackingStrip").click();
  await page.waitForFunction(() => !document.getElementById("trackingView")?.hidden);
  assert.equal(await page.locator("#trackingStrip").getAttribute("aria-expanded"), "true");
  assert.match(await page.locator("#trackingViewList").textContent(), /等待测试结果/);
  assert.match(await page.locator("#trackingViewList").textContent(), /测试结果已生成/);
  assert.match(await page.locator("#trackingViewList").textContent(), /等待中/);
  assert.doesNotMatch(await page.locator("#trackingViewList").textContent(), /还需要核对是否满足原条件/);
  hitAudit.trackingBack = await hitTarget("#trackingBackButton");
  assert.equal(hitAudit.trackingBack.hitButtonId, "trackingBackButton");
  await page.screenshot({ path: path.join(evidenceRoot, "pet-e2e-tracking.png"), omitBackground: true });
  await page.locator("#trackingBackButton").click();
  await page.waitForFunction(() => document.getElementById("trackingView")?.hidden);
  assert.equal(await page.locator("#trackingStrip").getAttribute("aria-expanded"), "false");
  await page.waitForTimeout(300);
  const expandedBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  assert.ok(expandedBounds.width >= 390 && expandedBounds.height >= 680);

  await page.waitForFunction(() => document.getElementById("outboundCount")?.textContent === "2");
  const approveRow = page.locator(`[data-outbound-id="${approveOutbound.id}"]`);
  await approveRow.click();
  await page.waitForFunction(() => !document.getElementById("outboundConfirmView")?.hidden);
  assert.equal((await page.locator("#outboundRecipient").textContent()).trim(), "示例人员29");
  assert.match(await page.locator("#outboundContextSummary").textContent(), /接口联调/);
  assert.match(await page.locator("#outboundContextMessages").textContent(), /这个接口边界你确认了吗/);
  assert.match(await page.locator("#outboundContextMessages").textContent(), /触发消息.*确认后告诉我结论/s);
  assert.match(await page.locator("#outboundReason").textContent(), /验证宠物/);
  await page.locator("#outboundEditor").fill("请确认修改后的灰度测试问题。");
  hitAudit.approveOutbound = await hitTarget("#approveOutboundButton");
  assert.equal(hitAudit.approveOutbound.hitButtonId, "approveOutboundButton");
  await page.screenshot({ path: path.join(evidenceRoot, "pet-e2e-outbound-confirm.png"), omitBackground: true });
  await page.locator("#approveOutboundButton").click();
  await page.waitForFunction((id) => !document.querySelector(`[data-outbound-id="${id}"]`), approveOutbound.id);
  const approvalStore = openDatabase(e2eDatabase);
  let approvedBeforeClosure;
  let approvedSendBeforeClosure;
  try {
    approvedBeforeClosure = approvalStore.outboundDraft(approveOutbound.id);
    assert.equal(approvedBeforeClosure.status, "approved");
    assert.equal(approvedBeforeClosure.approved_content, "请确认修改后的灰度测试问题。");
    assert.ok(approvedBeforeClosure.approved_at);
    assert.ok(JSON.parse(approvedBeforeClosure.metadata_json).audit.some((entry) => entry.event === "approved_by_user" && entry.edited));
    const sends = approvalStore.db.prepare("SELECT id, status, idempotency_key, payload_json FROM controller_outbox WHERE action_type='send_feishu_message'").all();
    assert.equal(sends.length, 1);
    [approvedSendBeforeClosure] = sends;
    assert.equal(approvedSendBeforeClosure.status, "pending");
    assert.deepEqual(JSON.parse(approvedSendBeforeClosure.payload_json), { draftId: approveOutbound.id, revision: approvedBeforeClosure.revision });
  } finally { approvalStore.close(); }

  const cancelOutboundRow = page.locator(`[data-outbound-id="${cancelOutbound.id}"]`);
  await cancelOutboundRow.click();
  await page.waitForFunction(() => !document.getElementById("outboundConfirmView")?.hidden);
  hitAudit.cancelOutbound = await hitTarget("#cancelOutboundButton");
  assert.equal(hitAudit.cancelOutbound.hitButtonId, "cancelOutboundButton");
  await page.locator("#cancelOutboundButton").click();
  await page.waitForFunction(() => !document.getElementById("outboundRejectComposer")?.hidden);
  assert.equal(await page.locator("#outboundConfirmActions").isHidden(), true);
  await page.locator("#outboundRejectComposer").evaluate((form) => form.requestSubmit());
  assert.match(await page.locator("#outboundActionStatus").textContent(), /请填写拒绝原因/);
  await page.locator("#outboundRejectReason").fill("这条消息没有实际结论，不应发送给对方。");
  hitAudit.confirmOutboundReject = await hitTarget("#confirmOutboundRejectButton");
  assert.equal(hitAudit.confirmOutboundReject.hitButtonId, "confirmOutboundRejectButton");
  await page.screenshot({ path: path.join(evidenceRoot, "pet-e2e-outbound-reject.png"), omitBackground: true });
  await page.locator("#outboundRejectComposer").evaluate((form) => form.requestSubmit());
  await page.waitForFunction(() => document.getElementById("outboundSection")?.hidden === true);
  const rejectionStore = openDatabase(e2eDatabase);
  let rejectedBeforeClosure;
  try {
    rejectedBeforeClosure = rejectionStore.outboundDraft(cancelOutbound.id);
    assert.equal(rejectedBeforeClosure.status, "cancelled");
    assert.equal(rejectedBeforeClosure.task_id, null);
  } finally { rejectionStore.close(); }

  assert.equal(await page.locator(".manual-mode-tab").count(), 0);
  await page.locator("#mainConversationTab").click();
  assert.match(await page.locator("#manualInput").getAttribute("placeholder"), /交代一件事/);
  await page.locator("#manualInput").fill("请创建一个任务：核对 E2E 发布证据范围");
  await page.locator("#manualInputForm").evaluate((form) => form.requestSubmit());
  await page.waitForSelector('#manualReceipt[data-state="success"]');
  assert.match(await page.locator("#manualReceipt").textContent(), /已进入任务卡.*E2E 用户交代的任务/);
  await page.locator("#manualInput").fill("E2E 查询当前工作状态");
  await page.locator("#manualInputForm").evaluate((form) => form.requestSubmit());
  await page.waitForSelector('#manualReceipt[data-state="pending"]');
  await page.waitForSelector('#manualReceipt[data-state="success"]');
  assert.match(await page.locator("#manualReceipt").textContent(), /Agent 已回复/);
  await page.waitForSelector('#mainConversationMessages .task-link');
  assert.match(await page.locator("#mainConversationMessages").textContent(), /请创建一个任务/);
  assert.match(await page.locator("#mainConversationMessages").textContent(), /E2E 查询当前工作状态/);
  await page.locator('#mainConversationMessages .task-link').first().click();
  await page.waitForFunction(() => document.getElementById("detailTitle")?.textContent === "E2E 用户交代的任务");
  assert.equal(await page.locator('[data-tab="conversation"]').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#nextStepComposer').isVisible(), true);
  await page.locator('#nextStepInput').fill('这个草稿只属于任务 A');
  await page.locator('#detailBackButton').click();
  assert.equal(await page.locator('#mainConversationView').isVisible(), true);
  await page.locator('#mainConversationMessages .task-link').first().click();
  await page.waitForFunction(() => document.getElementById("detailTitle")?.textContent === "E2E 用户交代的任务");
  assert.equal(await page.locator('#nextStepInput').inputValue(), '这个草稿只属于任务 A');
  await page.locator('#nextStepInput').fill('请把文档验收项列出来');
  await page.locator('#saveNextStepButton').click();
  await page.waitForFunction(() => document.getElementById('taskConversationMessages')?.textContent.includes('请把文档验收项列出来'));
  assert.equal(await page.locator('#nextStepComposer').isVisible(), true);
  const replyStore = openDatabase(e2eDatabase);
  try {
    const event = replyStore.db.prepare("SELECT seq, metadata_json FROM context_changes WHERE json_extract(metadata_json,'$.userText')=?").get('请把文档验收项列出来');
    assert.ok(event);
    replyStore.db.prepare("UPDATE context_changes SET metadata_json=?,status='consumed' WHERE seq=?").run(JSON.stringify({ ...JSON.parse(event.metadata_json),
      taskCheckpoint: { resultSummary: '已整理验收项：\n\n1. 明确目标范围\n2. 验证结果与证据\n3. 记录未完成项', recordedAt: new Date().toISOString() } }), event.seq);
  } finally { replyStore.close(); }
  await page.waitForFunction(() => document.getElementById('taskConversationMessages')?.textContent.includes('已整理验收项'));
  assert.equal(await page.locator('#taskConversationMessages [data-role="assistant"] ol li').count(), 3);
  await verifyCompactLayout('pet-task-conversation', ['#saveNextStepButton', '#confirmDoneButton', '#terminateTaskButton', '#detailBackButton']);
  await page.screenshot({ path: path.join(evidenceRoot, 'pet-task-conversation.png'), omitBackground: true });
  await page.locator('#detailBackButton').click();
  assert.doesNotMatch(await page.locator('#mainConversationMessages').textContent(), /请把文档验收项列出来/);
  await page.screenshot({ path: path.join(evidenceRoot, "pet-e2e-manual-input.png"), omitBackground: true });
  await page.locator("#manualInput").fill("__E2E_ERROR__");
  await page.locator("#manualInputForm").evaluate((form) => form.requestSubmit());
  await page.waitForFunction(() => /已保留并自动重试/.test(document.getElementById("manualReceipt")?.textContent || ""));
  assert.match(await page.locator("#manualReceipt").textContent(), /已保留并自动重试/);
  await page.reload();
  await page.locator('#attentionBadge').click();
  await page.locator('#mainConversationTab').click();
  await page.waitForFunction(() => document.getElementById('mainConversationMessages')?.textContent.includes('E2E 查询当前工作状态'));
  await verifyCompactLayout('pet-main-conversation', ['#manualSubmitButton', '#workHomeTab', '#closeButton']);
  await page.screenshot({ path: path.join(evidenceRoot, 'pet-main-conversation.png'), omitBackground: true });
  await page.locator('#workHomeTab').click();

  await page.waitForSelector("#reminderList .reminder-row");
  assert.equal(await page.locator("#reminderCount").textContent(), "3");
  assert.match(await page.locator("#reminderList").textContent(), /核对实时提醒界面/);
  const snoozeRow = page.locator(`[data-reminder-id="${snoozeReminder.id}"]`);
  await snoozeRow.getByRole("button", { name: "延后", exact: true }).click();
  await snoozeRow.locator('.snooze-form input[name="minutes"]').fill("17");
  await snoozeRow.locator('.snooze-form [type="submit"]').click();
  await page.waitForFunction((id) => document.querySelector(`[data-reminder-id="${id}"] .reminder-time`)?.textContent !== "已到期", snoozeReminder.id);

  const editRow = page.locator(`[data-reminder-id="${editReminder.id}"]`);
  await editRow.locator('[aria-label="修改提醒"]').click();
  await editRow.locator('.edit-form input[name="title"]').fill("提醒已通过界面修改");
  await editRow.locator('.edit-form [type="submit"]').click();
  await page.waitForFunction((id) => document.querySelector(`[data-reminder-id="${id}"]`)?.textContent.includes("提醒已通过界面修改"), editReminder.id);

  const cancelRow = page.locator(`[data-reminder-id="${cancelReminder.id}"]`);
  await cancelRow.locator('[aria-label="取消提醒"]').click();
  await page.waitForFunction((id) => !document.querySelector(`[data-reminder-id="${id}"]`), cancelReminder.id);
  hitAudit.reminderAcknowledge = await hitTarget(`[data-reminder-id="${editReminder.id}"] .reminder-actions > .reminder-action.primary`);
  assert.match(hitAudit.reminderAcknowledge.hitButtonClass, /reminder-action/);
  await page.screenshot({ path: path.join(evidenceRoot, "pet-e2e-reminder.png"), omitBackground: true });
  await page.locator(`[data-reminder-id="${editReminder.id}"] .reminder-actions > .reminder-action.primary`).click();
  await page.waitForFunction((id) => !document.querySelector(`[data-reminder-id="${id}"]`), editReminder.id);

  for (const selector of ["#historyButton", "#pinButton", "#collapseButton", "#closeButton"]) {
    hitAudit[selector] = await hitTarget(selector);
    assert.equal(hitAudit[selector].hitButtonId, selector.slice(1), `${selector} is obstructed`);
  }
  await page.locator("#pinButton").click();
  await page.waitForFunction(() => !document.getElementById("pinButton")?.classList.contains("is-active"));
  await page.locator("#pinButton").click();
  await page.waitForFunction(() => document.getElementById("pinButton")?.classList.contains("is-active"));

  await page.locator("#historyButton").click();
  await page.waitForFunction(() => !document.getElementById("historyView")?.hidden);
  const firstSession = page.locator("#historyList .session-row").first();
  await firstSession.waitFor();
  assert.ok((await page.locator("#historyCount").textContent()).includes("记录"));
  await firstSession.click();
  await page.waitForFunction(() => !document.getElementById("historyDetailPane")?.hidden);
  assert.equal(await page.locator("#historyListPane").isHidden(), true);
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".mascot-zone")).opacity) < 0.01);
  assert.ok(Number(await page.locator(".mascot-zone").evaluate((element) => getComputedStyle(element).opacity)) < 0.01);
  await page.waitForSelector("#sessionMessages .detail-block");
  assert.ok((await page.locator("#sessionTitle").textContent()).trim().length > 1);
  assert.ok(await page.locator("#sessionMessages .session-message, #sessionMessages .detail-block").count());
  await page.screenshot({ path: path.join(evidenceRoot, "pet-e2e-agent-history.png"), omitBackground: true });
  await page.locator("#historyBackButton").click();
  assert.equal(await page.locator("#historyListPane").isVisible(), true);
  await page.locator("#historyBackButton").click();
  assert.equal(await page.locator("#historyView").isHidden(), true);

  await page.locator("#userQueueTab").click();
  assert.equal(await page.locator("#userQueueTab").getAttribute("aria-selected"), "true");
  const userQueueRows = await page.locator("#queuedList .task-row.needs-user").count();
  const userQueueTotal = Number(await page.locator("#userActionCount").textContent());
  assert.equal(userQueueTotal, userQueueRows, "User queue must expose every counted task");
  assert.match(await page.locator("#queuedList").textContent(), /等待人工授权的阻塞事项/);
  assert.doesNotMatch(await page.locator("#queuedList").textContent(), /等待外部构建完成的阻塞事项/);
  await page.locator("#agentQueueTab").click();
  assert.equal(await page.locator("#agentQueueTab").getAttribute("aria-selected"), "true");
  const agentQueueRows = await page.locator("#queuedList .task-row.agent-queue").count();
  const agentQueueTotal = Number(await page.locator("#queuedCount").textContent());
  assert.equal(agentQueueTotal, agentQueueRows, "Agent queue must expose every counted task");
  assert.match(await page.locator("#queuedList").textContent(), /等待外部构建完成的阻塞事项/);
  assert.match(await page.locator("#queuedList").textContent(), /等待 Agent 重新规划/);
  assert.doesNotMatch(await page.locator("#queuedList").textContent(), /等待人工授权的阻塞事项/);
  const completedDotContent = await page.locator("#completedList .task-row.completed .task-dot").first()
    .evaluate((element) => getComputedStyle(element, "::after").content);
  assert.match(completedDotContent, /✓/);

  const firstTask = page.locator('#queuedList [data-task-id="pet-e2e-blocked-agent"]');
  await firstTask.scrollIntoViewIfNeeded();
  await firstTask.waitFor();
  hitAudit.firstTask = await firstTask.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { hitTag: hit?.tagName, hitTaskId: hit?.closest("button")?.dataset.taskId || null };
  });
  assert.ok(hitAudit.firstTask.hitTaskId);
  await firstTask.click();
  await page.waitForFunction(() => document.getElementById("pet")?.dataset.detail === "true");
  await page.waitForFunction(() => !document.getElementById("detailTitle")?.textContent.includes("加载"));
  assert.ok((await page.locator("#detailTitle").textContent()).trim().length > 2);
  assert.match(await page.locator("#detailOverview").textContent(), /关联跟踪/);
  assert.match(await page.locator("#detailOverview").textContent(), /已发现候选信息，等待 Agent 核对/);
  assert.match(await page.locator("#detailOverview").textContent(), /还需要核对是否满足原条件/);
  for (const selector of ["#confirmDoneButton", "#terminateTaskButton", "#saveNextStepButton"]) {
    hitAudit[selector] = await hitTarget(selector);
    assert.equal(hitAudit[selector].hitButtonId, selector.slice(1), `${selector} is obstructed`);
  }
  assert.ok(await page.locator("#detailOverview .markdown-body").count(), "overview should render Markdown content");
  assert.equal(await page.locator("#nextStepComposer").isVisible(), true);
  assert.equal(await page.locator("#nextStepInput").inputValue(), "");
  await page.locator("#nextStepInput").fill("该事项不属于我的职责，后续不要跟进");
  await page.locator("#nextStepComposer").evaluate((form) => form.requestSubmit());
  await page.waitForFunction(() => /消息已送达|消息已保存/.test(document.getElementById("detailActionStatus")?.textContent || ""));
  assert.equal(await page.locator("#nextStepComposer").isVisible(), true);
  assert.doesNotMatch(await page.locator("#detailBadges").textContent(), /已完成/);
  assert.equal(await page.locator("#confirmDoneButton").isDisabled(), false);

  await page.locator('[data-tab="execution"]').click();
  assert.equal(await page.locator("#detailExecution").isVisible(), true);
  assert.ok((await page.locator("#detailExecution").textContent()).trim().length > 8);
  assert.match(await page.locator("#detailExecution").textContent(), /知识库处理/);
  assert.match(await page.locator("#detailExecution").textContent(), /原始反馈已收录，等待 Codex 语义复核/);
  assert.match(await page.locator("#detailExecution").textContent(), /用户在任务卡片中继续交代/);
  await page.screenshot({ path: path.join(evidenceRoot, "pet-e2e-execution.png"), omitBackground: true });
  await page.locator('[data-tab="evidence"]').click();
  assert.equal(await page.locator("#detailEvidence").isVisible(), true);
  assert.ok((await page.locator("#detailEvidence").textContent()).trim().length > 8);
  assert.match(await page.locator("#detailEvidence").textContent(), /用户继续交代任务/);
  const firstEvidence = page.locator("#detailEvidence .evidence-item").first();
  if (await firstEvidence.count()) {
    await firstEvidence.locator("summary").click();
    assert.equal(await firstEvidence.locator(".evidence-body").isVisible(), true);
  }
  await page.screenshot({ path: path.join(evidenceRoot, "pet-e2e-detail.png"), omitBackground: true });

  await page.locator("#detailBackButton").click();
  assert.equal(await page.locator("#detailView").isHidden(), true);
  const completedTask = page.locator("#completedList .task-row").first();
  if (await completedTask.count()) {
    await completedTask.click();
    await page.waitForFunction(() => document.getElementById("pet")?.dataset.detail === "true");
    await page.waitForFunction(() => !document.getElementById("detailTitle")?.textContent.includes("加载"));
    await page.locator('[data-tab="execution"]').click();
    assert.match(await page.locator("#detailExecution").textContent(), /OpenClaw|Workboard|尚未执行/);
    assert.ok(await page.locator("#detailExecution .markdown-body").count(), "execution result should render Markdown");
    await page.screenshot({ path: path.join(evidenceRoot, "pet-e2e-completed-execution.png"), omitBackground: true });
    await page.locator("#detailBackButton").click();
  }
  await page.screenshot({ path: path.join(evidenceRoot, "pet-e2e-expanded.png"), omitBackground: true });

  await page.locator("#collapseButton").click();
  await page.waitForFunction(() => document.getElementById("pet")?.dataset.expanded === "false");
  await page.locator("#mascot").dblclick({ position: { x: 96, y: 104 } });
  await page.waitForFunction(() => document.getElementById("pet")?.dataset.expanded === "true");
  await page.screenshot({ path: path.join(evidenceRoot, "pet-e2e-collapsed-click-result.png"), omitBackground: true });

  const layout = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  assert.ok(layout.scrollWidth <= layout.width && layout.scrollHeight <= layout.height, JSON.stringify(layout));
  fs.writeFileSync(path.join(evidenceRoot, "pet-e2e-click-audit.json"), JSON.stringify({ hitAudit, layout }, null, 2), "utf8");

  await page.locator("#closeButton").click();
  await page.waitForTimeout(200);
  const hiddenWindowState = await app.evaluate(({ BrowserWindow }) => ({
    count: BrowserWindow.getAllWindows().length,
    visible: BrowserWindow.getAllWindows()[0]?.isVisible() ?? false,
  }));
  assert.deepEqual(hiddenWindowState, { count: 1, visible: false }, "X should hide the pet without exiting");
  const visibleAfterSecondLaunch = await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    electronApp.emit("second-instance", {}, [], "");
    return BrowserWindow.getAllWindows()[0]?.isVisible() ?? false;
  });
  assert.equal(visibleAfterSecondLaunch, true, "a second launch should restore the hidden pet");
  await verifyNativeTaskClosure(page);
  await verifyTaskClosureUiContract(page, verifyCompactLayout);
  fs.writeFileSync(path.join(evidenceRoot, "pet-e2e-click-audit.json"), JSON.stringify({ hitAudit, layout }, null, 2), "utf8");
  await app.close();
  const verificationStore = openDatabase(e2eDatabase);
  try {
    const retired = verificationStore.outboundDraft(approveOutbound.id);
    assert.equal(retired.status, "cancelled", "closing the task retires its approved but unsent draft");
    assert.equal(retired.approved_content, "请确认修改后的灰度测试问题。");
    assert.equal(retired.approved_at, approvedBeforeClosure.approved_at);
    assert.equal(retired.metadata_json, approvedBeforeClosure.metadata_json, "task cleanup must retain the approval audit");
    const closureRow = verificationStore.db.prepare(`SELECT metadata_json FROM context_changes
      WHERE kind='human_agent_operation' AND json_extract(metadata_json, '$.taskId')=?
        AND json_extract(metadata_json, '$.closure.outcome')='cancelled' ORDER BY seq DESC LIMIT 1`).get(approvedBeforeClosure.task_id);
    assert.ok(closureRow);
    const closureOperation = JSON.parse(closureRow.metadata_json);
    assert.equal(closureOperation.appliedStatus, "applied");
    assert.equal(retired.last_error, `Task closed: ${closureOperation.operationId}`);
    assert.ok(retired.cancelled_at);
    const sends = verificationStore.db.prepare("SELECT id, status, idempotency_key, payload_json FROM controller_outbox WHERE action_type='send_feishu_message'").all();
    assert.deepEqual(sends.map((row) => ({ ...row })), [{ ...approvedSendBeforeClosure, status: "cancelled" }], "only the original task-bound send is retired");
    const rejected = verificationStore.outboundDraft(cancelOutbound.id);
    assert.deepEqual(rejected, rejectedBeforeClosure, "closing another task must not alter the unrelated rejected draft");
    assert.equal(rejected.status, "cancelled");
    assert.equal(JSON.parse(rejected.metadata_json).audit.at(-1).reason, "这条消息没有实际结论，不应发送给对方。");
    assert.equal(verificationStore.db.prepare("SELECT COUNT(*) AS count FROM controller_outbox WHERE action_type='send_feishu_message' AND status='pending'").get().count, 0);
    const learned = verificationStore.db.prepare("SELECT title, content, metadata_json FROM evidence WHERE kind='manual_knowledge'").all();
    assert.ok(learned.some((item) => item.title.includes("用户直接告诉 Agent") && item.content.includes("核对 E2E 发布证据范围")));
    assert.ok(verificationStore.db.prepare("SELECT 1 FROM direct_input_receipts WHERE status='retry' AND last_error LIKE '%Gateway 离线%'").get());
    assert.ok(learned.some((item) => item.title.includes("用户修改并批准") && item.content.includes("原始草稿") && item.content.includes("修改稿")));
    assert.ok(learned.some((item) => item.title.includes("用户拒绝飞书消息") && item.content.includes("没有实际结论")));
    assert.ok(learned.some((item) => item.title.includes("用户继续交代任务") && item.content.includes("不属于我的职责")));
    assert.ok(verificationStore.db.prepare("SELECT 1 FROM context_changes WHERE kind='human_agent_operation' AND json_extract(metadata_json, '$.desiredEffect')='interpret_task_message'").get());
  } finally {
    verificationStore.close();
  }
  process.stdout.write(`${JSON.stringify({ ok: true, hitAudit, layout }, null, 2)}\n`);
} catch (error) {
  try {
    const page = await app.firstWindow();
    await page.screenshot({ path: path.join(evidenceRoot, "pet-e2e-failure.png") });
    process.stderr.write(`${await page.locator('body').innerText()}\n`);
  } catch { /* window may already be closed */ }
  try { await app.close(); } catch { /* already closed */ }
  throw error;
}
