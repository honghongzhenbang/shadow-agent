# ADR-0003 稳定工作会话与认知路由

- 状态：接受；项目 `workstream` 默认路由已被 ADR-0014 取代
- 被部分取代：ADR-0014
- 日期：2026-08-13
- 决策者：用户、Codex
- 关联契约：INV-06、INV-20、INV-24、INV-25、INV-26、INV-27、INV-28、INV-29
- 取代：`FEISHU_ATTENTION_V2.md` 中每批变化使用独立短会话的部分

## 背景

V3.3 已将消息按会话合并，并把一次常规注意力工具结果压缩到约 10 KiB；但每批仍创建新的 OpenClaw session key。实测一次极短判断仍报告约 19,896 Token，其中主要是固定 Agent harness、工作区提示和工具模式，而不是消息正文。与此同时，原始消息被物化为图实体并再进入变化流，知识、事件和注意力职责互相叠加。

## 决定

1. 飞书对话按 `chat + thread/root`、项目变化按 workstream、未归类变化按 inbox 路由到稳定 OpenClaw 会话。
2. OpenClaw 继续是唯一主控；使用其原生持久会话、Context Engine、pruning、compaction 和 transcript rotation，不在外层重写第二套会话运行时。
3. Context Engine 负责渐进式上下文编译，并对 Codex 持久线程使用稳定 epoch 的 bootstrap 投影。
4. 图谱从“尽量物化事件”收敛为耐久事实与认知路由图；原始事件保留在 Evidence Log。
5. 未知问题必须产生有序求知路径。询问人员是正式兜底，但发送仍受外部写入授权约束，发送后建立持久回复跟踪。
6. `context_changes` 只承担增量交付，不是任务状态；变化绑定稳定 session key 后按会话领取和确认。

## 备选方案

- 每批新建短会话：边界清晰，但固定上下文成本和连续性损失过高，驳回。
- 单一永久全局会话：初期简单，但不同项目和群聊互相污染，驳回。
- 每个项目一个永久会话：无法正确表达跨项目群聊和长期上下文增长，只保留 workstream 作为三类稳定会话之一。
- 增加前置小模型：会引入第二套判断责任和额外运行依赖，当前不采用。
- 把所有消息入图：存储与维护成本高，且把经历误作稳定知识，驳回。

## 影响

- 普通续轮的固定上下文更容易复用，项目和会话连续性提高。
- 上下文服务只做证据路由与可靠唤醒；语义决策仍由同一主控完成。
- 图谱规模不再与消息数量线性增长。
- 需要建立会话绑定、上下文 epoch、认知路由查询和未知问题跟踪的验证。

## 数据迁移

- 保留全部 Evidence、有效图谱事实、Workboard 和外部事件记录。
- 旧 Conversation 实体保留；V4 删除其到单条消息 Evidence 的冗余图链接和未完成的逐消息精炼队列，原始 Evidence 不删除。
- 旧全局注意力状态停止驱动；未确认变化一次性路由到稳定会话。
- 旧短会话 transcript 作为历史保留，不合并进新会话正文。

## 回退方案

保留 Git 标签 `v3.3.0-baseline` 和已校验源码 ZIP。停用 V4 Context Engine、恢复 legacy context engine 和 V3.3 守护脚本即可回到基线；不回滚 Evidence 或 Workboard 数据。

## 验证

- 单元测试验证稳定键、路由隔离、上下文层级和求知路径。
- 真实 OpenClaw 续轮验证相同 session key、context projection 和 Token 变化。
- 飞书测试验证询问授权、消息 ID 保存、condition watch 和回复恢复。
