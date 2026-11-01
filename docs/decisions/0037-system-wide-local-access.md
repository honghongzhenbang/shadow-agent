# ADR-0037：系统级本机高权限与执行继承

- 日期：2026-10-19
- 状态：已接受、已部署；真实父子执行验证通过，详见 [运维与验证记录](../operations/system-local-access.md)
- 契约：2.32.0

## 问题与决定

Skills 盘点子运行继承主控 minimal 工具清单，只有精确文件读取，没有目录发现、命令或写文件能力。Codex 原生 runtime 对有限工具清单采用 restricted turn，进一步移除原生文件/Code Mode 环境。缺工具被错误转述为需要用户提供路径。这是能力配置问题，不是知识库缺路径，也不应要求每个项目重新授权。

用户明确授权本系统在当前 Windows 身份下高权限工作。复用 OpenClaw 原生全局配置，不新增项目授权文件、权限服务或新的主控。

| 层 | 实现 |
|---|---|
| 唯一系统默认 | `config/openclaw-runtime-template.json.tools`：profile=full、exec.mode=full、host=gateway、fs/applyPatch.workspaceOnly=false |
| 本机安装实例 | 部署器生成 `runtime/openclaw-poc/state/openclaw.json` 全局 tools 与 sandbox.mode=off |
| 主控/新子运行 | 继承全局策略；清除旧逐 Agent minimal/allow 及本机限制，保留扩展和显式应用 deny |
| Codex runtime | 自动映射 never + danger-full-access；homeScope=agent 和隔离认证不变 |
| 其他模型 API | 使用相同 OpenClaw 工具权限，无需用户再配后端权限 |
| 新原生 runtime | 集成时编写权限映射并验证；不声称任意第三方 runtime 都能自动获得能力 |

模型选择仍是纯模型选择；不会因为改用另一模型而扩大授权。系统策略显式声明 full 后才能执行高权限部署。显式工具 deny、第三方账号授权、Windows ACL/UAC 和企业策略不被忽略，实际缺口必须报告，不能把 full 配置冒充已经验证的能力。

## 旧会话与业务边界

旧子会话会保存 inheritedToolAllow；不直接改 sessions 数据库，也不静默抹去限制。停止的旧执行保留结果和父卡关系，主控可在同一任务卡新建执行轮次。不批量重开历史任务。任务状态仍由现有主控/检查点更新。

本机高权限不等于授权处理所有看到的任务。飞书正常发送仍走 HITL；不更改用户 Codex 会话的只读监督；不读取无关凭据。任意命令可以旁路工具级限制，这是受信任个人 Agent 的真实风险，不能把提示词和出站确认当作强隔离。需要强隔离时应改变运行身份/机器/凭据，而不是新增模型后端权限开关。

## Codex 子运行兼容修正

首次真实验收发现：主控命令成功，但新子运行的动态工具登记中虽有 `exec`，模型只调用了 `process` 并报告无命令入口。不能把 Gateway 工具清单当作实际模型可执行能力的证明。

`apply-codex-shell-alias.mjs` 在已安装 Codex 插件的受限、非沙箱、Gateway-host 回合中启用已有 `gateway_exec`/`gateway_process` 投影。它复用已经过工具策略过滤的原执行器，不实现第二套 shell，也不打开被拒绝的 exec。memory、sandbox、node-host 和显式排除仍保持原行为。启动监督器执行幂等补丁，源码结构变化时拒绝盲改；原文件单独备份，不复制整个依赖目录。

这属于原生 runtime 集成处的一次兼容修复，不是让用户按后端配置权限。上游修复后应移除该补丁，并用同一个真实父子运行用例验收。

## 验证与上线

1. 单元测试：旧限制移除、模型切换独立、配置幂等、身份/应用 deny/监督策略保留。
2. 隔离配置 E2E：在临时目录生成配置，调用已安装 OpenClaw 原生 schema 验证，不触碰生产或模型。
3. 部署前只备份原配置和提示，不复制 node_modules 或数据库。检查活动执行后进行受控 Gateway 重启，保持现有巡检启停意图。
4. 真实模型冒烟：主控启动一个 visible 子运行，双方执行命令并在工作区外的测试目录列举、读取、写回随机证明。宿主验证实际产物，不以模型说“成功”作证明。不外发、不操作设备、不创建业务卡。
5. 测试结果写入运行证据目录。失败时明确区分配置、工具继承、账号、宿主和业务边界；不得宣称整体权限问题已解决。

回退只恢复本次配置/提示及对应源码改动；不会回滚业务数据库或删除历史执行。

## 原生依据

安装版本文档：`tools/openclaw-runtime/node_modules/openclaw/docs/gateway/permission-modes.md`、`docs/tools/subagents.md`、`docs/tools/exec.md`、`docs/plugins/codex-harness-reference.md`。这些描述分别约束会话模式、子会话继承、系统执行策略和 restricted Codex 回合。升级运行底座后应重跑上述验收，不依赖旧版默认值。
