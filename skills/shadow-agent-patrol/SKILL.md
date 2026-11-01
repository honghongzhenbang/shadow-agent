---
name: shadow-agent-patrol
description: 主动读取个人影子 Agent 的本机证据库、知识候选和持久任务队列，发现新问题、未完成事项、失败任务和可推进工作，并按权限策略执行低风险分析。用户要求影子 Agent、主动巡查、知识整理、自己找活、持续工作或检查影子 Agent 状态时使用。
---

# 影子 Agent 主动巡查

## 核心原则

- 不等待用户再次描述任务；从新证据、开放任务、失败记录和项目状态主动找工作。
- 把 Codex 会话正文、工具结果、Git、文档和连接器数据作为证据，不从标题直接推断结论。
- 任何候选知识保留 evidence id 和原始定位。
- 先读取再判断；外部写入、审批、提交、推送、发布和删除必须经过策略门禁。
- 一个数据源失败时继续处理其他数据源，并建立可重试任务。

## 标准流程

1. 在 `X:\ExampleProjects\sdagent` 运行 `npm run doctor`。
2. 运行 `npm run collect` 增量采集证据。
3. 运行 `npm run patrol` 执行采集、主动判断、任务创建和允许的自动任务。
4. 读取 `knowledge/generated/status.json`、`knowledge/open-loops/index.md` 和本轮报告。
5. 对失败来源或等待确认项给出准确状态，不把未授权或未验证内容写成已完成。

持续后台运行使用 `npm run daemon`。Windows 登录后自启由 `scripts/install-scheduled-task.ps1` 管理。

## 风险处理

读取 `references/policy.md` 判断动作风险。默认自动执行 `read`，其余动作留在任务队列。除非用户明确修改策略文件，不要绕过 `config/policy.json`。

## 飞书

飞书必须有 `lark-cli` 用户身份才能读取本人可见会话、文档和审批。只有 bot 身份时，保留等待授权任务并继续本地采集；禁止把 bot 可见范围描述为用户全部数据。

## 验证

- 重复执行采集，确认 evidence 数量不会因相同输入重复增长。
- 检查每条知识候选至少有一个有效 evidence id。
- 检查巡查在无用户提示时创建任务或保存无动作理由。
- 运行 `npm test`，再执行一次受限采集和真实巡查。
