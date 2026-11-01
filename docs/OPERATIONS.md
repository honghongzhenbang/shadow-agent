# 运行维护手册

本文是 [项目契约](PROJECT_CONTRACT.md) 下的运维说明，最后核对日期为 2026-08-27。运行模型、授权和进程状态可能变化，必须以实时检查结果为准。

## 组件边界

- `PersonalShadowAgentContextService`：增量采集、摘要和时序上下文图物化，不判断任务。
- 飞书事件流和快速轮询运行在 ContextService 内，负责去重、会话路由和唤醒，不是独立主控。
- `PersonalShadowAgentOpenClaw`：承载唯一 Shadow Agent 主控的运行设施。业务策略来自本项目，读取变更流并维护 Workboard。
- `PersonalShadowAgentPet`：只展示 Workboard 状态和执行历史，不保存第二份任务状态。

三个组件可以分别恢复，但系统中只能有一个 OpenClaw Gateway 和一个上下文服务实例。

### 2026-10-15 可靠性修复部署边界

本轮只改源码和测试，未启动、重启或停止任何生产进程，也未修改正式数据库。已有关闭开关不变；源码测试通过不等于后台正在使用新版插件。

恢复前先检查三个组件与现有巡检开关；经用户确认恢复后，使用现有插件安装流程部署，再重启相关组件。不要为运行隔离测试而启动所有计划任务或消费历史积压。

- 运行回执保存在原有 `settings` 的 `controller:turn:*` 条目，只有引用、哈希、时间和状态；`controller:turn-active:*` 是未确认会话的活动指针。排障不要手工删除回执或指针来“重试”。
- 人工/飞书对话需 `ok` 和最终回复；后台控制唤醒允许原生明确的 `silent` 终态回复。缺失回复、空文本和中间文字均不能推断成功。
- `OPENCLAW_RUN_UNCONFIRMED` / `OPENCLAW_REPLY_UNCONFIRMED` 表示需核对原 ID，不代表工作失败。原生运行身份不可再查询时，先查执行历史与产物，不得换 ID 盲目重做。
- `OPENCLAW_RUN_FAILED` 是已确认失败终态，同一请求不重复开工。需要新一轮处理时，应结合旧运行及副作用给出新决定。
- `OPENCLAW_SESSION_RECONCILIATION_REQUIRED` 表示该会话尚有未知结果的运行；先由原入口恢复，不能另起同会话请求绕过它。
- Codex 的 30 分钟缺省复查、只读探测的一秒观察片、outbox 30 秒续租都不是模型执行时限。生产 `runTimeoutSeconds=0` 保持不变。

验证命令与已知边界见 首批可靠性验证记录。

## 首次安装

新用户基础资料确认、初始化任务计划与既有用户迁移，按 [用户知识与冷启动](operations/user-knowledge-onboarding.md) 执行。不要使用旧 `bootstrap-work-focus.mjs` 写独立简况。

```powershell
cd X:\ExampleProjects\sdagent
npm install
npm test
npm run doctor
npm run init
powershell -ExecutionPolicy Bypass -File .\scripts\install-scheduled-task.ps1
```

从旧项目目录迁移且运行状态已复制完成时，使用 `-StartNow` 强制停止同名旧任务、重绑三个登录任务并立即从当前项目根目录启动：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-scheduled-task.ps1 -StartNow
powershell -ExecutionPolicy Bypass -File .\scripts\status-scheduled-task.ps1
```

状态输出中的三个 `WorkingDirectory` 和脚本参数都必须指向当前项目根目录；仍出现旧目录时不得清理旧副本。

Agent 的 Codex runtime 使用项目私有 `homeScope=agent`。首次部署或切换账号时，先停止 Gateway，再启动设备码登录：

```powershell
npm run openclaw:stop
npm run openclaw:auth:isolated
```

按终端提示打开设备登录页并输入一次性代码。凭据只写入 `runtime/openclaw-poc/state/agents/main/agent/` 下的 Agent 私有状态，不读取、复制或修改个人 `~/.codex/auth.json`。登录后重新启动 Gateway，并用 `openclaw models status --json` 确认 OpenAI/Codex 路由可用。

从 V4.26 之前共享 Home 迁移时，先保持 Agent 停止并执行精确审计；确认 `agentCwd` 和数量后再应用：

```powershell
npm run cleanup:shared-codex-agent-history
npm run cleanup:shared-codex-agent-history:apply
```

应用命令先将目标线程的状态行、历史项、日志、会话索引和校验后的压缩 rollout 保存到 `X:\ExampleProjects\shadow-agent-backups\shared-codex-agent-cleanup-*`。目标仅包括当前 Agent 工作区、`source=exec` 的旧 Shadow 根目录，以及项目 `runtime/evaluations` 下的隔离评测；原生 Codex 子任务和个人会话不在选择范围。默认不执行 `VACUUM`，避免运行中的 Codex 长时间锁库；需要物理收缩时应关闭 Codex 后单独维护。

用户明确要求移除侧边栏中的原生子任务会话时，先运行 `npm run cleanup:visible-subagent-history` 核对分类和数量，再运行 `npm run cleanup:visible-subagent-history:apply`。该显式模式只接受标准 `[Subagent Context]` 标题前缀，仍执行相同的 E 盘备份和 rollout 哈希校验；不得改成模糊标题搜索。

`install-scheduled-task.ps1` 已包含 OpenClaw 计划任务、Shadow Context 插件安装和无凭证运行策略模板应用，不需要再次单独运行 `install-openclaw-poc-task.ps1`。模板位于 `config/openclaw-runtime-template.json`，保存模型/默认推理等级、Heartbeat、工具、Skill、Context Engine、压缩和动态加载策略，不保存登录或令牌。

OpenClaw 首次使用前执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\openclaw-poc-auth.ps1
```

Codex 路径使用 ChatGPT/Codex OAuth；其他 API 模型使用各自的本机凭据配置。凭据不得提交 Git 或打包分发。

### 建立人工认知路由资料

从示例复制一份本机配置，填写职责、同事、源码、文档、飞书会话或 open_id 等真实入口：

```powershell
Copy-Item .\config\cognitive-profile.example.json .\config\cognitive-profile.local.json
npm run profile:import -- --file .\config\cognitive-profile.local.json --dry-run
npm run profile:import -- --file .\config\cognitive-profile.local.json
```

复制后先替换示例内容，再移除 `exampleOnly` 字段；原样示例会被拒绝导入。`*.local.json` 不进入 Git。禁止在该文件写密码、token、secret 或私钥；导入器会拒绝常见秘密字段。相同实体和关系可以重复导入更新，不会按次数扩张。

该文件按来源视为一份认知路由快照。职责、代码位置或联系人变化后，直接修改原文件并再次执行 dry-run 和正式导入；从文件删除且没有其他证据支持的旧路标会失效，原始导入证据仍保留用于追溯。

团队 Markdown 导入必须显式指定原文、本人姓名和稳定档案 ID，不能自动选用本机开发者的档案：

```powershell
npm run profile:build:team -- --source <原文路径> --owner <原文中本人的姓名> --profile-id <稳定档案ID>
npm run profile:import -- --file .\runtime\profiles\team-cognitive-profile.json --dry-run
npm run profile:import -- --file .\runtime\profiles\team-cognitive-profile.json
npm run profile:verify:team -- --file .\runtime\profiles\team-cognitive-profile.json
```

生成结果必须检查人员数量、关系数量、缺失引用和 Git 差异。原文及结构化快照可随当前受控仓库保存，但不得进入公开制品；学历、职业经历、管理评价、聊天原句和团队文化不进入结构化路由。运行时只能查询相关局部图，禁止把两个文件整篇发送给模型。

该导入器要求约定的编号章节和字段，不是任意 Markdown 的语义提取器。更新已有档案时保留原 `--profile-id` 和原输出文件路径（用 `--output` 指定），保持原 Document ID 与来源修订链；不要为升级工具批量重建正式库。

个人简况按[用户知识与冷启动](operations/user-knowledge-onboarding.md)生成。使用 `scripts/user-profile.mjs preview/confirm` 确认基本资料与任务计划，或 `migrate` 绑定既有本人实体；旧 `bootstrap-work-focus.mjs` 明确拒绝运行，不能继续维护一份独立职责正文。

飞书 CLI 默认从 PATH 查找 `lark-cli.ps1`；若计划任务的 PATH 不同，在不入 Git 的 `config/agent.local.json` 中设置 `feishu.cliPath` 的实际绝对路径。

## 日常检查

### 按任务配置推理等级

2026-10-15 的主模型配置为 `openai/gpt-5.6-sol`，不是所有任务统一极高。`config/agent.json.reasoning.byTask` 控制消息初筛 `medium`、人工输入/任务复核/知识维护 `high`、提醒主控通知 `low`。旧 `attention.thinking` 已移除，不再作为配置入口。原生工程子任务默认 `high`，主控可为确有需要的复杂技术任务显式传入 `xhigh`。

`config/openclaw-runtime-template.json` 保存主模型、全局兜底等级和原生子任务等级；运行副本是 `runtime/openclaw-poc/state/openclaw.json`。应用模板不会启动后台，也不会修改 SQLite 中保存的巡检开关。每种控制入口显式选择本轮等级；不要仅改 Gateway 默认值就宣称所有调用都已切换。

此次配置落盘不等于线上生效验证，本轮未执行任何启动、停止或重启。只读检查时网关计划任务仍显示 `Running`，采集服务与宠物为 `Ready`；不能声称整套进程已停，也不能把网关在线当作任务正在推进。重新启动须由用户明确要求；之后用新的实际执行记录核对模型、等级和回执。既有会话不删除，历史执行不重跑，隔离评测脚本的显式等级不随生产配置暗改。方案、验证范围和未完成项见 可靠性优化计划。

`node scripts/apply-openclaw-runtime-profile.mjs` 会同时应用受控运行参数，并把 `openclaw/workspace-template/` 中的 `AGENTS.md`、`HEARTBEAT.md`、`TOOLS.md` 同步到实际 OpenClaw 工作区。不要把 `runtime/.../workspace` 里的副本当作长期维护源。项目目录迁移后必须先运行该脚本，它会把工作区、Shadow 数据库、Workboard 数据库和两条 Codex runtime 路径统一绑定到当前项目根目录。

上下文服务在线必须同时满足：锁文件 PID 存活、`runtime:context:lastHeartbeat` 持续更新、飞书快速轮询时间推进。V4.8.1 起，Codex rollout 只读取本轮文件大小快照并按短事务提交；数据库心跳连续失败达到 `service.databaseHeartbeatFailureRestartThreshold` 时，子进程主动退出，`start-context-service.ps1` 负责自动拉起。

```powershell
npm run doctor
npm run status
npm run report:controller-runtime -- --hours 24
npm run smoke:controller-runtime
npm run openclaw:test
powershell -ExecutionPolicy Bypass -File .\scripts\status-scheduled-task.ps1
```

`openclaw:test` 同时检查未知问题的认知路由契约和 10 秒集成预算。若功能正确但超时，先查看输出中的证据目录，再检查 `graph_episode_fts` 是否完整以及插件是否启用了 Gateway 生命周期连接复用；不要直接放宽预算掩盖全表或长正文扫描。

`report:controller-runtime` 只读取匿名控制轮计数，报告时长分位数、Token 分类、工具调用和最近预算告警，不展示提示词或会话正文。首次升级后需重启上下文服务以初始化指标表；表尚未初始化时命令返回 `available=false`，不能把它解释为零消耗。Token、工具数或耗时告警是诊断信号，不会自动创建任务或截断正在执行的工作。

`smoke:controller-runtime` 使用固定隔离会话请求一个无工具标记回复，随后验证同一 run 的匿名指标已落库。它不得读取业务数据或创建任务、提醒、知识、草稿和外部对象；若出现任何工具调用、返回标记不符或指标缺失，命令必须失败。

`smoke:searchable-tools` 仅用于临时切到 `searchable` 后的实验验证，生产 `direct` 模式下会主动失败。它每次使用全新隔离会话，通过 Codex 原生工具搜索调用一次只读 `shadow_context_status`，只读取控制器状态，不创建或修改业务对象。该单工具冒烟只能作为 A/B 前置检查，不能替代 `benchmark:dynamic-tools` 的多工具完成率门禁。

`benchmark:dynamic-tools` 在当前运行模式下依次执行六个全新隔离会话，覆盖明确工具名和自然语言选择状态、工作简况、提醒、持续追踪及 Workboard 只读工具；可用 `--case <id>` 复测单项。报告校验实际目标工具、额外工具、回复标记、时长和 Token，并写入 `runtime/evaluations/dynamic-tool-loading/`。A/B 时必须暂停上下文服务，分别应用 `direct`、`searchable` 后重启 Gateway；结束后恢复版本化模板指定的 `direct`。测试提示不得包含业务正文或允许写入副作用。

正常状态应满足：

- `controller.mode` 为 `openclaw-single-controller`。
- `localPlannerRemoved`、`incrementalToolsReady`、`legacyToolsRemoved`、`contextEngineReady` 均为 `true`。
- `plugins.slots.contextEngine` 为 `shadow-work`，`contextInjection` 为 `continuation-skip`，OpenClaw 原生 `safeguard` compaction 与 transcript 截断保持启用；Shadow 不自建 transcript 轮换。
- Gateway 端口 `19011` 只有一个监听进程。
- 图谱的 `pendingChanges` 会由事件注意力调度器按有界批次租赁并确认；每轮最多推进一个明确的低风险事项，不会把全部历史重新变成任务。周期 Heartbeat 默认关闭。
- 飞书事件状态为 `ready`；个人消息快速轮询和文档快速轮询的最近成功时间持续更新。
- 提醒由 OpenClaw Cron 持久调度，宠物中的提醒投影可显示来源、到期时间和确认状态。
- 宠物“持续追踪”只统计未并入活动任务卡的外部等待和待判断线索；绑定活动卡片的 candidate/timed_out 在该卡“关联跟踪”中展示。只有已领取 `task_progress_due` 或存在运行执行的卡片显示为当前工作，打开任一详情都不会修改数据库。
- “需要你确认”和“Agent 待处理”的标签计数必须等于各自列表中的可点击卡片数；列表在当前工作台内滚动展示全部记录。若计数非零但列表为空，先重启宠物并执行生产只读点击检查，不得通过删除 Workboard 卡片修复界面。
- 宠物统一入口中的知识交代、任务反馈、飞书修改批准和带原因拒绝均在 `evidence.kind='manual_knowledge'` 中留下 `humanFeedback` 元数据，并立即生成精确 `knowledge_review_due`；问题解决后的可复用结论以 `shadow_agent_task_result` 生成 `knowledge_delta_due`。两者进入同一 `knowledge-curation` 会话和 `graph_enrichment_queue`，不应出现独立偏好库或人工反馈队列。
- `config/agent.json` 中 `feishu.outboundMessages.mode` 为 `hitl`；缺失或非法值也按 `hitl` 处理。宠物可看到待确认消息，未确认时 `controller_outbox` 不应存在对应发送动作。
- 每张活动 Workboard 卡在 `work_task_attention.owner_session_key` 有控制会话归属；Workboard 自身 `session_key` 仍只表示原生执行会话。任务操作应同时存在 `agent-operation:*` 上下文变化和对应 outbox 动作。
- 主动外发问题的 `outbound_message_drafts.task_id` 不为空，发送后对应 `condition_watches.task_id` 相同；条件 `continue` 的 `metadata_json.continuation` 和 `reviewHistory` 应记录后续动作与已消费候选。
- 飞书群消息若 `ownershipSignal` 为 `explicit_other_mention` 或 `unassigned_group`，且没有当前用户承诺、权威任务归属或既有卡延续，不应产生 `user_work`。核对人员时使用 open_id 与 `sentBySelf` / `mentionsSelf`，不要按姓名相似判断。
- `sentBySelf=true` 不能单独作为“本人承诺”依据。本人在单聊中向对方发出的指令、请求或派工，应展开该会话的有界后续；对方追问范围后回复“好的”等明确接受时，任务属于对方，不能创建或保留用户 Workboard 卡。用户纠正后走职责归属纠正操作归档误分类卡，并保留知识反馈和审计证明。

## 飞书消息出站模式

当前灰度测试使用：

```json
{
  "feishu": {
    "outboundMessages": {
      "mode": "hitl",
      "senderIdentity": "user"
    }
  }
}
```

处理链固定为“OpenClaw 生成正文 -> `outbound_message_drafts` -> 批准 -> `controller_outbox` -> lark-cli -> 回执 Evidence”。`hitl` 在宠物中展示发送身份、收件人、触发消息、最多八条最近对话、生成依据和可编辑正文，用户确认后才入队；取消不会发送。主动草稿调用 `shadow_outbound_draft_create` 时必须提供 `contextSummary`。联系人不使用黑名单或白名单。

当前用户身份发送仍全部走 HITL。机器人单聊入口批准后会向对方发送用户私聊；群内明确提及仅在用户可见的原群回复。未来正式放开机器人自动回复时，必须同时显式设置 `senderIdentity=bot` 和 `mode=automatic`；只修改模式不会放开用户身份自动发送。切换前必须执行主项目测试、插件测试和宠物 E2E，并由用户明确决定。

## 启停

```powershell
npm run openclaw:start
npm run openclaw:stop
npm run agent:stop
powershell -ExecutionPolicy Bypass -File .\scripts\start-context-service.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\start-pet.ps1
```

`openclaw:start`、登录计划任务和自动恢复统一运行 `run-openclaw-poc.ps1`。监督器通过 `runtime/openclaw-poc/supervisor.lock` 的独占文件锁选主，只有锁持有者能创建或重启 Gateway；其他启动请求只等待健康。任务计划仅负责登录唤醒，不是运行时控制面。

宠物启动后常驻 Windows 系统托盘。右上角 `X` 只隐藏窗口；单击托盘中的 Shadow Agent 角标可恢复。右键菜单提供“自动巡检”开关、当前巡检时间、“巡检设置...”和“退出 Shadow Agent”。托盘退出会先停止上下文服务、OpenClaw Gateway、Agent Codex app-server 和飞书事件消费者，确认后台归零后才关闭宠物；失败时宠物保持可见并通过系统通知和 `runtime/pet-shutdown-error.log` 报错。命令行可使用 `npm run agent:stop` 执行同一后台停止动作。默认按本机时间每日 `08:00-19:00` 自动巡检；在设置窗口修改后，运行中的上下文服务会在 15 秒内生效，不需要重启。时间窗外仍采集并保留变化，但不会启动后台 `attention` 模型轮次；人工交代、飞书实时消息、到期提醒和已批准发送不受影响。角标可能被 Windows 收进任务栏的隐藏图标区域。再次运行 `start-pet.ps1` 会清除临时停止标记并重新启动后台；已有宠物只会被唤回，不会出现第二个实例。

卸载全部登录启动任务：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-scheduled-task.ps1
```

## 数据与恢复

- 主数据库：`runtime/shadow-agent.sqlite`
- 上下文服务锁：`runtime/context-service.lock.json`
- OpenClaw 状态：`runtime/openclaw-poc/state/`
- Gateway 状态：`runtime/openclaw-poc/gateway-status.json`
- 验证证据：`runtime/openclaw-poc/evidence/`
- 宠物截图：`runtime/pet-evidence/`

原始 Codex 会话和项目文件只作为证据来源。图谱保存实体、时序事实和证据引用；Workboard 保存任务状态。

恢复前必须停止上下文服务和 OpenClaw 写入，并同时备份：

- `runtime/shadow-agent.sqlite` 及存在时的 `-wal`、`-shm`。
- `runtime/openclaw-poc/state/`，特别是 Workboard 数据库。
- 恢复所依据的源文件和配置版本。

`npm run init` 只初始化缺失模式、物化图谱或重建派生索引，不会恢复丢失的原始证据或 Workboard 状态。数据损坏时应从一致性备份恢复，再运行 `doctor`、知识审计和 Gateway 联调。

来源规范存储升级使用一次性切换，不保留旧视图或双写路径。先停止 Context Service、OpenClaw 和宠物，再预演并执行：

```powershell
npm run migrate:source-storage
npm run migrate:source-storage:apply
```

正式命令会在 `runtime/backups/canonical-source-storage/<时间>/` 保存完整 SQLite 和 `cutover-report.json`，随后回填 `source_observations`、`collaboration_events`、`execution_events` 并删除旧视图。只有报告中 `storageVersion=2`、`legacyViews=[]`、`orphanObservations=0`、`missingDomainRows=0` 才可重新启动。失败时停止所有写入并恢复整库备份，不得临时恢复双写。

任务处理权升级同样使用一次性切换。先停止 Context Service、OpenClaw 和宠物，预演输出只应包含缺失、模糊、过期或引用失效的 continuation：

```powershell
npm run migrate:task-handling
npm run migrate:task-handling:apply
```

正式命令在 `runtime/backups/task-handling-cutover/<时间>/` 同时备份 Shadow 和 Workboard 数据库，并写入 `cutover-report.json`。报告必须显示 `remainingChanges=0` 后才可重新部署运行工作区和插件。迁移只把非法状态转为到期 `internal_review`；有效人工动作、HITL 草稿、未来 condition watch 和运行中的 Codex 执行不会改变，迁移本身不会发送消息、修改外部文档、提交 Git、部署或控制设备。回退必须同时恢复两个数据库。

活动卡控制会话迁移必须先预演和备份。V4.10 会把旧 `workstream` 控制会话懒迁移到人工主会话、真实 conversation 或隐藏 inbox；项目只保留为检索作用域：

```powershell
npm run migrate:task-owners
npm run backup:runtime
npm run migrate:task-owners:apply
```

迁移只更新 Shadow `work_task_attention` 与 `conversation_bindings`，不得修改 Workboard 数据库。预演输出中的 `workboardExecutionSessionKey` 应与迁移前一致；缺少可验证来源的卡片进入 inbox，不按标题猜项目。旧绑定保留作审计，不再作为新变化的默认路由。

## 故障处理

1. OpenClaw 离线：查看 `gateway-status.json` 与 `runtime/openclaw-poc/logs/`，守护任务会自动恢复。
2. 上下文不更新：确认 `PersonalShadowAgentContextService` 正在运行，并检查 `context-service.lock.json` 中的 PID。
3. 待处理数量异常：先核对 Workboard 的 `todo/ready/running/review/blocked` 与 UI 分组；`context_changes` 是增量变化，不等同待办，不要从旧 `tasks` 表恢复队列。
4. 宠物无历史：确认 Gateway 在线且 Workboard 中存在 `done` 卡片。
5. 数据库过大：运行 `npm run optimize -- --vacuum`；执行前保证磁盘可用空间大于数据库文件大小。
6. 飞书实时事件无响应：检查 `lark-cli event status --json`、飞书开发者后台的事件订阅和机器人权限；15 分钟增量采集仍会补齐可读数据。
7. 提醒未弹出：检查 `openclaw cron list --json` 中的 `Shadow Reminder:` 作业，再核对 `reminders` 表的 `cron_job_id` 和 `status`。
8. 某问题没有答案：调用 `shadow_context_resolve` 核对源码/文档/人员路标；若没有路标，更新本机认知资料，而不是扩大每轮全库扫描。
9. 稳定会话上下文过长：确认 `safeguard`、`midTurnPrecheck.enabled` 和 `maxActiveTranscriptBytes` 生效；当前 OpenClaw 版本已移除旧 `truncateAfterCompaction` 配置，不要重新写回，也不要删除 Evidence 或把每条消息改成新会话。
10. 待确认消息未出现：检查 `outbound_message_drafts.status='pending_confirmation'`、宠物 Gateway 状态和 OpenClaw 是否调用 `shadow_outbound_draft_create`。不要改为直接调用飞书发送命令。
    待确认消息出现但上下文为空时，检查 `review_context_json`、`source_evidence_ids_json` 和 `conversation_key`；新草稿不得以空 `contextSummary` 创建，旧草稿回填失败时应保留“上下文缺失”提示。
11. 已确认消息未发送：检查对应 `controller_outbox.action_type='send_feishu_message'` 的 `status`、`next_attempt_at` 和 `last_error`；保留原修订号等待退避重试，禁止手工重复发送。
12. 飞书发送身份错误：核对 `feishu.outboundMessages.senderIdentity` 与草稿 `sender_identity`。当前两者都应为 `user`；机器人单聊应生成 `user_direct_message` 目标，不能用用户令牌直接回复机器人会话。不要通过换发送命令绕过草稿和 outbox。
13. 持续追踪数量存在但无法展开：先确认宠物已部署当前版本，再检查 `condition_watches` 中活动、候选和超时记录。详情只读取该表及其有界证据，不应通过新建任务来修复显示。
14. 人工输入长时间显示等待或重试：先查 `direct_input_receipts` 的 `status`、`last_error` 和 `run_id`，再查同一回执对应的 `controller_outbox.action_type='process_direct_input'`。不要重新提交原话或手工创建卡；恢复 Gateway 和上下文服务后，队列会沿用原幂等键续送。只有回执 `completed` 且保存了 `response_text` 或关联卡时才算完成。
14. 人工反馈或解决结果未进入知识复核：按 `metadata_json.humanFeedback` 或 `metadata_json.knowledgeDelta` 检查 `evidence`，再按 `evidence_id` 核对 `graph_episode_annotations`、`graph_enrichment_queue` 和 `context_changes`。事件应为 `knowledge_review_due`/`knowledge_delta_due` 并路由到同一 `knowledge-curation` session；不要重放业务动作或新建专用反馈表。
15. 飞书草稿无法拒绝：拒绝原因不能为空且最多 1000 字。草稿保持 `pending_confirmation` 时可修正原因后重试；不得通过数据库直接改为 `cancelled` 绕过 Evidence 和审计。
16. 任务指令已提交但卡片暂未更新：检查 `controller_outbox.action_type='apply_workboard_operation'` 的状态和错误。Gateway 离线时保留 pending/retry；恢复后幂等补送，不要重新点击制造第二个操作。
17. Agent 未理解任务状态变化：按 `work_task_attention.last_operation_id` 查找 `context_changes.event_key='agent-operation:<id>'`，确认 `owner_session_key`、`desiredEffect` 和 `appliedStatus`；Workboard `session_key` 不是控制会话字段。
18. 持续跟踪看似一直等待：检查 `condition_watches.last_checked_at`、`timeout_at`、`metadata_json.candidateSelectionVersion` 和候选证据。精确会话中的图片或附件应进入 candidate；旧游标只允许一次有界恢复，不得手工反复回退。
19. 活动任务长期不推进：检查 `work_task_attention.next_review_at`、`last_progress_event_key`，以及对应 `context_changes.kind='task_progress_due'` 是否 pending/leased/acknowledged。每次审计只应投递配置上限内的卡片；不得通过开启 Heartbeat 或全表模型巡检修复。
20. 日志出现 `cannot start a transaction within a transaction`：确认本地采集、飞书快速轮询、条件/任务审计和可靠出站分别使用 `collectionStore`、`externalStore`、`controlStore`、`outboxStore`，并在各自 lane 内串行；模型唤醒还必须经过 `SessionDispatchQueue`。不要让两个定时 lane 共用同一个 `ShadowStore`。
21. 群聊事项被误认成用户工作：先读取源 Evidence 的 `senderOpenId`、`sentBySelf`、`mentionsSelf`、`mentionOpenIds` 和 `ownershipSignal`，再核对卡片的正向归属依据。用户确认误分类后，通过统一 Agent 操作记录职责纠正、评论/证明并归档卡片；禁止直接修改 Workboard SQLite 或删除历史证据。
22. 条件有回复但任务不推进：调用 `shadow_condition_list` 检查候选正文、关联 `task_id`、`reviewHistory` 和 `continuation`。缺少 continuation 的 `continue` 应被工具拒绝；先回到父任务目标，执行或持久化下一动作后再决议。
23. 点 `X` 后看不到宠物：展开 Windows 任务栏隐藏图标，单击 Shadow Agent 角标；也可以再次运行 `scripts/start-pet.ps1` 唤回现有窗口。需要彻底退出时右键角标选择“退出 Shadow Agent”，不要把隐藏误判为 Agent 离线。
24. 提醒列表出现大量“复查…”或同一任务同一时间的重复项：核对 `reminders.explicit`、`task_id`、`source_evidence_ids_json` 和 `metadata_json.purpose`。用户可见提醒才能留在 `reminders` 和 OpenClaw Cron；Agent 内部复查应迁回 `work_task_attention.next_review_at` 后取消原 Cron，保留取消审计，不得直接删除历史行。
25. Gateway 重启期间出现大量毫秒级 `attention` 失败：按错误和完成时间聚合 `controller_turn_metrics`。当前版本应按同一批次的首尾变化序号复用稳定 run id，并从 run id 派生稳定 leaseOwner，再将该会话所有待处理变化的 `not_before` 按 30 秒、60 秒逐步退避，最高 15 分钟；不得通过删除变化、清空 pending input 或清空指标解决。若仍出现 `Pending input idempotency key conflicts`，说明上下文服务尚未加载当前版本。
26. 控制轮运行数分钟仍未完成：先检查 Gateway 的 run 是否仍为 `pending/running`，不要按累计时长手工标记失败。生产配置应为 `attention.runTimeoutSeconds=0`、`attention.waitSliceSeconds=60`；观察片返回 `pending`，或返回无 `endedAt` 且 `timeoutPhase=queue/gateway_draining` 的 `timeout`，都只表示本次等待窗口到期并继续等待。只有带运行结束时间的 `error/timeout` 终态、模型流空闲看门狗或循环检测结果才按失败处理。长编程任务应在 Workboard 中绑定独立 Codex child session，不应同步占住主控工具轮。
27. 卡片显示 Agent 待处理却长期写“等待用户授权”：查询 `work_task_attention.continuation_kind` 和 `continuation_user_action_json`。只有带有效 `userAction` 的 `requires_user` 才属于人工；缺失字段、失效条件或无绑定执行应由进度审计转为 `internal_review`。禁止通过改卡片标签或备注修复分栏，也禁止把本地调查、工作区修改和测试再次要求为笼统授权。

旧版本误建的内部复查提醒必须先备份、预演，再执行迁移：

```powershell
npm run backup:runtime
npm run migrate:internal-reminders
npm run migrate:internal-reminders:apply
```

迁移器只处理旧版本、非显式、绑定任务、以“复查”开头且缺少 `purpose=user_notification` 的活动记录。预演数量和任务数不符合预期时不得执行 `:apply`。

查看单个提醒作业的运行记录使用 `openclaw cron runs --id <job-id>`；当前版本的 `cron runs` 不接受 `--json`。一次性作业成功后会自动从活动列表删除，但 `reminders` 投影和运行记录仍用于审计。

## 变更发布

修改 Shadow Context 插件后：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-shadow-context-plugin.ps1
npm run openclaw:stop
npm run openclaw:start
npm run openclaw:test
```

如果 Agent 当前被人工停用，只执行插件安装与 `node scripts/apply-openclaw-runtime-profile.mjs`，保持三个计划任务为禁用状态，不运行 `openclaw:start`。待用户明确要求上线后再启动并执行 `openclaw:test`；停机发布不能冒充网关运行验证。

修改主控、任务状态、权限或数据模式时，还必须按项目契约执行全套验收并记录迁移与回退方案。
