import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8").replace(/^\uFEFF/, "");

test("project contract and current documentation have one canonical architecture", () => {
  assert.ok(read("openclaw/workspace-template/AGENTS.md").length <= 20_000, "workspace rules must fit the runtime injection limit");
  for (const relativePath of [
    "docs/PROJECT_CONTRACT.md",
    "docs/ARCHITECTURE.md",
    "docs/SOURCE_ADAPTER_ARCHITECTURE.md",
    "docs/GENERIC_EPISTEMIC_GRAPH.md",
    "docs/OPERATIONS.md",
    "docs/FEISHU_SETUP.md",
    "docs/README.md",
  ]) assert.ok(fs.existsSync(path.join(root, relativePath)), `missing ${relativePath}`);

  assert.equal(fs.existsSync(path.join(root, "docs/ARCHITECTURE_V2.md")), false);
  assert.match(read("README.md"), /docs\/PROJECT_CONTRACT\.md/);
  assert.match(read("docs/ARCHITECTURE.md"), /PROJECT_CONTRACT\.md/);
  assert.match(read("docs/SOURCE_ADAPTER_ARCHITECTURE.md"), /ADR-0028/);
});

test("ADR filenames, headings, and index entries use one unique identifier", () => {
  const decisionsRoot = path.join(root, "docs", "decisions");
  const index = read("docs/decisions/README.md");
  const ids = new Set();
  for (const name of fs.readdirSync(decisionsRoot).filter((entry) => /^\d{4}-.*\.md$/.test(entry))) {
    const fileId = name.slice(0, 4);
    const firstLine = read(path.join("docs", "decisions", name)).split(/\r?\n/, 1)[0];
    const headingId = firstLine.match(/^# ADR[- ](\d{4})/)?.[1];
    assert.equal(headingId, fileId, `${name} heading id mismatch`);
    assert.equal(ids.has(fileId), false, `duplicate ADR id ${fileId}`);
    ids.add(fileId);
    assert.match(index, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${name} missing from ADR index`);
  }
});

test("contract preserves the single-controller and single-task-source invariants", () => {
  const contract = read("docs/PROJECT_CONTRACT.md");
  const architecture = read("docs/ARCHITECTURE.md");
  const agentRules = read("openclaw/workspace-template/AGENTS.md");
  const heartbeat = read("openclaw/workspace-template/HEARTBEAT.md");
  const manifest = read("openclaw/shadow-work/openclaw.plugin.json");
  const runtimeTemplate = read("config/openclaw-runtime-template.json");
  const controllerOutbox = read("src/controller-outbox.mjs");
  const outboundMessages = read("src/outbound-messages.mjs");
  const workboardOperations = read("src/workboard-operations.mjs");

  assert.match(contract, /Shadow Agent 是唯一主动主控/);
  assert.match(contract, /Workboard 是活动任务和任务生命周期的唯一真相源/);
  assert.match(architecture, /Workboard SQLite\s+-> 现在要做什么/);
  assert.match(agentRules, /sole orchestrator/);
  assert.match(heartbeat, /sole controller/);
  assert.match(contract, /INV-13/);
  assert.match(contract, /INV-16/);
  assert.match(contract, /INV-17/);
  assert.match(contract, /INV-18/);
  assert.match(contract, /INV-19/);
  assert.match(contract, /INV-20/);
  assert.match(contract, /INV-21/);
  assert.match(contract, /INV-22/);
  assert.match(contract, /INV-23/);
  assert.match(contract, /INV-24/);
  assert.match(contract, /INV-25/);
  assert.match(contract, /INV-26/);
  assert.match(contract, /INV-27/);
  assert.match(contract, /INV-28/);
  assert.match(contract, /INV-29/);
  assert.match(contract, /INV-30/);
  assert.match(contract, /INV-31/);
  assert.match(contract, /INV-32/);
  assert.match(contract, /INV-33/);
  assert.match(contract, /INV-34/);
  assert.match(contract, /INV-35/);
  assert.match(contract, /INV-36/);
  assert.match(contract, /INV-37/);
  assert.match(contract, /INV-38/);
  assert.match(contract, /INV-39/);
  assert.match(contract, /INV-40/);
  assert.match(contract, /INV-41/);
  assert.match(contract, /INV-42/);
  assert.match(contract, /INV-43/);
  assert.match(contract, /INV-44/);
  assert.match(contract, /INV-45/);
  assert.match(contract, /INV-46/);
  assert.match(contract, /INV-47/);
  assert.match(contract, /INV-48/);
  assert.match(contract, /INV-49/);
  assert.match(contract, /INV-50/);
  assert.match(contract, /INV-51/);
  assert.match(contract, /INV-52/);
  assert.match(contract, /INV-53/);
  assert.match(contract, /INV-54/);
  assert.match(contract, /INV-55/);
  assert.match(contract, /INV-62/);
  assert.match(contract, /INV-63/);
  assert.match(contract, /INV-64/);
  assert.match(contract, /INV-65/);
  assert.match(contract, /INV-66/);
  assert.match(contract, /INV-67/);
  assert.match(contract, /INV-68/);
  assert.match(contract, /INV-69/);
  assert.match(contract, /INV-73/);
  assert.match(contract, /INV-74/);
  assert.match(contract, /INV-75/);
  assert.match(contract, /INV-76/);
  assert.match(contract, /INV-77/);
  assert.match(contract, /人工入口使用独立稳定会话并与后台巡检 inbox 隔离/);
  assert.match(runtimeTemplate, /"codexDynamicToolsLoading": "direct"/);
  assert.match(contract, /姓名相近、同领域和关键词命中均不得作为归属依据/);
  assert.match(contract, /业务相关性不得直接推出用户结果责任/);
  assert.match(contract, /不得建立并行人员数据库/);
  assert.match(contract, /不得把原始档案、完整结构化快照/);
  assert.match(contract, /结构化 continuation/);
  assert.match(contract, /有界进度审计/);
  assert.match(contract, /内部复查不得调用 `shadow_reminder_create`/);
  assert.match(contract, /同一任务同一时刻必须幂等/);
  assert.match(contract, /`candidate` 和 `timed_out` 是 Agent 的语义复核触发/);
  assert.match(contract, /不得用“有新结果”误导用户/);
  assert.match(contract, /关键词只可缩小无精确范围的广域筛选/);
  assert.match(contract, /句法归属标签都不是最终任务判定/);
  assert.match(manifest, /"trustedToolPolicies": \[\]/);
  assert.match(agentRules, /Ownership labels.*routing evidence/);
  assert.match(heartbeat, /grouped by conversation/);
  assert.match(contract, /机器人会话只作为可选交互入口/);
  assert.match(contract, /external_event_receipts/);
  assert.match(contract, /OpenClaw Cron/);
  assert.match(contract, /当前 `hitl` 模式不得绕过宠物确认/);
  assert.match(contract, /有界上下文/);
  assert.match(contract, /“持续追踪”状态条必须可打开只读详情/);
  assert.match(contract, /统一人工反馈知识 Episode/);
  assert.match(contract, /飞书拒绝必须由用户填写自然语言原因/);
  assert.match(contract, /不得为任务反馈、消息反馈或偏好学习建立独立知识库/);
  assert.match(contract, /不得只显示 Workboard 评论而隐藏知识处理状态/);
  assert.match(contract, /不得要求用户再点一次“确认已完成”/);
  assert.match(contract, /模型运行时授权有效且额度充足是语义执行前提/);
  assert.match(contract, /每张活动 Workboard 卡必须归属按 card_id 稳定绑定的独立任务会话/);
  assert.match(contract, /宠物不得用正则或关键词自行解释任意自然语言并改变任务状态/);
  assert.match(contract, /宠物首页必须只有一个通用自然语言入口/);
  assert.match(contract, /明确交给 Agent 的可执行工作必须在本轮创建或续接一张规范 Workboard 卡/);
  assert.match(contract, /任务详情必须提供“继续交代”入口/);
  assert.match(contract, /回执完成前绑定独立任务会话并幂等投递交接事件/);
  assert.match(contract, /本机 transcript 持久化与模型推理位置必须分别说明/);
  assert.match(contract, /恢复后按 `operation_id` 合并补送/);
  assert.match(contract, /项目是知识与检索作用域，不是默认模型会话/);
  assert.match(contract, /默认不超过 12 KiB、硬上限 16 KiB/);
  assert.match(contract, /统一人工入口必须在一个本地事务中保存原始 Evidence、持久回执和 `controller_outbox` 动作后立即返回/);
  assert.match(contract, /不得丢失输入、重复启动语义轮次或重复建卡/);
  assert.match(contract, /检查点只属于任务关注与审计覆盖层/);
  assert.match(agentRules, /`shadow_task_checkpoint`, with the exact leased `changeSeq`/);
  assert.match(agentRules, /expectedCheckpointRevision/);
  assert.match(heartbeat, /The tool rejects guarded active-task changes/);
  assert.match(heartbeat, /a delta is an input to consume, not another delta to produce/);
  assert.match(agentRules, /returned child `sessionKey`/);
  assert.match(heartbeat, /resolved model/);
  assert.match(controllerOutbox, /bind_workboard_execution/);
  assert.match(workboardOperations, /workboard\.cards\.update/);
  assert.match(outboundMessages, /bindTaskReplyWatch/);
  assert.match(contract, /候选发生后先为该任务写入一次结果检查点/);
  assert.match(contract, /不得仍引用同一个 watch/);
  assert.match(contract, /指标不得保存提示词、回复正文、真实会话键或消息内容/);
  assert.match(contract, /`pending`，以及无 `endedAt` 且阶段为 `queue\/gateway_draining` 的 `timeout`，都是正常非终态并必须续等/);
  assert.match(architecture, /项目本身不创建模型会话/);
  assert.match(architecture, /Collaboration/);
  assert.match(architecture, /Execution/);
  const adapters = read("docs/SOURCE_ADAPTER_ARCHITECTURE.md");
  const adapterRegistry = read("src/source-adapters/registry.mjs");
  const sourceRecords = read("src/source-records.mjs");
  const evidenceTool = read("openclaw/shadow-work/src/index.js");
  assert.match(adapters, /src\/collectors\/codex\.mjs/);
  assert.match(adapters, /src\/collectors\/feishu\.mjs/);
  assert.match(adapters, /src\/realtime\/feishu-events\.mjs/);
  assert.match(adapters, /底层证据统一、中间领域分离、顶层业务汇合/);
  assert.match(adapterRegistry, /codexSourceAdapter/);
  assert.match(adapterRegistry, /feishuSourceAdapter/);
  for (const table of ["source_observations", "collaboration_events", "execution_events"]) {
    assert.match(sourceRecords, new RegExp(table));
  }
  assert.match(sourceRecords, /DROP VIEW IF EXISTS source_observation_projection/);
  assert.match(evidenceTool, /sourceFamilies/);
  assert.match(evidenceTool, /eventKinds/);
  assert.match(agentRules, /Projects are knowledge scopes, not default model sessions/);
  assert.doesNotMatch(contract, /首页人工输入先进入稳定 inbox 会话/);
  assert.doesNotMatch(architecture, /动态工具采用 `searchable`/);
  assert.doesNotMatch(architecture, /Pet --> Workboard/);
  assert.match(agentRules, /never call a Lark send\/reply tool directly/);
  assert.match(agentRules, /Every active Workboard card must end each controller turn/);
  assert.match(agentRules, /Never silently steer user sessions/);
  assert.match(agentRules, /Keep every new Codex execution brief under 8 KiB/);
  assert.match(agentRules, /Never paste an OpenClaw transcript/);
  assert.match(agentRules, /Similar names, surnames or business relevance do not identify the user/);
  assert.match(agentRules, /`sentBySelf` proves identity, not commitment/);
  assert.match(agentRules, /counterpart acceptance can mean the user delegated work to them/);
  assert.match(heartbeat, /`sentBySelf` is sender metadata, not commitment evidence/);
  assert.match(contract, /`sentBySelf` 只证明发送人，不能单独证明本人承诺/);
  assert.match(contract, /默认每日 `08:00-19:00`/);
  assert.match(contract, /时间窗外不得领取变化租约或启动 `attention` 模型轮次/);
  assert.match(contract, /不得阻断人工交代、实时对话处理、到期提醒和已批准可靠动作/);
  assert.match(read("src/daemon.mjs"), /attentionScheduleStatus/);
  assert.match(read("src/daemon.mjs"), /sentBySelf 只证明发送身份/);
  assert.match(agentRules, /Pet direct input is a unified natural-language channel/);
  assert.match(agentRules, /workboard_create/);
});

test("pet close control hides to a persistent tray recovery path", () => {
  const contract = read("docs/PROJECT_CONTRACT.md");
  const main = read("desktop/main.mjs");
  const renderer = read("desktop/renderer.js");
  const html = read("desktop/index.html");

  assert.match(contract, /X.*只隐藏窗口/);
  assert.match(contract, /系统托盘.*显示.*退出/);
  assert.match(main, /new Tray\(createTrayIcon\(\)\)/);
  assert.match(main, /label: "显示工作现场"/);
  assert.match(main, /label: "自动巡检"/);
  assert.match(main, /label: "巡检设置\.\.\."/);
  assert.match(main, /"退出 Shadow Agent"/);
  assert.match(main, /stop-shadow-agent\.ps1/);
  assert.match(main, /await stopShadowAgentRuntime\(\)/);
  const stopAgent = read("scripts/stop-shadow-agent.ps1");
  assert.match(stopAgent, /PersonalShadowAgentContextService/);
  assert.match(stopAgent, /PersonalShadowAgentOpenClaw/);
  assert.match(stopAgent, /Get-ShadowProcessTree/);
  assert.match(stopAgent, /SessionId/);
  assert.match(stopAgent, /CreationDate/);
  assert.match(stopAgent, /shutdown\.requested/);
  assert.match(stopAgent, /contextStoppedGracefully/);
  assert.match(stopAgent, /remainingBackgroundProcesses = 0/);
  assert.match(read("src/daemon.mjs"), /shutdownRequestPath/);
  assert.match(read("scripts/start-pet.ps1"), /gateway\.disabled/);
  assert.match(renderer, /closeButton.*shadowPet\.hide\(\)/);
  assert.doesNotMatch(renderer, /closeButton.*shadowPet\.quit\(\)/);
  assert.doesNotMatch(read("desktop/preload.cjs"), /pet:quit/);
  assert.match(html, /隐藏到系统托盘/);
});

test("shared Codex history cleanup removes backed sidebar catalog entries and catalog-only orphans", () => {
  const cleanup = read("scripts/detach-shared-agent-codex-history.mjs");
  const contract = read("docs/PROJECT_CONTRACT.md");
  const decision = read("docs/decisions/0031-isolated-agent-codex-home.md");

  assert.match(cleanup, /codex-dev\.db/);
  assert.match(cleanup, /local_thread_catalog/);
  assert.match(cleanup, /catalogOnly: true/);
  assert.match(cleanup, /thread_timeline_ledger/);
  assert.match(cleanup, /removedCatalogRows/);
  assert.match(contract, /可见但无法打开的任务/);
  assert.match(decision, /正文已经移除但目录仍在/);
});

test("runtime workspace uses the current context tool names", () => {
  const workspace = ["AGENTS.md", "HEARTBEAT.md", "TOOLS.md"]
    .map((name) => read(`openclaw/workspace-template/${name}`)).join("\n");
  assert.doesNotMatch(workspace, /shadow_work_(?:status|search|task)/);
  for (const name of ["shadow_attention_packet", "shadow_context_resolve", "shadow_context_ack"]) {
    assert.match(workspace, new RegExp(name));
  }
});

test("runtime profile deploys every versioned workspace rule", () => {
  const deploy = read("scripts/apply-openclaw-runtime-profile.mjs");
  const template = JSON.parse(read("config/openclaw-runtime-template.json"));
  assert.match(deploy, /openclaw", "workspace-template/);
  for (const name of ["AGENTS.md", "HEARTBEAT.md", "TOOLS.md"]) {
    assert.match(deploy, new RegExp(name.replace(".", "\\.")));
  }
  for (const name of [
    "sessions_spawn",
    "sessions_history",
    "sessions_send",
    "sessions_yield",
    "subagents",
    "codex_endpoint_probe",
    "codex_sessions_list",
    "codex_session_read",
  ]) assert.ok(template.agentTools.alsoAllow.includes(name), `missing supervisor tool ${name}`);
  assert.equal(template.codexSupervision.allowRawTranscripts, true);
  assert.equal(template.codexSupervision.allowWriteControls, false);
  assert.equal(template.codexRuntime.homeScope, "agent");
  assert.equal(template.tools.loopDetection.enabled, true);
  assert.equal(template.tools.profile, "full");
  assert.equal(template.tools.exec.mode, "full");
  assert.equal(template.tools.fs.workspaceOnly, false);
  assert.equal(Object.hasOwn(template.codexRuntime, "sandbox"), false);
  assert.equal(Object.hasOwn(template.codexRuntime, "approvalPolicy"), false);
  assert.equal(template.controller.runtime, "codex");
  assert.equal(template.codingWorker.runtime, "codex");
  assert.equal(template.agentTools.alsoAllow.includes("codex_session_send"), false);
  assert.equal(template.agentTools.alsoAllow.includes("codex_session_interrupt"), false);
  assert.match(deploy, /transport: "stdio-proxy"/);
  assert.match(deploy, /allowWriteControls: template\.codexSupervision\.allowWriteControls/);
  assert.match(deploy, /config\.agents\.defaults\.workspace = workspacePath/);
  assert.match(deploy, /config\.tools\.loopDetection = template\.tools\.loopDetection/);
  assert.match(deploy, /config\.plugins\.entries\["shadow-work"\]\.config\.databasePath = databasePath/);
  assert.match(deploy, /config\.plugins\.entries\["shadow-work"\]\.config\.workboardDatabasePath = workboardDatabasePath/);
  assert.match(deploy, /config\.plugins\.entries\.codex\.config\.appServer\.command = codexCommand/);
  assert.match(deploy, /config\.plugins\.entries\.codex\.config\.appServer\.homeScope = template\.codexRuntime\.homeScope/);
  assert.match(deploy, /applyRuntimeSelection/);
});

test("plugin installer deploys the shared knowledge policy required at runtime", () => {
  const installer = read("scripts/install-shadow-context-plugin.ps1");
  const plugin = read("openclaw/shadow-work/src/epistemic.js");
  assert.match(plugin, /src\/graph-model\.mjs/);
  assert.match(read("src/graph-model.mjs"), /knowledge-policy\.mjs/);
  assert.match(installer, /'graph-model\.mjs'/);
  assert.match(installer, /src\\knowledge-policy\.mjs/);
  assert.match(installer, /state\\src\\knowledge-policy\.mjs/);
});

test("plugin manifest and documented contract expose the same tool set", () => {
  const manifest = JSON.parse(read("openclaw/shadow-work/openclaw.plugin.json"));
  const contract = read("docs/PROJECT_CONTRACT.md");
  const pluginReadme = read("openclaw/shadow-work/README.md");
  for (const tool of manifest.contracts.tools) {
    assert.match(contract, new RegExp(`\\b${tool}\\b`), `${tool} missing from contract`);
    assert.match(pluginReadme, new RegExp(`\\b${tool}\\b`), `${tool} missing from plugin README`);
  }
});

test("project, plugin package, manifest, and context engine report one version", () => {
  const project = JSON.parse(read("package.json"));
  const pluginPackage = JSON.parse(read("openclaw/shadow-work/package.json"));
  const manifest = JSON.parse(read("openclaw/shadow-work/openclaw.plugin.json"));
  const contextEngine = read("openclaw/shadow-work/src/context-engine.js");

  assert.equal(pluginPackage.version, project.version);
  assert.equal(manifest.version, project.version);
  assert.match(contextEngine, new RegExp(`version: ["']${project.version.replaceAll(".", "\\.")}["']`));
});

test("shared configuration does not advertise the retired local planner", () => {
  const config = JSON.parse(read("config/agent.json"));
  assert.equal(Object.hasOwn(config.codex, "taskReasoningEffort"), false);
  assert.equal(Object.hasOwn(config.codex, "taskTimeoutMinutes"), false);
  assert.equal(Object.hasOwn(config, "planner"), false);
});

test("Feishu outbound rollout defaults to HITL and preserves one reliable send path", () => {
  const config = JSON.parse(read("config/agent.json"));
  const realtime = read("src/realtime/feishu-events.mjs");
  const outbound = read("src/outbound-messages.mjs");
  const contract = read("docs/PROJECT_CONTRACT.md");

  assert.equal(config.feishu.outboundMessages.mode, "hitl");
  assert.equal(config.feishu.outboundMessages.senderIdentity, "user");
  assert.match(realtime, /automatic && outboundSenderIdentity\(config\) === "bot" \? "automatic" : "hitl"/);
  assert.match(realtime, /approvalMode: mode/);
  assert.match(realtime, /idempotencyKey: `\$\{mode\}-reply:/);
  assert.doesNotMatch(realtime, /\+messages-reply/);
  assert.match(outbound, /sendApprovedOutboundMessage/);
  assert.match(contract, /不使用联系人黑名单或白名单/);
});

test("long-running outbox wakeups cannot block state collection and remain session-serialized", () => {
  const daemon = read("src/daemon.mjs");
  assert.match(daemon, /const collectionStore = openDatabase\(config\.paths\.database\)/);
  assert.match(daemon, /const externalStore = openDatabase\(config\.paths\.database\)/);
  assert.match(daemon, /const controlStore = openDatabase\(config\.paths\.database\)/);
  assert.match(daemon, /const outboxStore = openDatabase\(config\.paths\.database\)/);
  assert.match(daemon, /const enqueueOutbox = createSerializedJobQueue/);
  assert.match(daemon, /sessionDispatch\.run\(\s*sessionKey/);
  assert.match(daemon, /enqueueOutbox\("controller-outbox"/);
});
