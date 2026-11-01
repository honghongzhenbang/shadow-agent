# 系统级本机权限

## 配置位置

这是整个 Shadow Agent 安装实例的策略，不是某个业务项目的配置，也不是 Windows 所有软件的权限设置。

- 版本化系统默认：`config/openclaw-runtime-template.json` 的 `tools`。
- 实际运行配置：`runtime/openclaw-poc/state/openclaw.json`，由 `scripts/apply-openclaw-runtime-profile.mjs` 生成。
- 默认值：工具 full；执行 full/gateway；文件和补丁不限制在工作区；本机沙箱关闭。
- 模型选择仍单独管理模型及 runtime，不携带权限。Codex 的 sandbox/approval 自动派生；独立账号与 homeScope=agent 不变。

不用为新项目再建授权文件。具备权限不等于整盘扫描：主控仍应按任务选目录和证据，避免读取无关文件和凭据。Windows ACL/UAC、企业策略、第三方授权需要独立满足，本配置不会绕过它们。

## 生效与诊断

部署脚本更新全局策略，清除旧主控 minimal/allow 和逐 Agent 本机执行限制。显式应用 deny 保留；后端缺能力时报告真实错误，不能重复让用户给一个目录。不要手工修改会话数据库来解除旧的 inheritedToolAllow；在原卡片保留执行历史，停止的旧执行由主控创建新轮次。

Gateway 启动会检查 Codex shell alias 兼容补丁。该补丁只为已有执行器提供可用名称，不绕过其权限。若升级后报告布局不匹配，先核对新版本原生实现并重新验收，不跳过校验强启。

## 可重复验收

在仓库根目录使用自带 Node：

```powershell
& .\tools\node-v24.19.0-win-x64\node.exe --test test/openclaw-runtime-profile.test.mjs test/codex-shell-alias.test.mjs test/project-contract.test.mjs
& .\tools\node-v24.19.0-win-x64\node.exe test/e2e/runtime-selection.e2e.mjs
& .\tools\node-v24.19.0-win-x64\node.exe test/e2e/codex-shell-alias.e2e.mjs
& .\tools\node-v24.19.0-win-x64\node.exe scripts/test-system-local-access.mjs
```

最后一项会真实调用模型，创建专用父子测试会话和 Windows 临时目录，消耗模型额度；不操作鼠标键盘、不发送消息、不创建业务卡。它验证父子命令调用、工作区外目录列举、随机文件读取和写回证明，证据保存在 `runtime/openclaw-poc/evidence/system-access-*`。测试临时目录和会话保留作追溯，不伪装成业务成果；需要清理时只清理本次输出指明的精确目录。

飞书正常出站仍走 HITL。拥有任意本机命令权限的进程有能力触达当前用户资源，所以这不是不可旁路的沙箱保证；这是用户明确选择的受信任个人 Agent 运行模式。

## 2026-10-19 验证记录

- 266 项回归测试全部通过；PowerShell 启动脚本解析通过。
- 临时配置 E2E 通过；正式 OpenClaw 配置校验通过，无警告。
- 已安装原生 shell 投影测试通过：复用既有执行器，缺少 exec、显式排除、sandbox 和 node-host 不会被放开。
- Gateway 已重启并恢复健康。真实主控调用 `bash` 和 `sessions_spawn`，真实子会话调用 `gateway_exec`。
- 父子运行在各自进程中读取相同随机 nonce、列举工作区外临时目录并分别生成证明文件；宿主校验通过。
- 成功证据：`runtime/openclaw-poc/evidence/system-access-1792378840255/`，其中 `result.json`、`parent.json`、`child-history.json` 和两份 `*-proof.json` 可交叉核对。
- 首轮 `system-access-1792378035077` 暴露子会话 exec 不可用；第二轮 `system-access-1792378713248` 因测试标签重名未创建子运行。均保留失败记录，未当作业务成功。
- 没有发送飞书消息、创建业务任务或把历史阻塞卡改成完成；未验证第三方管理员权限、真实设备或所有未来 runtime。
