import fs from "node:fs";
import path from "node:path";

import { collectAll } from "./collectors/index.mjs";
import { startVoiceIntakeService } from "./voice-intake-service.mjs";
import { collectFeishu, recordFeishuCollectionHealth } from "./collectors/feishu.mjs";
import { groupFeishuMessages } from "./attention-scheduler.mjs";
import {
  attentionScheduleSignature,
  attentionScheduleStatus,
  readAttentionSchedule,
} from "./attention-window.mjs";
import { evaluateConditionWatches } from "./condition-watches.mjs";
import { processControllerOutbox } from "./controller-outbox.mjs";
import { SessionDispatchQueue } from "./controller-dispatch.mjs";
import { materializeContextGraph, emitContextChange } from "./context-graph.mjs";
import { openDatabase } from "./db.mjs";
import { buildDigests } from "./digests.mjs";
import { repairCodexStateTitles } from "./codex-title-maintenance.mjs";
import { planPersonalMessageBatch } from "./feishu-ownership.mjs";
import { logger } from "./logger.mjs";
import { syncUserProfileFile, userProfileDirectory } from "./user-profile.mjs";
import { runOpenClawTurn, nextPendingAttentionTurn, deferPendingOpenClawTurn, pendingOpenClawTurn, openClawTurnReceipt } from "./openclaw/cli.mjs";
import { attentionTaskType, thinkingForTask } from "./openclaw/reasoning-policy.mjs";
import { FeishuEventBridge } from "./realtime/feishu-events.mjs";
import { auditTaskProgress } from "./task-progress-supervisor.mjs";
import { ensureDirectory, nowIso } from "./utils.mjs";
import {
  attentionLeaseOwner,
  attentionRetryDelayMs,
  attentionAttempt,
  advanceAttentionAttempt,
  captureAttentionBatch,
  attentionBatchProgress,
  bindWorkSession,
  deferAttentionSession,
  nextAttentionSession,
  releaseAttentionLease,
  routePendingContextChanges,
  sessionRuntimeDetail,
} from "./work-sessions.mjs";

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function nextAttentionWork(store, options = {}) {
  const pending = nextAttentionSession(store, options);
  const recovery = nextPendingAttentionTurn(store, options);
  const dueAt = recovery?.retryAt ?? recovery?.updatedAt;
  if (!recovery || (pending && (pending.due_at < dueAt || (pending.has_user_input && pending.due_at <= (options.now ?? nowIso()))))) return pending;
  return { session_key: recovery.sessionKey, due_at: dueAt, change_count: 0, recoveryRunId: recovery.requestId };
}

export function confirmAttentionProgress(store, batch) {
  const progress = attentionBatchProgress(store, batch);
  if (batch && !progress.progressed && progress.remaining > 0) {
    const error = new Error("Model turn ended without acknowledging any due context change.");
    error.code = "OPENCLAW_ATTENTION_NO_PROGRESS";
    throw error;
  }
  return progress;
}

export function enqueueLostRunReconciliation(store, { sessionKey, runId }) {
  const binding = store.workSessionByKey(sessionKey);
  return emitContextChange(store.db, {
    eventKey: `runtime-reconciliation:${runId}`, kind: "runtime_reconciliation_due",
    sessionKey, priority: "high", notBefore: nowIso(),
    summary: "旧控制运行已不在 Gateway 或原生队列中，业务结果未知。核对现有卡片、执行回执和外部结果后再推进；不得盲目重复原动作，不得仅凭运行丢失关闭任务。",
    metadata: { runId, taskId: binding?.task_id ?? null, outcome: "unknown" },
  });
}

export function createSerializedJobQueue(onError = () => {}) {
  let operation = Promise.resolve();
  const queued = new Set();
  return (key, job) => {
    if (queued.has(key)) return operation;
    queued.add(key);
    operation = operation.then(job).catch((error) => onError(key, error)).finally(() => queued.delete(key));
    return operation;
  };
}

export function shouldRestartAfterDatabaseFailures(failures, threshold = 3) {
  return Number(failures) >= Math.max(1, Number(threshold) || 3);
}

export function routePersonalMessageChanges(store, config, messages, scheduleAttention) {
  const groups = groupFeishuMessages(messages);
  for (const [conversationKey, changes] of groups) {
    const existingBinding = store.db.prepare(`
      SELECT * FROM conversation_bindings WHERE provider='feishu' AND conversation_key=?
    `).get(conversationKey) ?? null;
    const decision = planPersonalMessageBatch(changes, existingBinding, {
      activationHours: config.attention?.groupConversationActivationHours ?? 24,
    });
    bindWorkSession(store, {
      kind: "conversation",
      provider: "feishu",
      routeKey: conversationKey,
      eventAt: changes.at(-1)?.occurredAt,
      lastMessageId: changes.at(-1)?.externalId,
      metadata: {
        conversationKey,
        ownershipActivated: decision.ownershipActivated,
        ownershipActivatedUntil: decision.ownershipActivatedUntil,
        ownershipSignals: [...new Set(changes.map((change) => change.signal))],
        attentionDecision: decision.reason,
      },
    });
    if (decision.shouldWake) {
      scheduleAttention({ reason: `feishu:${conversationKey}`, count: changes.length });
      logger.info("Feishu conversation retained and batched for semantic attention", {
        conversationKey,
        signals: [...new Set(changes.map((change) => change.signal))],
        count: changes.length,
        reason: decision.reason,
      });
      continue;
    }
    store.retainInactiveSourceBackground(changes.map(change => change.evidenceId));
    logger.info("Feishu group background retained without semantic wake", {
      conversationKey,
      signals: [...new Set(changes.map((change) => change.signal))],
      count: changes.length,
    });
  }
}

export async function runDaemon(store, config) {
  const lockPath = path.join(config.projectRoot, "runtime", "context-service.lock.json");
  const shutdownRequestPath = path.join(config.projectRoot, "runtime", "shutdown.requested");
  ensureDirectory(path.dirname(lockPath));
  if (fs.existsSync(lockPath)) {
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      if (current.pid && processExists(current.pid)) throw new Error(`Shadow Agent daemon is already running with PID ${current.pid}`);
    } catch (error) {
      if (error.message.includes("already running")) throw error;
    }
  }
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: nowIso() }, null, 2), "utf8");
  store.setContextRuntimeState("starting", "正在启动上下文服务");

  const timers = new Set();
  const interval = (job, milliseconds) => {
    const timer = setInterval(job, milliseconds);
    timers.add(timer);
    return timer;
  };
  let attentionTimer = null;
  let attentionRun = null;
  let databaseHeartbeatFailures = 0;
  let databaseRestartScheduled = false;
  const attentionConfig = config.attention ?? {};
  let observedAttentionScheduleSignature = null;
  let reportedAttentionGate = null;
  const repairCodexTitles = () => {
    if (config.codex?.titleMaintenance?.enabled === false) return null;
    const result = repairCodexStateTitles(config, { apply: true });
    if (result.changed > 0) logger.info("Agent-generated Codex thread titles normalized", result);
    return result;
  };
  const refreshUserProfile = () => {
    try { syncUserProfileFile(store.db, userProfileDirectory(config.paths.database)); }
    catch (error) { logger.warn("Private user profile refresh failed; graph remains authoritative", { error: error.message }); }
  };
  refreshUserProfile();
  interval(refreshUserProfile, 30000);
  interval(() => {
    try {
      const phase = store.getSetting("runtime:context:phase", "idle");
      const detail = store.getSetting("runtime:context:detail", "");
      store.setContextRuntimeState(phase, detail);
      databaseHeartbeatFailures = 0;
    } catch (error) {
      databaseHeartbeatFailures += 1;
      logger.warn("Daemon heartbeat update failed", {
        error: error.message,
        consecutiveFailures: databaseHeartbeatFailures,
      });
      if (!databaseRestartScheduled && shouldRestartAfterDatabaseFailures(
        databaseHeartbeatFailures,
        config.service.databaseHeartbeatFailureRestartThreshold ?? 3,
      )) {
        databaseRestartScheduled = true;
        logger.error("Database health remained unavailable; restarting context service", {
          consecutiveFailures: databaseHeartbeatFailures,
        });
        setImmediate(() => process.exit(71));
      }
    }
  }, 30000);

  const createRuntimeLane = (lane) => createSerializedJobQueue((key, error) => {
    logger.error(`Scheduled ${lane}:${key} failed`, { error: error.message });
  });
  const enqueueControl = createRuntimeLane("control");
  const enqueueExternal = createRuntimeLane("external");
  const enqueueCollection = createRuntimeLane("collection");
  const enqueueAttention = createSerializedJobQueue((key, error) => {
    logger.error(`Scheduled attention:${key} failed`, { error: error.message });
  });
  const enqueueOutbox = createSerializedJobQueue((key, error) => {
    logger.error(`Scheduled outbox:${key} failed`, { error: error.message });
  });
  const collectionStore = openDatabase(config.paths.database);
  const externalStore = openDatabase(config.paths.database);
  const controlStore = openDatabase(config.paths.database);
  const outboxStore = openDatabase(config.paths.database);
  const sessionDispatch = new SessionDispatchQueue();
  const attentionFailureCounts = new Map();

  const deferFailedAttention = (sessionKey, leaseOwner, error, previousAttempts = 0) => {
    const failures = Math.max(attentionFailureCounts.get(sessionKey) ?? 0, previousAttempts) + 1;
    attentionFailureCounts.set(sessionKey, failures);
    const retryAt = new Date(Date.now() + attentionRetryDelayMs(failures, attentionConfig)).toISOString();
    const preserveLease = deferPendingOpenClawTurn(store, sessionKey, retryAt);
    deferAttentionSession(store, { sessionKey, leaseOwner, notBefore: retryAt, preserveLease });
    logger.warn("Semantic attention run failed; retry scheduled", {
      error: error.message,
      sessionKey,
      failures,
      retryAt,
    });
    return retryAt;
  };

  const currentAttentionGate = () => {
    const schedule = readAttentionSchedule(store, attentionConfig);
    observedAttentionScheduleSignature = attentionScheduleSignature(schedule);
    return attentionScheduleStatus(schedule);
  };

  const reportAttentionGate = (gate) => {
    const state = gate.allowed ? "active" : gate.reason === "disabled" ? "disabled" : "paused";
    const reportKey = `${state}:${gate.nextStartAt ?? ""}:${attentionScheduleSignature(gate.schedule)}`;
    if (reportKey === reportedAttentionGate) return;
    reportedAttentionGate = reportKey;
    store.setSetting("runtime:attention:schedule:state", JSON.stringify({
      state,
      nextStartAt: gate.nextStartAt,
      schedule: gate.schedule,
      updatedAt: nowIso(),
    }));
    logger.info("Automatic attention schedule changed", {
      state,
      start: gate.schedule.start,
      end: gate.schedule.end,
      nextStartAt: gate.nextStartAt,
    });
  };

  const armAttentionTimer = () => {
    if (attentionTimer) {
      clearTimeout(attentionTimer);
      timers.delete(attentionTimer);
      attentionTimer = null;
    }
    const gate = currentAttentionGate();
    reportAttentionGate(gate);
    if (!gate.allowed) {
      if (!gate.nextStartAt) return;
      const resumeDelay = Math.max(0, Date.parse(gate.nextStartAt) - Date.now());
      attentionTimer = setTimeout(() => {
        timers.delete(attentionTimer);
        attentionTimer = null;
        armAttentionTimer();
      }, resumeDelay);
      timers.add(attentionTimer);
      return;
    }
    routePendingContextChanges(store, attentionConfig);
    const next = nextAttentionWork(store);
    if (!next?.due_at) return;
    const dueDelay = Math.max(0, Date.parse(next.due_at) - Date.now());
    const delay = attentionRun ? Math.max(30_000, dueDelay) : dueDelay;
    attentionTimer = setTimeout(() => {
      timers.delete(attentionTimer);
      attentionTimer = null;
      enqueueAttention("semantic-attention", dispatchAttention);
    }, delay);
    timers.add(attentionTimer);
  };

  const scheduleAttention = ({ reason, count = 1 }) => {
    const routed = routePendingContextChanges(store, attentionConfig);
    armAttentionTimer();
    const next = nextAttentionWork(store);
    logger.info("Semantic attention scheduled", {
      dueAt: next?.due_at ?? null,
      sessionKey: next?.session_key ?? null,
      count,
      routed: routed.routed,
      reason,
    });
    return next;
  };

  const recordControllerTurn = (resultOrError) => {
    if (resultOrError?.payload?.replayed) return;
    const metrics = resultOrError?.metrics ?? resultOrError?.turnMetrics;
    if (!metrics) return;
    store.recordControllerTurnMetric(metrics, {
      retentionRows: config.controllerBudgets?.retentionRows,
    });
    const details = {
      runId: metrics.runId,
      triggerKind: metrics.triggerKind,
      durationMs: metrics.durationMs,
      inputTokens: metrics.inputTokens,
      cacheReadTokens: metrics.cacheReadTokens,
      outputTokens: metrics.outputTokens,
      toolCalls: metrics.toolCalls,
      budgetStatus: metrics.budgetStatus,
      budgetFlags: metrics.budgetFlags,
    };
    if (metrics.budgetStatus === "warning") logger.warn("OpenClaw controller turn exceeded a runtime budget", details);
    else logger.info("OpenClaw controller turn metrics", details);
  };

  const measuredTurn = async (operation) => {
    try {
      const result = await operation();
      recordControllerTurn(result);
      return result;
    } catch (error) {
      recordControllerTurn(error);
      throw error;
    }
  };

  const processOutbox = (options = {}) => processControllerOutbox(outboxStore, config, {
    limit: options.limit ?? config.tracking?.outboxBatchSize ?? 5,
    dependencies: {
      ...(options.dependencies ?? {}),
      wake: (projectRoot, message, sessionKey, options = {}) => sessionDispatch.run(
        sessionKey,
        () => measuredTurn(() => runOpenClawTurn(projectRoot, {
          allowSilent: true,
          ...options,
          sessionKey,
          message,
          thinking: options.thinking ?? thinkingForTask(config, "task_review"),
          triggerKind: options.triggerKind ?? "controller_outbox",
          budgets: config.controllerBudgets,
          stateStore: outboxStore,
        })),
      ),
      runDirectInputConversation: (projectRoot, input) => sessionDispatch.run(
        input.sessionKey,
        () => measuredTurn(() => runOpenClawTurn(projectRoot, {
          ...input,
          triggerKind: "direct_input",
          budgets: config.controllerBudgets,
          stateStore: outboxStore,
        })),
      ),
      scheduleAttention,
    },
  });

  const superviseTaskProgress = async () => {
    if (!currentAttentionGate().allowed) return { enqueued: 0, skipped: "attention_paused" };
    const result = await auditTaskProgress(controlStore, config);
    if (result.enqueued > 0) {
      scheduleAttention({ reason: "task-progress-due", count: result.enqueued });
      logger.info("Bounded task progress review scheduled", result);
    }
    return result;
  };

  async function dispatchAttention() {
    if (attentionRun) {
      armAttentionTimer();
      return;
    }
    const gate = currentAttentionGate();
    reportAttentionGate(gate);
    if (!gate.allowed) {
      armAttentionTimer();
      return;
    }
    routePendingContextChanges(store, attentionConfig);
    const pending = nextAttentionWork(store, { readyOnly: true });
    if (!pending) {
      armAttentionTimer();
      return;
    }
    const sessionKey = pending.session_key;
    const binding = store.workSessionByKey(sessionKey);
    const isKnowledgeCuration = binding?.conversation_key === "knowledge-curation";
    const reasoningTask = attentionTaskType(pending);
    const thinking = thinkingForTask(config, reasoningTask);
    const attempt = pending.recoveryRunId ? null : attentionAttempt(store, pending);
    const runId = pending.recoveryRunId ?? attempt.runId;
    const batch = captureAttentionBatch(store, pending);
    const leaseOwner = attentionLeaseOwner(sessionKey, runId);
    try {
      const prompt = [
          `稳定工作会话 ${sessionKey} 有 ${pending.change_count} 个已到期的增量变化。`,
          `先调用 shadow_attention_packet：sessionKey=${sessionKey}、leaseOwner=${leaseOwner}、limit=4、maxBytes=12288。通常只领取一个包；原文还有未读分页或收到运行中新信息通知时，先妥善处理已领变化，再用同一租约领取必要新页。禁止空轮询；参数校验失败应修正重试。`,
          "注意力包包含本会话检查点、长期简况、候选卡片和有限新证据。候选为空不证明没有既有任务；发现具体工作但无匹配卡片时，先用 shadow_context_focus 的有界雷达查找，再读取可能相关卡片。只在出现具体未知问题时调用 shadow_context_resolve；禁止扫描全库或列出整个 Workboard。",
          "evidence_batch_ingested 是来源输入。读完当前页并按需检索相关卡片后，用 shadow_information_dispatch 指定本页 Evidence IDs、knowledge 与受影响 tasks 及原因；两者可同时选择，也可说明为何均不需要。新任务先建立唯一卡片再分发。分发持久化后才能 ACK 来源；不等待知识维护完成，也不直接推进其他任务会话。回复草稿的既有流程不能替代信息分发，且不要再为来源批次重复回复。",
          "informationDelivery 是已分发的信息，不能再次调用分发工具。任务先核对原始证据和发生时间，决定是否改变自己的计划；需要知识沉淀时仅提交有新增内容的检查点 learning。知识维护判断重复、修订与冲突，只有实质变化才回告相关任务；复述同一来源不构成独立佐证。",
          "若注意力包包含 human_agent_operation，优先处理这类用户指令。只处理 metadata.taskId 指向的卡片；自然语言下一步需要由你结合上下文判断，已由确定性通路执行的 confirm_done 等命令不得撤销或重复执行。",
          "任务独立会话只推进绑定的任务。读取该卡目标和本次 Evidence，按需检索共享知识；不加载主对话或其他任务的全部历史。对用户交代必须使用 workboard_comment 在同一卡片留下可直接阅读的答复、结果或具体问题；不能只在模型终答中回复，也不能用已接收代替执行结果。",
          "若注意力包包含 task_progress_due，读取且只读取 metadata.taskId 指向的卡片，核对相关外部条件、文档、代码或 Codex 结果是否变化，并推进一个可形成结果的内部动作；若仍需等待，必须留下具体预期事件和未来复查时间。",
          "若复查原因是 knowledge_feedback_reviewed，人工反馈的知识维护已返回结果，不是新增任务或授权。读取原始反馈和复核结论，重新判断原卡责任、完成证据与下一步；不能仅因事实暂定就忽略明确的用户交代，也不能把 completed 复核状态当成任务已完成。无变化也要留下核对结果；已结束卡不要重开。",
          "复查若带有 executionRunId/executionSessionKey，先按原运行查询原生状态和结果；cached running 或复查到期都不是失败证明。观察失败时保留原运行继续核对，不得另开同一任务；运行成功也须核对产物才可验收。",
          "runtime_reconciliation_due 表示旧控制运行丢失，但业务结果未知；先核对卡片评论、子任务回执及外部效果，接续已有结果，不得直接重复派发或发送。核对结论写回同一卡片再确认变化。",
          "明确归属已经授权本地只读调查、工作区修改、测试和草稿，不得再等待笼统的实施授权。只有缺少具体输入/决策、现实验收，或到达对外发送、外部文档写入、Git 提交推送、部署发布、设备控制、特权访问和破坏性操作边界时，才可使用带结构化 userAction 的 requires_user。",
          "shadow_task_checkpoint、条件解析、增量确认和 Workboard 状态属于当前 OpenClaw 控制层，不得交给 Codex 子任务；子任务报告看不到 Shadow 工具不构成人工阻塞。",
          ...(isKnowledgeCuration ? [
            "本轮是专用知识维护会话，只消费 knowledge_review_due/knowledge_delta_due，禁止调用 shadow_context_capture、shadow_knowledge_delta_capture 或 shadow_context_revise，禁止把输入差量再包装成新差量。",
            `必须对注意力包中的精确 Evidence ID 调用 shadow_context_enrichment（leaseOwner=${leaseOwner}），有界查询现有知识后按需调用 shadow_context_propose；无论结果是合并、新增、取代、无需长期化或需追问，都必须调用 shadow_context_annotate 完成该 Evidence 的 graphReview，再确认变化。`,
            "若任务差量只是复述已有可用原始知识，用 alreadyRepresentedFactIds 指向它，不再用任务总结增加佐证。若发现影响其他活动任务，用 taskImpacts 给出卡片 ID 与原因；不要自行改卡或重开已结束任务。比较信息发生时间、作用域与证据，晚到不等于更新。",
          ] : []),
          "先判断结果责任，再判断业务相关性。只有明确指派/提及当前用户、当前用户无歧义的第一人称承诺、权威任务归属、用户明确接手或已确认活动卡延续，才可创建或激活 user_work。sentBySelf 只证明发送身份：本人发给对方的指令、请求、派工、状态询问或范围澄清不是本人承诺；单聊中对方追问范围并明确接受，默认是对方承担被委派结果，除非有更强证据重新指向当前用户。明确指派他人和未指派群消息只能作为背景、依赖或风险。身份以 open_id、sentBySelf、mentionsSelf 为准，禁止因姓名相近、同领域、关键词或紧急措辞把他人工作归给用户。",
          `完成后调用 shadow_context_ack，并使用 leaseOwner=${leaseOwner} 确认本轮变化。对外发送、审批、提交、部署和设备操作仍需明确授权。`,
        ].join("\n");
      store.setSetting("controller:attention:lastDispatchAt", nowIso());
      store.markWorkSessionDispatched(sessionKey);
      store.setSetting("controller:attention:run", JSON.stringify({
        state: "running",
        startedAt: nowIso(),
        pending: Number(pending.change_count),
        sessionKey,
        sessionKind: binding?.session_kind ?? "unknown",
        leaseOwner,
        runId,
      }));
      store.setContextRuntimeState("thinking", sessionRuntimeDetail(binding, pending.change_count));
      attentionRun = sessionDispatch.run(sessionKey, () => measuredTurn(() => runOpenClawTurn(config.projectRoot, {
        sessionKey,
        message: prompt,
        runTimeoutSeconds: Number(attentionConfig.runTimeoutSeconds ?? 0),
        waitSliceSeconds: Number(attentionConfig.waitSliceSeconds ?? 60),
        thinking,
        triggerKind: "attention",
        idempotencyKey: runId,
        budgets: config.controllerBudgets,
        stateStore: controlStore,
        resumePending: true,
        allowSilent: true,
        observeOnce: true,
        attentionBatch: batch,
      }))).then((result) => {
        confirmAttentionProgress(store, result.payload.attentionBatch ?? batch);
        advanceAttentionAttempt(store, attempt);
        attentionFailureCounts.delete(sessionKey);
        store.markWorkSessionCompleted(sessionKey);
        store.setSetting("controller:attention:run", JSON.stringify({
          state: "completed", finishedAt: nowIso(), sessionKey,
        }));
      }).catch((error) => {
        if (error.requiresReconciliation) enqueueLostRunReconciliation(store, { sessionKey, runId: error.runId });
        const waiting = error.code === "OPENCLAW_RUN_PENDING";
        const receipt = openClawTurnReceipt(store, sessionKey, runId);
        if (receipt && ["completed", "failed"].includes(receipt.state)) advanceAttentionAttempt(store, attempt);
        const retryAt = waiting ? new Date(Date.now() + 30_000).toISOString()
          : deferFailedAttention(sessionKey, leaseOwner, error, attempt?.attempt ?? 0);
        if (waiting) deferPendingOpenClawTurn(store, sessionKey, retryAt);
        store.setSetting("controller:attention:run", JSON.stringify({
          state: waiting ? "waiting" : "failed",
          finishedAt: nowIso(),
          error: error.message,
          sessionKey,
          runId,
          retryAt,
        }));
      }).finally(() => {
        attentionRun = null;
        if (!pendingOpenClawTurn(store, sessionKey)) releaseAttentionLease(store, leaseOwner);
        store.setContextRuntimeState("idle", "上下文已就绪，等待下一次变化");
        armAttentionTimer();
      });
      logger.info("Semantic attention dispatched", {
        pending: Number(pending.change_count), sessionKey, leaseOwner, runId,
        reasoningTask, thinking,
      });
    } catch (error) {
      deferFailedAttention(sessionKey, leaseOwner, error);
      armAttentionTimer();
    }
  }

  const collect = async (full = false) => {
    collectionStore.setContextRuntimeState("collecting", full ? "正在全面更新证据与知识图谱" : "正在增量更新证据与知识图谱");
    try {
      const result = await collectAll(collectionStore, config, full ? {} : {
        skipProjects: true,
        localOnly: true,
        incremental: true,
      });
      if (result.feishu?.newMessages?.length) routePersonalMessageChanges(store, config, result.feishu.newMessages, scheduleAttention);
      if (Number(result.contextGraph?.changes ?? 0) > 0) {
        scheduleAttention({
          reason: full ? "full-reconcile" : "local-increment",
          count: result.contextGraph.changes,
        });
      }
      evaluateConditionWatches(collectionStore, config.tracking);
    } finally {
      collectionStore.setContextRuntimeState("idle", "上下文已就绪，等待下一次变化");
    }
  };

  const collectFeishuQuick = async (kind) => {
    const sections = feishuQuickCollectionOptions(kind);
    externalStore.setSetting(`runtime:feishu:quick:${kind}:state`, "running");
    try {
      const result = await collectFeishu(externalStore, config, {
        ...sections,
        pageLimit: 1,
        maxDocumentBodies: kind === "documents" ? 3 : 0,
        resetDrivePage: kind === "documents",
      });
      recordFeishuCollectionHealth(externalStore, kind, result);
      if (!result.evidence) return result;
      buildDigests(externalStore, config);
      const graph = materializeContextGraph(externalStore, config, { refreshStructural: false, runMaintenance: false });
      evaluateConditionWatches(externalStore, config.tracking);
      if (kind === "messages" && result.newMessages.length) {
        routePersonalMessageChanges(store, config, result.newMessages, scheduleAttention);
      } else if (kind === "documents" && result.documentContentEvidence > 0 && graph.changes > 0) {
        scheduleAttention({
          reason: "feishu-document-content",
          count: graph.changes,
        });
      } else if (["tasks", "approvals"].includes(kind) && graph.changes > 0) {
        scheduleAttention({
          reason: `feishu-${kind}-fallback`,
          count: graph.changes,
        });
      }
      enqueueOutbox("controller-outbox", () => processOutbox());
    } catch (error) {
      externalStore.setSetting(`runtime:feishu:quick:${kind}:state`, `error:${error.message}`);
      throw error;
    }
  };

  const eventBridge = new FeishuEventBridge({
    store,
    config,
    runAgent: (projectRoot, input) => measuredTurn(() => runOpenClawTurn(projectRoot, {
      ...input,
      triggerKind: "feishu_realtime",
      budgets: config.controllerBudgets,
      stateStore: store,
    })),
    dispatchSession: (sessionKey, operation) => sessionDispatch.run(sessionKey, operation),
    scheduleAttention: ({ reason, count = 1 }) => scheduleAttention({ reason, count }),
  });
  let cleanedUp = false;
  const voiceIntake = startVoiceIntakeService(config, { onChange: () => scheduleAttention({ reason: "voice-intake", count: 1 }) });
  // UI corrections persist directly to the existing context queue, including while offline.
  let voiceRevision = '';
  interval(() => {
    const pending = store.db.prepare("SELECT COUNT(*) n,MAX(seq) seq,SUM(json_extract(metadata_json,'$.count')) size FROM context_changes WHERE status='pending' AND json_extract(metadata_json,'$.provider')='voice'").get();
    const revision = JSON.stringify(pending);
    if (pending.n && revision !== voiceRevision) scheduleAttention({ reason: "voice-context-change", count: pending.n });
    voiceRevision = revision;
  }, 5000);
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    voiceIntake.stop();
    for (const timer of timers) clearInterval(timer);
    eventBridge.stop().catch(() => {});
    try { store.setContextRuntimeState("offline", "上下文服务已停止"); } catch { /* database may already be closed */ }
    try { fs.unlinkSync(lockPath); } catch { /* already removed */ }
    try { collectionStore.close(); } catch { /* already closed */ }
    try { externalStore.close(); } catch { /* already closed */ }
    try { controlStore.close(); } catch { /* already closed */ }
    try { outboxStore.close(); } catch { /* already closed */ }
    try { store.close(); } catch { /* already closed */ }
  };
  interval(() => {
    if (!fs.existsSync(shutdownRequestPath)) return;
    try { fs.unlinkSync(shutdownRequestPath); } catch { /* stop remains idempotent */ }
    cleanup();
    process.exit(0);
  }, 250);
  process.once("SIGINT", () => { cleanup(); process.exit(0); });
  process.once("SIGTERM", () => { cleanup(); process.exit(0); });
  process.once("exit", cleanup);

  logger.info("Shadow Agent context service started", {
    pid: process.pid,
    collectionIntervalMinutes: config.service.collectionIntervalMinutes,
    controller: "openclaw",
  });
  repairCodexTitles();
  const lastFull = Date.parse(store.getSetting("collection:lastFullProjectScanAt", ""));
  const fullIntervalMs = config.service.fullReconcileIntervalHours * 60 * 60 * 1000;
  const needsFullCollection = !Number.isFinite(lastFull) || Date.now() - lastFull >= fullIntervalMs;
  await enqueueCollection("collection", () => collect(false));
  await eventBridge.start().catch((error) => logger.warn("Feishu event bridge start failed", { error: error.message }));
  store.setSetting("controller:attention:pending", "null");
  scheduleAttention({ reason: "startup-pending-recovery", count: 1 });
  enqueueControl("condition-watches", () => {
    evaluateConditionWatches(controlStore, config.tracking);
    enqueueOutbox("controller-outbox", () => processOutbox());
  });
  enqueueControl("task-progress", () => superviseTaskProgress());
  if (config.feishu.enabled) {
    const personalSources = config.feishu.personalSources ?? {};
    if (personalSources.messages?.enabled !== false) enqueueExternal("feishu-messages", () => collectFeishuQuick("messages"));
    if (personalSources.documents?.enabled !== false) enqueueExternal("feishu-documents", () => collectFeishuQuick("documents"));
    if (personalSources.tasks?.enabled !== false) enqueueExternal("feishu-tasks", () => collectFeishuQuick("tasks"));
    if (personalSources.approvals?.enabled !== false) enqueueExternal("feishu-approvals", () => collectFeishuQuick("approvals"));
  }

  interval(
    () => enqueueCollection("collection", () => collect(false)),
    config.service.collectionIntervalMinutes * 60 * 1000,
  );
  interval(
    () => enqueueCollection("codex-title-maintenance", () => repairCodexTitles()),
    Math.max(30, Number(config.codex?.titleMaintenance?.intervalSeconds ?? 60)) * 1000,
  );
  interval(
    () => enqueueAttention("attention-recovery", async () => {
      scheduleAttention({ reason: "pending-change-recovery", count: 1 });
    }),
    Math.max(5, Number(attentionConfig.recoveryMinutes ?? 10)) * 60 * 1000,
  );
  interval(
    () => {
      const schedule = readAttentionSchedule(store, attentionConfig);
      const signature = attentionScheduleSignature(schedule);
      if (signature === observedAttentionScheduleSignature) return;
      enqueueAttention("attention-schedule-refresh", async () => armAttentionTimer());
    },
    15_000,
  );
  interval(
    () => enqueueCollection("full-collection", () => collect(true)),
    fullIntervalMs,
  );
  if (config.feishu.enabled) {
    const personalSources = config.feishu.personalSources ?? {};
    if (personalSources.messages?.enabled !== false) {
    interval(
      () => enqueueExternal("feishu-messages", () => collectFeishuQuick("messages")),
      Math.max(15, Number(personalSources.messages?.pollSeconds ?? 60)) * 1000,
    );
    }
    if (personalSources.documents?.enabled !== false) {
    interval(
      () => enqueueExternal("feishu-documents", () => collectFeishuQuick("documents")),
      Math.max(300, Number(personalSources.documents?.pollSeconds ?? 600)) * 1000,
    );
    }
    if (personalSources.tasks?.enabled !== false) {
      interval(
        () => enqueueExternal("feishu-tasks", () => collectFeishuQuick("tasks")),
        Math.max(1, Number(personalSources.tasks?.fallbackPollMinutes ?? 15)) * 60 * 1000,
      );
    }
    if (personalSources.approvals?.enabled !== false) {
      interval(
        () => enqueueExternal("feishu-approvals", () => collectFeishuQuick("approvals")),
        Math.max(1, Number(personalSources.approvals?.fallbackPollMinutes ?? 15)) * 60 * 1000,
      );
    }
  }
  interval(
    () => enqueueControl("condition-watches", () => {
      evaluateConditionWatches(controlStore, config.tracking);
      enqueueOutbox("controller-outbox", () => processOutbox());
    }),
    Math.max(5, Number(config.tracking?.conditionCheckSeconds ?? 30)) * 1000,
  );
  interval(
    () => enqueueControl("task-progress", () => superviseTaskProgress()),
    Math.max(1, Number(config.taskSupervision?.auditMinutes ?? 5)) * 60 * 1000,
  );
  interval(
    () => enqueueOutbox("controller-outbox", () => processOutbox()),
    Math.max(2, Number(config.tracking?.outboxPollSeconds ?? 3)) * 1000,
  );
  if (needsFullCollection) enqueueCollection("full-collection", () => collect(true));
  await new Promise(() => {});
}

export function feishuQuickCollectionOptions(kind) {
  const sections = {
    messages: false,
    approvals: false,
    tasks: false,
    drive: false,
  };
  if (kind === "messages") sections.messages = true;
  else if (kind === "documents") sections.drive = true;
  else if (kind === "tasks") sections.tasks = true;
  else if (kind === "approvals") sections.approvals = true;
  else throw new Error(`Unknown Feishu quick collection kind: ${kind}`);
  return sections;
}
