import { bindWorkSession } from "./work-sessions.mjs";
import { recordAgentOperation, resolveTaskOwnerSession } from "./agent-operations.mjs";
import { runOpenClawConversation } from "./openclaw/cli.mjs";
import { thinkingForTask } from "./openclaw/reasoning-policy.mjs";
import { listWorkboardCardsThroughGateway } from "./workboard-operations.mjs";

export const DIRECT_INPUT_SESSION_KEY = "agent:main:shadow:user";

function parse(value, fallback = {}) {
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

export function ensureDirectInputSession(store, eventAt = new Date().toISOString()) {
  return bindWorkSession(store, {
    kind: "conversation",
    provider: "shadow",
    routeKey: "user",
    sessionKey: DIRECT_INPUT_SESSION_KEY,
    eventAt,
    metadata: {
      title: "用户直接交代",
      source: "pet-direct-input",
    },
  });
}

export const DIRECT_INPUT_INSTRUCTION = `这是用户从宠物统一入口直接交给 Shadow Agent 的消息。不要要求用户预先选择“问答、知识、提醒或任务”，由你结合原话和当前上下文判断。

- 问题：按需检索并直接回答；无法确定时给出下一处可查询来源。
- 首次使用或用户要求完善基本资料：先读当前个人简况，只询问缺失信息和希望接入的软件/资料范围。按 docs/operations/user-knowledge-onboarding.md 使用 scripts/user-profile.mjs 预览基本资料与初始化任务计划，用户确认后再提交；不要只在聊天或 USER.md 另存一份。初始化的用户补充、软件登录和 Agent 调查同样通过 Workboard 推进，不收集明文凭据。普通明确交办不因资料缺项而停住。
- 稳定知识、决定、职责或资料位置：使用现有知识工具维护长期认知；原话已由界面保存为证据，不要重复录入同一份原文。
- 有明确通知时间的事项：使用提醒工具；提醒不等于任务。
- 用户明确要求 Agent 完成、推进、制作、核查或持续负责的工作：它具有直接的用户授权和归属依据。优先续接同一目标的活动 Workboard 卡；没有时使用 workboard_create 创建一张规范卡，写清目标、验收标准、来源 Evidence、权限边界和下一触发。新建或续接时，必须将本次精确 Evidence ID 写入卡片来源。主对话只负责澄清、建卡和简短回执；任务执行由系统交给该卡的独立稳定会话，不在主对话启动工程子任务，不把执行日志灌回主对话。
- 明确归属同时授权本地调查、工作区修改、测试和草稿；不得再用笼统“等待实施授权”停住。只有缺少具体输入/决策、需要现实验收，或即将执行对外发送、外部文档写入、Git 提交推送、部署发布、设备控制、特权访问、破坏性操作时，才可停在 requires_user，并明确写出结构化 userAction。
- OpenClaw 自己负责任务检查点、条件解析、Workboard 状态和增量确认；Codex 子任务只负责工程工作。子任务看不到 Shadow 工具时，OpenClaw 必须接回控制动作，不能把它转成用户阻塞。
- 普通讨论或一次性回答不得为了显得忙碌而创建卡片；同一句话不得同时创建重复卡片。

任务卡是唯一任务状态，稳定会话只承载上下文。最终简洁说明你做了什么；创建或续接卡片时明确给出卡片标题和 ID。`;

export function buildDirectInputPrompt({ text, evidenceId }) {
  const normalizedText = String(text ?? "").trim();
  const normalizedEvidenceId = String(evidenceId ?? "").trim();
  if (!normalizedText) throw new Error("Direct input text is required.");
  if (!normalizedEvidenceId) throw new Error("Direct input evidence id is required.");
  return `${DIRECT_INPUT_INSTRUCTION}\n\n本次输入的原始 Evidence ID：${normalizedEvidenceId}\n\n用户输入：\n${normalizedText}`;
}

export function cardsForEvidence(cards, evidenceId) {
  const marker = String(evidenceId ?? "").trim();
  if (!marker) return [];
  return (cards ?? [])
    .filter((card) => JSON.stringify(card).includes(marker))
    .map((card) => ({ id: card.id, title: card.title }));
}

export function enqueueDirectInputRequest(store, input) {
  const evidenceId = String(input.evidenceId ?? "").trim();
  const sessionKey = String(input.sessionKey ?? DIRECT_INPUT_SESSION_KEY).trim();
  if (!evidenceId) throw new Error("Direct input Evidence ID is required.");
  ensureDirectInputSession(store);
  const receipt = store.createDirectInputReceipt({
    evidenceId,
    sessionKey,
    metadata: { source: input.source ?? "pet-ui" },
  });
  const action = store.enqueueControllerAction({
    idempotencyKey: `process-direct-input:${receipt.id}`,
    actionType: "process_direct_input",
    payload: { requestId: receipt.id, evidenceId, sessionKey },
  });
  return { receipt, action };
}

export async function processDirectInputRequest(store, config, requestId, dependencies = {}) {
  let receipt = store.directInputReceipt(requestId);
  if (!receipt) throw new Error(`Direct input receipt not found: ${requestId}`);
  if (receipt.status === "completed") {
    const metadata = parse(receipt.metadata_json, {});
    return {
      requestId: receipt.id,
      evidenceId: receipt.evidence_id,
      sessionKey: receipt.session_key,
      text: receipt.response_text ?? "",
      createdTasks: Array.isArray(metadata.createdTasks) ? metadata.createdTasks : [],
      idempotent: true,
    };
  }
  const evidence = store.db.prepare(`
    SELECT id, content FROM evidence WHERE id=? AND kind='manual_knowledge'
  `).get(receipt.evidence_id);
  if (!evidence) throw new Error(`Direct input Evidence not found: ${receipt.evidence_id}`);
  const startedAt = receipt.started_at ?? new Date().toISOString();
  receipt = store.updateDirectInputReceipt(receipt.id, {
    status: "processing",
    startedAt,
    lastError: null,
  });
  const runConversation = dependencies.runConversation ?? runOpenClawConversation;
  const listCards = dependencies.listCards ?? listWorkboardCardsThroughGateway;
  const result = await runConversation(config.projectRoot, {
    sessionKey: receipt.session_key,
    message: buildDirectInputPrompt({ text: evidence.content, evidenceId: evidence.id }),
    runTimeoutSeconds: Number(config.attention?.runTimeoutSeconds ?? 0),
    waitSliceSeconds: Number(config.attention?.waitSliceSeconds ?? 60),
    thinking: thinkingForTask(config, "direct_input"),
    idempotencyKey: receipt.idempotency_key,
    historySinceAt: startedAt,
    stateStore: store,
  });
  const cards = await listCards(config.projectRoot);
  const createdTasks = cardsForEvidence(cards, evidence.id);
  for (const item of createdTasks) {
    const card = cards.find((candidate) => candidate.id === item.id);
    if (!card) continue;
    const owner = resolveTaskOwnerSession(store, card, {
      sessionKey: receipt.session_key,
      bindingReason: "direct_user_input",
      evidenceIds: [evidence.id],
    });
    recordAgentOperation(store, {
      operationId: `direct-task:${receipt.id}:${card.id}`, actor: "user", source: "main-conversation",
      action: "task_handoff", targetType: "workboard_task", targetId: card.id, taskId: card.id,
      card, owner, evidenceIds: [evidence.id], evidenceId: evidence.id,
      desiredEffect: "interpret_task_message", summary: `主对话交代任务：${card.title}`,
      metadata: { taskTitle: card.title, userText: evidence.content, originSessionKey: receipt.session_key },
    });
  }
  const acceptedRunId = result.payload?.accepted?.runId ?? receipt.idempotency_key;
  store.updateDirectInputReceipt(receipt.id, {
    status: "completed",
    responseText: result.text,
    createdTaskIds: createdTasks.map((item) => item.id),
    runId: acceptedRunId,
    completedAt: new Date().toISOString(),
    lastError: null,
    metadata: { createdTasks },
  });
  return {
    requestId: receipt.id,
    evidenceId: evidence.id,
    sessionKey: receipt.session_key,
    text: result.text,
    createdTasks,
    runId: acceptedRunId,
    idempotent: false,
  };
}
