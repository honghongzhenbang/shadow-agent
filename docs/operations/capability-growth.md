# 能力接入与模型切换

规范见 [ADR-0036](../decisions/0036-delegation-and-native-capability-growth.md)。本操作面复用 OpenClaw 2026.8.1，不额外安装 MCP 框架或创建第二任务库。

## 先决条件

- 现有 Workboard 卡片已有用户目标和授权范围。工具源、启动程序和依赖须经过检查。
- 使用项目固定 Node 与 OpenClaw；以下命令在项目根目录执行。
- OAuth/API Key 由本人通过原生流程提供。不得把令牌写入候选文件、Git 或聊天；候选只引用环境变量。
- MCP `probe` 不是安全沙箱：它会启动程序/连接服务。隔离的是配置和状态目录，不能限制程序访问操作系统。
- 凭据不足则保留待办；不复制正式 OAuth 存储到隔离目录。可先在原生 MCP 配置完成登录，再另行验证真实账号；该步骤不由本脚本自动化。

## 切换思考后端，保留 Codex 编程

在 `runtime/runtime-selection.private.json` 配置两个角色，格式见 `config/runtime-selection.example.json`。例如主控使用 `deepseek/deepseek-chat` + `openclaw`，编程执行器继续使用 `openai/gpt-5.6-sol` + `codex`。

供应商地址、API 协议、模型能力和鉴权仍配置在 OpenClaw 原生 provider 中。示例模型名不是可用性保证，须按已开通账号核对。一个完全相同的模型引用不能要求两个 runtime，需使用不同引用或供应商别名。

```powershell
& .\tools\node-v24.19.0-win-x64\node.exe scripts/apply-openclaw-runtime-profile.mjs
```

部署脚本默认读取上述私有选择文件；`SHADOW_RUNTIME_PROFILE_PATH` 可以指定另一个文件，显式路径不存在时报错，不静默回退。输出 `selection` 是配置结果，不是在线推理成功证明。模板保留额外 MCP、技能和工具项及原有 deny。Skill Workshop 是可选提案工具；主动使用时保留其发布约束，但已授权的本地 Skill 开发、测试和接入无需先经过 Workshop。

切换前先完成/停止相关活动执行，保存当前配置；确认 Gateway 加载后，测试普通回答、工具检索、子任务启动、原卡回写和压缩。数据库和现有运行绑定不迁移；已有显式 pin 的会话不会因改默认值自动切换，必须通过原生会话控制检查并解除不需要的 pin。没有新模型凭据时，只能报告配置层通过。

## MCP 候选

JSON 示例只包含演示地址，不能直接作为真实服务：

```json
{
  "name": "company_docs",
  "taskId": "现有卡片 ID",
  "purpose": "查询已授权项目文档，验收为找到已知文档并返回原文位置",
  "tools": ["search", "read"],
  "server": {
    "url": "https://mcp.example.com/mcp",
    "transport": "streamable-http",
    "headers": { "Authorization": "Bearer ${COMPANY_DOCS_TOKEN}" }
  }
}
```

不要在 URL、参数或 purpose 中填凭据。`env/headers` 只接受环境变量引用；本封装不是通用密钥扫描器，无法识别任意参数中的秘密。原生更多认证类型应走专项接入，不绕过候选检查。只接受精确工具名，禁止 `*`；名字必须小写字母开头、只含字母数字下划线。

```powershell
$node = '.\tools\node-v24.19.0-win-x64\node.exe'
$proposal = '.\runtime\capabilities\company-docs.proposal.json'
& $node scripts/manage-mcp-capability.mjs prepare --manifest .\runtime\company-docs.json --proposal $proposal
& $node scripts/manage-mcp-capability.mjs probe --proposal $proposal --trust-server
& $node scripts/manage-mcp-capability.mjs publish --proposal $proposal
& $node scripts/manage-mcp-capability.mjs status --proposal $proposal
```

上例发布为 **禁用**，不会改变正在工作的工具面。若此前已经取得启用授权，在首次 `publish` 时增加 `--authorization-evidence 对应用户授权EvidenceID`，发布为启用且仅将候选精确工具加入主控工具表。这个字符串只是操作者提供的审计依据，脚本不会验证授权证据正文；不能把它当安全权限签发机制。发布后本机原生 Codex 默认仍逐次要求 MCP 工具审批；这不等于通用 API runtime 也有同样的逐次审批。会发消息/修改外部资源的能力必须继续经过现有 HITL 或另行设计原生授权集成，不能靠本参数放开。

已发布为禁用的候选不允许被同一回执再次启用。先撤回，再用新候选、探测和明确授权重新发布，避免“复用旧探测偷偷扩大权限”。

## 验收、故障与撤回

- `probe.passed` 仅证明原生协议连接及预期工具发现，不调用业务工具；超过 24 小时必须重测。180 秒限制仅用于探测连接进程，不是工程任务时限。
- `publication` 固定标记 `runtimeVerified=false`、`businessVerified=false`，只是发布回执。实际运行证据和业务验收另写原 Workboard 卡片；不要手改回执冒充验证。
- OpenClaw 对 `mcp.*` 支持热加载，但不同 runtime 的既有会话快照可能不同。必须在新轮次核对工具可见性；必要时受控重启，不自动中断正在运行的任务。
- 配置变化、候选变化、失败/过期探测均拒绝发布；重新基于最新配置创建候选。不要删除别人写入的配置来强行通过。
- `--config PATH` 可指向隔离配置进行完整流程测试；生产配置仍是默认路径。

```powershell
& $node scripts/manage-mcp-capability.mjs rollback --proposal $proposal
```

撤回只删除此次服务器及此次增加的工具允许项，不恢复整份旧配置，其他接入继续保留。服务器已被后来修改时拒绝撤回。发布前写 `.intent.json`；如果进程中断，先检查正式配置与意图中的 before/after 哈希，不能盲目重试。`.capability.lock` 是协作写锁；外部程序不遵守此锁时仍应避免同时编辑。完整崩溃恢复步骤见命令 `recover`，不自动删除未知锁。

## 何时需要修改核心

新 Skill、现成 MCP/CLI、模型供应商配置通常不需要改核心。新增持续事件源需要实现现有来源协议。改任务生命周期、证据/冲突语义、授权或进度检查点才需要修改核心并更新契约。核心自修改使用工程分支、回归测试和受控部署，不在主控运行中热替换源码。
