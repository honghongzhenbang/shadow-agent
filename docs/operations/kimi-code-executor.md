# Kimi Code 可续接执行器

本接入把 Kimi Code CLI 作为可选的本地编程执行器，不改变 OpenClaw 主控、Codex 默认执行器、Workboard 或飞书 HITL。任务状态仍由主控负责；本封装只保存 `task -> Kimi native session` 映射、运行状态、结构化输出和 Git 产物摘要。

## 官方能力基线

- 产品与安装：[Getting started](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html)
- 自动化参数：[kimi Command](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html)
- 原生会话：[Sessions and context](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/sessions.html)
- 数据位置：[Data locations](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html)
- 中断方式：[Interaction and input](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/interaction.html)
- ACP 接口：[kimi acp](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html)
- 本地 REST/WebSocket 接口：[Server API](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html)

当前封装采用官方 `--prompt --output-format stream-json` 和 `--session <id>`；不常驻 `kimi web`，不处理或复制认证材料。

## 执行器契约

- **身份**：一个 Shadow/Workboard task key 只绑定一个 Kimi 原生 `sessionId`；首次成功后才能 `resume`，续接始终显式传 `--session <id>`。
- **状态**：`starting -> running -> completed | failed | timed_out | cancelled`；wrapper 进程 PID、时间、退出码和 signal 持久化，控制面仍由父控制器裁决。
- **进度**：stdout 的 `stream-json` 原样追加到 `events.jsonl`，工具进度与续接通知保留在 `stderr.log`；`status` 只返回有界尾部。
- **产物**：每轮结束记录 Git status、diff stat 和文件名，不复制源码正文，不把本封装的推测写成任务完成。
- **失败**：非零退出、无可发现原生 session、进程错误分别保留原始 stderr/错误；不自动重试，不切换到其他凭据。
- **超时与取消**：wrapper 发出 `SIGTERM` 并保留任务目录；退出后由父控制器检查工作区，再决定同会话续接、重跑或回退 Codex。
- **隔离**：Kimi 使用独立 `KIMI_CODE_HOME`；默认 Codex、OpenClaw 模型选择、消息 HITL 与权限表均不变。

## 安装与隔离认证

```powershell
npm install -g @moonshot-ai/kimi-code@2.2.0
Copy-Item config/kimi-code-executor.example.json runtime/openclaw-poc/kimi-code-executor.private.json
```

示例中的相对路径以**复制后的私有配置目录** `runtime/openclaw-poc/` 为基准：Node 指向项目 `tools/`，`kimiCodeHome` 和 `stateDir` 指向同目录下的 `state/`。`prefixArgs[0]` 是明确占位符，必须替换为本机官方 npm 包入口的绝对路径；需要 Git Bash 时填写实际 `shellPath`，不沿用开发者盘符。核对后再将 `enabled` 改为 `true`。Kimi 使用独立 `KIMI_CODE_HOME`，不得复制 Codex、浏览器、其他 Kimi home 或其他工具的凭据。

```powershell
$env:KIMI_CODE_HOME = (Resolve-Path runtime/openclaw-poc/state/kimi-code-home)
$privateConfig = Get-Content runtime/openclaw-poc/kimi-code-executor.private.json -Raw -Encoding UTF8 | ConvertFrom-Json
$env:KIMI_SHELL_PATH = $privateConfig.shellPath
kimi login
```

`kimi login` 是官方 RFC 8628 设备码流程。认证由用户在浏览器完成；聊天、任务描述、日志和配置中不得出现验证码、Cookie、Token 或 API Key。登录后先运行：

```powershell
node scripts/kimi-code-executor.mjs doctor
```

## 稳定任务调用

将指令写入临时文件，避免封装自己的命令行再次转义；Kimi CLI 原生仍把 `--prompt` 作为进程参数处理。

```powershell
node scripts/kimi-code-executor.mjs start `
  --task 69884e1c-d13a-4f64-bba3-db674e8e9a40 `
  --workspace E:\isolated\demo `
  --prompt-file E:\isolated\prompt-1.txt `
  --timeout-seconds 600

node scripts/kimi-code-executor.mjs status --task 69884e1c-d13a-4f64-bba3-db674e8e9a40
node scripts/kimi-code-executor.mjs wait --task 69884e1c-d13a-4f64-bba3-db674e8e9a40 --wait-seconds 60

node scripts/kimi-code-executor.mjs resume `
  --task 69884e1c-d13a-4f64-bba3-db674e8e9a40 `
  --workspace E:\isolated\demo `
  --prompt-file E:\isolated\prompt-2.txt
```

`resume` 必须复用 manifest 中同一个 `nativeSessionId`，不会按“最近会话”猜测。`status` 返回 stdout/stderr 尾部、退出状态、超时状态和 Git `status --short` / `diff --stat` / changed files；`changedFiles` 合并未暂存 tracked、已暂存 tracked 和未跟踪文件名，但不复制文件正文。完整流式事件和 stderr 位于 manifest 的 `files` 字段。

停止当前执行：

```powershell
node scripts/kimi-code-executor.mjs stop --task 69884e1c-d13a-4f64-bba3-db674e8e9a40
```

Kimi TUI 官方支持流式期间 `Ctrl-C` 或 `Esc` 中断；`kimi login` 取消/失败退出码为 1；本封装向后台 worker 发送 `SIGTERM`，超时记为 `timed_out` 且使用退出码 124。失败、取消或超时不删除 Kimi 原生 session，可在确认工作区状态后再次 `resume`。

## 回退

1. 将私有配置 `enabled` 设为 `false`，主控继续使用原 Codex 路径。
2. 无活动执行后删除忽略目录 `runtime/openclaw-poc/state/kimi-code-executor`，只移除任务映射和运行日志。
3. 如需清除独立 Kimi 状态，使用原生 `/logout` 后删除配置指定的 `kimiCodeHome`；不要碰其他 Kimi home。
4. `npm uninstall -g @moonshot-ai/kimi-code` 移除用户级 CLI。
5. 源码回退仅需撤销本功能的 module、script、test、example、operation doc 和 package scripts；不涉及 Codex、OpenClaw runtime selection 或 HITL 配置。
