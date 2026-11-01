# ADR-0014 软关系会话路由与稳定 Codex 投影

- 状态：部分取代；任务共用来源/人工会话的决定已由 [ADR-0033](0033-main-and-task-conversations.md) 替换为按卡片独立的稳定任务会话。项目软关系、来源会话连续性及稳定投影规则仍有效。
- 日期：2026-08-28
- 决策者：用户、Codex
- 关联契约：INV-06、INV-15、INV-24、INV-25、INV-29、INV-34、INV-51、INV-52、INV-53、INV-54、INV-55
- 部分取代：ADR-0003、ADR-0007、ADR-0010、ADR-0013 中项目 `workstream` 作为默认控制会话的设计

## 背景

现有系统把飞书对话、项目和未归类变化分别绑定到 conversation、workstream 和 inbox。这个方案避免了每条消息新建会话，但又把“属于某个项目”和“应由哪个上下文推进”写成同一件事。跨项目群聊、同一消息关联多个任务、项目内他人工作以及任务后续进入其他对话时，硬映射会产生错误归属或重复项目会话。

同时，Shadow Context Engine 把职责修订号、待领取数量、条件跟踪和会话元数据写入 `thread_bootstrap`，并把完整文本参与 projection fingerprint。普通数据变化因而可能被 OpenClaw 解释为绑定不兼容，轮换原生 Codex thread。注意力包虽然有字节上限，但仍可能携带过多动态简况、证据和仅靠文本相似度召回的卡片，削弱任务重点。

## 决定

1. Shadow Agent 只有一个产品身份和一个语义主控。人工主会话、外部连续会话、任务控制归属和隐藏 inbox 只是上下文边界，不是多个 Agent。
2. 长期模型上下文只保留三类边界：`agent:main:shadow:user`、真实外部 conversation、`agent:main:shadow:inbox`。任务引用其中一个控制会话；项目不再默认创建永久模型会话。
3. 消息、会话、任务、项目、人员和职责使用现有通用图谱保存多对多、可修订、带 Evidence 的软关系。会话项目线索、目录项目键和候选卡只提供先验，最终关联由 OpenClaw 语义判断；任务同一时刻仍只有一个 action owner。
4. 项目文件、Git、文档和其他无真实来源会话的变化保留 `project_key` 后进入隐藏 inbox。真实飞书会话继续按 `chat + thread/root` 串行，避免把真实对话拆散。
5. `thread_bootstrap` 只包含稳定控制协议。projection epoch/fingerprint 由协议版本和固定文本决定，不读取数据库，不包含职责、队列、条件、任务、项目或运行状态。只有显式协议升级、原生线程丢失或用户重置才允许换 thread；历史压缩继续交给 OpenClaw/Codex 原生机制。
6. 自动 `shadow_attention_packet` 最多领取 4 个变化，每个变化最多携带最近 12 条 Evidence，默认 12 KiB、硬上限 16 KiB。工作简况只提供职责判断所需的短摘要；最多三张 `relatedCards` 明确标记为候选，除显式 task ID 外不得视为归属。
7. 原文、完整会话、代码、局部图和人员关系不进入默认包。OpenClaw 只有在一个具体歧义阻碍当前动作时，才调用 `shadow_context_resolve` 或来源定位逐层取回。
8. 新建 Codex 子任务使用不超过 8 KiB 的执行简报，只传目标、验收、授权范围、当前差异、必要约束和证据定位。主控读取已有 Codex thread 时先读元数据，只在任务复核确有需要时展开 turns；任何后续执行都不得把原 transcript 再拼接为新输入。

## 备选方案

- **每个项目永久一个长会话**：项目内连续性直观，但跨项目消息、共享任务和职责边界会硬分裂；长期项目数量也会线性增加线程，驳回。
- **所有工作放进一个永久主会话**：实现简单，但自动巡检、人工输入和外部群聊互相污染，驳回。
- **每条消息或每张任务一个会话**：隔离最强，但固定提示和工具成本重复，任务追溯碎片化，驳回。
- **在模型前增加独立分类模型**：可能减少主模型调用，但会引入第二语义判断层，并仍需职责和关系上下文，当前不采用。
- **删除关系并完全临时判断**：短期灵活，但每次重复推断人员、项目和任务关系，无法从人工纠正中学习，驳回。

## 影响

- 项目仍可通过图谱、Workboard `project_key` 和检索路标聚合，不需要项目专用业务模块。
- 飞书消息可以同时关联多个项目和任务，但只由一张目标任务卡及其控制会话执行动作。
- 普通职责、跟踪或队列变化不再导致 Codex thread 抖动；首轮稳定提示也显著缩短。
- 语义主控需要把高价值关系以 `shadow_context_propose` 写入现有图谱，并在用户纠正时通过既有修订链更新，而不是修改硬编码映射。

## 数据迁移

1. 保留 Evidence、图谱事实、Workboard、Codex transcript 和全部历史 `conversation_bindings`，不删除审计记录。
2. 尚未处理且绑定 legacy workstream 的 `context_changes` 在下一次路由时改投 inbox，保留 `project_key`。
3. 活动卡若仍由 workstream 控制，重新运行任务归属迁移：有真实来源会话则绑定来源会话，否则绑定 inbox；`project_key` 原样保留。
4. 历史 workstream 绑定停止接收新变化，可在确认无 pending change 和活动 owner 后标记为 retired。

## 回退方案

回退代码时可以恢复 project-to-workstream 路由，但不得删除迁移后形成的软关系、Evidence 或历史绑定。回退前必须确认不会让同一活动任务同时被 inbox 和旧 workstream 推进。

## 验证

- 修改长期职责、待处理数量、条件跟踪或会话元数据后，bootstrap epoch、fingerprint 和文本完全相同。
- 数据库暂时不可用时，bootstrap 身份仍相同；工具按运行错误报告数据不可用。
- 项目变化进入 inbox 且保留项目候选，真实飞书对话继续进入独立 conversation。
- 项目来源任务没有真实对话时归 inbox，不修改 Workboard 原生 `session_key`。
- 8 KiB 注意力测试内，显式卡和同项目候选均可见，候选关系状态不同；噪声卡不进入包。
- 工作区规则和契约测试同时约束 Codex 执行简报不得携带完整 transcript、Workboard、图谱或外部会话。
- 全量单元测试、插件测试和 `doctor` 通过；真实网关验证需在 Agent 恢复运行后确认连续多轮复用同一 Codex thread。
