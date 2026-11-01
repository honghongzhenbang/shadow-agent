# ADR-0022 控制轮预算与可观测性

- 状态：接受
- 日期：2026-08-31
- 决策者：项目维护者
- 关联契约：INV-06、INV-22、INV-24、INV-29、INV-53、INV-55、INV-66
- 适用版本：V4.17.0+

## 背景

系统已经限制注意力包、会话窗口、一级证据和 Codex 简报的字节数，并把 transcript 压缩交给 OpenClaw 原生 compaction。但此前无法持续回答一轮控制实际读取了多少缓存上下文、调用多少工具、耗时多久，也无法区分“小数据包”和“大历史会话”各自造成的成本。单纯继续缩小注意力包不能解决长会话缓存读取或工具循环问题。

## 决定

1. 所有生产 OpenClaw 控制入口复用 `runOpenClawTurn` 的统一指标提取：自动注意力、人工输入、可靠 outbox 和飞书实时会话。
2. 每个 Gateway run 以 run id 幂等写入 `controller_turn_metrics`，记录匿名会话哈希、触发类型、模型、终态、时长、字节、Token 分类、工具名计数、history 完整性和预算标志。
3. 指标不得保存提示词、回复正文、工具参数、工具结果或真实会话键；默认有限保留最近 2000 轮。
4. 初始提示超过 UTF-8 硬字节上限时在 Gateway 调度前失败。已有 attention、conversation、evidence 和 Codex 简报预算继续各自生效。
5. OpenClaw 原生 `tools.loopDetection` 启用，负责重复调用、无进展轮询、ping-pong 和压缩后重复的运行内熔断。
6. Token、总工具调用和耗时阈值只形成告警，不自动截断当前任务、不改变 Workboard 状态，也不生成 Agent 工作。后续优化必须依据按触发类型分组的真实指标和任务质量一起决定。
7. 注意力调度在 Gateway 离线时复用同一变化批次的稳定 run id，并把现有 `context_changes.not_before` 更新为 30 秒起、15 分钟封顶的指数退避；成功后清除该会话的连续失败计数。失败证据保留，但不得用快速新 run 重试制造指标和连接风暴。

## 备选方案

- 看到 Token 高就周期性重建会话：拒绝，会破坏连续性并把问题转化为重复初始化。
- 再缩小所有工具输出：拒绝，缺少按阶段证据，容易损害关键任务质量。
- 自建模型工具循环和 transcript 压缩：拒绝，与 OpenClaw runtime 重复且形成第二执行层。
- 把预算告警创建成 Workboard 卡：拒绝，会让观测噪声进入用户任务状态。

## 影响

- 可以按触发类型比较每轮时长、Token 和工具调用，定位是长会话、检索展开还是执行循环造成浪费。
- 重复无进展工具循环在 OpenClaw 内部及时熔断。
- Gateway 重启或短时离线不会把一条待处理变化放大成高频失败轮。
- Provider 不报告 usage 或 history 截断时指标可能不完整，记录必须如实标记。
- 指标本身只产生少量同步 SQLite 写入，不参与模型上下文。

## 数据迁移

数据库初始化时创建 `controller_turn_metrics`。历史 transcript 不批量回灌，避免扫描大文件和混淆不同 runtime 版本；部署后的新轮次自然积累基线。旧运行配置由 `apply-openclaw-runtime-profile.mjs` 写入 loop detection 配置。

## 回退方案

可停止指标写入和报告命令，但保留已有匿名计数用于审计。loop detection 可恢复 OpenClaw 默认阈值，但不得在没有替代保护时显式关闭压缩后重复熔断。任务、会话和知识数据无需迁移。

## 验证

- 单元测试验证 UTF-8 提示预算、Token/工具统计、匿名会话和 run 幂等。
- 契约测试验证原生 loop detection 被部署且阈值有序。
- 全量测试验证新增表不改变任务、消息、提醒、图谱和条件语义。
- 生产灰度后使用 `report:controller-runtime` 检查首批真实轮次和告警分布。
