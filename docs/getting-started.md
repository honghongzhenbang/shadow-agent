# 安装与首次运行

本文面向首次使用的 Windows x64 用户，依次配置工程依赖、模型运行环境、Shadow 插件及个人资料。当前通过源码安装，尚无一键安装器。

## 0. 先决定数据与权限

- 用新的目录，优先独立 Windows 用户或测试环境；不要覆盖已有安装。
- 当前模板包含高权限本机工具。来源范围与提示约束不是硬沙箱。
- 准备模型账号，但不把密码/API Key 写进仓库、聊天、资料 JSON 或任务卡。
- 不复制别人的 `runtime/`、`config/*.local.json`、模型授权库和数据库。
- 暂时不要接入真实办公会话、启用麦克风或安装登录自启。先完成最小验证。

## 1. 准备工程依赖

安装 Git、PowerShell 和 Node.js。当前既有 Windows 启动脚本还要求项目内存在：

```text
tools/node-v24.19.0-win-x64/node.exe
tools/openclaw-runtime/node_modules/openclaw/openclaw.mjs
```

从 Node.js 官方发行页取得对应 Windows x64 ZIP，核对官方校验值后解压到上述 Node 目录。不要把电脑上某个其他版本改目录名来充数；改版本需要同步检查启动脚本和运行时补丁。

在项目根目录执行：

```powershell
$root = (Get-Location).Path
$env:PATH = (Join-Path $root 'tools/node-v24.19.0-win-x64') + ';' + $env:PATH
node --version
npm ci
node .\node_modules\electron\install.js
npm install --prefix .\tools\openclaw-runtime --save-exact openclaw@2026.8.1
```

Node 24.19.0 附带的 npm 会要求审核依赖安装脚本。查看待审核列表，只批准来自已确认包的脚本，再完成原生依赖和 OpenClaw 内置插件安装：

```powershell
npm approve-scripts --prefix .\tools\openclaw-runtime --allow-scripts-pending
npm approve-scripts --prefix .\tools\openclaw-runtime --allow-scripts-pin openclaw koffi protobufjs tree-sitter-bash '@google/genai'
npm rebuild --prefix .\tools\openclaw-runtime openclaw koffi protobufjs tree-sitter-bash '@google/genai'
```

不要用批准全部包代替审核。若实际待审核名单不同，先核对对应包及脚本；旧版 npm 不支持该命令时，先核对正在使用的 Node/npm 版本。

当前锁定的 Electron 包需要显式执行 `install.js` 下载并校验桌面运行文件；只有 `npm ci` 成功还不能启动桌面。如果下载失败，检查网络后重试同一命令，不要复制未知版本的 `electron.exe`。

已配置 `HTTPS_PROXY` / `HTTP_PROXY` 且需要代理访问 GitHub 下载时，在执行 Electron 安装命令前设置 `$env:ELECTRON_GET_USE_PROXY = '1'`。不要关闭 TLS 或文件校验来绕过下载错误。

GitHub 大文件下载持续失败时，也可以显式选择 npmmirror 的 Electron 镜像。安装器仍使用 npm 包内的上游校验值检查文件：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_CUSTOM_DIR = '{{ version }}'
node .\node_modules\electron\install.js
```

如果注册表无法取得指定的 OpenClaw 版本，或包内布局和补丁不匹配，停止安装并保留错误。不能默默改成 `latest`，也不能复制含凭据的旧运行目录替代。

语音依赖和模型此时不安装；它们不是主对话/知识库最小体验的前置条件。

## 2. 将本机来源限制在选定范围

仅在这个新目录创建 `config/agent.local.json`，例如：

```json
{
  "paths": {
    "codexHome": "./runtime/empty-codex-home",
    "inboxRoots": ["./inbox/documents"]
  },
  "codex": { "titleMaintenance": { "enabled": false } },
  "feishu": {
    "enabled": false,
    "realtime": { "enabled": false }
  }
}
```

这里暂时不读取个人 Codex Home，也不连接飞书。该示例不能覆盖老用户的整个本机配置；老用户应合并需要改变的字段。

```powershell
npm run init
```

`init` 创建本地目录和数据库，不等于模型可用，也不会完成个人资料确认。开始接入真实来源时，逐项检查实际读取范围和凭据，不要仅因为配置文件存在就宣布接入成功。

## 3. 初始化独立的 OpenClaw 环境

先固定项目状态目录，避免向个人默认 OpenClaw 实例写配置：

```powershell
$root = (Get-Location).Path
$env:OPENCLAW_STATE_DIR = Join-Path $root 'runtime/openclaw-poc/state'
$env:OPENCLAW_CONFIG_PATH = Join-Path $env:OPENCLAW_STATE_DIR 'openclaw.json'
$env:OPENCLAW_WORKSPACE_DIR = Join-Path $root 'runtime/openclaw-poc/workspace'
$oc = Join-Path $root 'tools/openclaw-runtime/node_modules/.bin/openclaw.cmd'
& $oc onboard --classic --agent-name main --mode local --workspace $env:OPENCLAW_WORKSPACE_DIR --gateway-port 19011 --gateway-bind loopback --no-install-daemon
```

在原生向导中完成自己的模型选择和授权。暂不安装另一套常驻 daemon 或开放公网；稍后由本项目启动脚本管理。

同机已有实例占用 19011 时，在向导命令中换一个空闲端口，例如 `--gateway-port 19173`。启动脚本读取本项目 `openclaw.json` 的 `gateway.port`，不应停止另一安装目录的实例。

默认 Codex 路线还需安装与此运行时配套的原生插件：

```powershell
& $oc plugins install '@openclaw/codex@2026.8.1' --pin --accept-capabilities
```

按安装提示确认官方包来源。不要将这一步改为安装 `latest`。项目的 `ensure-openclaw-codex-runtime.ps1` 会查找原生受管安装并要求 app-server `>=0.149.0`。出现 `Managed Windows Codex executable was not found` 时，说明这一步未完成，不应从其他用户目录复制授权文件。

API 模型需自己的 provider 配置、API Key 和额度。示例模型 ID 不是账号可用性保证。主控与编程执行器的选择格式见 `config/runtime-selection.example.json`；实际覆盖文件是私有的 `runtime/runtime-selection.private.json`。

## 4. 安装 Shadow 插件并应用策略

先确认 `runtime/openclaw-poc/state/openclaw.json` 已由原生配置产生且有 `main` Agent。`config/openclaw-runtime-template.json` 是 Shadow 的策略模板，不是可以直接复制覆盖的完整 OpenClaw 原生配置。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-shadow-context-plugin.ps1
node scripts/apply-openclaw-runtime-profile.mjs
```

配置应用会写入项目私有运行配置、工作区模板和受控策略补丁。代码/版本形状不支持时会拒绝，不应绕过校验硬启动。它不会自动完成所有第三方 Skill、模型插件或账号配置。

该步骤会显式启用 Codex、Workboard 和 Shadow Work 核心插件，并为 Shadow Work 开启任务结束回调所需的会话访问。只安装插件文件而未应用策略，不能替代完整配置。

默认技能列表包含飞书相关 Skill。未安装时应按实际能力补齐或调整自己的运行配置并验证，不能声称已经能读取飞书。首次先验收主对话与一项本地任务。

默认独立 Codex 授权入口为：

```powershell
npm run openclaw:auth:isolated
```

按本机终端提示完成官方设备码登录。不要把代码、Token 或授权数据库发到聊天和 Git。

## 5. 启动并验证最小体验

```powershell
npm run openclaw:start
```

另开一个项目终端执行：

```powershell
npm run serve
```

再开一个终端显示桌面：

```powershell
npm run pet
```

先交代一个不涉及外发、设备和真实数据变更的小任务，检查：

1. 主控实际返回结果，不只是端口在线。
2. 明确任务有真实 Workboard 卡片，在卡内继续交代仍是同一项工作。
3. 结果有可回查依据，完成和终止不会混淆。
4. 来源暂未连接时清楚报告缺口，不生成虚假的调查结果。

`npm run doctor` 可辅助检查，但它会创建部分目录/初始化数据库并探测依赖，不是纯只读审计；某些检查沿用传统 Codex CLI 位置，应与独立运行时的实际状态一起判断。`doctor` 的绿色项不能替代上述业务验证。

## 6. 确认个人资料与引导任务

按 [用户知识与冷启动](operations/user-knowledge-onboarding.md) 准备 `config/user-basics.local.json`，预览后人工确认完整哈希。不要原样导入示例，也不要让助手替你默许资料和来源授权。

确认回执中的 `queued` 只说明初始化请求已保存。主控在线消费后，检查初始化总卡及关联卡：补充职责、软件登录、指定范围调查、首个目标，以及用户选用语音时的配置验收。

模型不在线时保留原请求，不反复创建另一套资料或任务。只读入口、图谱事实和真实任务卡均应在完成后可回查。

## 7. 再接入更多来源

- 飞书：先安装并授权用户选择的 CLI/Skill，再启用本机配置中的普通和实时入口。聊天、文档、任务等有不同的可见权限。
- Codex：明确用户允许读取的 Home/会话范围；Agent 的模型授权 Home 和用户的历史资料读取入口是不同用途。
- 文件/Git：选择项目与资料目录。不要把“发现目录”当成已经理解整个项目。
- 语音：通过配置任务核对设备、依赖、模型和真实样本。见 [语音模型与两端配置](voice-guide.md)。不自动录音或上传。
- 其他 MCP/CLI/Skill：见 [能力接入](operations/capability-growth.md)。工具可调用不等于已形成持续事件摄入。

## 8. 自启、停止和升级

最小体验确认后，再决定是否安装当前用户的三个登录任务：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-scheduled-task.ps1
```

该命令会注册/更新计划任务并安装插件；不要在还有活动任务的老环境中随意重跑。

`npm run agent:stop` 停止受管后台；托盘退出也会影响后台，不只是隐藏窗口。升级前备份自己的数据，确认活动任务、源码版本、运行插件和原生补丁状态。不要把开发分支上的通过结果直接视为新安装的验收结果。

## 验证状态

已在 Windows 11 的独立目录、空用户配置和空依赖缓存下验证下载与安装，并通过 928 项源码回归（4 项条件性跳过）和 6 项桌面界面检查。首次安装的核心插件配置修复后，11 项定向回归及 Gateway 启停、知识/任务工具发现、空任务卡读取通过。

这属于本机隔离验证，不是另一台电脑或全新操作系统验收。未导入既有模型认证，也未验证新账号登录后的真实模型回答。模型登录、外部软件授权、手机连接和 GPU 语音处理需在使用设备上分别验证；遇到依赖版本不匹配时保留错误，不要跳过校验。
