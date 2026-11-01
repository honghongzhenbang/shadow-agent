export const FEISHU_CAPABILITY_ROLES = Object.freeze({
  personal_primary: "personal_primary",
  personal_operational: "personal_operational",
  bot_dialogue: "bot_dialogue",
});

export function feishuEventSpecs(config) {
  const personal = config.feishu?.personalSources ?? {};
  const dialogue = config.feishu?.botDialogue ?? {};
  const specs = [];
  if (dialogue.enabled !== false && dialogue.realtimeEvent) {
    specs.push({
      key: dialogue.realtimeEvent,
      identity: "bot",
      role: FEISHU_CAPABILITY_ROLES.bot_dialogue,
      capability: "botDialogue",
      label: "机器人对话入口",
    });
  }
  if (personal.tasks?.enabled !== false && personal.tasks?.realtimeEvent) {
    specs.push({
      key: personal.tasks.realtimeEvent,
      identity: "user",
      role: FEISHU_CAPABILITY_ROLES.personal_operational,
      capability: "personalTasks",
      label: "个人任务实时更新",
    });
  }
  if (personal.approvals?.enabled !== false) {
    for (const event of personal.approvals?.realtimeEvents ?? []) {
      specs.push({
        key: event,
        identity: "user",
        role: FEISHU_CAPABILITY_ROLES.personal_operational,
        capability: "personalApprovals",
        label: "个人审批实时更新",
      });
    }
  }
  return specs;
}

function eventState(store, key) {
  return store.getSetting(`runtime:feishu:event:${key}`, "not_started");
}

function pollCapability(store, { id, label, settingKey, enabled }) {
  const state = enabled === false ? "disabled" : store.getSetting(`runtime:feishu:quick:${settingKey}:state`, "not_started");
  return {
    id,
    label,
    role: FEISHU_CAPABILITY_ROLES.personal_primary,
    mode: "personal_oauth_poll",
    state,
    available: enabled !== false && ["ready", "running", "partial"].includes(state),
    lastSuccessAt: store.getSetting(`runtime:feishu:quick:${settingKey}:lastSuccessAt`, "") || null,
    gap: state.startsWith("error:") ? state.slice(6) : null,
  };
}

function operationalCapability(store, config, { id, label, sourceKey, eventKeys }) {
  const enabled = config.feishu?.personalSources?.[sourceKey]?.enabled !== false;
  const states = eventKeys.map((key) => ({ key, state: eventState(store, key) }));
  const realtime = enabled && states.length > 0 && states.every((item) => item.state === "ready");
  const waiting = states.filter((item) => item.state === "waiting_console_subscription").map((item) => item.key);
  return {
    id,
    label,
    role: FEISHU_CAPABILITY_ROLES.personal_operational,
    mode: realtime ? "personal_oauth_realtime" : "personal_oauth_poll_fallback",
    state: enabled === false ? "disabled" : realtime ? "ready" : waiting.length ? "waiting_external_approval" : "polling_fallback",
    available: enabled,
    realtime,
    eventStates: states,
    gap: waiting.length ? `等待飞书后台事件审批：${waiting.join(", ")}` : null,
  };
}

export function feishuCapabilitySnapshot(store, config) {
  const personal = config.feishu?.personalSources ?? {};
  const dialogue = config.feishu?.botDialogue ?? {};
  const taskEvents = personal.tasks?.realtimeEvent ? [personal.tasks.realtimeEvent] : [];
  const approvalEvents = personal.approvals?.realtimeEvents ?? [];
  const dialogueState = dialogue.realtimeEvent ? eventState(store, dialogue.realtimeEvent) : "disabled";
  const capabilities = [
    pollCapability(store, { id: "personalMessages", label: "个人消息", settingKey: "messages", enabled: personal.messages?.enabled }),
    pollCapability(store, { id: "personalDocuments", label: "个人文档", settingKey: "documents", enabled: personal.documents?.enabled }),
    operationalCapability(store, config, { id: "personalTasks", label: "个人任务", sourceKey: "tasks", eventKeys: taskEvents }),
    operationalCapability(store, config, { id: "personalApprovals", label: "个人审批", sourceKey: "approvals", eventKeys: approvalEvents }),
    {
      id: "botDialogue",
      label: "机器人对话入口",
      role: FEISHU_CAPABILITY_ROLES.bot_dialogue,
      mode: "bot_realtime",
      state: dialogue.enabled === false ? "disabled" : dialogueState,
      available: dialogue.enabled !== false && dialogueState === "ready",
      realtime: dialogueState === "ready",
      eventStates: dialogue.realtimeEvent ? [{ key: dialogue.realtimeEvent, state: dialogueState }] : [],
      gap: dialogueState === "waiting_console_subscription" ? "等待机器人消息事件订阅" : null,
    },
  ];
  const primary = capabilities.filter((item) => item.role !== FEISHU_CAPABILITY_ROLES.bot_dialogue);
  const gaps = capabilities.filter((item) => item.gap).map((item) => ({ id: item.id, label: item.label, detail: item.gap }));
  return {
    personalDataAvailable: primary.some((item) => item.available),
    personalRealtimeComplete: primary.filter((item) => item.id !== "personalMessages" && item.id !== "personalDocuments").every((item) => item.realtime),
    capabilities,
    gaps,
  };
}
