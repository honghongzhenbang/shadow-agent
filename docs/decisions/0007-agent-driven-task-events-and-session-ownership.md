# ADR-0007 Agent 驱动的任务事件与稳定会话归属

- 状态：接受；项目 `workstream` 控制归属已被 ADR-0014 取代
- 被部分取代：ADR-0014
- 日期：2026-08-15
- 决策者：用户、Codex
- 关联契约：INV-01、INV-02、INV-13、INV-15、INV-25、INV-32、INV-33、INV-34、INV-35

## 背景

V4 已能把飞书对话、项目变化和未归类变化路由到稳定 OpenClaw 会话，并以 `context_changes` 和 `controller_outbox` 提供部分恢复能力。但人工任务操作仍可能直接改变 Workboard，活动卡片没有独立的控制会话归属；“补充下一步”中的关闭语义由宠物正则判断，人工问答共用一个全局 manual 会话。这样会让 Agent 不知道状态为何改变，也无法可靠延续某张任务的上下文。

OpenClaw Workboard 的卡片 `session_key` 已有明确原生语义：它关联任务的执行/子 Agent 会话，并参与 Workboard 生命周期判断。把控制会话写进该字段会破坏底座语义，因此控制归属必须属于 Shadow 自己的投影。

模型额度耗尽会使整个语义主控不可用。为这种状态再实现一套本地语义判断既不能保持同等能力，也会制造第二主控，因此不属于产品降级目标。需要保护的是网关重启、进程离线、网络闪断和外部接口瞬时失败造成的事件丢失。

## 决定

1. OpenClaw 继续是唯一语义主控。任意自然语言任务指令由 OpenClaw 解释，宠物和后台脚本不得用正则扩展业务语义。
2. Workboard 继续是唯一任务状态源；统一命令执行器负责幂等写入，所有写入同时产生可追溯因果事件。
3. 每张活动卡在 Shadow `work_task_attention.owner_session_key` 归属一个稳定控制会话，但不为每张卡创建模型会话。优先复用已有控制归属，其次来源会话、项目 workstream，最后使用 inbox。Workboard 原生 `session_key` 只表示执行会话，不参与控制归属。
4. 用户点击结构化按钮已经构成决定，执行器可以立即落库；操作仍须可靠通知归属会话，由 Agent 更新认知和检查关联后续。
5. 用户提交自然语言“补充下一步”时，先保存知识 Episode 与任务指令事件；OpenClaw 在归属会话决定更新、关闭、拆分或询问。明确表达不增加第二次确认。
6. 每次操作记录 `operation_id`、`causation_id`、actor、source、card_id、基础状态、期望效果、应用状态、evidence_id 和控制 session key。同一操作的评论、证明、状态与知识反馈合并为一个变化包。
7. 事件先持久化再唤醒。Agent 或网关短暂离线时保留并退避重试，恢复后幂等补送；模型额度或授权不可用只报告运行故障，不启用语义降级。
8. Shadow 不实现物理 transcript 换代。稳定逻辑键长期不变，物理 transcript 的 safeguard compaction、历史占比限制和截断由 OpenClaw 原生 runtime 负责；Shadow 只提供有界注意力包和回查路标。

## 不采用的方案

- **宠物直接解析自然语言**：响应快，但会成为第二语义主控，无法稳定理解职责和上下文。
- **所有状态变化都先等待一次模型调用**：一致性高，但结构化用户决定会被无意义阻塞。改为立即执行并可靠通知 Agent。
- **每张任务一个模型会话**：隔离清楚，但会话数量与任务数线性增长，跨任务项目知识重复。任务只绑定已有 conversation/workstream/inbox。
- **所有人工输入共用 manual 会话**：实现简单，但不同项目与提醒相互污染，长期上下文不可控。
- **为额度不足实现规则降级**：无法保持语义能力，并引入第二控制面。
- **把控制归属写入 Workboard `session_key`**：字段看似可复用，但会覆盖原生执行会话语义，影响任务分派和陈旧状态判断。
- **自建 generation/checkpoint transcript 换代**：与 OpenClaw 原生 compaction 重复，增加恢复和上下文一致性风险。

## 迁移

1. 为现有活动卡按已有控制归属、来源证据、项目键和 inbox 顺序回填 `work_task_attention.owner_session_key`；不得修改 Workboard `session_key`。
2. 新建统一任务命令与因果事件协议，把宠物、提醒、出站审核和执行结果接入同一可靠通知入口。
3. 将自然语言任务处置从宠物移到 OpenClaw，删除关闭正则；结构化按钮继续走命令执行器。
4. 将人工入口按当前卡片、来源会话和项目路由，停止向全局 manual 会话增加新内容。
5. 验证 OpenClaw 原生 compaction 配置和 transcript 上限；Shadow 只监测健康度，不操作或拼接历史 transcript。

## 回退与故障处理

迁移期间可以禁用自然语言自动推进，使指令保持待处理，但不得恢复宠物正则作为主控。Shadow SQLite 内的 Episode、操作事件和 outbox 在一个本地事务中提交；Workboard 是跨数据库副作用，通过 `(operation_id, effect_type, target)` 幂等执行。事件协议失败时保留原 Episode、Workboard 当前状态和 pending 事件，修复后重放。卡片暂时无法归类时绑定 inbox，不允许活动卡保持无控制会话归属。

## 验证

- 活动卡 `work_task_attention.owner_session_key` 非空，并且同一卡同一时刻只有一个控制会话；Workboard `session_key` 在迁移前后不变。
- 同一操作重放不会重复评论、证明、状态变化、知识 Episode 或外部发送。
- Agent 离线后提交人工操作，恢复时只收到一个合并变化包。
- 自然语言关闭由 OpenClaw 产生可审计决议，宠物源码不再包含业务关闭正则。
- OpenClaw compaction 配置保持启用，Shadow 不创建、拼接或轮换物理 transcript。
