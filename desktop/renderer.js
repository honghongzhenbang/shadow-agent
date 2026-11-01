(async () => {
  const { mergeTaskConversationPage } = await import("../src/task-progress-presentation.mjs");
  const pet = document.getElementById("pet");
  const openclawStatus = document.getElementById("openclawStatus");
  const contextStatus = document.getElementById("contextStatus");
  const feishuStatus = document.getElementById("feishuStatus");
  const phaseTitle = document.getElementById("phaseTitle");
  const phaseDetail = document.getElementById("phaseDetail");
  const currentTask = document.getElementById("currentTask");
  const currentProject = document.getElementById("currentProject");
  const focusStrip = document.getElementById("focusStrip");
  const trackingStrip = document.getElementById("trackingStrip");
  const trackingTitle = document.getElementById("trackingTitle");
  const trackingDetail = document.getElementById("trackingDetail");
  const trackingCount = document.getElementById("trackingCount");
  const trackingView = document.getElementById("trackingView");
  const trackingViewCount = document.getElementById("trackingViewCount");
  const trackingViewStatus = document.getElementById("trackingViewStatus");
  const trackingViewList = document.getElementById("trackingViewList");
  const panelScroll = document.querySelector(".panel-scroll");
  const attentionCount = document.getElementById("attentionCount");
  const queuedCount = document.getElementById("queuedCount");
  const userActionCount = document.getElementById("userActionCount");
  const maintenanceText = document.getElementById("maintenanceText");
  const lastHeartbeat = document.getElementById("lastHeartbeat");
  const reminderSection = document.getElementById("reminderSection");
  const reminderList = document.getElementById("reminderList");
  const reminderCount = document.getElementById("reminderCount");
  const outboundSection = document.getElementById("outboundSection");
  const outboundList = document.getElementById("outboundList");
  const outboundCount = document.getElementById("outboundCount");
  const outboundConfirmView = document.getElementById("outboundConfirmView");
  const outboundRecipient = document.getElementById("outboundRecipient");
  const outboundKindBadge = document.getElementById("outboundKindBadge");
  const outboundReason = document.getElementById("outboundReason");
  const outboundSource = document.getElementById("outboundSource");
  const outboundContextSummary = document.getElementById("outboundContextSummary");
  const outboundContextMessages = document.getElementById("outboundContextMessages");
  const outboundContextEmpty = document.getElementById("outboundContextEmpty");
  const outboundEditor = document.getElementById("outboundEditor");
  const outboundActionStatus = document.getElementById("outboundActionStatus");
  const outboundSafetyText = document.getElementById("outboundSafetyText");
  const outboundConfirmActions = document.getElementById("outboundConfirmActions");
  const outboundRejectComposer = document.getElementById("outboundRejectComposer");
  const outboundRejectReason = document.getElementById("outboundRejectReason");
  const manualInputForm = document.getElementById("manualInputForm");
  const manualInput = document.getElementById("manualInput");
  const manualSubmitButton = document.getElementById("manualSubmitButton");
  const manualReceipt = document.getElementById("manualReceipt");
  const detailView = document.getElementById("detailView");
  const confirmDoneButton = document.getElementById("confirmDoneButton");
  const terminateTaskButton = document.getElementById("terminateTaskButton");
  const taskClosureDialog = document.getElementById("taskClosureDialog");
  const taskClosureForm = document.getElementById("taskClosureForm");
  const taskClosureNote = document.getElementById("taskClosureNote");
  const taskClosureOutcomes = document.getElementById("taskClosureOutcomes");
  const taskClosureError = document.getElementById("taskClosureError");
  const confirmTaskClosureButton = document.getElementById("confirmTaskClosureButton");
  const cancelTaskClosureButton = document.getElementById("cancelTaskClosureButton");
  const taskClosureStatus = document.getElementById("taskClosureStatus");
  const detailActionStatus = document.getElementById("detailActionStatus");
  const nextStepComposer = document.getElementById("nextStepComposer");
  const nextStepInput = document.getElementById("nextStepInput");
  const historyView = document.getElementById("historyView");
  const historyListPane = document.getElementById("historyListPane");
  const historyDetailPane = document.getElementById("historyDetailPane");
  const historySearchInput = document.getElementById("historySearchInput");
  let expanded = false;
  let pinned = true;
  let currentRunningTaskId = null;
  let selectedTaskId = null;
  let selectedTask = null;
  let taskSelectionGeneration = 0;
  let taskClosureSession = null;
  let sendingTaskMessage = false;
  const taskClosureAttempts = new Map();
  let selectedThreadId = null;
  let selectedOutboundId = null;
  let selectedTab = "conversation";
  let homeView = "conversation";
  const taskDrafts = new Map();
  const conversations = new Map();
  let conversationRefreshBusy = false;
  let historySearchTimer = null;
  let queueView = "user";
  let latestSnapshot = null;

  const phaseCopy = {
    starting: ["正在醒来", "连接工作现场", "waiting"],
    collecting: ["正在收集", "读取最新消息和项目变化", "running"],
    patrolling: ["正在思考", "判断下一项该推进的工作", "review"],
    idle: ["当前空闲", "等待新的变化", "idle"],
    offline: ["Agent 后台离线", "守护进程正在自动恢复", "failed"],
  };

  const statusLabels = {
    new: "待开始",
    planned: "已规划",
    running: "执行中",
    waiting_user: "等待确认",
    blocked: "受阻",
    failed: "失败",
    backlog: "历史线索",
    ready: "待处理",
    todo: "待处理",
    review: "待确认",
    done: "已完成",
    completed: "已完成",
    cancelled: "已终止",
    archived: "已归档",
    pending: "等待处理",
    leased: "处理中",
    review_needed: "需要复核",
  };
  const riskLabels = {
    read: "只读分析",
    "local-write": "本地修改",
    "external-write": "外部写入",
    "approval-decision": "审批判断",
    destructive: "高风险操作",
    "external-auth": "外部授权",
  };

  function relativeTime(value) {
    const time = Date.parse(value || "");
    if (!Number.isFinite(time)) return "未知";
    const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
    if (seconds < 60) return "刚刚";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时`;
    return `${Math.floor(seconds / 86400)} 天`;
  }

  function dateTime(value) {
    const parsed = Date.parse(value || "");
    if (!Number.isFinite(parsed)) return "无记录";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).format(parsed);
  }

  function setServiceStatus(element, state, detail) {
    element.dataset.state = state;
    element.title = detail;
    element.setAttribute("aria-label", `${element.textContent.trim()}：${detail}`);
  }

  function showManualReceipt(state, message) {
    manualReceipt.hidden = false;
    manualReceipt.dataset.state = state;
    manualReceipt.textContent = message;
    manualReceipt.title = message;
  }

  function localDateTimeValue(value) {
    const parsed = Date.parse(value || "");
    if (!Number.isFinite(parsed)) return "";
    const date = new Date(parsed - new Date(parsed).getTimezoneOffset() * 60_000);
    return date.toISOString().slice(0, 16);
  }

  function setHomeView(view) {
    homeView = view === "work" ? "work" : "conversation";
    pet.dataset.home = homeView;
    document.querySelectorAll(".home-tabs button").forEach((button) => {
      button.setAttribute("aria-selected", String(button.dataset.home === homeView));
    });
    if (homeView === "conversation") refreshConversation();
  }

  function renderConversation(key, page, { older = false } = {}) {
    const main = key === "main";
    const list = document.getElementById(main ? "mainConversationMessages" : "taskConversationMessages");
    const scroll = main ? document.getElementById("mainConversationScroll") : document.querySelector(".detail-content");
    const more = document.getElementById(main ? "mainConversationMore" : "taskConversationMore");
    const current = main ? conversations.get(key) ?? { messages: new Map() }
      : mergeTaskConversationPage(conversations.get(key), page, { older });
    if (main) {
      for (const message of page.messages) current.messages.set(message.id, message);
      if (older || !current.before) { current.before = page.before; current.hasMore = page.hasMore; }
    }
    const messages = main ? [...current.messages.values()].sort((a, b) => a.at.localeCompare(b.at)
      || (a.role === b.role ? a.id.localeCompare(b.id) : a.role === "user" ? -1 : 1)) : current.messages;
    conversations.set(key, current);
    const fingerprint = JSON.stringify(messages);
    const changedKey = list.dataset.key !== key;
    const bottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 45;
    const previousHeight = scroll.scrollHeight;
    if (list.dataset.fingerprint !== fingerprint || list.dataset.key !== key) {
      list.replaceChildren();
      if (!messages.length) {
        const empty = document.createElement("p");
        empty.className = "conversation-empty";
        empty.textContent = main ? "今天有什么要交给我？" : "还没有对话。";
        list.append(empty);
      }
      for (const message of messages) {
        const item = document.createElement("article");
        item.className = "conversation-message";
        item.dataset.role = message.role;
        item.dataset.messageId = message.id;
        const heading = document.createElement("header");
        const name = document.createElement("strong");
        name.textContent = message.role === "user" ? "你" : "Agent";
        const time = document.createElement("time");
        time.textContent = dateTime(message.at);
        heading.append(name, time);
        item.append(heading);
        if (message.aggregation) item.append(renderProgressReview(key, message, current));
        else if (message.text) item.append(renderMarkdown(message.text));
        if (message.status && message.status !== "completed") {
          const status = document.createElement("p");
          status.className = `message-status${message.status === "failed" ? " message-error" : ""}`;
          status.textContent = { queued: "已接收，等待处理", processing: "正在处理…", retry: "连接暂不可用，已保留并等待重试", failed: "处理失败" }[message.status] || message.status;
          if (message.error) status.textContent += `：${message.error}`;
          item.append(status);
        }
        if (message.operationDelivery) {
          const receipt = message.operationDelivery;
          const status = document.createElement("p");
          status.className = "message-status" + (["failed", "retry"].includes(receipt.status) ? " message-error" : "");
          status.dataset.operationDelivery = receipt.actionId;
          const label = { pending: "任务卡同步待处理", processing: "正在同步任务卡", retry: "任务卡同步失败，等待重试",
            failed: "任务卡同步失败", completed: "任务卡已同步", cancelled: "任务卡同步已取消" }[receipt.status] || receipt.status;
          status.textContent = label + (receipt.error ? "：" + receipt.error : "");
          item.append(status);
        }
        for (const task of message.tasks ?? []) {
          const link = document.createElement("button");
          link.type = "button";
          link.className = "task-link";
          link.dataset.taskId = task.id;
          const title = document.createElement("span");
          title.textContent = task.title;
          link.innerHTML = '<i data-lucide="folder-open"></i>';
          link.append(title);
          link.addEventListener("click", () => openTaskDetail(task.id));
          item.append(link);
        }
        list.append(item);
      }
      list.dataset.fingerprint = fingerprint;
      list.dataset.key = key;
      if (older) scroll.scrollTop += scroll.scrollHeight - previousHeight;
      else if (changedKey || bottom) scroll.scrollTop = scroll.scrollHeight;
      window.lucide?.createIcons();
    }
    more.hidden = !current.hasMore;
    conversations.set(key, current);
  }

  function renderProgressReview(taskId, message, state) {
    const group = message.aggregation;
    state.auditRows ??= new Map();
    state.expandedReviews ??= new Set();
    const details = document.createElement("details");
    details.className = "progress-review";
    details.dataset.count = String(group.count);
    details.open = group.sequences.some((seq) => state.expandedReviews.has(seq));
    const summary = document.createElement("summary");
    const icon = document.createElement("i");
    icon.dataset.lucide = "history";
    const label = document.createElement("span");
    label.className = "progress-review-label";
    label.append(document.createTextNode(`无变化复查 ${group.count} 次`));
    const times = document.createElement("span");
    times.className = "progress-review-times";
    times.textContent = `最近：${dateTime(group.lastCheckedAt)} · 下一复查：${dateTime(group.nextTrigger.nextReviewAt)}`;
    label.append(times);
    summary.append(icon, label);
    const originals = document.createElement("div");
    originals.className = "progress-review-originals";
    const status = document.createElement("p");
    status.className = "message-status";
    status.setAttribute("role", "status");
    const more = document.createElement("button");
    more.type = "button";
    more.className = "history-more";
    more.textContent = "查看更多原件";
    details.append(summary, originals, status, more);
    let visible = Math.min(group.count, Math.max(20, group.sequences.filter((seq) => state.auditRows.has(seq)).length));
    let busy = false;
    async function load(refresh = false) {
      if (busy) return;
      busy = true;
      more.disabled = true;
      status.textContent = "正在读取原件";
      try {
        const ids = group.sequences.slice(0, visible);
        const missing = refresh ? ids : ids.filter((seq) => !state.auditRows.has(seq));
        for (let offset = 0; offset < missing.length; offset += 100) {
          const page = await window.shadowPet.taskConversation(taskId, { view: "audit", sequences: missing.slice(offset, offset + 100) });
          if (!details.isConnected) return;
          if (page.taskId !== taskId) throw new Error("原件任务归属不匹配");
          for (const seq of missing.slice(offset, offset + 100)) state.auditRows.delete(seq);
          for (const row of page.audit ?? []) state.auditRows.set(row.seq, row);
        }
        if (!details.isConnected) return;
        originals.replaceChildren();
        for (const seq of ids) {
          const row = state.auditRows.get(seq);
          const article = document.createElement("article");
          article.className = "progress-review-original";
          article.dataset.eventSeq = String(seq);
          if (!row) {
            article.textContent = `事件 ${seq} 原件不可用`;
          } else {
            let metadata = {};
            try { metadata = JSON.parse(row.metadata_json) ?? {}; } catch { /* Raw row remains available below. */ }
            const label = document.createElement("p");
            label.className = "progress-review-source";
            label.textContent = `${dateTime(metadata.taskCheckpoint?.recordedAt || row.occurred_at || row.created_at)} · ${row.event_key}`;
            article.append(label, renderMarkdown(metadata.taskCheckpoint?.resultSummary || row.summary || ""));
            const raw = document.createElement("details");
            const rawTitle = document.createElement("summary");
            rawTitle.textContent = "原始审计记录";
            const pre = document.createElement("pre");
            pre.textContent = JSON.stringify(row, null, 2);
            raw.append(rawTitle, pre);
            article.append(raw);
          }
          originals.append(article);
        }
        status.textContent = `${ids.length} / ${group.count} 条原件`;
        more.hidden = visible >= group.count;
        more.textContent = "查看更多原件";
      } catch (error) {
        status.textContent = `原件读取失败：${error.message}`;
        more.hidden = false;
        more.textContent = "重试读取";
      } finally { busy = false; more.disabled = false; }
    }
    details.addEventListener("toggle", () => {
      if (!details.isConnected) return;
      for (const seq of group.sequences) {
        if (details.open) state.expandedReviews.add(seq);
        else state.expandedReviews.delete(seq);
      }
      if (details.open) load(true);
    });
    more.addEventListener("click", () => {
      if (more.textContent !== "重试读取") visible = Math.min(group.count, visible + 20);
      load();
    });
    return details;
  }

  async function refreshConversation(older = false) {
    if (conversationRefreshBusy || pet.dataset.expanded !== "true" || document.hidden) return;
    if (taskDetailLoadingGeneration === receiptDetailGeneration) return;
    const taskId = selectedTaskId;
    if (taskClosureAttempts.get(taskId)?.pending) return;
    const generation = receiptDetailGeneration;
    if (!taskId && homeView !== "conversation") return;
    const key = taskId || "main";
    const before = older ? conversations.get(key)?.before : null;
    conversationRefreshBusy = true;
    try {
      const page = taskId
        ? await window.shadowPet.taskConversation(taskId, { before, view: "progress" })
        : await window.shadowPet.mainConversation({ before });
      if (selectedTaskId !== taskId || generation !== receiptDetailGeneration) return;
      if (page.task) renderTaskHeading(page.task);
      renderConversation(key, page, { older });
    } catch (error) {
      if (selectedTaskId === taskId && generation === receiptDetailGeneration) {
        if (taskId) detailActionStatus.textContent = `对话读取失败：${error.message}`;
        else showManualReceipt("error", `对话读取失败：${error.message}`);
      }
    } finally { conversationRefreshBusy = false; }
  }

  function taskHandlingCopy(task, mode = "agent") {
    if (["done", "cancelled", "archived"].includes(task.status)) return statusLabels[task.status];
    if (mode === "user") return task.user_action?.request || (task.status === "review" ? "需要你确认执行结果" : "需要你处理");
    if (mode === "completed") return "Agent 已处理";
    if (task.handling_state === "running") return "正在执行";
    if (task.handling_state === "verifying") return "Agent 正在核对";
    if (task.handling_state === "queued_review") return "等待 Agent 核对";
    if (task.handling_state === "recovery") return "等待 Agent 重新规划";
    if (task.handling_state === "watching") return "Agent 正在监控外部条件";
    if (task.handling_state === "scheduled") return "Agent 已安排内部复查";
    if (task.status === "blocked") return `Agent 受阻：${task.blocked_reason || "等待条件恢复"}`;
    return "Agent 待处理";
  }

  function taskRow(task, mode = "agent") {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `task-row ${task.status === "cancelled" ? "terminated" : task.status === "archived" ? "archived"
      : mode === "user" ? "needs-user" : mode === "completed" ? "completed" : "agent-queue"}`;
    row.dataset.taskId = task.id;
    row.setAttribute("aria-label", `查看任务：${task.title}`);
    row.addEventListener("click", () => openTaskDetail(task.id));
    const dot = document.createElement("span");
    dot.className = "task-dot";
    if (task.status === "cancelled") dot.innerHTML = '<i data-lucide="circle-stop"></i>';
    const main = document.createElement("span");
    main.className = "task-main";
    const title = document.createElement("strong");
    title.textContent = task.title;
    const meta = document.createElement("small");
    const priority = ["critical", "high"].includes(task.priority) ? " · 高优先级" : "";
    const ownership = taskHandlingCopy(task, mode);
    meta.textContent = `${ownership}${priority}${task.project_name ? ` · ${task.project_name}` : ""}`;
    const time = document.createElement("span");
    time.className = "task-time";
    time.textContent = relativeTime(task.updated_at);
    main.append(title, meta);
    row.append(dot, main, time);
    return row;
  }

  function renderList(id, tasks, mode = "agent") {
    const list = document.getElementById(id);
    list.replaceChildren();
    if (!tasks.length) {
      const empty = document.createElement("div");
      empty.className = "empty-row";
      empty.textContent = mode === "completed"
        ? "还没有新的处理完成记录"
        : mode === "user" ? "目前没有需要你确认的事项" : "Agent 待处理队列已经清空";
      list.append(empty);
      return;
    }
    tasks.forEach((task) => list.append(taskRow(task, mode)));
    window.lucide?.createIcons();
  }

  function reminderDueLabel(reminder) {
    const due = Date.parse(reminder.due_at || "");
    if (!Number.isFinite(due)) return "时间未知";
    const delta = due - Date.now();
    if (reminder.status === "delivered" || delta <= 0) return "已到期";
    if (delta < 3600000) return `${Math.max(1, Math.ceil(delta / 60000))} 分钟后`;
    if (delta < 86400000) return `${Math.ceil(delta / 3600000)} 小时后`;
    return dateTime(reminder.due_at);
  }

  function reminderRow(reminder) {
    const due = Date.parse(reminder.due_at || "");
    const delivered = reminder.status === "delivered" || (Number.isFinite(due) && due <= Date.now());
    const row = document.createElement("article");
    row.className = `reminder-row${delivered ? "" : " is-upcoming"}`;
    row.dataset.reminderId = reminder.id;
    const main = document.createElement("div");
    main.className = "reminder-main";
    const icon = document.createElement("i");
    icon.dataset.lucide = delivered ? "bell-ring" : "clock-3";
    const copy = document.createElement("div");
    copy.className = "reminder-copy";
    const title = document.createElement("strong");
    title.textContent = reminder.title;
    const detail = document.createElement("small");
    detail.textContent = [reminder.message, reminder.source_locator ? `来源：${reminder.source_locator}` : ""].filter(Boolean).join(" · ");
    const time = document.createElement("span");
    time.className = "reminder-time";
    time.textContent = reminderDueLabel(reminder);
    copy.append(title, detail);
    main.append(icon, copy, time);
    const actions = document.createElement("div");
    actions.className = "reminder-actions";
    const feedback = document.createElement("div");
    feedback.className = "reminder-feedback";
    feedback.setAttribute("aria-live", "polite");
    const setFeedback = (state, message) => {
      feedback.dataset.state = state;
      feedback.textContent = message;
    };
    const acknowledge = document.createElement("button");
    acknowledge.type = "button";
    acknowledge.className = "reminder-action primary";
    acknowledge.innerHTML = '<i data-lucide="check"></i><span>知道了</span>';
    acknowledge.addEventListener("click", async () => {
      acknowledge.disabled = true;
      setFeedback("pending", "正在确认提醒");
      try {
        await window.shadowPet.acknowledgeReminder(reminder.id);
        setFeedback("success", "已确认");
        await refresh();
      } catch (error) {
        setFeedback("error", `确认失败：${error.message}`);
        acknowledge.disabled = false;
      }
    });
    const snooze = document.createElement("button");
    snooze.type = "button";
    snooze.className = "reminder-action";
    snooze.innerHTML = '<i data-lucide="alarm-clock-plus"></i><span>延后</span>';
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "reminder-action icon-only";
    edit.title = "修改提醒";
    edit.setAttribute("aria-label", "修改提醒");
    edit.innerHTML = '<i data-lucide="pencil"></i>';
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "reminder-action icon-only danger";
    cancel.title = "取消提醒";
    cancel.setAttribute("aria-label", "取消提醒");
    cancel.innerHTML = '<i data-lucide="trash-2"></i>';

    const snoozeForm = document.createElement("form");
    snoozeForm.className = "reminder-inline-form snooze-form";
    snoozeForm.hidden = true;
    snoozeForm.innerHTML = `
      <label><span>延后分钟</span><input name="minutes" type="number" min="1" max="10080" step="1" value="10" required></label>
      <div class="reminder-form-actions">
        <button class="reminder-action" type="button" data-action="close">取消</button>
        <button class="reminder-action primary" type="submit">确认延后</button>
      </div>`;
    snooze.addEventListener("click", () => {
      snoozeForm.hidden = !snoozeForm.hidden;
      editForm.hidden = true;
      if (!snoozeForm.hidden) snoozeForm.elements.minutes.focus();
    });
    snoozeForm.querySelector('[data-action="close"]').addEventListener("click", () => { snoozeForm.hidden = true; });
    snoozeForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const minutes = Number(snoozeForm.elements.minutes.value);
      const submit = snoozeForm.querySelector('[type="submit"]');
      submit.disabled = true;
      setFeedback("pending", `正在延后 ${minutes} 分钟`);
      try {
        await window.shadowPet.snoozeReminder(reminder.id, minutes);
        setFeedback("success", `已延后 ${minutes} 分钟`);
        await refresh();
      } catch (error) {
        setFeedback("error", `延后失败：${error.message}`);
        submit.disabled = false;
      }
    });

    const editForm = document.createElement("form");
    editForm.className = "reminder-inline-form edit-form";
    editForm.hidden = true;
    editForm.innerHTML = `
      <label><span>标题</span><input name="title" maxlength="200" required></label>
      <label><span>内容</span><input name="message" maxlength="1000"></label>
      <label><span>时间</span><input name="dueAt" type="datetime-local" required></label>
      <div class="reminder-form-actions">
        <button class="reminder-action" type="button" data-action="close">取消</button>
        <button class="reminder-action primary" type="submit">保存修改</button>
      </div>`;
    editForm.elements.title.value = reminder.title || "";
    editForm.elements.message.value = reminder.message || "";
    editForm.elements.dueAt.value = localDateTimeValue(reminder.due_at);
    edit.addEventListener("click", () => {
      editForm.hidden = !editForm.hidden;
      snoozeForm.hidden = true;
      if (!editForm.hidden) editForm.elements.title.focus();
    });
    editForm.querySelector('[data-action="close"]').addEventListener("click", () => { editForm.hidden = true; });
    editForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = editForm.querySelector('[type="submit"]');
      const dueAt = new Date(editForm.elements.dueAt.value).toISOString();
      submit.disabled = true;
      setFeedback("pending", "正在修改提醒");
      try {
        await window.shadowPet.updateReminder(reminder.id, {
          title: editForm.elements.title.value.trim(),
          message: editForm.elements.message.value.trim(),
          dueAt,
        });
        setFeedback("success", "提醒已修改");
        await refresh();
      } catch (error) {
        setFeedback("error", `修改失败：${error.message}`);
        submit.disabled = false;
      }
    });
    cancel.addEventListener("click", async () => {
      cancel.disabled = true;
      setFeedback("pending", "正在取消提醒");
      try {
        await window.shadowPet.cancelReminder(reminder.id);
        setFeedback("success", "提醒已取消");
        await refresh();
      } catch (error) {
        setFeedback("error", `取消失败：${error.message}`);
        cancel.disabled = false;
      }
    });
    actions.append(acknowledge, snooze, edit, cancel);
    row.append(main, actions, snoozeForm, editForm, feedback);
    return row;
  }

  function renderReminders(reminders) {
    reminderList.replaceChildren();
    reminderSection.hidden = reminders.length === 0;
    reminderCount.textContent = String(reminders.length);
    document.getElementById("reminderHeading").textContent = reminders.some((item) => item.status === "delivered") ? "到期提醒" : "接下来提醒";
    for (const reminder of reminders) reminderList.append(reminderRow(reminder));
    if (window.lucide) window.lucide.createIcons();
  }

  function outboundKindLabel(kind) {
    if (kind === "reply") return "回复";
    if (kind === "question") return "主动询问";
    return "主动消息";
  }

  function contextTime(value) {
    const timestamp = Date.parse(value || "");
    if (!Number.isFinite(timestamp)) return "";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(timestamp));
  }

  function outboundContextRow(message, { trigger = false } = {}) {
    const row = document.createElement("div");
    row.className = `outbound-context-row ${message.direction === "outgoing" ? "is-outgoing" : "is-incoming"}${trigger ? " is-trigger" : ""}`;
    const meta = document.createElement("div");
    const role = document.createElement("strong");
    role.textContent = trigger
      ? `触发消息 · ${message.senderName || "对方"}`
      : message.direction === "outgoing" ? "已发送" : (message.senderName || "对方");
    const time = document.createElement("time");
    time.textContent = contextTime(message.occurredAt);
    const content = document.createElement("p");
    content.textContent = message.content;
    meta.append(role, time);
    row.append(meta, content);
    return row;
  }

  function renderOutboundContext(draft) {
    const context = draft.review_context || {};
    const recent = Array.isArray(context.recentMessages) ? context.recentMessages : [];
    outboundContextMessages.replaceChildren();
    outboundContextSummary.textContent = context.summary || "";
    outboundContextSummary.hidden = !context.summary;
    for (const message of recent) outboundContextMessages.append(outboundContextRow(message));
    if (context.trigger?.content) outboundContextMessages.append(outboundContextRow(context.trigger, { trigger: true }));
    outboundContextEmpty.hidden = Boolean(context.summary || recent.length || context.trigger?.content);
    outboundSource.textContent = draft.source_locator ? `来源：${draft.source_locator}` : "";
    outboundSource.hidden = !draft.source_locator;
  }

  function openOutboundConfirmation(draftId) {
    const draft = latestSnapshot?.outboundMessages?.find((item) => item.id === draftId);
    if (!draft || draft.status !== "pending_confirmation") return;
    closeTaskDetail();
    closeHistory();
    closeTracking();
    selectedOutboundId = draft.id;
    outboundRecipient.textContent = draft.recipient_name;
    outboundKindBadge.textContent = outboundKindLabel(draft.message_kind);
    outboundReason.textContent = draft.reason || "Agent 建议发送此消息，请复核收件人与正文。";
    renderOutboundContext(draft);
    outboundEditor.value = draft.content;
    outboundSafetyText.textContent = draft.sender_identity === "bot"
      ? "仅在你点击确认后，以 Shadow Agent 机器人身份进入可靠发送队列。"
      : "仅在你点击确认后，以你的飞书身份进入可靠发送队列。";
    outboundActionStatus.textContent = "";
    outboundRejectComposer.hidden = true;
    outboundConfirmActions.hidden = false;
    outboundRejectReason.value = "";
    outboundConfirmView.hidden = false;
    pet.dataset.outbound = "true";
    setTimeout(() => outboundEditor.focus(), 0);
  }

  function closeOutboundConfirmation() {
    selectedOutboundId = null;
    outboundConfirmView.hidden = true;
    pet.dataset.outbound = "false";
    outboundActionStatus.textContent = "";
    outboundRejectComposer.hidden = true;
    outboundConfirmActions.hidden = false;
    outboundRejectReason.value = "";
  }

  function setOutboundRejectMode(active) {
    outboundRejectComposer.hidden = !active;
    outboundConfirmActions.hidden = active;
    outboundActionStatus.textContent = "";
    if (!active) {
      outboundRejectReason.value = "";
      return;
    }
    setTimeout(() => outboundRejectReason.focus(), 0);
  }

  function outboundRow(draft) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "outbound-row";
    row.dataset.outboundId = draft.id;
    const icon = document.createElement("i");
    icon.dataset.lucide = draft.message_kind === "reply" ? "reply" : "message-square-more";
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = `${outboundKindLabel(draft.message_kind)} · ${draft.recipient_name}`;
    const preview = document.createElement("small");
    preview.textContent = draft.content;
    copy.append(title, preview);
    const action = document.createElement("b");
    action.textContent = "复核";
    row.append(icon, copy, action);
    row.addEventListener("click", () => openOutboundConfirmation(draft.id));
    return row;
  }

  function renderOutboundMessages(messages) {
    const pending = messages.filter((draft) => draft.status === "pending_confirmation");
    outboundList.replaceChildren();
    outboundSection.hidden = pending.length === 0;
    outboundCount.textContent = String(pending.length);
    for (const draft of pending) outboundList.append(outboundRow(draft));
    if (window.lucide) window.lucide.createIcons();
  }

  function trackingEvidenceGroup(label, items) {
    if (!items.length) return null;
    const details = document.createElement("details");
    details.className = "tracking-evidence";
    const summary = document.createElement("summary");
    summary.textContent = `${label} ${items.length}`;
    details.append(summary);
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "tracking-evidence-row";
      const title = document.createElement("strong");
      title.textContent = item.title || item.kind || "未命名证据";
      const meta = document.createElement("small");
      meta.textContent = `${item.kind || "evidence"} · ${dateTime(item.occurred_at || item.collected_at)}`;
      const content = document.createElement("pre");
      content.textContent = item.content || "无正文";
      const source = document.createElement("span");
      source.textContent = item.source_locator ? `来源：${item.source_locator}` : "";
      source.hidden = !item.source_locator;
      row.append(title, meta, content, source);
      details.append(row);
    }
    return details;
  }

  function trackingRow(item) {
    const statusCopy = {
      active: ["等待中", "active"],
      candidate: ["待 Agent 判断", "review"],
      timed_out: ["超时待 Agent 处理", "timeout"],
    }[item.status] || [item.status || "未知", "idle"];
    const row = document.createElement("article");
    row.className = "tracking-view-item";
    row.dataset.state = statusCopy[1];
    const heading = document.createElement("div");
    heading.className = "tracking-item-heading";
    const title = document.createElement("strong");
    title.textContent = item.title || "未命名追踪";
    const badge = document.createElement("span");
    badge.textContent = statusCopy[0];
    heading.append(title, badge);
    const condition = document.createElement("p");
    condition.textContent = item.condition_text || "未记录判断条件";
    const timing = document.createElement("div");
    timing.className = "tracking-item-meta";
    const timingParts = [`更新于 ${relativeTime(item.updated_at)}`];
    if (item.last_checked_at) timingParts.push(`上次检查 ${dateTime(item.last_checked_at)}`);
    if (item.timeout_at) timingParts.push(`截止 ${dateTime(item.timeout_at)}`);
    if (item.candidate_at) timingParts.push(`发现结果 ${dateTime(item.candidate_at)}`);
    timing.textContent = timingParts.join(" · ");
    row.append(heading, condition, timing);
    if (["candidate", "timed_out"].includes(item.status)) {
      const ownership = document.createElement("div");
      ownership.className = "tracking-item-link";
      ownership.textContent = "由 Agent 核对候选证据，当前不需要你操作";
      row.append(ownership);
    }
    if (item.task_id) {
      const task = document.createElement("div");
      task.className = "tracking-item-link";
      task.textContent = `关联任务：${item.task_title || item.task_id}${item.task_status ? ` · ${item.task_status}` : ""}`;
      row.append(task);
    }
    if (item.conversation_key) {
      const conversation = document.createElement("div");
      conversation.className = "tracking-item-link";
      conversation.textContent = `关联会话：${item.conversation_provider || "agent"} / ${item.conversation_key}`;
      row.append(conversation);
    }
    if (item.last_error) {
      const error = document.createElement("div");
      error.className = "tracking-item-error";
      error.textContent = `最近错误：${item.last_error}`;
      row.append(error);
    }
    const candidateEvidence = trackingEvidenceGroup("候选证据", item.candidate_evidence || []);
    const sourceEvidence = trackingEvidenceGroup("起始证据", item.source_evidence || []);
    if (candidateEvidence) row.append(candidateEvidence);
    if (sourceEvidence) row.append(sourceEvidence);
    return row;
  }

  function renderTrackingView(tracking = latestSnapshot?.tracking) {
    const items = Array.isArray(tracking?.items) ? tracking.items : [];
    const active = Number(tracking?.active ?? 0);
    const review = Number(tracking?.needsReview ?? 0);
    trackingViewCount.textContent = `${items.length} 项追踪`;
    trackingViewStatus.textContent = review
      ? `${review} 项候选信息由 Agent 核对${active ? `，${active} 项仍在等待` : ""}`
      : active ? `${active} 项正在等待外部变化` : "暂无持续追踪";
    trackingViewList.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "tracking-view-empty";
      empty.textContent = "当前没有活动、待判断或超时的持续追踪。";
      trackingViewList.append(empty);
    } else {
      for (const item of items) trackingViewList.append(trackingRow(item));
    }
  }

  function openTracking() {
    if (!latestSnapshot?.tracking?.items?.length) return;
    closeTaskDetail();
    closeHistory();
    closeOutboundConfirmation();
    trackingView.hidden = false;
    pet.dataset.tracking = "true";
    trackingStrip.setAttribute("aria-expanded", "true");
    renderTrackingView();
    if (window.lucide) window.lucide.createIcons();
  }

  function closeTracking() {
    trackingView.hidden = true;
    pet.dataset.tracking = "false";
    trackingStrip.setAttribute("aria-expanded", "false");
  }

  function setQueueView(view) {
    queueView = view === "agent" ? "agent" : "user";
    document.querySelectorAll(".queue-tab").forEach((tab) => {
      const active = tab.dataset.queue === queueView;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    if (!latestSnapshot) return;
    const visible = queueView === "user" ? latestSnapshot.needsUser : [...latestSnapshot.running, ...latestSnapshot.queued];
    const total = queueView === "user"
      ? (latestSnapshot.counts?.needsUser ?? visible.length)
      : visible.length;
    renderList("queuedList", visible, queueView);
    document.getElementById("queuedList").dataset.total = String(total);
  }

  function badge(text, tone = "") {
    const item = document.createElement("span");
    item.className = `detail-badge ${tone}`.trim();
    item.textContent = text;
    return item;
  }

  function renderMarkdown(content, className = "markdown-body") {
    const body = document.createElement("div");
    body.className = className;
    const source = String(content || "无记录");
    if (!window.marked || !window.DOMPurify) {
      body.textContent = source;
      return body;
    }
    const parsed = window.marked.parse(source, { gfm: true, breaks: true });
    body.innerHTML = window.DOMPurify.sanitize(parsed, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["img", "video", "audio", "iframe", "object", "embed"],
      FORBID_ATTR: ["style"],
    });
    body.querySelectorAll("a").forEach((link) => {
      link.target = "_blank";
      link.rel = "noreferrer noopener";
    });
    return body;
  }

  function detailBlock(title, content) {
    const block = document.createElement("section");
    block.className = "detail-block";
    const heading = document.createElement("h3");
    heading.textContent = title;
    block.append(heading, renderMarkdown(content));
    return block;
  }

  function keyValues(items) {
    const block = document.createElement("section");
    block.className = "detail-block";
    const list = document.createElement("dl");
    list.className = "detail-kv";
    for (const [key, value] of items) {
      const term = document.createElement("dt");
      term.textContent = key;
      const description = document.createElement("dd");
      description.textContent = value ?? "无记录";
      list.append(term, description);
    }
    block.append(list);
    return block;
  }

  function timelineItem(title, meta, result, failed = false) {
    const item = document.createElement("article");
    item.className = `timeline-item${failed ? " failed" : ""}`;
    const heading = document.createElement("strong");
    heading.textContent = title;
    const detail = document.createElement("small");
    detail.textContent = meta;
    item.append(heading, detail);
    if (result) {
      item.append(renderMarkdown(result, "timeline-result markdown-body"));
    }
    return item;
  }

  function fenced(value) {
    return `\`\`\`text\n${String(value ?? "").replaceAll("```", "` ` `")}\n\`\`\``;
  }

  function traceSummary(trace) {
    switch (trace.type) {
      case "command_execution":
        return {
          title: "执行命令",
          meta: [trace.status, trace.exitCode === undefined ? "" : `退出码 ${trace.exitCode}`].filter(Boolean).join(" · "),
          result: [`**命令**\n${fenced(trace.command)}`, trace.output ? `**输出**\n${fenced(trace.output)}` : ""].filter(Boolean).join("\n\n"),
        };
      case "mcp_tool_call":
        return {
          title: `调用工具 · ${trace.tool}`,
          meta: trace.status || "工具调用",
          result: [trace.arguments ? `**参数**\n${fenced(trace.arguments)}` : "", trace.error ? `**错误**\n${trace.error}` : trace.result ? `**返回**\n${fenced(trace.result)}` : ""].filter(Boolean).join("\n\n"),
        };
      case "file_change":
        return {
          title: "文件变更",
          meta: trace.status || "文件操作",
          result: (trace.changes || []).map((change) => `- \`${change.kind}\` ${change.path}`).join("\n"),
        };
      case "web_search": return { title: "网页搜索", meta: trace.status || "搜索", result: trace.query };
      case "todo_list": return { title: "调整执行计划", meta: trace.status || "计划", result: (trace.items || []).map((item) => `- ${item.text || item}`).join("\n") };
      case "reasoning": return { title: "判断与推理", meta: trace.status || "分析", result: trace.text };
      case "error": return { title: "执行错误", meta: "失败", result: trace.message, failed: true };
      default: return { title: trace.type || "执行步骤", meta: trace.status || "", result: "" };
    }
  }

  function traceGroup(trace) {
    if (!Array.isArray(trace) || !trace.length) return null;
    const group = document.createElement("details");
    group.className = "trace-group";
    const summary = document.createElement("summary");
    summary.innerHTML = `<span>查看具体执行步骤</span><small>${trace.length} 项</small>`;
    const body = document.createElement("div");
    body.className = "trace-list";
    for (const step of trace) {
      const formatted = traceSummary(step);
      const item = timelineItem(formatted.title, formatted.meta, formatted.result, formatted.failed);
      item.classList.add("trace-item");
      body.append(item);
    }
    group.append(summary, body);
    return group;
  }

  function setDetailTab(name) {
    selectedTab = name;
    document.querySelectorAll(".detail-tab").forEach((tab) => {
      const active = tab.dataset.tab === name;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll(".detail-pane").forEach((pane) => {
      pane.hidden = pane.dataset.pane !== name;
    });
  }

  function renderTaskHeading(task) {
    if (task.id !== selectedTaskId) return;
    selectedTask = { ...selectedTask, ...task };
    document.getElementById("detailTitle").textContent = task.title;
    document.getElementById("taskComposerLabel").textContent = `交代：${task.title}`;
    const badges = document.getElementById("detailBadges");
    badges.replaceChildren(
      badge(statusLabels[task.status] || task.status, task.status === "failed" ? "warning" : "accent"),
      ...(task.project_name ? [badge(task.project_name)] : []),
    );
    confirmDoneButton.querySelector("span").textContent = task.status === "done" ? "已确认完成" : "确认已完成";
    updateTaskClosureControls();
    renderTaskClosureStatus();
  }

  function isTerminalTask(task) {
    return ["done", "cancelled", "archived"].includes(task?.status);
  }

  function isCurrentTaskClosure(session) {
    return taskClosureSession === session && session.cardId === selectedTaskId
      && session.generation === taskSelectionGeneration && !detailView.hidden && taskClosureDialog.open;
  }

  function showTaskClosureError(message) {
    taskClosureError.textContent = message;
    taskClosureError.hidden = !message;
  }

  function updateTaskClosureControls() {
    const attempt = taskClosureAttempts.get(selectedTaskId);
    const unavailable = !selectedTask || selectedTask.id !== selectedTaskId || isTerminalTask(selectedTask)
      || Boolean(selectedTask.closure) || attempt?.pending || attempt?.accepted || sendingTaskMessage;
    confirmDoneButton.disabled = Boolean(unavailable);
    terminateTaskButton.disabled = Boolean(unavailable);
    document.getElementById("saveNextStepButton").disabled = Boolean(sendingTaskMessage || attempt?.pending || taskClosureDialog.open);
    const pending = Boolean(taskClosureSession && taskClosureAttempts.get(taskClosureSession.cardId)?.pending);
    taskClosureForm.setAttribute("aria-busy", String(pending));
    taskClosureOutcomes.disabled = pending;
    taskClosureNote.disabled = pending;
    cancelTaskClosureButton.disabled = pending;
    confirmTaskClosureButton.disabled = pending || Boolean(unavailable)
      || !taskClosureSession || !isCurrentTaskClosure(taskClosureSession);
    if (taskClosureSession && !pending && isTerminalTask(selectedTask)) {
      showTaskClosureError("任务已结束，不能再次确认关闭。");
    }
  }

  function taskClosurePresentation(task) {
    const attempt = taskClosureAttempts.get(task.id);
    const closure = task.closure ?? (attempt?.accepted ? {
      outcome: attempt.outcome, note: attempt.note,
      status: attempt.operation?.queued ? "queued" : "applied", operationId: attempt.operationId,
    } : null);
    const executionStop = task.executionStop ?? attempt?.operation?.executionStop;
    if (!closure && !executionStop) return null;
    const outcomeLabel = closure?.outcome === "cancelled" ? "终止" : "完成";
    const result = !closure ? `任务${statusLabels[task.status] || task.status}` : closure.status === "queued"
      ? `${outcomeLabel}确认已保存，等待后台同步`
      : isTerminalTask(task) ? `任务${statusLabels[task.status]}` : `${outcomeLabel}确认已保存`;
    const stop = {
      stopped: "执行已确认停止",
      not_running: "执行：未在运行",
      pending: "执行停止待确认",
      unconfirmed: "执行停止未确认",
    }[executionStop?.status] || "执行停止未确认";
    return { closure, text: `${result}；${stop}${executionStop?.error ? `（${executionStop.error}）` : ""}` };
  }

  function renderTaskClosureStatus() {
    const presentation = selectedTask ? taskClosurePresentation(selectedTask) : null;
    taskClosureStatus.hidden = !presentation;
    taskClosureStatus.textContent = presentation?.text || "";
  }

  function updateTaskClosureOutcome() {
    const terminated = taskClosureForm.elements.outcome.value === "cancelled";
    confirmTaskClosureButton.classList.toggle("success", !terminated);
    confirmTaskClosureButton.classList.toggle("danger", terminated);
    confirmTaskClosureButton.querySelector("span").textContent = terminated ? "确认终止" : "确认完成";
  }

  function openTaskClosure(outcome) {
    if (taskClosureDialog.open || !selectedTaskId || confirmDoneButton.disabled) return;
    const previous = taskClosureAttempts.get(selectedTaskId);
    taskClosureSession = { cardId: selectedTaskId, generation: taskSelectionGeneration };
    taskClosureDialog.dataset.cardId = selectedTaskId;
    document.getElementById("taskClosureTaskName").textContent = selectedTask.title;
    taskClosureForm.elements.outcome.value = outcome;
    taskClosureNote.value = previous?.note || "";
    showTaskClosureError("");
    updateTaskClosureOutcome();
    taskClosureDialog.showModal();
    updateTaskClosureControls();
    cancelTaskClosureButton.focus();
  }

  function dismissTaskClosure(force = false) {
    if (!force && taskClosureAttempts.get(taskClosureSession?.cardId)?.pending) return;
    taskClosureSession = null;
    if (taskClosureDialog.open) taskClosureDialog.close();
    delete taskClosureDialog.dataset.cardId;
    updateTaskClosureControls();
  }

  let receiptDetailFingerprint = "";
  let receiptDetailReadPending = false;
  let receiptDetailGeneration = 0;
  let receiptDetailReadError = "";
  let taskDetailLoadingGeneration = null;

  async function refreshReceiptDetails() {
    if (taskDetailLoadingGeneration === receiptDetailGeneration) return;
    if (receiptDetailReadPending || !selectedTaskId || detailView.hidden
        || taskClosureAttempts.get(selectedTaskId)?.pending
        || document.hidden || pet.dataset.expanded !== "true") return;
    const taskId = selectedTaskId;
    const tab = selectedTab;
    const generation = receiptDetailGeneration;
    receiptDetailReadPending = true;
    try {
      const details = await window.shadowPet.taskDetails(taskId);
      if (selectedTaskId !== taskId || selectedTab !== tab || detailView.hidden
          || generation !== receiptDetailGeneration) return;
      if (!details || details.task?.id !== taskId) return;
      if (JSON.stringify(details) !== receiptDetailFingerprint) renderTaskDetails(details);
      if (receiptDetailReadError && detailActionStatus.textContent === receiptDetailReadError) detailActionStatus.textContent = "";
      receiptDetailReadError = "";
    } catch (error) {
      if (selectedTaskId === taskId && selectedTab === tab && !detailView.hidden
          && generation === receiptDetailGeneration) {
        receiptDetailReadError = "跟进记录读取失败：" + error.message;
        detailActionStatus.textContent = receiptDetailReadError;
      }
    } finally {
      receiptDetailReadPending = false;
    }
  }

  function renderTaskDetails(details) {
    if (details.task?.id !== selectedTaskId) return;
    receiptDetailFingerprint = JSON.stringify(details);
    const { task, patrol, actions, evidence, linkedConditions = [], workboard } = details;
    renderTaskHeading(task);
    if (details.conversation) renderConversation(task.id, details.conversation);
    document.getElementById("detailDescription").textContent = task.description || "无任务说明";
    const overview = document.getElementById("detailOverview");
    overview.replaceChildren(keyValues([
      ["任务编号", task.id],
      ["执行类型", task.action_type],
      ["优先级", task.priority],
      ["尝试次数", String(task.attempts ?? 0)],
      ["创建时间", dateTime(task.created_at)],
      ["最近更新", dateTime(task.updated_at)],
      ["归属依据", task.metadata?.assignmentBasis || "历史任务/已知职责"],
      ["总控卡片", workboard?.cardId || "尚未迁移"],
      ["总控状态", workboard?.status || "本地任务"],
      ["当前处理者", task.handling_lane === "user" ? "需要你" : task.handling_lane === "agent" ? "Agent" : "已结束"],
      ["当前进展", taskHandlingCopy(task, task.handling_lane === "user" ? "user" : "agent")],
    ]));
    overview.append(detailBlock("任务说明", task.description || "无任务说明"));
    const closurePresentation = taskClosurePresentation(selectedTask);
    if (closurePresentation) {
      const record = document.createElement("section");
      record.id = "taskClosureRecord";
      record.className = "detail-block";
      const heading = document.createElement("h3");
      heading.textContent = "任务关闭记录";
      const result = document.createElement("p");
      result.textContent = closurePresentation.text;
      const note = document.createElement("p");
      note.id = "taskClosureRecordNote";
      note.className = "task-closure-record-note";
      note.textContent = closurePresentation.closure?.note || "无备注";
      record.append(heading, result, note);
      overview.append(record);
    }
    if (linkedConditions.length) {
      const conditionCopy = linkedConditions.map((condition) => {
        const status = {
          active: "等待外部变化",
          candidate: "已发现候选信息，等待 Agent 核对",
          timed_out: "已到复查时间，等待 Agent 核对",
        }[condition.status] || condition.status;
        const evidence = condition.candidate_evidence?.map((item) => `  - ${item.title || item.kind}：${String(item.content || "").slice(0, 300)}`).join("\n");
        return [
          `- **${condition.title || "未命名跟踪"}**：${status}`,
          `  - 条件：${condition.condition_text || "未记录"}`,
          condition.last_checked_at ? `  - 最近检查：${dateTime(condition.last_checked_at)}` : "",
          evidence,
        ].filter(Boolean).join("\n");
      }).join("\n");
      overview.append(detailBlock("关联跟踪", conditionCopy));
    }
    if (task.result) overview.append(detailBlock("当前结果", task.result));
    else overview.append(detailBlock("当前状态", task.last_error || "尚未生成执行结果，后台会按优先级推进。"));

    const execution = document.getElementById("detailExecution");
    execution.replaceChildren();
    if (patrol) {
      const item = timelineItem(
        "Codex 巡查发现任务",
        `${dateTime(patrol.started_at)} · 巡查 ${patrol.id}`,
        [patrol.summary, patrol.codex_thread_id ? `Codex 会话：${patrol.codex_thread_id}` : ""].filter(Boolean).join("\n\n"),
        patrol.status === "failed",
      );
      const trace = traceGroup(patrol.metadata?.trace);
      if (trace) item.append(trace);
      execution.append(item);
    }
    for (const action of actions) {
      const threadId = action.metadata?.codexThreadId;
      const item = timelineItem(
        action.command_summary || action.action_type,
        `${dateTime(action.started_at)} 至 ${dateTime(action.completed_at)} · ${riskLabels[action.risk_level] || action.risk_level} · ${statusLabels[action.status] || action.status}`,
        [threadId ? `Codex 会话：${threadId}` : "", action.error || action.result || ""].filter(Boolean).join("\n\n"),
        action.status === "failed",
      );
      const trace = traceGroup(action.metadata?.trace);
      if (trace) item.append(trace);
      execution.append(item);
    }
    if (!patrol && !actions.length) execution.append(detailBlock("尚未执行", "该任务目前只进入队列，还没有 Codex 执行动作或会话记录。"));

    const evidencePane = document.getElementById("detailEvidence");
    evidencePane.replaceChildren();
    if (!evidence.length) evidencePane.append(detailBlock("暂无来源证据", "该任务没有关联到可展示的证据。"));
    for (const item of evidence) {
      const wrapper = document.createElement("details");
      wrapper.className = "evidence-item";
      const summary = document.createElement("summary");
      const title = document.createElement("strong");
      let evidenceTitle = item.title || item.kind;
      if (evidenceTitle === "Feishu message") {
        try {
          const payload = JSON.parse(item.content);
          evidenceTitle = `${payload.sender?.name || "飞书"}的消息`;
        } catch { /* keep the stored title */ }
      }
      title.textContent = evidenceTitle;
      const meta = document.createElement("small");
      meta.textContent = `${item.kind} · ${dateTime(item.occurred_at || item.collected_at)}`;
      summary.append(title, meta);
      const body = document.createElement("pre");
      body.className = "evidence-body";
      body.textContent = `${item.content || "无正文"}\n\n来源：${item.source_locator}`;
      wrapper.append(summary, body);
      evidencePane.append(wrapper);
    }
    setDetailTab(selectedTab);
    if (window.lucide) window.lucide.createIcons();
  }

  async function openTaskDetail(id) {
    if (!id) return;
    const generation = ++receiptDetailGeneration;
    taskDetailLoadingGeneration = generation;
    taskSelectionGeneration += 1;
    dismissTaskClosure(true);
    closeOutboundConfirmation();
    closeTracking();
    if (selectedTaskId) taskDrafts.set(selectedTaskId, nextStepInput.value);
    selectedTaskId = id;
    selectedTask = null;
    updateTaskClosureControls();
    renderTaskClosureStatus();
    nextStepInput.value = taskDrafts.get(id) || "";
    selectedTab = "conversation";
    nextStepComposer.hidden = false;
    detailActionStatus.textContent = "";
    receiptDetailFingerprint = "";
    receiptDetailReadError = "";
    document.getElementById("detailBadges").replaceChildren();
    document.getElementById("taskComposerLabel").textContent = "交代这项任务";
    const messages = document.getElementById("taskConversationMessages");
    delete messages.dataset.key;
    delete messages.dataset.fingerprint;
    document.getElementById("taskConversationMore").hidden = true;
    for (const pane of [messages, ...["detailOverview", "detailExecution", "detailEvidence"].map(name => document.getElementById(name))]) {
      const loading = document.createElement("p");
      loading.className = "conversation-empty";
      loading.textContent = "正在加载…";
      pane.replaceChildren(loading);
    }
    detailView.hidden = false;
    pet.dataset.detail = "true";
    document.getElementById("detailTitle").textContent = "加载任务详情";
    document.getElementById("detailDescription").textContent = "正在读取证据和执行记录";
    setDetailTab("conversation");
    try {
      const details = await window.shadowPet.taskDetails(id, { preferCached: true });
      if (!details || selectedTaskId !== id || generation !== receiptDetailGeneration) return;
      renderTaskDetails(details);
    } catch (error) {
      if (selectedTaskId !== id || generation !== receiptDetailGeneration) return;
      document.getElementById("detailTitle").textContent = "详情加载失败";
      document.getElementById("detailDescription").textContent = error.message;
      messages.textContent = `读取失败：${error.message}`;
    } finally {
      if (taskDetailLoadingGeneration === generation) taskDetailLoadingGeneration = null;
    }
  }

  function historyRow(run) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "session-row";
    row.dataset.runId = run.id;
    row.addEventListener("click", () => openAgentHistoryDetail(run.id));

    const title = document.createElement("strong");
    title.textContent = run.status === "running"
      ? "智能体正在巡查"
      : run.preview_task || run.summary || run.no_action_reason || (run.status === "failed" ? "智能体处理失败" : "本轮未发现新任务");
    const time = document.createElement("time");
    time.textContent = dateTime(run.started_at);
    const meta = document.createElement("small");
    meta.textContent = `${statusLabels[run.status] || run.status} · 分析 ${run.evidence_count || 0} 条证据 · 发现 ${run.discovered_task_count || 0} 项 · 执行 ${run.action_count || 0} 项`;
    const preview = document.createElement("p");
    preview.textContent = String(run.error || run.summary || run.no_action_reason || "本轮正在读取增量变化并判断是否需要处理。" ).replace(/\s+/g, " ");
    row.append(title, time, meta, preview);
    return row;
  }

  async function loadAgentHistory() {
    const list = document.getElementById("historyList");
    list.replaceChildren(detailBlock("正在读取", "正在加载智能体的巡查、判断和执行记录。"));
    try {
      const runs = await window.shadowPet.agentHistory({
        limit: 300,
        query: historySearchInput.value.trim(),
      });
      list.replaceChildren();
      document.getElementById("historyCount").textContent = `${runs.length} 条记录`;
      if (!runs.length) {
        list.append(detailBlock("没有匹配记录", "请调整搜索条件，或等待智能体完成下一轮巡查。"));
        return;
      }
      runs.forEach((run) => list.append(historyRow(run)));
    } catch (error) {
      list.replaceChildren(detailBlock("处理历史加载失败", error.message));
    }
  }

  function renderAgentHistoryDetails(details) {
    const { run, tasks, actions, evidenceKinds, evidence } = details;
    document.getElementById("historyToolbarTitle").textContent = "处理详情";
    document.getElementById("sessionTitle").textContent = run.status === "running"
      ? "智能体正在巡查"
      : run.status === "failed"
        ? "本轮处理失败"
        : tasks.length
          ? `本轮发现 ${tasks.length} 项需要推进的工作`
          : "本轮没有新增任务";
    document.getElementById("sessionMeta").textContent = `${dateTime(run.started_at)} 至 ${dateTime(run.completed_at)} · ${run.id}`;
    const badges = document.getElementById("sessionBadges");
    badges.replaceChildren(
      badge(statusLabels[run.status] || run.status, run.status === "failed" ? "warning" : "accent"),
      badge(`分析 ${run.evidence_count || 0} 条证据`),
      badge(`发现 ${tasks.length} 项任务`),
    );

    const activityPane = document.getElementById("sessionActivity");
    activityPane.replaceChildren();
    const evidenceLabels = {
      codex_user_message: "Codex 用户消息",
      codex_agent_message: "Codex 回复",
      codex_thread_digest: "会话摘要",
      feishu_message: "飞书消息",
      feishu_task: "飞书任务",
      feishu_approval_task: "飞书审批",
      feishu_document_content: "飞书文档",
      project_document_digest: "项目文档摘要",
      git_history_digest: "Git 变更摘要",
    };
    for (const item of evidenceKinds) {
      const stat = document.createElement("span");
      stat.className = "session-stat";
      stat.textContent = `${evidenceLabels[item.kind] || item.kind} ${item.count}`;
      activityPane.append(stat);
    }
    if (!evidenceKinds.length) {
      const stat = document.createElement("span");
      stat.className = "session-stat";
      stat.textContent = "本轮尚未登记证据";
      activityPane.append(stat);
    }

    const messagePane = document.getElementById("sessionMessages");
    messagePane.replaceChildren();
    messagePane.append(detailBlock(
      "处理结论",
      run.error
        ? `**失败原因**\n\n${run.error}`
        : run.summary || run.no_action_reason || "本轮仍在处理中，尚未生成最终结论。",
    ));
    const runTrace = traceGroup(run.metadata?.trace);
    if (runTrace) {
      const traceBlock = document.createElement("section");
      traceBlock.className = "detail-block";
      const heading = document.createElement("h3");
      heading.textContent = "判断过程";
      traceBlock.append(heading, runTrace);
      messagePane.append(traceBlock);
    }
    const taskBlock = document.createElement("section");
    taskBlock.className = "detail-block";
    const taskHeading = document.createElement("h3");
    taskHeading.textContent = `本轮发现的任务 (${tasks.length})`;
    taskBlock.append(taskHeading);
    if (!tasks.length) {
      taskBlock.append(renderMarkdown("本轮没有创建新任务。"));
    } else {
      for (const task of tasks) {
        taskBlock.append(timelineItem(
          task.title,
          `${task.project_name || "未归类项目"} · ${statusLabels[task.status] || task.status} · ${riskLabels[task.risk_level] || task.risk_level}`,
          task.result || task.last_error || task.description,
          task.status === "failed",
        ));
      }
    }
    messagePane.append(taskBlock);

    const actionBlock = document.createElement("section");
    actionBlock.className = "detail-block";
    const actionHeading = document.createElement("h3");
    actionHeading.textContent = `本轮执行的动作 (${actions.length})`;
    actionBlock.append(actionHeading);
    if (!actions.length) {
      actionBlock.append(renderMarkdown("本轮只完成了判断和任务归档，没有自动执行动作。"));
    } else {
      for (const action of actions) {
        const item = timelineItem(
          action.command_summary || action.task_title || action.action_type,
          `${dateTime(action.started_at)} · ${statusLabels[action.status] || action.status} · ${riskLabels[action.risk_level] || action.risk_level}`,
          action.error || action.result || "动作尚未产生结果。",
          action.status === "failed",
        );
        const trace = traceGroup(action.metadata?.trace);
        if (trace) item.append(trace);
        actionBlock.append(item);
      }
    }
    messagePane.append(actionBlock);

    const evidenceBlock = document.createElement("section");
    evidenceBlock.className = "detail-block";
    const evidenceHeading = document.createElement("h3");
    evidenceHeading.textContent = `本轮参考的证据 (${run.evidence_count || 0})`;
    evidenceBlock.append(evidenceHeading);
    if (!evidence.length) {
      evidenceBlock.append(renderMarkdown("没有可展示的证据样本。"));
    } else {
      for (const source of evidence) {
        const wrapper = document.createElement("details");
        wrapper.className = "evidence-item";
        const summary = document.createElement("summary");
        const title = document.createElement("strong");
        title.textContent = source.title || source.kind;
        const meta = document.createElement("small");
        meta.textContent = `${evidenceLabels[source.kind] || source.kind} · ${dateTime(source.occurred_at || source.collected_at)}`;
        summary.append(title, meta);
        const body = document.createElement("pre");
        body.className = "evidence-body";
        body.textContent = `${source.content || "无正文"}\n\n来源：${source.source_locator}`;
        wrapper.append(summary, body);
        evidenceBlock.append(wrapper);
      }
    }
    messagePane.append(evidenceBlock);
  }

  async function openAgentHistoryDetail(id) {
    selectedThreadId = id;
    historyListPane.hidden = true;
    historyDetailPane.hidden = false;
    document.getElementById("historyToolbarTitle").textContent = "加载记录";
    document.getElementById("sessionTitle").textContent = "正在读取处理历史";
    document.getElementById("sessionMeta").textContent = id;
    document.getElementById("sessionMessages").replaceChildren();
    try {
      const details = await window.shadowPet.agentHistoryDetails(id);
      if (!details || selectedThreadId !== id) return;
      renderAgentHistoryDetails(details);
    } catch (error) {
      document.getElementById("sessionTitle").textContent = "处理记录加载失败";
      document.getElementById("sessionMeta").textContent = error.message;
    }
  }

  function openHistory() {
    closeTaskDetail();
    closeOutboundConfirmation();
    closeTracking();
    selectedThreadId = null;
    historyView.hidden = false;
    historyListPane.hidden = false;
    historyDetailPane.hidden = true;
    document.getElementById("historyToolbarTitle").textContent = "处理历史";
    pet.dataset.history = "true";
    loadAgentHistory();
  }

  function closeHistory() {
    selectedThreadId = null;
    historyView.hidden = true;
    historyListPane.hidden = false;
    historyDetailPane.hidden = true;
    pet.dataset.history = "false";
  }

  function historyBack() {
    if (!historyDetailPane.hidden) {
      selectedThreadId = null;
      historyDetailPane.hidden = true;
      historyListPane.hidden = false;
      document.getElementById("historyToolbarTitle").textContent = "处理历史";
      return;
    }
    closeHistory();
  }

  function closeTaskDetail() {
    receiptDetailGeneration += 1;
    taskSelectionGeneration += 1;
    dismissTaskClosure(true);
    if (selectedTaskId) taskDrafts.set(selectedTaskId, nextStepInput.value);
    selectedTaskId = null;
    selectedTask = null;
    updateTaskClosureControls();
    detailView.hidden = true;
    pet.dataset.detail = "false";
    nextStepComposer.hidden = true;
  }

  function setExpanded(value) {
    expanded = Boolean(value);
    if (!expanded) {
      closeTaskDetail();
      closeHistory();
      closeOutboundConfirmation();
      closeTracking();
    }
    pet.dataset.expanded = String(expanded);
    window.shadowPet.setExpanded(expanded);
  }

  async function refresh() {
    try {
      const snapshot = await window.shadowPet.snapshot();
      const firstSnapshot = latestSnapshot === null;
      latestSnapshot = snapshot;
      if (selectedTaskId && (selectedTab === "execution" || taskClosureDialog.open
          || selectedTask?.closure || taskClosureAttempts.get(selectedTaskId)?.accepted)) await refreshReceiptDetails();
      else await refreshConversation();
      const heartbeatAge = Date.now() - Date.parse(snapshot.runtime.lastHeartbeat || "");
      const contextOnline = Number.isFinite(heartbeatAge) && heartbeatAge < 90000;
      const clawPhase = snapshot.openclaw?.supervisorPhase;
      const openclawOnline = Boolean(snapshot.openclaw?.connected);
      const openclawRecovering = ["starting", "recovering", "restarting"].includes(clawPhase);
      const feishuAvailable = Boolean(snapshot.feishu?.personalDataAvailable);
      const feishuGaps = snapshot.feishu?.gaps?.length ?? 0;
      setServiceStatus(
        openclawStatus,
        openclawOnline ? "online" : openclawRecovering ? "warning" : "error",
        openclawOnline ? "OpenClaw 主控在线" : openclawRecovering ? "OpenClaw 主控正在恢复" : "OpenClaw 主控离线",
      );
      setServiceStatus(
        contextStatus,
        contextOnline ? "online" : "error",
        contextOnline ? `上下文采集在线，${relativeTime(snapshot.runtime.lastHeartbeat)}更新` : "上下文采集心跳中断",
      );
      setServiceStatus(
        feishuStatus,
        feishuAvailable ? (feishuGaps ? "warning" : "online") : "error",
        feishuAvailable ? (feishuGaps ? `飞书可读，${feishuGaps} 项能力待审批` : "飞书能力在线") : "飞书能力不可用",
      );
      const runningUserTask = snapshot.running.find((task) => task.domain === "user_work");
      const runningTask = runningUserTask || snapshot.running[0];
      const failedTask = snapshot.failed[0];
      const deliveredReminder = snapshot.reminders?.find((reminder) => reminder.status === "delivered");
      const phase = contextOnline ? snapshot.runtime.phase : "offline";
      const copy = deliveredReminder && !runningTask
        ? ["有提醒到期", deliveredReminder.title, "review"]
        : failedTask && !runningTask ? ["有任务失败", failedTask.title, "failed"] : (phaseCopy[phase] || phaseCopy.idle);
      phaseTitle.textContent = runningTask?.title || copy[0];
      phaseDetail.textContent = runningTask?.description || snapshot.runtime.detail || copy[1];
      window.shadowMascot.setState(runningTask ? "running" : copy[2]);
      const pendingOutbound = snapshot.outboundMessages?.find((draft) => draft.status === "pending_confirmation");
      if (pendingOutbound && !runningTask) {
        phaseTitle.textContent = "有飞书消息待确认";
        phaseDetail.textContent = `收件人：${pendingOutbound.recipient_name}`;
        window.shadowMascot.setState("review");
      }

      currentRunningTaskId = runningTask?.id || null;
      focusStrip.disabled = !currentRunningTaskId;
      currentTask.textContent = runningTask?.title || copy[0];
      currentProject.textContent = runningTask?.project_name || snapshot.runtime.detail || copy[1];
      const activeTracking = Number(snapshot.tracking?.active ?? 0);
      const reviewTracking = Number(snapshot.tracking?.needsReview ?? 0);
      const totalTracking = activeTracking + reviewTracking;
      trackingStrip.dataset.state = reviewTracking ? "review" : activeTracking ? "active" : "idle";
      trackingTitle.textContent = "持续跟踪";
      trackingDetail.textContent = reviewTracking
        ? `${reviewTracking} 项候选信息${activeTracking ? ` · ${activeTracking} 项继续等待` : ""}`
        : activeTracking ? `${activeTracking} 项正在等待外部变化` : "暂无持续跟踪";
      trackingCount.textContent = String(Math.min(99, totalTracking));
      trackingStrip.disabled = totalTracking === 0;
      if (!trackingView.hidden) renderTrackingView(snapshot.tracking);
      const waitingCount = snapshot.counts?.queued ?? snapshot.queued.length;
      const needsUserCount = snapshot.counts?.needsUser ?? snapshot.needsUser.length;
      const deliveredReminderCount = snapshot.counts?.deliveredReminders ?? 0;
      const pendingOutboundCount = snapshot.counts?.pendingOutboundMessages ?? 0;
      attentionCount.textContent = String(Math.min(99, needsUserCount + deliveredReminderCount + pendingOutboundCount));
      document.getElementById("workAttentionCount").textContent = String(needsUserCount + deliveredReminderCount + pendingOutboundCount);
      userActionCount.textContent = String(needsUserCount);
      queuedCount.textContent = String(waitingCount + snapshot.running.length);
      if (firstSnapshot) queueView = needsUserCount > 0 ? "user" : "agent";
      setQueueView(queueView);
      renderReminders(snapshot.reminders ?? []);
      renderOutboundMessages(snapshot.outboundMessages ?? []);
      renderList("completedList", snapshot.completed, "completed");
      const maintenance = snapshot.maintenance[0];
      const workboardPending = ["ready", "review", "blocked", "running", "todo", "backlog"]
        .reduce((total, status) => total + (snapshot.workboard?.counts?.[status] ?? 0), 0);
      const clawState = snapshot.openclaw?.connected
        ? `OpenClaw 在线 · ${workboardPending} 卡`
        : clawPhase === "starting"
          ? "OpenClaw 正在启动"
          : ["recovering", "restarting"].includes(clawPhase)
            ? "OpenClaw 正在自动恢复"
            : clawPhase === "disabled"
              ? "OpenClaw 已手动停用"
              : "OpenClaw 离线";
      const feishuState = snapshot.feishu?.personalDataAvailable
        ? snapshot.feishu.gaps?.length
          ? `个人飞书可读 · ${snapshot.feishu.gaps.length} 项实时能力待审批`
          : "个人飞书实时在线"
        : "个人飞书不可用";
      maintenanceText.textContent = maintenance ? `${clawState} · ${feishuState} · ${maintenance.title}` : `${clawState} · ${feishuState}`;
      lastHeartbeat.textContent = contextOnline ? `${relativeTime(snapshot.runtime.lastHeartbeat)}更新` : "采集心跳中断";
    } catch (error) {
      setServiceStatus(openclawStatus, "error", "OpenClaw 主控状态读取失败");
      setServiceStatus(contextStatus, "error", "上下文采集状态读取失败");
      setServiceStatus(feishuStatus, "error", "飞书能力状态读取失败");
      phaseTitle.textContent = "暂时失联";
      phaseDetail.textContent = error.message;
      window.shadowMascot.setState("failed");
    }
  }

  manualInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) manualInputForm.requestSubmit();
  });
  manualInputForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = manualInput.value.trim();
    if (!text || manualSubmitButton.disabled) {
      manualInput.focus();
      return;
    }
    manualSubmitButton.disabled = true;
    showManualReceipt("pending", "正在可靠保存并提交给 Agent");
    try {
      const result = await window.shadowPet.submitManualInput(text);
      const created = result?.createdTasks?.length
        ? `已进入任务卡：${result.createdTasks.map((task) => task.title).join("、")}`
        : result?.status === "completed" ? "Agent 已回复" : result?.text || "Agent 已接收";
      showManualReceipt(result?.status === "completed" ? "success" : "pending", created);
      manualInput.value = "";
      refresh();
    } catch (error) {
      showManualReceipt("error", `提交失败：${error.message}`);
    } finally {
      manualSubmitButton.disabled = false;
    }
  });

  document.getElementById("attentionBadge").addEventListener("click", () => { setHomeView("work"); setExpanded(true); });
  document.querySelectorAll(".home-tabs button").forEach((button) => button.addEventListener("click", () => setHomeView(button.dataset.home)));
  document.getElementById("mainConversationMore").addEventListener("click", () => refreshConversation(true));
  document.getElementById("taskConversationMore").addEventListener("click", () => refreshConversation(true));
  document.getElementById("mascot").addEventListener("dblclick", () => setExpanded(true));
  panelScroll.addEventListener("scroll", () => { pet.dataset.scrolled = String(panelScroll.scrollTop > 24); }, { passive: true });
  focusStrip.addEventListener("click", () => openTaskDetail(currentRunningTaskId));
  trackingStrip.addEventListener("click", openTracking);
  document.getElementById("historyButton").addEventListener("click", openHistory);
  document.getElementById("outboundBackButton").addEventListener("click", closeOutboundConfirmation);
  document.getElementById("trackingBackButton").addEventListener("click", closeTracking);
  document.getElementById("approveOutboundButton").addEventListener("click", async () => {
    if (!selectedOutboundId) return;
    const button = document.getElementById("approveOutboundButton");
    const content = outboundEditor.value.trim();
    if (!content) {
      outboundActionStatus.textContent = "发送内容不能为空";
      outboundEditor.focus();
      return;
    }
    button.disabled = true;
    outboundActionStatus.textContent = "正在写入发送队列";
    try {
      await window.shadowPet.approveOutboundMessage(selectedOutboundId, content);
      closeOutboundConfirmation();
      await refresh();
    } catch (error) {
      outboundActionStatus.textContent = `确认失败：${error.message}`;
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById("cancelOutboundButton").addEventListener("click", () => {
    if (selectedOutboundId) setOutboundRejectMode(true);
  });
  document.getElementById("dismissOutboundRejectButton").addEventListener("click", () => setOutboundRejectMode(false));
  outboundRejectReason.addEventListener("input", () => {
    if (outboundRejectReason.value.trim()) outboundActionStatus.textContent = "";
  });
  outboundRejectComposer.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!selectedOutboundId) return;
    const reason = outboundRejectReason.value.trim();
    if (!reason) {
      outboundActionStatus.textContent = "请填写拒绝原因";
      outboundRejectReason.focus();
      return;
    }
    const button = document.getElementById("confirmOutboundRejectButton");
    button.disabled = true;
    outboundActionStatus.textContent = "正在记录原因并拒绝草稿";
    try {
      await window.shadowPet.cancelOutboundMessage(selectedOutboundId, reason);
      closeOutboundConfirmation();
      await refresh();
    } catch (error) {
      outboundActionStatus.textContent = `拒绝失败：${error.message}`;
    } finally {
      button.disabled = false;
    }
  });
  document.querySelectorAll(".queue-tab").forEach((tab) => tab.addEventListener("click", () => setQueueView(tab.dataset.queue)));
  document.getElementById("historyBackButton").addEventListener("click", historyBack);
  document.getElementById("historyRefreshButton").addEventListener("click", () => {
    if (selectedThreadId && !historyDetailPane.hidden) openAgentHistoryDetail(selectedThreadId);
    else loadAgentHistory();
  });
  historySearchInput.addEventListener("input", () => {
    clearTimeout(historySearchTimer);
    historySearchTimer = setTimeout(loadAgentHistory, 250);
  });
  document.getElementById("detailBackButton").addEventListener("click", closeTaskDetail);
  confirmDoneButton.addEventListener("click", () => openTaskClosure("done"));
  terminateTaskButton.addEventListener("click", () => openTaskClosure("cancelled"));
  taskClosureOutcomes.addEventListener("change", updateTaskClosureOutcome);
  cancelTaskClosureButton.addEventListener("click", () => dismissTaskClosure());
  taskClosureDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dismissTaskClosure();
  });
  taskClosureForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const session = taskClosureSession;
    if (!session || !isCurrentTaskClosure(session) || confirmTaskClosureButton.disabled) return;
    const cardId = session.cardId;
    const outcome = taskClosureForm.elements.outcome.value;
    const note = taskClosureNote.value;
    if (!["done", "cancelled"].includes(outcome) || note.length > 4000) return;
    const previous = taskClosureAttempts.get(cardId);
    // An unchanged retry must keep the same id even if the previous response was lost.
    const attempt = previous?.outcome === outcome && previous.note === note ? previous : {
      outcome, note, operationId: window.crypto.randomUUID(),
    };
    if (attempt.pending || attempt.accepted) return;
    taskClosureAttempts.set(cardId, attempt);
    attempt.pending = true;
    receiptDetailGeneration += 1;
    showTaskClosureError("");
    updateTaskClosureControls();
    try {
      const current = await window.shadowPet.taskDetails(cardId);
      if (!isCurrentTaskClosure(session)) return;
      if (current?.task?.id !== cardId) throw new Error("任务详情不匹配，请重新打开任务。");
      renderTaskDetails(current);
      if (isTerminalTask(current.task) || current.task.closure) {
        throw new Error("任务已结束或关闭确认已保存，不能再次提交。");
      }
      const details = await window.shadowPet.closeTask(cardId, { outcome, note, operationId: attempt.operationId });
      if (details?.task?.id !== cardId) throw new Error("关闭结果不匹配，尚未确认提交结果。");
      attempt.accepted = true;
      attempt.operation = details.operation;
      if (isCurrentTaskClosure(session)) {
        renderTaskDetails(details);
        detailActionStatus.textContent = "";
        dismissTaskClosure(true);
      }
    } catch (error) {
      if (isCurrentTaskClosure(session)) showTaskClosureError(`确认失败：${error.message}`);
    } finally {
      attempt.pending = false;
      if (session.generation === taskSelectionGeneration && selectedTaskId === cardId) receiptDetailGeneration += 1;
      updateTaskClosureControls();
      if (attempt.accepted) refresh();
    }
  });
  nextStepInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) nextStepComposer.requestSubmit();
  });
  nextStepComposer.addEventListener("submit", async (event) => {
    event.preventDefault();
    const nextStep = nextStepInput.value.trim();
    if (taskClosureDialog.open || taskClosureAttempts.get(selectedTaskId)?.pending) return;
    if (!selectedTaskId || !nextStep) {
      nextStepInput.focus();
      return;
    }
    const saveButton = document.getElementById("saveNextStepButton");
    if (saveButton.disabled) return;
    const sendingTaskId = selectedTaskId;
    const sendingGeneration = taskSelectionGeneration;
    sendingTaskMessage = true;
    updateTaskClosureControls();
    detailActionStatus.textContent = "正在发送";
    try {
      const details = await window.shadowPet.sendTaskMessage(sendingTaskId, nextStep);
      taskDrafts.delete(sendingTaskId);
      if (!details || details.task.id !== selectedTaskId || sendingGeneration !== taskSelectionGeneration) return;
      nextStepInput.value = "";
      renderTaskDetails(details);
      detailActionStatus.textContent = details.operation?.queued
        ? "消息已保存"
        : "消息已送达当前任务";
      refresh();
    } catch (error) {
      if (selectedTaskId === sendingTaskId && sendingGeneration === taskSelectionGeneration) detailActionStatus.textContent = `发送失败：${error.message}`;
    } finally {
      sendingTaskMessage = false;
      updateTaskClosureControls();
    }
  });
  document.querySelectorAll(".detail-tab").forEach((tab) => tab.addEventListener("click", () => setDetailTab(tab.dataset.tab)));
  document.getElementById("collapseButton").addEventListener("click", () => setExpanded(false));
  document.getElementById("closeButton").addEventListener("click", () => window.shadowPet.hide());
  document.getElementById("pinButton").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const requested = !pinned;
    button.classList.toggle("is-active", requested);
    try {
      pinned = await window.shadowPet.setPinned(requested);
    } catch {
      pinned = !requested;
    }
    button.classList.toggle("is-active", pinned);
  });
  window.shadowPet.onExpanded((value) => {
    expanded = value;
    pet.dataset.expanded = String(value);
    if (!expanded) {
      closeTaskDetail();
      closeHistory();
      closeOutboundConfirmation();
      closeTracking();
    }
  });
  if (window.lucide) window.lucide.createIcons();
  refresh();
  setInterval(refresh, 2500);
})();
