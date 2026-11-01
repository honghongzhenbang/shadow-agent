# ADR-0031 隔离 Agent Codex Home 与个人历史只读监督

- 状态：接受
- 日期：2026-09-07
- 决策者：用户、项目维护者
- 关联契约：INV-47、INV-50、INV-55、INV-81
- 取代：ADR-0008 中“共享用户级 Codex Home”的认证与存储决定

## 背景

共享 `homeScope=user` 让 OpenClaw 创建的普通持久化 Codex 线程进入个人 `~/.codex`。虽然标题维护已把可见标题限制到 160 字符，历史上 226 个 Agent 线程仍累计了大体量首轮输入、历史投影、日志和 rollout，导致个人 Codex 侧边栏、数据库和索引承担不属于用户日常会话的负担。共享认证还把“允许 Agent 使用同一订阅”与“允许 Agent 写个人会话库”错误地绑定在一起。

## 决定

1. OpenClaw 原生 Codex app-server 固定使用 `homeScope=agent`，认证、配置、线程和 transcript 全部落在项目私有 Agent Home。
2. Agent 通过设备码在私有 Home 独立登录；不得读取、复制或回退到个人 `~/.codex/auth.json`。
3. 个人 Codex 历史继续由独立 `codex-supervisor` stdio 端点只读查询。它没有写控制，不承担 Agent 子任务执行。
4. Workboard 继续保存任务与 Agent child session 的绑定。切换 Home 不改变任务主控、执行回写、知识图谱或一级 Evidence 语义。
5. 共享 Home 的遗留 Agent 线程按版本化运行边界识别：当前运行工作目录精确匹配；旧 Shadow 根目录还必须满足 `source=exec`；隔离评测必须位于项目 `runtime/evaluations` 子树。应用清理前必须在 E 盘压缩归档状态行、历史项、日志、侧边栏 `local_thread_catalog`、关联目录记录和逐文件哈希验证的 rollout；不得只按模糊标题、日期、宽泛来源标签或关键词扩大范围。正文已经移除但目录仍在的同一运行边界记录必须作为孤立项一并清理，不能留下可见但打不开的任务。原生 Codex 子任务默认保留；用户明确要求清理侧边栏子任务时，可通过显式模式删除标准 `[Subagent Context]` 标题前缀线程。
6. 标题维护继续作为防御性约束，但不再承担个人 Home 与 Agent Home 的隔离职责。

## 备选方案

- 继续共享 Home，只隐藏或缩短标题：无法消除历史、日志和索引负担，驳回。
- 完全禁止 Agent 读取个人 Codex：会破坏基于历史执行证据的任务核验，驳回。
- 复制个人认证文件到 Agent Home：扩大密钥暴露范围且难以审计，驳回。
- 仅在 UI 过滤 Agent 会话：底层数据库和 rollout 仍持续增长，驳回。

## 影响

- Agent 需要一次独立设备码登录；账号额度和登录状态与个人 Codex 可分别维护。
- 新 Agent 子任务不会出现在个人 Codex 侧边栏；Agent 仍能通过只读 Supervisor 查询个人历史。
- 旧 Agent 线程从个人索引删除后，Shadow Evidence 和 Workboard 结果保持不变；压缩归档保留恢复与审计材料。

## 数据迁移

停止 Gateway、上下文服务和事件消费者；将旧 Agent 私有 Home 整体移动到 E 盘备份，以空目录启动。应用运行模板后，对个人 Home 先运行清理 dry-run，再运行 apply。清理工具在删除前完成压缩归档和哈希校验，不执行在线 `VACUUM`。

## 回退方案

停止 Agent，把备份的旧私有 Home 移回原位置并将运行模板临时恢复为原配置。个人 Codex 遗留线程如需恢复，必须依据清理 manifest 和压缩数据库行/rollout 做定向恢复；不得覆盖整个当前个人 Home。

## 验证

- 契约测试确认模板和运行配置均为 `homeScope=agent`。
- 设备码登录后，模型状态和一次无副作用模型冒烟通过。
- 冒烟前后个人 `state_5.sqlite` 线程数不增加，Agent 私有 Home 出现新线程。
- 清理 dry-run 与 apply 的目标数量一致，分类计数可审计，四个数据库 `quick_check` 均为 `ok`，个人 Home 中目标运行边界线程和侧边栏目录孤立项归零，且原生 Codex 子任务数量不变。
- Supervisor 仍能只读列出个人 Codex 会话，写控制保持关闭。
