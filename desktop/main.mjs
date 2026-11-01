import { operationDeliveryActions } from "../src/operation-delivery-view.mjs";
import { recordTaskClosure, taskClosureView } from '../src/task-closure.mjs';
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  Tray,
} from "electron";

import { loadConfig } from "../src/config.mjs";
import { createVoiceWindowController } from "./voice-window.mjs";
import {
  ATTENTION_SCHEDULE_SETTING_KEY,
  attentionScheduleStatus,
  normalizeAttentionSchedule,
  readAttentionSchedule,
} from "../src/attention-window.mjs";
import { materializeContextGraph } from "../src/context-graph.mjs";
import { openDatabase } from "../src/db.mjs";
import { mainConversationPage, taskConversationPage } from "../src/pet-conversations.mjs";
import {
  DIRECT_INPUT_SESSION_KEY,
  enqueueDirectInputRequest,
  ensureDirectInputSession,
} from "../src/direct-input.mjs";
import { feishuCapabilitySnapshot } from "../src/feishu-capabilities.mjs";
import {
  loadOpenClawGatewaySettings,
  OpenClawGatewayClient,
} from "../src/openclaw/gateway-client.mjs";
import { captureKnowledgeEpisode } from "../openclaw/shadow-work/src/epistemic.js";
import {
  markAgentOperationEffectApplied,
  recordAgentOperation,
  resolveTaskOwnerSession,
} from "../src/agent-operations.mjs";
import { applyWorkboardOperation } from "../src/workboard-operations.mjs";
import { readWorkboardProjection } from "../src/workboard-reader.mjs";
import { ACTIVE_TASK_STATUSES, classifyTaskHandling, parseTaskJson } from "../src/task-handling.mjs";
import {
  cancelReminder,
  snoozeReminder,
  updateReminder as updateScheduledReminder,
} from "../src/reminders.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COLLAPSED_SIZE = { width: 270, height: 310 };
const EXPANDED_SIZE = { width: 392, height: 700 };
const E2E_MODE = process.env.SHADOW_PET_E2E === "1";
const execFileAsync = promisify(execFile);

if (!E2E_MODE && !app.requestSingleInstanceLock()) app.quit();

let window = null;
let settingsWindow = null;
let voiceWindow = null;
let tray = null;
let isQuitting = false;
let store = null;
let expanded = false;
let moveTimer = null;
let projectRoot = null;
let gatewayClient = null;
let gatewayRefreshTimer = null;
let workboardCards = [];
let appConfig = null;
let shutdownInProgress = false;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function feedbackExternalId(action, targetId, content) {
  return `pet-feedback:${createHash("sha256")
    .update(`${action}\n${targetId}\n${content}`, "utf8")
    .digest("hex")}`;
}

function capturePetKnowledgeEpisode(input, options = {}) {
  const content = String(input.content ?? input.text ?? "").trim();
  return captureKnowledgeEpisode(store.db, {
    ...input,
    content,
    feedbackSource: "pet-ui",
    generatedBy: "shadow-pet",
    externalId: input.externalId ?? feedbackExternalId(input.action, input.targetId, content),
    metadata: {
      ...(input.metadata ?? {}),
      humanFeedback: {
        ...(input.metadata?.humanFeedback ?? {}),
        operationRequested: true,
      },
    },
  }, options);
}

function reviewContextAsText(context = {}) {
  const lines = [];
  if (context.summary) lines.push(`上下文摘要：\n${context.summary}`);
  const recent = Array.isArray(context.recentMessages) ? context.recentMessages.slice(-8) : [];
  if (recent.length) {
    lines.push(`最近对话：\n${recent.map((message) => {
      const speaker = message.senderName || message.sender_name || message.role || "未知发送者";
      return `${speaker}：${message.content || ""}`;
    }).join("\n")}`);
  }
  if (context.trigger?.content) {
    const speaker = context.trigger.senderName || context.trigger.sender_name || context.trigger.role || "触发消息";
    lines.push(`触发消息：\n${speaker}：${context.trigger.content}`);
  }
  return lines.join("\n\n");
}

async function captureDiagnostics() {
  if (!window || !process.argv.includes("--capture-preview")) return;
  const evidenceRoot = path.join(projectRoot, "runtime", "pet-evidence");
  fs.mkdirSync(evidenceRoot, { recursive: true });
  await delay(500);
  const diagnostics = await window.webContents.executeJavaScript(`({
    readyState: document.readyState,
    title: document.title,
    bodyText: document.body.innerText,
    bodySize: { width: document.body.clientWidth, height: document.body.clientHeight },
    mascotSize: (() => { const r = document.getElementById('mascot')?.getBoundingClientRect(); return r ? { width: r.width, height: r.height } : null; })(),
    expanded: document.getElementById('pet')?.dataset.expanded,
  })`);
  fs.writeFileSync(path.join(evidenceRoot, "pet-diagnostic.json"), JSON.stringify(diagnostics, null, 2), "utf8");
  const collapsed = await window.webContents.capturePage();
  fs.writeFileSync(path.join(evidenceRoot, "pet-collapsed.png"), collapsed.toPNG());
  resizePet(true);
  await delay(500);
  const expandedImage = await window.webContents.capturePage();
  fs.writeFileSync(path.join(evidenceRoot, "pet-expanded.png"), expandedImage.toPNG());
  resizePet(false);
}

function numberSetting(key) {
  const value = Number(store.getSetting(key, ""));
  return Number.isFinite(value) ? value : null;
}

function desiredBounds(size) {
  const savedX = numberSetting("runtime:pet:x");
  const savedY = numberSetting("runtime:pet:y");
  const targetDisplay = savedX === null
    ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    : screen.getDisplayMatching({ x: savedX, y: savedY ?? 0, width: size.width, height: size.height });
  const area = targetDisplay.workArea;
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height - 24);
  return {
    width,
    height,
    x: savedX === null ? area.x + area.width - width - 18 : Math.max(area.x, Math.min(savedX, area.x + area.width - width)),
    y: savedY === null ? area.y + Math.round((area.height - height) / 2) : Math.max(area.y, Math.min(savedY, area.y + area.height - height)),
  };
}

function resizePet(nextExpanded) {
  if (!window) return;
  expanded = Boolean(nextExpanded);
  const previous = window.getBounds();
  const display = screen.getDisplayMatching(previous);
  const requested = expanded ? EXPANDED_SIZE : COLLAPSED_SIZE;
  const width = Math.min(requested.width, display.workArea.width);
  const height = Math.min(requested.height, display.workArea.height - 24);
  const right = previous.x + previous.width;
  const x = Math.max(display.workArea.x, Math.min(right - width, display.workArea.x + display.workArea.width - width));
  const y = Math.max(display.workArea.y, Math.min(previous.y, display.workArea.y + display.workArea.height - height));
  window.setBounds({ x, y, width, height }, true);
  window.webContents.send("pet:expanded", expanded);
}

function createTrayIcon() {
  const logicalSize = 16;
  const scaleFactor = 2;
  const pixelSize = logicalSize * scaleFactor;
  const bitmap = Buffer.alloc(pixelSize * pixelSize * 4);
  const colors = {
    dark: { r: 22, g: 35, b: 31, a: 255 },
    face: { r: 242, g: 247, b: 244, a: 255 },
    mint: { r: 50, g: 201, b: 153, a: 255 },
  };
  const fillRect = (x, y, width, height, color) => {
    for (let py = y * scaleFactor; py < (y + height) * scaleFactor; py += 1) {
      for (let px = x * scaleFactor; px < (x + width) * scaleFactor; px += 1) {
        const offset = (py * pixelSize + px) * 4;
        bitmap[offset] = color.b;
        bitmap[offset + 1] = color.g;
        bitmap[offset + 2] = color.r;
        bitmap[offset + 3] = color.a;
      }
    }
  };

  fillRect(7, 0, 2, 2, colors.mint);
  fillRect(7, 2, 2, 1, colors.dark);
  fillRect(3, 3, 10, 10, colors.dark);
  fillRect(4, 5, 8, 5, colors.face);
  fillRect(5, 6, 2, 2, colors.dark);
  fillRect(9, 6, 2, 2, colors.dark);
  fillRect(7, 9, 2, 1, colors.mint);
  fillRect(4, 13, 3, 2, colors.dark);
  fillRect(9, 13, 3, 2, colors.dark);

  return nativeImage.createFromBitmap(bitmap, {
    width: pixelSize,
    height: pixelSize,
    scaleFactor,
  });
}

function showPet() {
  if (!window || window.isDestroyed()) {
    if (app.isReady() && store) createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function hidePet() {
  if (!window || window.isDestroyed()) return false;
  window.hide();
  return true;
}

async function stopShadowAgentRuntime() {
  const powerShell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = path.join(projectRoot, "scripts", "stop-shadow-agent.ps1");
  return execFileAsync(powerShell, [
    "-NoProfile",
    "-WindowStyle", "Hidden",
    "-ExecutionPolicy", "Bypass",
    "-File", script,
  ], {
    cwd: projectRoot,
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
}

async function quitPet() {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  refreshTrayMenu();
  try {
    if (!E2E_MODE) await stopShadowAgentRuntime();
    isQuitting = true;
    app.quit();
  } catch (error) {
    shutdownInProgress = false;
    refreshTrayMenu();
    const message = `后台停止失败：${error.message}`;
    const logPath = path.join(projectRoot, "runtime", "pet-shutdown-error.log");
    fs.writeFileSync(logPath, `[${new Date().toISOString()}] ${error.stack ?? error.message}\n`, "utf8");
    if (Notification.isSupported()) {
      new Notification({ title: "Shadow Agent 未退出", body: message }).show();
    }
  }
}

function petAttentionSchedule() {
  const schedule = readAttentionSchedule(store, appConfig?.attention ?? {});
  return { ...attentionScheduleStatus(schedule), schedule };
}

function savePetAttentionSchedule(input) {
  const current = readAttentionSchedule(store, appConfig?.attention ?? {});
  const schedule = normalizeAttentionSchedule(input, current);
  store.setSetting(ATTENTION_SCHEDULE_SETTING_KEY, JSON.stringify(schedule));
  refreshTrayMenu();
  settingsWindow?.webContents.send("pet:attention-schedule", petAttentionSchedule());
  return petAttentionSchedule();
}

function openAttentionSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 380,
    height: 330,
    useContentSize: true,
    title: "自动巡检设置",
    backgroundColor: "#f5f8f6",
    autoHideMenuBar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  settingsWindow.loadFile(path.join(__dirname, "settings.html"));
  settingsWindow.once("ready-to-show", () => {
    settingsWindow?.show();
    settingsWindow?.focus();
  });
  settingsWindow.on("closed", () => { settingsWindow = null; });
}

function refreshTrayMenu() {
  if (!tray || !store) return;
  const schedule = readAttentionSchedule(store, appConfig?.attention ?? {});
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示工作现场", click: showPet },
    { type: "separator" },
    {
      label: "自动巡检",
      type: "checkbox",
      checked: schedule.enabled,
      click: (item) => savePetAttentionSchedule({ ...schedule, enabled: item.checked }),
    },
    { label: `巡检时间 ${schedule.start}-${schedule.end}`, enabled: false },
    { label: "巡检设置...", click: openAttentionSettings },
    { label: "声音与人物...", click: () => voiceWindow?.open() },
    { type: "separator" },
    {
      label: shutdownInProgress ? "正在退出 Shadow Agent..." : "退出 Shadow Agent",
      enabled: !shutdownInProgress,
      click: quitPet,
    },
  ]));
}

function createTray() {
  if (tray) return tray;
  tray = new Tray(createTrayIcon());
  tray.setToolTip("Shadow Agent 工作现场");
  refreshTrayMenu();
  tray.on("click", showPet);
  tray.on("double-click", showPet);
  return tray;
}

function createWindow() {
  window = new BrowserWindow({
    ...desiredBounds(COLLAPSED_SIZE),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: true,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.loadFile(path.join(__dirname, "index.html"));
  window.webContents.once("did-finish-load", async () => {
    window.showInactive();
    try { await captureDiagnostics(); } catch (error) {
      fs.writeFileSync(path.join(projectRoot, "runtime", "pet-capture-error.log"), error.stack ?? error.message, "utf8");
    }
  });
  window.on("move", () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (!window || !store) return;
      const bounds = window.getBounds();
      store.setSetting("runtime:pet:x", bounds.x);
      store.setSetting("runtime:pet:y", bounds.y);
    }, 250);
  });
  window.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    hidePet();
  });
  window.on("closed", () => { window = null; });
}

function loadOpenClawSupervisorStatus() {
  const statusPath = path.join(projectRoot, "runtime", "openclaw-poc", "gateway-status.json");
  if (!fs.existsSync(statusPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statusPath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function openClawSnapshot() {
  const connection = gatewayClient?.status() ?? {
    connected: false,
    lastError: "OpenClaw Gateway not configured.",
  };
  const supervisor = loadOpenClawSupervisorStatus();
  return {
    ...connection,
    supervisorPhase: connection.connected ? "online" : (supervisor?.phase ?? "offline"),
    supervisorDetail: supervisor?.detail ?? "OpenClaw 后台尚未启动。",
    supervisorUpdatedAt: supervisor?.updatedAt ?? null,
    supervisorPid: supervisor?.pid ?? null,
    restartCount: supervisor?.restartCount ?? 0,
  };
}

function isoFromMilliseconds(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Date(number).toISOString() : null;
}

function labelValue(labels, prefix, fallback = null) {
  const value = (labels ?? []).find((label) => String(label).startsWith(prefix));
  return value ? String(value).slice(prefix.length) : fallback;
}

function migrationField(notes, name) {
  return String(notes ?? "").match(new RegExp(`^- ${name}:\\s*(.+)$`, "mi"))?.[1]?.trim() ?? null;
}

function booleanValue(value) {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "required", "waiting"].includes(String(value ?? "").trim().toLowerCase());
}

function cardHumanState(card, notes) {
  const labels = (card.labels ?? []).map((label) => String(label).trim().toLowerCase());
  const metadata = card.metadata ?? {};
  const requiresUserLabel = labels.find((label) => label.startsWith("requires_user:") || label.startsWith("requires-user:"));
  const authorizationLabel = labels.some((label) => [
    "awaiting-authorization",
    "authorization:waiting",
    "authorization:required",
    "waiting:authorization",
  ].includes(label));
  const authorizationWaiting = booleanValue(metadata.authorizationWaiting)
    || booleanValue(metadata.authorization_waiting)
    || ["waiting", "required", "waiting_user"].includes(String(metadata.authorizationStatus ?? metadata.authorization_status ?? "").toLowerCase())
    || authorizationLabel
    || /^(waiting|required|等待授权|需要授权)$/i.test(migrationField(notes, "Authorization") ?? "");
  const requiresUser = booleanValue(metadata.requiresUser)
    || booleanValue(metadata.requires_user)
    || booleanValue(requiresUserLabel?.split(":").slice(1).join(":"))
    || labels.includes("requires-user")
    || labels.includes("requires_user")
    || booleanValue(migrationField(notes, "Requires user"))
    || authorizationWaiting;
  const blockedReason = metadata.blockedReason
    ?? metadata.blocked_reason
    ?? labelValue(card.labels, "blocked_reason:")
    ?? labelValue(card.labels, "blocked-reason:")
    ?? migrationField(notes, "Blocked reason")
    ?? null;
  return { requiresUser, authorizationWaiting, blockedReason: blockedReason ? String(blockedReason) : null };
}

function cardToTask(card) {
  const notes = String(card.notes ?? "");
  const description = notes.split(/^## Migration source/m)[0].trim() || notes.trim();
  const humanState = cardHumanState(card, notes);
  const closureView = taskClosureView(store.db, card.id);
  return {
    id: card.id,
    title: card.title,
    description,
    status: closureView.closure?.outcome === 'cancelled' && (card.metadata?.archivedAt || card.archivedAt) ? 'cancelled' : card.status,
    priority: card.priority ?? "normal",
    risk_level: labelValue(card.labels, "risk:", migrationField(notes, "Risk") ?? "read"),
    action_type: labelValue(card.labels, "action:", migrationField(notes, "Action") ?? "workboard_task"),
    domain: "user_work",
    project_name: migrationField(notes, "Project") ?? (card.boardId === "shadow-work" ? null : card.boardId),
    created_at: isoFromMilliseconds(card.createdAt),
    updated_at: isoFromMilliseconds(card.updatedAt),
    attempts: (card.events ?? []).filter((event) => event.kind === "claimed").length,
    result: null,
    last_error: null,
    requires_user: humanState.requiresUser,
    authorization_waiting: humanState.authorizationWaiting,
    blocked_reason: humanState.blockedReason,
    metadata: { boardId: card.boardId, agentId: card.agentId, labels: card.labels ?? [], ...card.metadata },
    ...closureView,
  };
}

function applyHandlingToTask(task, handling) {
  return {
    ...task,
    requires_user: handling.lane === "user",
    handling_lane: handling.lane,
    handling_state: handling.state,
    handling_reason: handling.reason,
    user_action: handling.userAction ?? null,
  };
}

function handlingForCard(card) {
  const attention = store.db.prepare("SELECT * FROM work_task_attention WHERE card_id=?").get(card.id) ?? null;
  const referenceId = attention?.continuation_reference_id;
  const watch = referenceId ? store.db.prepare("SELECT * FROM condition_watches WHERE id=?").get(referenceId) : null;
  const outboundDraft = referenceId ? store.db.prepare("SELECT * FROM outbound_message_drafts WHERE id=?").get(referenceId) : null;
  const progressChange = store.db.prepare(`
    SELECT * FROM context_changes
    WHERE kind='task_progress_due' AND status IN ('pending','leased')
      AND json_extract(metadata_json, '$.taskId')=?
    ORDER BY seq DESC LIMIT 1
  `).get(card.id) ?? null;
  return classifyTaskHandling({ card, attention, watch, outboundDraft, progressChange });
}

function e2eWorkboardFixtures() {
  const now = Date.now();
  const card = (id, title, status, labels, updatedOffset = 0) => ({
    id,
    title,
    status,
    priority: "high",
    boardId: "shadow-work",
    agentId: "main",
    notes: "E2E 隔离界面夹具，不写入真实 Workboard。",
    labels,
    createdAt: now - 60_000,
    updatedAt: now + updatedOffset,
    events: [{ kind: "created", at: now - 60_000 }],
    metadata: { fixture: true, comments: [] },
  });
  const requiresUser = card(
    "pet-e2e-blocked-user",
    "等待人工授权的阻塞事项",
    "blocked",
    ["requires_user:true", "blocked_reason:等待人工授权"],
    2,
  );
  const autonomous = card(
    "pet-e2e-blocked-agent",
    "等待外部构建完成的阻塞事项",
    "blocked",
    ["blocked_reason:等待外部构建完成"],
    1,
  );
  const done = card("pet-e2e-done", "宠物界面处理记录", "done", ["risk:read"], 0);
  done.metadata.comments.push({ id: "pet-e2e-comment", createdAt: now, body: "E2E 已完成界面处理验证。" });
  done.events.push({ kind: "moved", fromStatus: "ready", toStatus: "done", at: now });
  return [requiresUser, autonomous, done];
}

function activeWorkboardCards() {
  return workboardCards.filter((card) => card.boardId !== "shadow-migration");
}

function petSnapshot() {
  const conditionWatches = store.listConditionWatches({ limit: 100 });
  const watchesById = new Map(conditionWatches.map((watch) => [watch.id, watch]));
  const allOutboundDrafts = store.listOutboundDrafts({ limit: 100 });
  const draftsById = new Map(allOutboundDrafts.map((draft) => [draft.id, draft]));
  const attentionByCard = new Map(store.db.prepare("SELECT * FROM work_task_attention").all().map((row) => [row.card_id, row]));
  const progressByCard = new Map();
  for (const change of store.db.prepare(`
    SELECT * FROM context_changes
    WHERE kind='task_progress_due' AND status IN ('pending','leased')
    ORDER BY seq DESC
  `).all()) {
    const taskId = parseObject(change.metadata_json).taskId;
    if (taskId && !progressByCard.has(taskId)) progressByCard.set(taskId, change);
  }
  const tasks = activeWorkboardCards().map((card) => {
    const task = cardToTask(card);
    let attention = attentionByCard.get(card.id) ?? null;
    if (E2E_MODE && card.metadata?.fixture && task.requires_user) {
      attention = {
        continuation_kind: "requires_user",
        continuation_user_action_json: JSON.stringify({
          reason: "decision",
          request: task.blocked_reason || "请确认下一步",
        }),
      };
    }
    const handling = classifyTaskHandling({
      card,
      attention,
      watch: attention?.continuation_reference_id ? watchesById.get(attention.continuation_reference_id) : null,
      outboundDraft: attention?.continuation_reference_id ? draftsById.get(attention.continuation_reference_id) : null,
      progressChange: progressByCard.get(card.id) ?? null,
    });
    return applyHandlingToTask(task, handling);
  });
  const newest = (items) => items.sort((left, right) => Date.parse(right.updated_at ?? "") - Date.parse(left.updated_at ?? ""));
  const running = newest(tasks.filter((task) => task.handling_lane === "agent" && ["running", "verifying"].includes(task.handling_state)));
  const needsUser = newest(tasks.filter((task) => task.handling_lane === "user"));
  const queued = newest(tasks.filter((task) => task.handling_lane === "agent" && !["running", "verifying"].includes(task.handling_state)));
  const completed = newest(tasks.filter((task) => ['done','cancelled'].includes(task.status))).slice(0, 4);
  const rawRuntimeDetail = store.getSetting("runtime:context:detail", "上下文服务尚未启动");
  let runtimeSession = null;
  try {
    const parsed = JSON.parse(rawRuntimeDetail);
    if (parsed && typeof parsed === "object" && parsed.sessionKey) runtimeSession = parsed;
  } catch { /* plain-text runtime detail remains supported */ }
  const runtime = {
    phase: store.getSetting("runtime:context:phase", "offline"),
    detail: runtimeSession
      ? `${runtimeSession.label || "稳定工作会话"} · ${Number(runtimeSession.pendingCount ?? 0)} 条新变化`
      : rawRuntimeDetail,
    session: runtimeSession,
    lastHeartbeat: store.getSetting("runtime:context:lastHeartbeat", ""),
  };
  const reminders = store.listReminders({ limit: 8 }).map((reminder) => ({
    ...reminder,
    source_evidence_ids_json: undefined,
    metadata_json: undefined,
    explicit: Boolean(reminder.explicit),
  }));
  const outboundMessages = allOutboundDrafts.slice(0, 8).map((draft) => ({
    id: draft.id,
    message_kind: draft.message_kind,
    sender_identity: draft.sender_identity,
    approval_mode: draft.approval_mode,
    recipient_name: draft.recipient_name,
    content: draft.content,
    reason: draft.reason,
    status: draft.status,
    revision: draft.revision,
    created_at: draft.created_at,
    updated_at: draft.updated_at,
    last_error: draft.last_error,
    source_locator: draft.source_locator,
    review_context: store.outboundDraftReviewContext(draft),
  }));
  const directInputs = store.listDirectInputReceipts({ limit: 5 }).map((receipt) => {
    const metadata = parseObject(receipt.metadata_json);
    return {
      id: receipt.id,
      evidence_id: receipt.evidence_id,
      session_key: receipt.session_key,
      status: receipt.status,
      response_text: receipt.response_text,
      created_tasks: Array.isArray(metadata.createdTasks) ? metadata.createdTasks : [],
      created_at: receipt.created_at,
      started_at: receipt.started_at,
      completed_at: receipt.completed_at,
      updated_at: receipt.updated_at,
      last_error: receipt.last_error,
    };
  });
  const pendingOutboundMessages = outboundMessages.filter((draft) => draft.status === "pending_confirmation");
  const deliveredReminders = reminders.filter((reminder) => reminder.status === "delivered");
  const parseEvidenceIds = (value) => {
    try {
      const parsed = JSON.parse(value || "[]");
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean).slice(0, 12) : [];
    } catch {
      return [];
    }
  };
  const trackingEvidenceIds = [...new Set(conditionWatches.flatMap((watch) => [
    ...parseEvidenceIds(watch.source_evidence_ids_json),
    ...parseEvidenceIds(watch.candidate_evidence_ids_json),
  ]))];
  const trackingEvidence = new Map(evidenceByIds(trackingEvidenceIds).map((item) => [item.id, {
    ...item,
    content: String(item.content || "").slice(0, 1200),
  }]));
  const trackingTasks = new Map(workboardCards.map((card) => [card.id, card]));
  const trackingItems = conditionWatches.map((watch) => {
    const resolveEvidence = (value) => parseEvidenceIds(value)
      .map((id) => trackingEvidence.get(id))
      .filter(Boolean);
    const task = watch.task_id ? trackingTasks.get(watch.task_id) : null;
    return {
      id: watch.id,
      title: watch.title,
      condition_text: watch.condition_text,
      status: watch.status,
      timeout_at: watch.timeout_at,
      created_at: watch.created_at,
      updated_at: watch.updated_at,
      last_checked_at: watch.last_checked_at,
      candidate_at: watch.candidate_at,
      last_error: watch.last_error,
      resolution_note: watch.resolution_note,
      conversation_provider: watch.conversation_provider,
      conversation_key: watch.conversation_key,
      task_id: watch.task_id,
      task_title: task?.title ?? null,
      task_status: task?.status ?? null,
      source_evidence: resolveEvidence(watch.source_evidence_ids_json),
      candidate_evidence: resolveEvidence(watch.candidate_evidence_ids_json),
    };
  });
  const visibleTrackingItems = trackingItems.filter((item) => (
    item.status === "active"
    || !item.task_id
    || !ACTIVE_TASK_STATUSES.has(String(item.task_status ?? ""))
  ));
  for (const reminder of deliveredReminders) {
    const notifiedKey = `runtime:pet:reminder-notified:${reminder.id}`;
    if (store.getSetting(notifiedKey)) continue;
    if (!E2E_MODE && Notification.isSupported()) {
      new Notification({ title: `提醒：${reminder.title}`, body: reminder.message, silent: false }).show();
    }
    window?.flashFrame(true);
    store.setSetting(notifiedKey, new Date().toISOString());
  }
  for (const draft of pendingOutboundMessages) {
    const notifiedKey = `runtime:pet:outbound-notified:${draft.id}:r${draft.revision}`;
    if (store.getSetting(notifiedKey)) continue;
    if (!E2E_MODE && Notification.isSupported()) {
      new Notification({
        title: `飞书消息待确认：${draft.recipient_name}`,
        body: draft.content,
        silent: false,
      }).show();
    }
    window?.flashFrame(true);
    store.setSetting(notifiedKey, new Date().toISOString());
  }
  return {
    runtime,
    running,
    failed: [],
    needsUser,
    queued,
    completed,
    maintenance: [],
    reminders,
    outboundMessages,
    directInputs,
    counts: {
      running: running.length,
      needsUser: needsUser.length,
      queued: queued.length,
      completed: tasks.filter((task) => task.status === "done").length,
      backlog: tasks.filter((task) => task.status === "backlog").length,
      reminders: reminders.length,
      deliveredReminders: deliveredReminders.length,
      pendingOutboundMessages: pendingOutboundMessages.length,
      conditionWatches: conditionWatches.length,
      conditionCandidates: conditionWatches.filter((watch) => ["candidate", "timed_out"].includes(watch.status)).length,
    },
    openclaw: openClawSnapshot(),
    feishu: feishuCapabilitySnapshot(store, appConfig),
    tracking: {
      active: visibleTrackingItems.filter((item) => item.status === "active").length,
      needsReview: visibleTrackingItems.filter((item) => ["candidate", "timed_out"].includes(item.status)).length,
      items: visibleTrackingItems,
    },
    workboard: {
      cards: activeWorkboardCards(),
      counts: activeWorkboardCards().reduce((counts, card) => {
        counts[card.status] = (counts[card.status] ?? 0) + 1;
        return counts;
      }, {}),
    },
  };
}

function evidenceIdsFromNotes(notes) {
  const raw = migrationField(notes, "Evidence ids");
  return raw ? raw.split(",").map((value) => value.trim()).filter(Boolean).slice(0, 40) : [];
}

function evidenceByIds(ids) {
  if (!ids.length) return [];
  return store.db.prepare(`
    SELECT id, kind, occurred_at, collected_at, title, substr(content, 1, 5000) AS content,
      source_locator, external_id
    FROM evidence WHERE id IN (${ids.map(() => "?").join(",")})
    ORDER BY COALESCE(occurred_at, collected_at) DESC
  `).all(...ids);
}

async function readWorkboardCard(id, { preferCached = false } = {}) {
  const localFixture = E2E_MODE && workboardCards.find((card) => card.id === id && card.metadata?.fixture);
  if (localFixture) return localFixture;
  const cached = workboardCards.find((card) => card.id === id);
  // First-open detail must use the same snapshot already shown in the overview.
  // Background refresh and all mutation readbacks still request fresh data.
  if (preferCached && cached) return cached;
  if (!gatewayClient?.connected) {
    if (cached) return cached;
    throw new Error("OpenClaw Gateway 当前离线，且本地没有该 Workboard 卡片缓存。");
  }
  const cards = await refreshWorkboard({ maxAgeMs: 2000, throwErrors: true });
  const card = cards?.find((item) => item.id === id);
  if (!card) throw new Error(`Workboard card not found: ${id}`);
  return card;
}

function e2eWorkboardClient(card) {
  return {
    async invokeTool(name, args) {
      if (name === "workboard_read") return { output: { details: { card } } };
      if (name === "workboard_comment") {
        card.metadata.comments.push({ id: `pet-e2e-comment-${Date.now()}`, createdAt: Date.now(), body: args.body });
        card.updatedAt = Date.now();
        return { ok: true };
      }
      if (name === "workboard_proof") {
        card.metadata.proof ??= [];
        card.metadata.proof.push({ id: `pet-e2e-proof-${Date.now()}`, createdAt: Date.now(), ...args });
        card.updatedAt = Date.now();
        return { ok: true };
      }
      throw new Error(`Unsupported E2E Workboard tool: ${name}`);
    },
    async request(method, args) {
      if (method === 'workboard.cards.update') { Object.assign(card, args.patch); return { card }; }
      if (method === 'workboard.cards.archive') {
        card.metadata.archivedAt = args.archived ? Date.now() : null; return { card };
      }
      if (method !== "workboard.cards.move") throw new Error(`Unsupported E2E Workboard RPC: ${method}`);
      const previous = card.status;
      card.status = args.status;
      card.updatedAt = Date.now();
      card.events.push({ kind: "moved", fromStatus: previous, toStatus: args.status, at: card.updatedAt });
      return { card };
    },
  };
}

async function applyPetAgentOperation(operation, card) {
  const payload = JSON.parse(operation.action.payload_json || "{}");
  const client = E2E_MODE && card?.metadata?.fixture ? e2eWorkboardClient(card) : gatewayClient;
  if (!client?.connected && !(E2E_MODE && card?.metadata?.fixture)) {
    return { applied: false, queued: true, reason: "gateway_offline" };
  }
  const claimed = store.claimControllerAction(operation.action.id);
  if (!claimed) return { applied: false, queued: true, reason: "background_claimed" };
  operation.action = claimed;
  try {
    const result = await applyWorkboardOperation(client, payload);
    markAgentOperationEffectApplied(store, operation, result);
    if (!E2E_MODE) await refreshWorkboard();
    return { applied: true, queued: false, result, ...taskClosureView(store.db, card.id) };
  } catch (error) {
    if (gatewayClient) gatewayClient.lastError = error.message;
    store.finishControllerAction(operation.action.id, {
      status: "retry",
      error: error.message,
      retryAt: new Date(Date.now() + 5000).toISOString(),
    });
    return { applied: false, queued: true, reason: error.message };
  }
}

function cardActions(card) {
  const comments = (card.metadata?.comments ?? []).slice(-30).reverse().map((comment) => ({
    id: comment.id,
    action_type: "workboard_comment",
    risk_level: "read",
    status: "completed",
    started_at: isoFromMilliseconds(comment.createdAt),
    completed_at: isoFromMilliseconds(comment.createdAt),
    command_summary: "OpenClaw 处理记录",
    result: comment.body,
    error: null,
    metadata: { source: "workboard", trace: [] },
  }));
  const recentEvents = (card.events ?? []).slice(-20);
  if (recentEvents.length) {
    comments.push({
      id: `events:${card.id}`,
      action_type: "workboard_state_history",
      risk_level: "read",
      status: "completed",
      started_at: isoFromMilliseconds(recentEvents[0].at),
      completed_at: isoFromMilliseconds(recentEvents.at(-1).at),
      command_summary: "Workboard 状态轨迹",
      result: recentEvents.map((event) => `- ${isoFromMilliseconds(event.at)} · ${event.kind}${event.fromStatus ? ` · ${event.fromStatus} -> ${event.toStatus}` : ""}`).join("\n"),
      error: null,
      metadata: { source: "workboard", trace: [] },
    });
  }
  return comments;
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function knowledgeTraceForTarget(targetType, targetId) {
  const sourceLocator = `shadow://knowledge-episode/${targetType}/${targetId}`;
  const rows = store.db.prepare(`
    SELECT e.id, e.occurred_at,
           a.summary, a.status AS annotation_status, a.review_status, a.review_outcome, a.metadata_json AS annotation_metadata_json,
           q.status AS queue_status, q.completed_at, q.last_error
    FROM evidence e
    LEFT JOIN graph_episode_annotations a ON a.evidence_id=e.id
    LEFT JOIN graph_enrichment_queue q ON q.evidence_id=e.id
    WHERE e.kind='manual_knowledge' AND e.source_locator=?
    ORDER BY e.occurred_at DESC
    LIMIT 20
  `).all(sourceLocator);

  const actions = rows.map((row) => {
    const annotationMetadata = parseObject(row.annotation_metadata_json);
    const graphReview = annotationMetadata.graphReview && typeof annotationMetadata.graphReview === "object"
      ? annotationMetadata.graphReview
      : {};
    const reviewStatus = row.review_status ?? "pending";
    const reviewOutcome = row.review_outcome ?? null;
    const reviewedFactIds = [...new Set((Array.isArray(graphReview.factIds) ? graphReview.factIds : [])
      .filter((id) => typeof id === "string" && id.trim()))];
    const queueStatus = row.queue_status || "pending";
    const status = {
      pending: "ready",
      leased: "running",
      completed: "completed",
      review_needed: "blocked",
      failed: "failed",
    }[queueStatus] || "ready";
    const stage = {
      pending: "原始反馈已收录，等待 Codex 语义复核",
      leased: "Codex 正在进行语义复核",
      completed: "语义复核已完成",
      review_needed: "语义复核需要补充信息",
      failed: "语义复核失败，等待重试",
    }[queueStatus] || `知识处理状态：${queueStatus}`;
    const reviewResult = reviewStatus === "completed"
      ? reviewOutcome === "facts_recorded"
        ? reviewedFactIds.length ? `本次复核关联 ${reviewedFactIds.length} 条事实记录` : "本次复核已关联事实记录"
        : reviewOutcome === "no_durable_facts" ? "本次复核未形成长期事实" : "复核已完成，未记录处理结果"
      : reviewStatus === "needs_input" ? "需要补充信息，尚未完成知识复核"
        : reviewStatus === "pending" ? "尚未形成长期知识判断" : "复核状态暂不可识别";
    return {
      id: `knowledge:${row.id}`,
      action_type: "knowledge_episode",
      risk_level: "local-write",
      status,
      started_at: row.occurred_at,
      completed_at: row.completed_at || row.occurred_at,
      command_summary: "知识库处理",
      result: [
        `**${stage}**`,
        row.summary ? `初步摘要：${row.summary}` : "",
        reviewResult ? `复核结果：${reviewResult}` : "",
        graphReview.rationale ? `判断依据：${graphReview.rationale}` : "",
        `Evidence：\`${row.id}\``,
        row.last_error ? `错误：${row.last_error}` : "",
      ].filter(Boolean).join("\n\n"),
      error: queueStatus === "failed" ? row.last_error : null,
      metadata: {
        source: "knowledge-episode",
        evidenceId: row.id,
        annotationStatus: row.annotation_status,
        queueStatus,
        graphReviewStatus: reviewStatus,
        graphReviewOutcome: reviewOutcome,
        trace: [],
      },
    };
  });

  return { actions, evidenceIds: rows.map((row) => row.id) };
}

async function taskDetailsWithWorkboard(id, options = {}) {
  const card = await readWorkboardCard(id, options);
  const task = applyHandlingToTask(cardToTask(card), handlingForCard(card));
  const knowledge = knowledgeTraceForTarget("workboard_task", card.id);
  const linkedConditionRows = store.db.prepare(`
    SELECT * FROM condition_watches
    WHERE task_id=? AND status IN ('active','candidate','timed_out')
    ORDER BY updated_at DESC LIMIT 20
  `).all(card.id);
  const linkedEvidenceIds = [...new Set(linkedConditionRows.flatMap((watch) => [
    ...parseTaskJson(watch.source_evidence_ids_json, []),
    ...parseTaskJson(watch.candidate_evidence_ids_json, []),
  ]).map(String).filter(Boolean))];
  const linkedEvidence = new Map(evidenceByIds(linkedEvidenceIds).map((item) => [item.id, item]));
  const linkedConditions = linkedConditionRows.map((watch) => ({
    id: watch.id,
    title: watch.title,
    condition_text: watch.condition_text,
    status: watch.status,
    timeout_at: watch.timeout_at,
    last_checked_at: watch.last_checked_at,
    candidate_at: watch.candidate_at,
    source_evidence: parseTaskJson(watch.source_evidence_ids_json, []).map((evidenceId) => linkedEvidence.get(String(evidenceId))).filter(Boolean),
    candidate_evidence: parseTaskJson(watch.candidate_evidence_ids_json, []).map((evidenceId) => linkedEvidence.get(String(evidenceId))).filter(Boolean),
  }));
  const actions = [...cardActions(card), ...knowledge.actions, ...operationDeliveryActions(store.db, card.id)]
    .sort((left, right) => Date.parse(right.started_at || 0) - Date.parse(left.started_at || 0));
  if (card.status === "done") task.result = actions.find((action) => action.action_type === "workboard_comment")?.result ?? "Workboard 已标记完成。";
  return {
    task,
    patrol: null,
    actions,
    evidence: evidenceByIds([...new Set([...evidenceIdsFromNotes(card.notes), ...knowledge.evidenceIds])]),
    linkedConditions,
    conversation: taskConversationPage(store, card),
    workboard: { cardId: card.id, boardId: card.boardId, status: card.status, priority: card.priority },
  };
}

async function refreshWorkboard({ maxAgeMs = 0, throwErrors = false } = {}) {
  if (!gatewayClient?.connected) return;
  try {
    const cards = await readWorkboardProjection(gatewayClient, { maxAgeMs });
    workboardCards = cards.filter((card) => !card?.metadata?.archivedAt
      || taskClosureView(store.db, card.id).closure?.outcome === 'cancelled');
    window?.webContents.send("pet:openclaw-status", openClawSnapshot());
    return cards;
  } catch (error) {
    gatewayClient.lastError = error.message;
    if (throwErrors) throw error;
  }
}

async function confirmWorkboardTaskDone(cardId, note) {
  return closeWorkboardTask(cardId, { outcome: 'done', note });
}

async function closeWorkboardTask(cardId, input) {
  const card = await readWorkboardCard(cardId);
  const operation = recordTaskClosure(store, card, { ...input, projectKey: cardToTask(card).project_name });
  const metadata = parseTaskJson(operation.change.metadata_json, {});
  if (metadata.appliedStatus === 'applied') return { applied: true, queued: false, ...taskClosureView(store.db, cardId) };
  return applyPetAgentOperation(operation, card);
}

async function sendWorkboardTaskMessage(cardId, message) {
  const current = await readWorkboardCard(cardId);
  const task = cardToTask(current);
  const owner = resolveTaskOwnerSession(store, current, { projectKey: task.project_name });
  const operation = recordAgentOperation(store, {
    action: "task_message",
    actor: "user",
    source: "pet-ui",
    targetType: "workboard_task",
    targetId: cardId,
    taskId: cardId,
    card: current,
    owner,
    projectKey: task.project_name,
    baseStatus: task.status,
    desiredEffect: "interpret_task_message",
    summary: `用户在任务卡片中继续交代：${task.title}`,
    metadata: { userText: message, taskTitle: task.title },
    knowledge: {
      action: "task_message",
      actionLabel: "继续交代任务",
      targetType: "workboard_task",
      targetId: cardId,
      targetLabel: task.title,
      title: `用户继续交代任务：${task.title}`,
      content: [
        `任务：${task.title}`,
        `当前状态：${task.status}`,
        task.description ? `当前说明：\n${task.description}` : "",
        `用户在卡片中的消息：\n${message}`,
      ].filter(Boolean).join("\n\n"),
      scope: { project: task.project_name, taskId: cardId },
      keywords: ["任务跟进", task.project_name].filter(Boolean),
      retrievalCues: [`用户最近对“${task.title}”交代了什么？`],
    },
    workboardEffect: {
      cardId,
      effect: "task_instruction_comment",
      comment: `用户在任务卡片中继续交代：\n${message}`,
      baseStatus: task.status,
    },
  });
  return applyPetAgentOperation(operation, current);
}

async function submitManualInput(text) {
  const normalizedText = String(text ?? "").trim();
  if (!normalizedText) throw new Error("请输入内容。");
  if (normalizedText.length > 2000) throw new Error("内容不能超过 2000 字。");
  ensureDirectInputSession(store);
  let captured;
  let queued;
  store.transaction(() => {
    captured = capturePetKnowledgeEpisode({
      action: "direct_message",
      actionLabel: "直接告诉 Agent",
      targetType: "agent_conversation",
      targetId: DIRECT_INPUT_SESSION_KEY,
      targetLabel: "Shadow Agent 统一输入",
      title: "用户直接告诉 Agent 的消息",
      content: normalizedText,
      threadId: DIRECT_INPUT_SESSION_KEY,
      scope: { sessionKey: DIRECT_INPUT_SESSION_KEY },
      keywords: ["用户直接输入", "Agent 对话"],
      retrievalCues: ["用户最近直接交代或询问了什么？"],
      externalId: `pet-direct-message:${randomUUID()}`,
    }, { transaction: false });
    queued = enqueueDirectInputRequest(store, {
      evidenceId: captured.evidenceId,
      sessionKey: DIRECT_INPUT_SESSION_KEY,
      source: "pet-ui",
    });
  });
  if (E2E_MODE) {
    await delay(180);
    if (normalizedText === "__E2E_ERROR__") {
      store.updateDirectInputReceipt(queued.receipt.id, {
        status: "retry",
        startedAt: new Date().toISOString(),
        lastError: "E2E 模拟 Gateway 离线",
      });
      store.finishControllerAction(queued.action.id, {
        status: "retry",
        error: "E2E 模拟 Gateway 离线",
        retryAt: new Date(Date.now() + 60_000).toISOString(),
      });
      return {
        ok: true,
        status: "retry",
        requestId: queued.receipt.id,
        sessionKey: DIRECT_INPUT_SESSION_KEY,
        evidenceId: captured.evidenceId,
        createdTasks: [],
        text: "Agent 暂时不可用，输入已保留并自动重试。",
      };
    }
    const createdTasks = normalizedText.includes("任务")
      ? [{ id: "pet-e2e-created-task", title: "E2E 用户交代的任务" }]
      : [];
    for (const item of createdTasks) {
      let card = workboardCards.find((entry) => entry.id === item.id);
      if (!card) {
        card = { ...e2eWorkboardFixtures()[0], ...item, status: "todo",
          notes: `来源 Evidence: ${captured.evidenceId}`, metadata: { fixture: true, comments: [] }, events: [] };
        workboardCards.push(card);
      }
      recordAgentOperation(store, { operationId: `direct-task:${queued.receipt.id}:${card.id}`,
        action: "task_handoff", targetType: "workboard_task", targetId: card.id, taskId: card.id, card,
        evidenceId: captured.evidenceId, evidenceIds: [captured.evidenceId],
        metadata: { userText: normalizedText, taskTitle: card.title } });
    }
    store.updateDirectInputReceipt(queued.receipt.id, {
      status: "completed",
      responseText: "E2E 已通过统一稳定会话接收输入。",
      createdTaskIds: createdTasks.map((item) => item.id),
      completedAt: new Date().toISOString(),
      metadata: { createdTasks },
    });
    store.finishControllerAction(queued.action.id, { status: "completed" });
    return {
      ok: true,
      status: "completed",
      requestId: queued.receipt.id,
      sessionKey: DIRECT_INPUT_SESSION_KEY,
      evidenceId: captured.evidenceId,
      createdTasks,
      text: "E2E 已通过统一稳定会话接收输入。",
    };
  }
  return {
    ok: true,
    status: "queued",
    requestId: queued.receipt.id,
    sessionKey: DIRECT_INPUT_SESSION_KEY,
    evidenceId: captured.evidenceId,
    createdTasks: [],
    text: "已可靠接收，Agent 将在后台处理。",
  };
}

function recordReminderUserOperation(action, before, after, summary) {
  const metadata = parseObject(after?.metadata_json ?? before?.metadata_json);
  const taskOwner = (after?.task_id ?? before?.task_id)
    ? store.db.prepare("SELECT owner_session_key FROM work_task_attention WHERE card_id=?")
      .get(after?.task_id ?? before?.task_id)?.owner_session_key
    : null;
  return recordAgentOperation(store, {
    action,
    actor: "user",
    source: "pet-ui",
    targetType: "reminder",
    targetId: after?.id ?? before?.id,
    sessionKey: taskOwner ?? metadata.sessionKey ?? null,
    desiredEffect: `record_reminder_${action}`,
    baseStatus: before?.status ?? null,
    summary,
    metadata: {
      appliedStatus: after?.status ?? null,
      taskId: after?.task_id ?? before?.task_id ?? null,
      reminderRevision: after?.revision ?? null,
      dueAt: after?.due_at ?? null,
    },
  });
}

async function updatePetReminder(id, changes) {
  const reminderId = String(id ?? "").trim();
  if (!reminderId) throw new Error("缺少提醒 ID。");
  const normalized = {
    title: String(changes?.title ?? "").trim(),
    message: String(changes?.message ?? "").trim(),
    dueAt: String(changes?.dueAt ?? "").trim(),
  };
  if (!normalized.title) throw new Error("提醒标题不能为空。");
  if (!normalized.dueAt || !Number.isFinite(Date.parse(normalized.dueAt))) throw new Error("提醒时间无效。");
  const before = store.reminder(reminderId);
  let reminder;
  if (E2E_MODE) {
    reminder = store.updateReminder(reminderId, {
      ...normalized,
      status: "scheduled",
      lastError: null,
    });
  } else {
    reminder = await updateScheduledReminder(store, appConfig, reminderId, normalized);
  }
  recordReminderUserOperation("updated", before, reminder, `用户修改提醒：${reminder.title}`);
  return reminder;
}

async function cancelPetReminder(id) {
  const reminderId = String(id ?? "").trim();
  if (!reminderId) throw new Error("缺少提醒 ID。");
  const before = store.reminder(reminderId);
  const reminder = E2E_MODE
    ? store.cancelReminderRecord(reminderId)
    : await cancelReminder(store, appConfig, reminderId);
  recordReminderUserOperation("cancelled", before, reminder, `用户取消提醒：${reminder.title}`);
  return reminder;
}

function approvePetOutboundMessage(id, content) {
  const draftId = String(id ?? "").trim();
  if (!draftId) throw new Error("缺少飞书草稿 ID。");
  const approvedContent = String(content ?? "").trim();
  if (!approvedContent) throw new Error("发送内容不能为空。");
  const draft = store.outboundDraft(draftId);
  if (!draft) throw new Error(`Outbound draft not found: ${draftId}`);
  const context = store.outboundDraftReviewContext(draft);
  const edited = approvedContent !== draft.content;
  const captured = capturePetKnowledgeEpisode({
    action: edited ? "revise_and_approve_outbound" : "approve_outbound",
    actionLabel: edited ? "修改并批准飞书消息" : "批准飞书消息",
    targetType: "outbound_message",
    targetId: draftId,
    targetLabel: `发给${draft.recipient_name}的飞书消息`,
    title: `${edited ? "用户修改并批准" : "用户批准"}飞书消息：${draft.recipient_name}`,
    content: [
      `收件人：${draft.recipient_name}`,
      `消息类型：${draft.message_kind}`,
      reviewContextAsText(context),
      `原始草稿：\n${draft.content}`,
      edited ? `用户批准的修改稿：\n${approvedContent}` : "用户确认原草稿可以发送。",
    ].filter(Boolean).join("\n\n"),
    threadId: draft.conversation_key,
    sourceLocator: draft.source_locator || `shadow://outbound-message/${draftId}`,
    scope: { conversationKey: draft.conversation_key, recipient: draft.recipient_name, messageKind: draft.message_kind },
    keywords: ["飞书消息审核", draft.recipient_name, edited ? "消息修改" : "消息批准"],
    retrievalCues: [`用户如何修改或确认发给“${draft.recipient_name}”的飞书消息？`],
  });
  const approved = store.approveOutboundDraft(draftId, { content: approvedContent });
  recordAgentOperation(store, {
    action: edited ? "revise_and_approve_outbound" : "approve_outbound",
    actor: "user",
    source: "pet-ui",
    targetType: "outbound_message",
    targetId: draftId,
    sessionKey: draft.session_key,
    conversationKey: draft.conversation_key,
    evidenceId: captured.evidenceId,
    desiredEffect: "send_approved_outbound",
    baseStatus: draft.status,
    summary: `用户${edited ? "修改并批准" : "批准"}发给${draft.recipient_name}的飞书消息`,
    metadata: { draftRevision: approved.revision, recipientName: draft.recipient_name },
  });
  return approved;
}

function cancelPetOutboundMessage(id, reason) {
  const draftId = String(id ?? "").trim();
  if (!draftId) throw new Error("缺少飞书草稿 ID。");
  const rejectionReason = String(reason ?? "").trim();
  if (!rejectionReason) throw new Error("请填写拒绝原因，帮助 Agent 理解你的职责和偏好。");
  if (rejectionReason.length > 1000) throw new Error("拒绝原因不能超过 1000 字。");
  const draft = store.outboundDraft(draftId);
  if (!draft) throw new Error(`Outbound draft not found: ${draftId}`);
  const context = store.outboundDraftReviewContext(draft);
  const captured = capturePetKnowledgeEpisode({
    action: "reject_outbound",
    actionLabel: "拒绝飞书消息",
    targetType: "outbound_message",
    targetId: draftId,
    targetLabel: `发给${draft.recipient_name}的飞书消息`,
    title: `用户拒绝飞书消息：${draft.recipient_name}`,
    content: [
      `收件人：${draft.recipient_name}`,
      `消息类型：${draft.message_kind}`,
      reviewContextAsText(context),
      `被拒绝的草稿：\n${draft.content}`,
      `用户填写的拒绝原因：\n${rejectionReason}`,
    ].filter(Boolean).join("\n\n"),
    threadId: draft.conversation_key,
    sourceLocator: draft.source_locator || `shadow://outbound-message/${draftId}`,
    scope: { conversationKey: draft.conversation_key, recipient: draft.recipient_name, messageKind: draft.message_kind },
    keywords: ["飞书消息审核", "拒绝原因", draft.recipient_name],
    retrievalCues: [`用户为什么拒绝发给“${draft.recipient_name}”的飞书消息？`],
  });
  const cancelled = store.cancelOutboundDraft(draftId, { reason: rejectionReason });
  recordAgentOperation(store, {
    action: "reject_outbound",
    actor: "user",
    source: "pet-ui",
    targetType: "outbound_message",
    targetId: draftId,
    sessionKey: draft.session_key,
    conversationKey: draft.conversation_key,
    evidenceId: captured.evidenceId,
    desiredEffect: "keep_outbound_cancelled_and_learn",
    baseStatus: draft.status,
    summary: `用户拒绝发给${draft.recipient_name}的飞书消息并给出原因`,
    metadata: { recipientName: draft.recipient_name, rejectionReason },
  });
  return cancelled;
}

function agentHistoryFromWorkboard(options = {}) {
  const query = String(options.query ?? "").trim().toLocaleLowerCase();
  const limit = Math.min(300, Math.max(1, Number(options.limit) || 100));
  return activeWorkboardCards()
    .filter((card) => card.status === "done")
    .filter((card) => !query || card.title.toLocaleLowerCase().includes(query))
    .sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt))
    .slice(0, limit)
    .map((card) => ({
      id: card.id,
      started_at: isoFromMilliseconds(card.createdAt),
      completed_at: isoFromMilliseconds(card.updatedAt),
      status: "completed",
      evidence_count: 0,
      discovered_task_count: 1,
      action_count: 1,
      preview_task: card.title,
      summary: card.title,
      no_action_reason: null,
      error: null,
    }));
}

async function agentHistoryDetailsFromWorkboard(id) {
  const details = await taskDetailsWithWorkboard(id);
  const evidenceKinds = Object.entries(details.evidence.reduce((counts, item) => {
    counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    return counts;
  }, {})).map(([kind, count]) => ({ kind, count }));
  return {
    run: {
      id,
      started_at: details.task.created_at,
      completed_at: details.task.updated_at,
      status: details.task.status === "done" ? "completed" : "running",
      evidence_count: details.evidence.length,
      summary: details.task.result || details.task.description,
      no_action_reason: null,
      error: details.task.last_error,
      metadata: { source: "workboard", trace: [] },
    },
    tasks: [details.task],
    actions: details.actions,
    evidenceKinds,
    evidence: details.evidence,
  };
}

function startOpenClawBridge() {
  if (E2E_MODE) {
    gatewayClient = { connected: false, status: () => ({ connected: false, lastError: "隔离界面测试：未连接生产 Gateway" }) };
    return;
  }
  try {
    gatewayClient = new OpenClawGatewayClient({
      ...loadOpenClawGatewaySettings(projectRoot),
      autoReconnect: true,
    });
    gatewayClient.on("status", (status) => {
      window?.webContents.send("pet:openclaw-status", { ...openClawSnapshot(), ...status });
      if (status.connected) refreshWorkboard();
    });
    gatewayClient.on("event", () => {
      window?.webContents.send("pet:openclaw-status", openClawSnapshot());
    });
    gatewayClient.start().catch(() => {});
    gatewayRefreshTimer = setInterval(refreshWorkboard, 5_000);
  } catch (error) {
    gatewayClient = { status: () => ({ connected: false, lastError: error.message }) };
  }
}

app.on("second-instance", () => {
  showPet();
});

app.on("activate", showPet);

app.whenReady().then(() => {
  const config = loadConfig();
  appConfig = config;
  projectRoot = config.projectRoot;
  store = openDatabase(config.paths.database);
  voiceWindow = createVoiceWindowController({ getStore: () => store, getConfig: () => appConfig });
  if (store.getSetting("contextGraph:version", "") !== "epistemic-context-v4") {
    materializeContextGraph(store, config, {
      emitChanges: false,
      refreshStructural: false,
      runMaintenance: false,
    });
  }
  if (E2E_MODE) workboardCards = e2eWorkboardFixtures();
  startOpenClawBridge();
  ipcMain.handle("pet:snapshot", () => petSnapshot());
  ipcMain.handle("pet:openclaw-status", () => openClawSnapshot());
  ipcMain.handle("pet:attention-schedule", () => petAttentionSchedule());
  ipcMain.handle("pet:update-attention-schedule", (_event, input) => savePetAttentionSchedule(input ?? {}));
  ipcMain.handle("pet:submit-manual-input", (_event, text) => submitManualInput(text));
  ipcMain.handle("pet:main-conversation", (_event, options) => mainConversationPage(store, options ?? {}));
  ipcMain.handle("pet:task-conversation", async (_event, id, options) => {
    const card = await readWorkboardCard(String(id));
    const { title, status, project_name } = cardToTask(card);
    return { ...taskConversationPage(store, card, options ?? {}), task: { id: card.id, title, status, project_name } };
  });
  ipcMain.handle("pet:agent-history", (_event, options) => agentHistoryFromWorkboard(options ?? {}));
  ipcMain.handle("pet:agent-history-details", (_event, id) => agentHistoryDetailsFromWorkboard(String(id ?? "")));
  ipcMain.handle("pet:task-details", (_event, id, options) => taskDetailsWithWorkboard(String(id ?? ""), {
    preferCached: options?.preferCached === true,
  }));
  ipcMain.handle("pet:confirm-task-done", async (_event, id, note) => {
    const cardId = String(id ?? "");
    const confirmation = String(note ?? "");
    const operation = await confirmWorkboardTaskDone(cardId, confirmation);
    return { ...await taskDetailsWithWorkboard(cardId), operation };
  });
  ipcMain.handle('pet:close-task', async (_event, id, input) => {
    const cardId = String(id ?? '');
    const operation = await closeWorkboardTask(cardId, input ?? {});
    return { ...await taskDetailsWithWorkboard(cardId), operation };
  });
  ipcMain.handle("pet:send-task-message", async (_event, id, message) => {
    const cardId = String(id ?? "");
    const normalized = String(message ?? "").trim();
    if (!normalized) throw new Error("请输入内容。");
    const operation = await sendWorkboardTaskMessage(cardId, normalized);
    return { ...await taskDetailsWithWorkboard(cardId), operation };
  });
  ipcMain.handle("pet:acknowledge-reminder", (_event, id) => {
    const reminderId = String(id ?? "");
    const before = store.reminder(reminderId);
    const reminder = store.acknowledgeReminder(reminderId);
    recordReminderUserOperation("acknowledged", before, reminder, `用户确认收到提醒：${reminder.title}`);
    window?.flashFrame(false);
    return reminder;
  });
  ipcMain.handle("pet:snooze-reminder", async (_event, id, minutes) => {
    const reminderId = String(id ?? "");
    const delayMinutes = Number(minutes) || 10;
    const before = store.reminder(reminderId);
    const reminder = E2E_MODE
      ? store.updateReminder(reminderId, {
        dueAt: new Date(Date.now() + delayMinutes * 60 * 1000).toISOString(),
        status: "scheduled",
        deliveredAt: null,
        acknowledgedAt: null,
        lastError: null,
      })
      : await snoozeReminder(store, appConfig, reminderId, delayMinutes);
    recordReminderUserOperation("snoozed", before, reminder, `用户将提醒延后 ${delayMinutes} 分钟：${reminder.title}`);
    window?.flashFrame(false);
    return reminder;
  });
  ipcMain.handle("pet:update-reminder", (_event, id, changes) => updatePetReminder(id, changes));
  ipcMain.handle("pet:cancel-reminder", (_event, id) => cancelPetReminder(id));
  ipcMain.handle("pet:approve-outbound-message", (_event, id, content) => approvePetOutboundMessage(id, content));
  ipcMain.handle("pet:cancel-outbound-message", (_event, id, reason) => cancelPetOutboundMessage(id, reason));
  ipcMain.handle("pet:set-expanded", (_event, value) => resizePet(value));
  ipcMain.handle("pet:set-pinned", (_event, value) => {
    if (!window) return false;
    if (value) window.setAlwaysOnTop(true, "floating");
    else window.setAlwaysOnTop(false);
    return window.isAlwaysOnTop();
  });
  ipcMain.handle("pet:hide", () => hidePet());
  createTray();
  createWindow();
  if (process.argv.includes("--open-attention-settings")) openAttentionSettings();
  if (process.argv.includes("--open-voice")) voiceWindow.open();
});

app.on("before-quit", () => {
  isQuitting = true;
  clearTimeout(moveTimer);
  clearInterval(gatewayRefreshTimer);
  try { settingsWindow?.destroy(); } catch { /* already closed */ }
  settingsWindow = null;
  voiceWindow?.dispose();
  tray?.destroy();
  tray = null;
  try { gatewayClient?.stop?.(); } catch { /* already closed */ }
  try { store?.close(); } catch { /* already closed */ }
});
