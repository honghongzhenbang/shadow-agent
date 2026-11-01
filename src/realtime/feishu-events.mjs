import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { materializeContextGraph } from "../context-graph.mjs";
import { evaluateConditionWatches } from "../condition-watches.mjs";
import { getFeishuHealth, timestampIso } from "../collectors/feishu.mjs";
import { feishuEventSpecs } from "../feishu-capabilities.mjs";
import { feishuMessageIdentity } from "../feishu-message-identity.mjs";
import { logger } from "../logger.mjs";
import { runOpenClawConversation } from "../openclaw/cli.mjs";
import { thinkingForTask } from "../openclaw/reasoning-policy.mjs";
import {
  adapterSourceMetadata,
  feishuConversationKey,
  feishuMessageProjectionMetadata,
} from "../source-adapters/index.mjs";
import { safeEvidenceText, sha256, stableJson } from "../utils.mjs";

function larkScript(config) {
  return path.join(path.dirname(config.feishu.cliPath), "node_modules", "@larksuite", "cli", "scripts", "run.js");
}

function eventBody(payload) {
  if (payload?.event && typeof payload.event === "object") return payload.event;
  return payload ?? {};
}

export function normalizeFeishuEvent(spec, payload) {
  const body = eventBody(payload);
  const header = payload?.header ?? {};
  const eventType = body.type ?? header.event_type ?? spec.key;
  const messageId = body.message_id ?? body.id;
  const eventId = messageId ?? body.event_id ?? header.event_id
    ?? sha256(stableJson({ eventType, body })).slice(0, 32);
  return { eventType, eventId: String(eventId), body, header, raw: payload };
}

export function conversationKeyForMessage(message) {
  return feishuConversationKey(message);
}

export function shouldQueueMessageForHitl(message, botOpenId) {
  if (!message?.message_id || message.sender_type === "bot") return false;
  if (message.chat_type === "p2p") return true;
  if (message.chat_type !== "group" || !botOpenId) return false;
  return (message.mentions ?? []).some((mention) => {
    const mentionId = mention?.id;
    return mentionId === botOpenId
      || mentionId?.open_id === botOpenId
      || mention?.open_id === botOpenId;
  });
}

function ignoredMessageReason(message, botOpenId) {
  if (!message?.message_id) return "missing_message_id";
  if (message.sender_type === "bot") return "bot_sender";
  if (message.chat_type === "group" && !botOpenId) return "bot_identity_unavailable";
  if (message.chat_type === "group") return "bot_not_mentioned";
  return "unsupported_chat_type";
}

function outboundSenderIdentity(config) {
  return config.feishu?.outboundMessages?.senderIdentity === "bot" ? "bot" : "user";
}

function outboundMode(config) {
  const automatic = config.feishu?.outboundMessages?.mode === "automatic";
  return automatic && outboundSenderIdentity(config) === "bot" ? "automatic" : "hitl";
}

function feishuMessageText(value, depth = 0) {
  if (value == null || depth > 3) return "";
  if (typeof value === "object") {
    for (const key of ["text", "content", "message", "body"]) {
      if (value[key] != null) {
        const nested = feishuMessageText(value[key], depth + 1);
        if (nested) return nested;
      }
    }
    return stableJson(value).slice(0, 4000);
  }
  const text = String(value).trim().slice(0, 4000);
  if (!text || !/^[\[{]/.test(text)) return text;
  try { return feishuMessageText(JSON.parse(text), depth + 1) || text; } catch { return text; }
}

function agentPrompt(message, conversationKey, evidenceId, mode) {
  return [
    "你正在处理发给 Shadow Agent 的飞书消息。直接回复对方，不要描述内部架构或思考过程。",
    mode === "automatic"
      ? "运行配置已显式启用 automatic；回复正文将由统一出站链自动批准。"
      : "当前是 hitl 灰度模式；回复正文只会形成宠物待确认草稿，不会直接发送。",
    "你只能回复当前机器人会话，不得据此代用户承诺、审批、修改远程文档、提交代码、部署或控制设备。",
    "先理解上下文；只有消息形成真实待办或改变已有工作时，才使用 Workboard 更新或创建一张规范卡片。不要把每条消息都变成任务。",
    "如果消息含明确的提醒要求或明确截止时间，按运行规则登记提醒；不明确时不要猜日期。",
    `外部会话键：${conversationKey}`,
    `证据 ID：${evidenceId}`,
    `消息正文：${feishuMessageText(message.content)}`,
    "不要调用 shadow_outbound_draft_create 或任何飞书发送工具；事件桥会把你的最终正文写入正确的统一出站记录。",
    "最终只输出要发送给对方的回复正文。",
  ].join("\n");
}

export class FeishuEventBridge {
  constructor({
    store,
    config,
    materialize = materializeContextGraph,
    runAgent = runOpenClawConversation,
    dispatchSession = (_sessionKey, operation) => operation(),
    scheduleAttention = async () => ({ queued: false }),
  }) {
    this.store = store;
    this.config = config;
    this.materialize = materialize;
    this.runAgent = runAgent;
    this.dispatchSession = dispatchSession;
    this.scheduleAttention = scheduleAttention;
    this.children = new Map();
    this.restartTimers = new Set();
    this.conversationQueues = new Map();
    this.stopped = true;
    this.botOpenId = null;
    this.configuredSpecs = [];
    this.recoveryTimer = null;
    this.recoveryRun = null;
  }

  async start() {
    if (this.config.feishu?.realtime?.enabled === false || this.stopped === false) return;
    this.stopped = false;
    const health = await getFeishuHealth(this.config);
    this.botOpenId = health.status?.identities?.bot?.openId ?? null;
    const configured = feishuEventSpecs(this.config);
    this.configuredSpecs = configured;
    for (const spec of configured) this.#spawn(spec);
    this.recoveryTimer = setInterval(() => {
      this.recoverFailedEvents(configured).catch((error) => {
        logger.warn("Feishu event recovery failed", { error: error.message });
      });
    }, Math.max(15, Number(this.config.feishu?.realtime?.recoverySeconds ?? 30)) * 1000);
    this.recoveryTimer.unref();
    try {
      await this.recoverFailedEvents(configured);
    } catch (error) {
      logger.warn("Initial Feishu event recovery deferred to retry timer", { error: error.message });
    }
  }

  async stop() {
    this.stopped = true;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
    for (const timer of this.restartTimers) clearTimeout(timer);
    this.restartTimers.clear();
    for (const child of this.children.values()) {
      try { child.stdin.end(); } catch { /* already closed */ }
      setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* already closed */ } }, 1500).unref();
    }
    this.children.clear();
    await Promise.allSettled([...this.conversationQueues.values()]);
  }

  async handle(spec, payload) {
    const event = normalizeFeishuEvent(spec, payload);
    const message = event.eventType === "im.message.receive_v1" ? event.body : null;
    const conversationKey = message ? conversationKeyForMessage(message) : null;
    const hitlCandidate = message ? shouldQueueMessageForHitl(message, this.botOpenId) : false;
    const mode = outboundMode(this.config);
    const disposition = message
      ? hitlCandidate ? (mode === "automatic" ? "automatic_reply" : "hitl_review") : "background_ignored"
      : "controller_wake";
    const source = this.store.upsertSource({
      sourceKey: `feishu:event:${spec.key}`,
      kind: "feishu_event",
      uri: `feishu://event/${spec.key}`,
      metadata: adapterSourceMetadata("feishu", {
        identity: spec.identity,
        role: spec.role,
        capability: spec.capability,
        label: spec.label,
      }),
    });
    const evidenceKind = message
      ? "feishu_message"
      : event.eventType.startsWith("approval.") ? "feishu_approval_task" : "feishu_task";
    const evidence = this.store.addEvidence({
      sourceId: source.id,
      kind: evidenceKind,
      occurredAt: timestampIso(event.body.create_time ?? event.body.operate_time ?? event.body.timestamp ?? event.header.create_time),
      title: message ? "飞书实时消息" : `飞书事件：${event.eventType}`,
      content: safeEvidenceText(event.body, this.config.collection.maxEvidenceChars),
      sourceLocator: message ? `feishu://message/${event.eventId}` : `feishu://event/${event.eventId}`,
      externalId: event.eventId,
      fingerprint: message
        ? feishuMessageIdentity(message).fingerprint
        : sha256(`feishu-event:${event.eventType}:${event.eventId}`),
      metadata: message ? feishuMessageProjectionMetadata(message, {
        eventType: event.eventType,
        conversationKey,
        eventId: event.eventId,
      }) : {
        eventType: event.eventType,
        eventId: event.eventId,
      },
    });
    const receipt = this.store.receiveExternalEvent({
      provider: "feishu",
      eventType: event.eventType,
      eventId: event.eventId,
      dedupeKey: `feishu:${event.eventType}:${event.eventId}`,
      conversationKey,
      evidenceId: evidence.id,
      metadata: {
        spec: spec.key,
        disposition,
        ...(hitlCandidate || !message ? { retryPayload: event.raw } : {}),
        ...(message && !hitlCandidate ? { reason: ignoredMessageReason(message, this.botOpenId) } : {}),
      },
    });
    if (!receipt.inserted && ["processing", "processed", "ignored"].includes(receipt.status)) return receipt;
    if (message && !hitlCandidate) {
      this.store.startExternalEvent(receipt.id);
      return this.store.finishExternalEvent(receipt.id, { status: "ignored" });
    }
    this.materialize(this.store, this.config);
    evaluateConditionWatches(this.store, this.config.tracking);
    if (message) {
      return this.#queueConversation(conversationKey, () => this.#processMessage(receipt.id, message, conversationKey, evidence.id));
    }
    const started = this.store.startExternalEvent(receipt.id);
    if (started.status !== "processing") return started;
    try {
      await this.scheduleAttention({
        reason: `feishu-event:${event.eventType}`,
        count: 1,
        evidenceId: evidence.id,
        eventType: event.eventType,
      });
      return this.store.finishExternalEvent(receipt.id, { status: "processed" });
    } catch (error) {
      return this.store.finishExternalEvent(receipt.id, { status: "failed", error: error.message });
    }
  }

  #queueConversation(key, job) {
    const previous = this.conversationQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(job).finally(() => {
      if (this.conversationQueues.get(key) === current) this.conversationQueues.delete(key);
    });
    this.conversationQueues.set(key, current);
    return current;
  }

  async recoverFailedEvents(specs = this.configuredSpecs) {
    if (this.recoveryRun) return this.recoveryRun;
    const byKey = new Map(specs.map((spec) => [spec.key, spec]));
    this.recoveryRun = (async () => {
      const rows = this.store.recoverExternalEvents({ limit: 20, staleSeconds: 300 });
      let recovered = 0;
      for (const row of rows) {
        let metadata = {};
        try { metadata = JSON.parse(row.metadata_json || "{}"); } catch { /* invalid legacy metadata */ }
        const spec = byKey.get(metadata.spec);
        if (!spec || !metadata.retryPayload) continue;
        await this.handle(spec, metadata.retryPayload);
        recovered += 1;
      }
      return { candidates: rows.length, recovered };
    })().finally(() => { this.recoveryRun = null; });
    return this.recoveryRun;
  }

  async #processMessage(receiptId, message, conversationKey, evidenceId) {
    const current = this.store.startExternalEvent(receiptId);
    if (current.status !== "processing") return current;
    const binding = this.store.bindConversation({
      provider: "feishu",
      conversationKey,
      lastMessageId: message.message_id,
      eventAt: timestampIso(message.create_time),
      metadata: { chatId: message.chat_id, chatType: message.chat_type, senderId: message.sender_id },
    });
    const mode = outboundMode(this.config);
    const senderIdentity = outboundSenderIdentity(this.config);
    const userDirectP2p = senderIdentity === "user" && message.chat_type === "p2p";
    const recipientName = message.sender_name ?? message.sender?.name ?? "飞书联系人";
    const sourceLocator = `feishu://message/${message.message_id}`;
    const reviewContext = this.store.buildOutboundReviewContext({
      conversationKey,
      trigger: {
        direction: "incoming",
        senderName: recipientName,
        content: feishuMessageText(message.content),
        occurredAt: timestampIso(message.create_time),
        messageId: message.message_id,
      },
      reason: mode === "automatic"
        ? "automatic 模式下回复发给 Shadow Agent 的当前会话消息"
        : "回复发给 Shadow Agent 的当前会话消息，等待用户确认",
      sourceLocator,
      evidenceIds: [evidenceId],
      sessionKey: binding.session_key,
    });
    return this.dispatchSession(binding.session_key, async () => {
      try {
        const answer = await this.runAgent(this.config.projectRoot, {
          sessionKey: binding.session_key,
          message: agentPrompt(message, conversationKey, evidenceId, mode),
          thinking: thinkingForTask(this.config, "message_triage"),
          idempotencyKey: `feishu-reply:${message.message_id}`,
          stateStore: this.store,
        });
        const existingDraft = this.store.outboundDraftForReply(message.message_id, { approvalMode: mode });
        const draft = existingDraft
          ? this.store.setOutboundDraftReviewContext(existingDraft.id, reviewContext, { onlyIfEmpty: true })
          : this.store.createOutboundDraft({
            idempotencyKey: `${mode}-reply:${message.message_id}`,
            messageKind: "reply",
            senderIdentity,
            approvalMode: mode,
            recipientName,
            recipientOpenId: typeof message.sender_id === "string" ? message.sender_id : message.sender_id?.open_id,
            replyToMessageId: userDirectP2p ? null : message.message_id,
            replyInThread: !userDirectP2p && Boolean(message.thread_id || message.root_id),
            conversationKey: userDirectP2p ? null : conversationKey,
            sessionKey: binding.session_key,
            content: answer.text,
            reason: mode === "automatic"
              ? "automatic 模式下回复发给 Shadow Agent 的当前会话消息"
              : "回复发给 Shadow Agent 的当前会话消息，等待用户确认",
            sourceLocator,
            evidenceIds: [evidenceId],
            reviewContext,
            trackReply: mode !== "automatic",
            createdBy: "feishu-event-bridge",
            metadata: {
              sourceConversationKey: conversationKey,
              outboundTargetMode: userDirectP2p ? "user_direct_message" : "reply_in_source_conversation",
            },
          });
        // A reply receipt is not proof that the source's task/knowledge impact was reviewed.
        try {
          await this.scheduleAttention({ reason: 'feishu-reply-source-review', count: 1, evidenceId, conversationKey });
        } catch (error) {
          logger.warn('Feishu reply retained; source review remains pending for scheduler recovery', { evidenceId, error: error.message });
        }
        return this.store.finishExternalEvent(receiptId, {
          status: "processed",
          responseExternalId: `outbound-draft:${draft.id}`,
        });
      } catch (error) {
        logger.warn("Feishu real-time message processing failed", { error: error.message, conversationKey });
        return this.store.finishExternalEvent(receiptId, { status: "failed", error: error.message });
      }
    });
  }

  #spawn(spec) {
    if (this.stopped) return;
    const script = larkScript(this.config);
    const updateRuntime = (state, lastError = null) => {
      this.store.setSetting(`runtime:feishu:event:${spec.key}`, state);
      this.store.upsertSource({
        sourceKey: `feishu:event:${spec.key}`,
        kind: "feishu_event",
        uri: `feishu://event/${spec.key}`,
        status: state === "ready" ? "ready" : state === "waiting_console_subscription" ? "waiting_external_approval" : "partial",
        lastError,
        metadata: adapterSourceMetadata("feishu", {
          identity: spec.identity,
          role: spec.role,
          capability: spec.capability,
          label: spec.label,
        }),
      });
    };
    if (!fs.existsSync(script)) {
      updateRuntime("missing_cli", "lark-cli not found");
      return;
    }
    const child = spawn(process.execPath, [script, "event", "consume", spec.key, "--as", spec.identity], {
      cwd: this.config.projectRoot,
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      },
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.children.set(spec.key, child);
    updateRuntime("connecting");
    let stdoutBuffer = "";
    let outputTail = "";
    let permanentFailure = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      outputTail = `${outputTail}${String(chunk)}`.slice(-12000);
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const payload = JSON.parse(line);
          if (payload?.ok === false) {
            const message = String(payload.error?.message ?? "Feishu event consumer failed");
            if (message.includes("requires event types not subscribed in console")) {
              permanentFailure = true;
              updateRuntime("waiting_console_subscription", message);
            } else {
              updateRuntime(`error:${message}`, message);
            }
            continue;
          }
          this.handle(spec, payload).catch((error) => logger.warn("Feishu event handler failed", { event: spec.key, error: error.message }));
        }
        catch (error) { logger.warn("Invalid Feishu event JSON", { event: spec.key, error: error.message }); }
      }
    });
    child.stderr.setEncoding("utf8");
    let stderrBuffer = "";
    child.stderr.on("data", (chunk) => {
      stderrBuffer = `${stderrBuffer}${String(chunk)}`.slice(-12000);
      if (String(chunk).includes("[event] ready")) updateRuntime("ready");
    });
    child.on("error", (error) => updateRuntime(`error:${error.message}`, error.message));
    child.on("close", (code) => {
      this.children.delete(spec.key);
      if (this.stopped) return;
      if (permanentFailure || `${outputTail}\n${stderrBuffer}`.includes("requires event types not subscribed in console")) {
        updateRuntime("waiting_console_subscription", "等待飞书开发者后台事件订阅审批");
        return;
      }
      updateRuntime(`reconnecting:${code ?? -1}`, `consumer exited with code ${code ?? -1}`);
      const delayMs = Math.max(1000, Number(this.config.feishu.realtime?.reconnectSeconds ?? 5) * 1000);
      const timer = setTimeout(() => {
        this.restartTimers.delete(timer);
        this.#spawn(spec);
      }, delayMs);
      timer.unref();
      this.restartTimers.add(timer);
    });
  }
}
