# 飞书采集与机器人会话配置

本文描述 Shadow Agent 的飞书个人数据采集和机器人会话权限。个人账号读取不授予代用户回复权限；直接发给机器人或群聊中明确提及机器人的消息允许机器人在原会话回复。它受 [项目契约](PROJECT_CONTRACT.md) 的外部系统和授权边界约束，最后核对日期为 2026-08-12。

## 身份边界

影子 Agent 必须使用 `lark-cli --as=user` 读取本人可见内容。机器人身份只能看到应用自身范围，不能当作本人的消息、云盘、任务或审批数据。

飞书授权有两层：管理员在开发者后台给应用开 scope，本人再通过 `auth login` 授权。两层缺一都会返回 `missing_scope`。

## 当前个人账号 scope

```text
search:message
im:message:readonly
im:message.reactions:read
im:chat:read
approval:task:read
approval:instance:read
task:task:read
task:tasklist:read
task:section:read
search:docs:read
docs:document.content:read
docx:document:readonly
docx:document:write_only
approval:task:write
approval:instance:write
offline_access
auth:user.id:read
```

读取 scope 用于建立个人工作上下文；写入 scope 只表示应用与本人均已授权相应接口，不表示 Shadow Agent 可以自动执行。回复个人消息、修改文档和审批决定仍受项目契约及 `config/policy.json` 控制。`offline_access` 让 `lark-cli` 在本机刷新用户 token。

## 状态检查

```powershell
$env:LARKSUITE_CLI_NO_UPDATE_NOTIFIER='1'
$env:LARKSUITE_CLI_NO_SKILLS_NOTIFIER='1'
E:\DevTools\npm-global\lark-cli.ps1 auth status --json --verify
```

必须确认：`identity=user`、`identities.user.status=ready`、`verified=true`、`tokenStatus=valid`。

## 增量授权

不要把 token、app secret 或 device code 写入项目。由 Codex 发起以下 split-flow，用户只需打开临时链接确认：

```powershell
E:\DevTools\npm-global\lark-cli.ps1 auth login `
  --scope="search:message im:message:readonly im:message.reactions:read im:chat:read approval:task:read task:task:read search:docs:read docx:document:readonly" `
  --no-wait --json
```

授权完成后由 Codex 使用本次返回的 device code 完成轮询，不长期保存 device code。

当前验证快照：2026-08-12，个人 OAuth 已包含消息搜索、文档内容、任务、审批任务和审批实例权限。开发者后台的事件订阅仍可能处于组织审批中；每轮必须以真实 API 与事件消费者结果为准。

## 采集内容

- 最近时间窗内的本人可见消息和会话上下文。
- 待办审批，保存审批证据并形成需要人工决定的工作线索，不自动同意或拒绝。当前采集器仍通过旧 `tasks` 表写兼容记录，必须迁移到规范变化流或 Workboard 后才能移除该兼容路径。
- 分配给本人的未完成飞书任务。
- 云盘最近结果的标题、类型、URL、编辑时间和摘要。
- 每轮最多 10 篇发生变化的 Docx/Wiki 正文；未处理正文会在后续轮次继续。

飞书多维表格的专用写入 Skill 与本项目的知识采集是两条权限链。影子 Agent 不会因为已有 Base 写权限就自动修改表格。

## 实时事件订阅

飞书开发者后台必须另外订阅事件；拥有 scope 不等于已经订阅事件。当前代码支持：

```text
im.message.receive_v1
task.task.update_user_access_v2
approval.task.status_changed_v4
approval.instance.status_changed_v4
```

这些事件不是同一种能力：

| 能力 | 身份 | 作用 | 事件未审批时 |
|---|---|---|---|
| 个人消息 | `user` | 每 60 秒读取本人可见新消息，是工作认知主来源 | 继续轮询，不受影响 |
| 个人文档 | `user` | 每 2 分钟读取最近编辑文档，是工作认知主来源 | 继续轮询，不受影响 |
| 个人任务 | `user` | `task.task.update_user_access_v2` 提供实时加速 | 15 分钟 API 补偿 |
| 个人审批 | `user` | 两条 `approval.*` 事件提供实时加速 | 15 分钟 API 补偿 |
| 机器人对话 | `bot` | 只处理发给 Shadow Agent 机器人的消息 | 该入口不可用，不影响个人采集 |

未在开发者后台订阅时，运行状态显示 `waiting_console_subscription`，能力快照对外显示 `waiting_external_approval`，不会反复重连刷日志。不能把这类缺口说成“Agent 看不到用户的飞书”。

开发者后台订阅变更后重启 `PersonalShadowAgentContextService`。运行：

```powershell
E:\DevTools\npm-global\lark-cli.ps1 event status --json
node scripts\inspect-runtime-state.mjs
```

`scripts/inspect-runtime-state.mjs` 会分别输出 `personal_primary`、`personal_operational` 和 `bot_dialogue`。应先确认 `personalDataAvailable=true`，再查看实时事件是否 `ready`；不要把 `waiting_console_subscription` 误报为权限 scope 缺失或整体离线。

## 常见问题

- `missing_scope`：按错误中的 scope 做增量授权，并确认应用后台也已开通。
- lark-cli 返回 `ok:false`：即使进程退出码是 0 也按失败处理，不能把权限错误误报成“0 条结果”。
- `identity=bot`：不要继续采集个人数据，先完成 user 登录。
- token 过期：重新执行 `auth status --verify`，必要时重新登录。
- 锁屏：API 采集可继续；休眠、断网和关机会暂停。
- 文档类型不是 Docx/Wiki：当前采集器保留元数据；Sheets/Base 内部数据需要对应连接器下钻，且写入仍需独立授权。
