# ADR-0008 主动任务监督与 Codex 执行闭环

- 状态：部分被 ADR-0031 取代
- 日期：2026-08-15
- 决策者：用户、Codex
- 关联契约：INV-01、INV-02、INV-10、INV-28、INV-34、INV-35、INV-36
- 契约版本：2.7.0

## 背景

系统已经能从飞书、Codex、项目和人工操作产生增量变化，也能把任务归属到稳定 OpenClaw 控制会话。但“发现变化”不等于“负责结果”：工作交给 Codex 后缺少统一复核和继续指令，主动飞书询问后也可能只停在发送动作。单纯增加定时巡检会重复读取活动卡片，并不能可靠表达任务正在等什么。

## 决定

1. OpenClaw 仍是唯一任务主控；Codex 是无长期任务权的执行器。
2. Agent 管理的 Codex 工作使用 OpenClaw 原生 `sessions_spawn`，由后台完成事件唤醒原控制会话。主控按验收标准读取有界结果，决定接受、修正、继续、阻塞或请求用户。续指令通过 `sessions_send(timeoutSeconds: 0)` 可靠入队，结果再以事件唤醒主控，避免原生 Codex 工具回合因长等待产生未配对结果。
3. 用户创建的本机 Codex 会话通过 `codex-supervisor` 只读接入，可用于核实结果；当前不开放 `codex_session_send` 和中断能力，不静默接管用户工作。
4. 每张被处理的非终态卡必须留下一个明确继续条件：正在执行、Codex 完成回调、外部条件跟踪、明确复查时间、可执行下一动作或结构化等待用户。
5. 主动飞书沟通继续复用统一出站草稿。当前 `hitl` 模式必须由用户确认；发送成功后创建回复条件跟踪或明确复查时间，不能把“已发送”当成任务完成。
6. V4.8.6 曾让 OpenClaw 原生 Codex runtime 使用本机用户级 Codex Home；该认证与 transcript 共享方式自 V4.26 起由 ADR-0031 取代。显式原生 runtime、`workspace-write` 和只读 Supervisor 约束继续有效。

## 备选方案

- 周期扫描全部 Workboard：拒绝。它把主动性等同于轮询，随着任务增长浪费模型上下文，也无法表达等待条件。
- 直接开放 Codex Supervisor 写控制：暂不采用。插件授权粒度是全端点，尚不能硬性限制到已绑定任务，可能干扰用户正在使用的会话。
- 为每张任务建立独立规划 Agent：拒绝。会制造第二任务主控并增加会话数量。

## 影响

- 主控获得 OpenClaw 原生 session orchestration 工具，可自动管理自己发起的 Codex 子任务。
- `codex-supervisor` 改用本机 stdio app-server，开放会话列表和有界正文读取，写控制保持关闭。
- Workboard 仍保存唯一任务状态；OpenClaw 后台 task 只是执行活动记录。
- 飞书 HITL、可靠发送和条件跟踪没有新增旁路。

## 数据迁移

不改写现有 Workboard 状态或 `session_key`。现有用户 Codex 会话仅在相关任务需要时作为证据读取；新 Agent 管理的 Codex 执行从启用后开始在卡片评论或证明中记录 run id 和 child session key。

## 回退方案

从运行模板移除 session orchestration 和 `codex-supervisor` 工具，恢复旧工具白名单并重新应用配置、重启 Gateway。Workboard、证据和既有 Codex 会话不需要回滚。

## 验证

- 契约测试确认主控拥有原生 session tools，但 Codex Supervisor 写控制关闭。
- 真实端点探测必须返回可用，能列出和读取本机存储会话。
- 模型烟雾测试发起一个无副作用子任务，观察完成事件回到原会话并形成结果复核。
- 推进烟雾测试必须在 Agent 管理的同一 child session 上完成首次结果、一次 `sessions_send` 续指令和第二次结果；仅看到工具目录不算闭环通过。
- 飞书链继续验证未确认不发送，确认后仅发送一次并建立回复跟踪。
