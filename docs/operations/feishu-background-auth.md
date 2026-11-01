# 飞书后台授权与只读验收

## 适用问题

Codex 里 `lark-cli auth status` 能看到用户，但正式后台采集报 `token_missing`。
不要因此反复退出登录、导出令牌，或把机器人可用当作个人消息可读。

2026-10-18 已复现：同一 Windows 用户在两种启动环境看到的 Lark CLI 凭据项不同。
具体 Windows 包或注册表视图机制尚未完全证明；操作上使用与正式服务一致的启动环境完成授权和验证。

## 脚本边界

- 入口：`scripts/feishu-background-auth.ps1`，工作进程：`scripts/feishu-background-auth.mjs`。
- 前置：Windows 已登录；已安装 `PersonalShadowAgentContextService` 计划任务；任务必须属于当前 Windows 用户，采用 Interactive 登录方式；项目自带 Node 和配置中的 Lark CLI 可用。
- 脚本复用该任务的身份注册一次性任务，隐藏运行，使用项目工作目录和固定 Node。
- 不修改正式任务、巡检时间、既有登录或出站 HITL 策略，不发送测试消息。
- 不返回访问令牌或刷新令牌，只返回状态或当前短期授权挑战。
- 临时输入输出仅本人和 SYSTEM 可读；返回后删除一次性任务和临时文件。挑战必须及时完成，过期重新发起，不复用旧链接。

## 操作流程

在项目目录执行：

```powershell
# 只读身份检查。ok 表示检查执行成功；个人身份是否可用看 userReady。
.\scripts\feishu-background-auth.ps1 -Mode status

# 指定本次实际需要的权限，不使用无边界的 all。
.\scripts\feishu-background-auth.ps1 -Mode login -Scopes 'search:message im:message:readonly offline_access'
```

示例仅覆盖基础读取。完整后台还需按启用功能核对消息搜索/详情、文档、审批和任务的只读权限；已有经人工审核的发送功能需保留 `im:message.send_as_user` 和 `im:message`。
不要凭此示例削减现有功能或要求无关权限。

将返回的 `verification_url` 原样交给用户，使用 `lark-cli auth qrcode` 生成二维码。
此时结束当前交互，等用户确认已授权后，再使用同次返回的 `device_code` 执行：

```powershell
.\scripts\feishu-background-auth.ps1 -Mode complete -DeviceCode '<本次未过期的 device_code>'
.\scripts\feishu-background-auth.ps1 -Mode probe
```

`complete` 会再次在后台身份下校验登录；`probe` 以用户身份读取最近一天最多 1 条消息，只返回条数，不返回聊天正文。
探针和正式采集统一使用带时区的 ISO 时间。本机 CLI 1.0.84 虽然帮助中列出 Unix 秒，但实测消息搜索会返回 `99992402 field validation failed`；这类参数错误不是登录失败，不应要求再次授权。
新链接过期时重新执行 login，不把旧 device code 保存在配置、文档或 Git。

## 验收不能止步于登录

1. `status.userReady=true`，且用户姓名/open_id 与预期一致。
2. `probe.ok=true`、`identity=user`；没有新消息时 `messages=0` 也可证明读取成功。
3. 正式采集的错误消失，实际成功时间更新。
4. 分页窗口能够续采并在末页推进覆盖时间，新证据和会话变化已持久化。
5. 选择实际任务验证 Agent 的复查结果；不能以进程在线或队列被唤醒替代业务完成。

若仅机器人 ready、userReady=false，仍未完成个人授权。网络、参数和权限错误分别处理，不统一提示重新登录。
