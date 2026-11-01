# 多源适配与领域汇合架构

| 项目 | 内容 |
|---|---|
| 文档状态 | 现行领域设计 |
| 适用基线 | Shadow Agent V4.23.0 |
| 日期 | 2026-09-02 |
| 规范依据 | [项目契约](PROJECT_CONTRACT.md)、[ADR-0028](decisions/0028-source-domain-adapters.md) |

## 1. 目标

Shadow Agent 需要同时接入两类长期来源：

- 企业协作来源：飞书、钉钉、企业微信、Slack、Microsoft Teams、Google Chat，以及其中的文档、任务、审批、日程和组织信息。
- 编程执行来源：Codex、Claude Code、Cursor、TRAE、Windsurf、GitHub Copilot CLI、Cline，以及未来兼容的编程 Agent。

这两类来源都能形成“会话”，但会话的含义不同。企业协作会话表达人员之间的沟通、指派、承诺和状态变化；编程 Agent 会话表达目标、推理、工具调用、文件改动、测试与执行结果。系统不得为了复用一张消息表而抹平这种差异。

本设计采用“底层证据统一、中间领域分离、顶层业务汇合”：

```text
Provider Adapter
        |
        v
Observation / Evidence Envelope
        |
        +-------------------------------+
        |                               |
        v                               v
Collaboration Projection          Execution Projection
沟通、内容、工作、组织              会话、回合、工具、产物、状态
        |                               |
        +---------------+---------------+
                        v
 Task / Decision / Commitment / Artifact / Person / Project / Knowledge
                        |
                        v
             Workboard + Epistemic Graph
```

## 2. 非目标

- 不把飞书消息和 Codex 工具日志转换成同一种通用消息正文。
- 不为每个供应商复制一套 Evidence、任务库、知识图谱或主控。
- 不要求每个适配器都支持实时订阅、历史补采、会话恢复和外部写入。
- 不解析供应商未承诺稳定的内部数据库格式作为长期主接口。
- 不把消息、工具调用或摘要自动提升为任务、决定或长期事实。
- 不因增加钉钉、Cursor 等来源而迁移或重写现有原始 Evidence。

## 3. 分层模型

### 3.1 Provider Adapter

适配器只负责供应商协议和身份边界：认证、权限、事件接收、游标、历史读取、原始对象定位和可选写入。适配器不得判断工作归属、创建 Workboard 卡或直接写长期事实。

每个适配器必须声明能力，而不是由核心代码猜测：

```json
{
  "family": "collaboration | execution",
  "provider": "feishu | codex | ...",
  "capabilities": {
    "subscribeEvents": true,
    "readDelta": true,
    "historyBackfill": true,
    "readWindow": true,
    "resolveArtifact": false,
    "resumeSession": false,
    "observeTools": false,
    "sendMessage": true,
    "sendAsUser": true
  }
}
```

缺少能力时采用明确降级：实时订阅缺失则使用增量轮询；增量接口缺失则使用显式导出；只有不稳定内部格式时只允许实验性、版本锁定的导入，不成为生产必需能力。

### 3.2 Observation / Evidence Envelope

所有来源共享最小证据信封，用于幂等、审计和回源，不承担领域语义统一：

| 字段 | 含义 |
|---|---|
| `provider`、`account_scope` | 来源与账号/租户边界 |
| `source_object_id`、`event_id` | 供应商稳定对象和事件标识 |
| `occurred_at`、`ingested_at` | 现实发生时间与系统获知时间 |
| `stream_id` | 来源内部稳定会话、空间或执行会话 |
| `parent_id`、`causation_id` | 回复、分叉、触发或执行因果关系 |
| `source_locator` | 回到原消息、会话、rollout、文件或 API 对象的位置 |
| `content_hash`、`cursor` | 去重、增量读取和漂移检测 |
| `visibility` | 用户、机器人、群组、租户和敏感级别 |
| `payload_kind` | 原始对象的稳定粗粒度类型 |
| `provider_payload_ref` | 平台专有字段或外部大对象定位 |

当前 `sources`、`threads` 和 `evidence` 保存来源、会话定位和唯一正文。V4.23.0 由 `src/source-records.mjs` 在 SQLite 中维护三张正式规范表：

- `source_observations`
- `collaboration_events`
- `execution_events`

规范表只保存标识、路由、关系与运行元数据，通过 `evidence_id` 回到唯一正文。Provider Adapter 在采集事务内直接写入；存量数据经一致性备份后一次性回填。旧视图、旧查询 API 和按 Evidence 名称猜供应商的兼容逻辑已删除。

### 3.3 Collaboration 规范记录

企业协作平台在本领域内统一为四类资源：

| 子域 | 规范对象 |
|---|---|
| Communication | Space、Conversation、Thread、Message、Mention、Reaction、Attachment |
| Content | Document、File、Comment、KnowledgeSpace |
| Work | Task、Approval、CalendarEvent、Meeting |
| Organization | Person、Department、Role、Group、Membership |

消息规范记录至少包含：

```text
provider / tenant_id / actor_id / actor_kind
space_id / conversation_id / thread_id / message_id / reply_to
message_type / direction / mentions / attachments
created_at / updated_at / deleted_at
source_locator / raw_evidence_id
```

平台专有卡片、富文本、审批表单和文档块不强制展开为公共字段。规范记录保存可路由字段，完整结构保留在原始 Evidence 或供应商对象定位中。

协作来源的运行路径分四层：

1. 所有获准事件先可靠留存，不因暂时与用户无关而丢弃。
2. 活跃会话状态维护参与者、回复关系、本人参与、关联任务和最近窗口。
3. 主控按需识别指派、承诺、决定、问题、截止时间、交付和状态变化。
4. 只有稳定职责、人员关系、项目事实和经复核结论进入长期图谱。

原始消息不是默认检索入口。正常注意力使用有界会话状态和语义事件；需要核对原话、冲突、数值或责任归属时，才按消息 ID、会话和时间窗口展开一级 Evidence。

### 3.4 Execution 规范记录

编程 Agent 在本领域内统一为以下对象：

```text
ExecutionSession
  -> Run / Turn
    -> UserIntent
    -> AssistantResult
    -> ToolCall / ToolResult
    -> FileChange / Command / TestResult
    -> Checkpoint / Compaction / StatusTransition
```

规范记录至少包含：

```text
provider / account_scope / session_id / parent_session_id
workspace / repository / branch / commit
run_id / turn_id / event_seq / event_kind / status
tool_name / artifact_refs / source_locator / raw_evidence_id
model_provider / model / reasoning_effort
```

模型供应商不是默认会话来源。DeepSeek、OpenAI 或 Anthropic API 只作为一次执行的 `model_provider/model`；会话由承载它的 Codex、TRAE、Cline、DeepSeek Harness 或其他 Agent Runtime 拥有。

常规模型上下文只提供目标、当前阶段、最近结果、改动产物、测试、阻塞和下一步。大段源码、命令输出和工具轨迹通过 Artifact/Evidence 定位按需展开，不复制到知识图谱。

### 3.5 共享业务语义

两个领域只在可证明的业务对象上汇合：

- `Task`：现在要完成什么，权威状态仍在 Workboard。
- `Decision`：谁在何时基于什么作出决定。
- `Commitment`：明确指派、接受、承诺和截止时间。
- `Artifact`：文档、源码、提交、构建物、测试报告。
- `Person`、`Project`：身份、职责和作用域。
- `Knowledge`：经来源和时间约束的稳定事实。

例如，飞书中的明确指派形成 `Commitment` 并关联 Workboard 卡；Codex 的修改和测试形成 `Artifact` 与 `ExecutionResult`，再关联同一张卡。二者不会互相复制正文。

## 4. 检索与上下文策略

共享检索规划器先判断问题类型，再选择领域：

| 问题 | 首选来源 | 必要时展开 |
|---|---|---|
| 谁要求、谁承诺、何时截止 | Collaboration 状态和语义事件 | 精确消息和回复链 |
| 如何实现、修改了什么 | Execution 状态、Git 和 Artifact | 工具结果、diff、源码 |
| 当前做到哪一步 | Workboard + 最新协作/执行状态 | 关联 Evidence |
| 这个结论依据什么 | 图谱事实与 Evidence ID | 原始消息、rollout、文件 |

上下文组装遵循：先紧凑状态，再候选 ID，最后按问题展开一级证据。不得把一个飞书会话和一个 Codex transcript 同时整段塞入模型，只因为它们关联同一项目。

## 5. 当前 Codex 具体实现

### 5.1 已实现

- `src/source-adapters/` 定义能力契约、注册表及 Codex Provider Adapter；能力缺失通过 `SOURCE_CAPABILITY_UNSUPPORTED` 明确报告。
- `src/collectors/codex.mjs` 只读 `~/.codex/state_5.sqlite` 获取 `thread_id`、cwd、Git 和 rollout 定位。
- rollout JSONL 按文件字节游标和固定快照边界增量读取；供应商事件到 Evidence 的转换由 `src/source-adapters/providers/codex.mjs` 负责，采集器只负责发现、游标、批量事务和落库。
- `threads.thread_id` 是稳定执行会话身份；项目只作为候选作用域，不决定 OpenClaw 控制会话。
- `digest_queue` 在用户输入、回合结束和工具流水安静期后生成一代可检索 `codex_thread_digest`。
- `codex_thread_digest` 是 Shadow 派生 Evidence，不属于 Codex Provider 原生 Execution 事件；它通过 `thread_id` 和 `evidence_links` 回到会话，但不写入来源规范表。
- Agent 管理的 Codex 子任务由 OpenClaw 创建并绑定 Workboard execution；用户创建的 Codex 会话默认只读。
- Codex source 声明 `provider=codex`、`family=execution` 和逐项 capability；写 Evidence 时同事务写入 `source_observations` 与 `execution_events`。

### 5.2 当前规范映射

V4.23.0 已通过 `source_observations` 与 `execution_events` 实现以下直接映射：

```text
threads.id                         -> ExecutionSession.session_id
evidence.thread_id                -> ExecutionEvent.session_id
codex_user_message                -> UserIntent
codex_agent_message               -> AssistantResult
codex_tool_call / tool_output     -> ToolCall / ToolResult
codex_patch_result                -> FileChange
codex_turn_summary                -> TurnSummary
codex_compaction_summary          -> Compaction
source_locator                    -> PrimaryEvidence locator
```

`shadow_evidence_search` 可用 `sourceFamilies=["execution"]`、`providers=["codex"]` 和 `eventKinds` 先选择执行语义，再按 `threadId`、项目、时间或 Evidence ID 展开原文。工具调用和结果仍须显式选择 provider kind，避免默认把高体量轨迹送进模型。

后续接 Cursor、Claude Code 等时复用 Execution 规范表，不要求它们生成 Codex 风格 JSONL。适配器可以用 Hook、SDK、结构化输出或稳定 transcript 生成相同记录。

## 6. 当前飞书具体实现

### 6.1 已实现

- `src/source-adapters/providers/feishu.mjs` 统一生成会话键、人员、回复、提及、附件和方向字段；轮询与实时事件不再各自维护一套消息投影。
- `src/collectors/feishu.mjs` 通过用户身份的 `lark-cli` 增量读取用户可见消息、文档等来源，并保存 Evidence。
- `src/realtime/feishu-events.mjs` 消费已授权实时事件，先写 Evidence 和 `external_event_receipts`，再执行会话路由；短时失败保留重试和幂等键。
- `conversation_bindings` 用 `provider + conversation_key` 绑定稳定 OpenClaw conversation；同会话由串行队列处理。
- 飞书消息全部留存，但私聊、本人发言、明确提及/回复本人、活动任务或条件范围决定是否激活有界语义处理。
- 出站统一经过 `outbound_message_drafts`、HITL、`controller_outbox`、真实发送回执和可选回复条件跟踪。
- `shadow_conversation_window` 只按已知 `provider + streamId` 有界展开；飞书 `conversationKey` 是兼容别名，不提供无范围的全历史消息倾倒。
- 飞书 source 写入 `provider=feishu`、`family=collaboration` 和逐项 capability；出站 Evidence 使用同一适配器身份。

### 6.2 当前规范映射

V4.23.0 保留 `feishu_*` Evidence kind，并由 `source_observations` 与 `collaboration_events` 建立以下直接映射：

```text
conversation_key                   -> Conversation.stream_id
chat_id                            -> Space.id
thread_id / root_id                -> Thread.id
message_id / event_id              -> Message.id / Event.id
sender_id / sender identity        -> Actor.ref
mentions / reply_to                -> Message relations
feishu_message                     -> Collaboration Message Evidence
feishu_task / approval_task        -> Work resource event
outbound_message_drafts            -> Collaboration Action intent
```

`shadow_conversation_window` 的规范身份是 `provider + streamId`，飞书 `conversationKey` 作为兼容别名继续可用。`shadow_evidence_search` 可按 Collaboration、飞书、规范事件、精确会话和时间窗组合过滤。

新增钉钉等平台时实现新的 Provider Adapter，并复用 `external_event_receipts`、Collaboration 规范表、注意力、HITL 和可靠出站语义。不得把钉钉事件伪装成 `feishu_message`，也不得复制一套任务判断器。

## 7. 实施状态与顺序

### 阶段 A：契约与验证视图（V4.22.0 已完成并退出）

1. 固化本设计、ADR 和契约不变量。
2. 定义 `SourceAdapterCapabilities`、`ObservationEnvelope`、`CollaborationEvent` 和 `ExecutionEvent` 的运行时 schema。
3. 为现有 Codex、飞书 Evidence 建只读映射和契约测试，不迁移原始数据。

### 阶段 B：正式规范存储切换（V4.23.0 已完成当前来源部分）

1. 一次性备份并回填现有 Codex/飞书数据，删除验证视图和旧查询 API，不双写。
2. Codex 与飞书 Provider Adapter 在 Evidence 写入事务中直接写规范记录；collector 继续保留游标、快照与短事务职责。
3. 一级证据检索支持 Collaboration、Execution、provider 和规范事件索引过滤；Workboard 与图谱入口保持独立。
4. 飞书文档块、审批表单和 Codex 专有工具 payload 不强制展开为公共结构；这是有意保留的平台边界。

### 阶段 C：第二供应商验证（未开始）

1. Execution 侧优先接 Cursor 或 Claude Code，验证 Hook/SDK 与 Codex JSONL 能否写入同一规范结构。
2. Collaboration 侧优先接钉钉，验证 Stream 事件、会话、身份和出站能力差异。
3. 只有第二个供应商通过增量、去重、断线恢复、历史补采、权限和检索测试后，才把公共接口标记为稳定。

## 8. 验收标准

- 新适配器不修改 Workboard、图谱和其他适配器的原始记录。
- 同一供应商事件重复投递只产生一次业务副作用。
- 会话、线程、回复、分叉和执行身份可稳定回源。
- 飞书背景消息继续留存但不自动成为用户任务。
- Codex 工具日志不自动成为长期知识或企业协作消息。
- 跨来源任务可从飞书指派追溯到 Workboard、Codex 执行、测试和出站回复。
- 不支持的能力明确显示 `unsupported`，不得伪装为空结果或成功。
- 供应商内部格式变化只影响对应适配器，不要求迁移共享业务层。

本机可用以下只读检查确认声明和规范记录：

```powershell
npm run status:sources
node src/cli.mjs source-events --source-family=collaboration --provider=feishu --limit=10
node src/cli.mjs source-events --source-family=execution --provider=codex --event-kind=user_intent --limit=10
```

## 9. 外部接口依据

- [Cursor Hooks](https://prod.cursor.com/docs/hooks)
- [Claude Code CLI 会话恢复](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
- [TRAE CLI 会话与 JSONL](https://docs.trae.cn/cli_command-line-parameters)
- [Windsurf Cascade Hooks](https://docs.windsurf.com/zh/windsurf/cascade/hooks)
- [GitHub Copilot CLI 会话数据](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)
- [Slack Events API](https://api.slack.com/apis/connections/events-api)
- [Microsoft Teams Change Notifications](https://learn.microsoft.com/en-us/graph/teams-changenotifications-chatmessage)
- [Google Workspace Chat Events](https://developers.google.com/workspace/events/guides/events-chat)
- [钉钉 Stream 模式](https://opensource.dingtalk.com/developerpedia/docs/explore/tutorials/stream/overview/)
