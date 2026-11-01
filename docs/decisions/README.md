# 架构决定记录

本目录保存会长期影响 Shadow Agent 结构、数据或权限的决定。项目契约优先于任何单条决定；需要改变契约时必须先更新契约版本。

## 新增格式

文件名使用 `NNNN-short-title.md`，正文至少包含：

```markdown
# ADR-NNNN 标题

- 状态：提议 / 接受 / 已取代 / 驳回
- 日期：YYYY-MM-DD
- 决策者：
- 关联契约：INV-xx
- 取代：可选
- 被取代：可选

## 背景
## 决定
## 备选方案
## 影响
## 数据迁移
## 回退方案
## 验证
```

实现细节、普通重构和临时调试不需要 ADR。改变唯一主控、任务权威源、证据语义、授权等级、数据删除规则或插件工具语义时必须建立 ADR。

## 当前决定

- [ADR-0001 OpenClaw 单主控](0001-openclaw-single-controller.md)
- [ADR-0002 事件驱动运行时与提醒](0002-event-driven-runtime-and-reminders.md)
- [ADR-0003 稳定会话与认知路由](0003-stable-sessions-and-cognitive-routing.md)
- [ADR-0004 运行时收口与人工闭环](0004-runtime-hardening-and-human-loop.md)
- [ADR-0005 飞书统一出站模式](0005-unified-feishu-outbound-modes.md)
- [ADR-0006 持久化 HITL 审核上下文](0006-persisted-hitl-review-context.md)
- [ADR-0007 Agent 驱动的任务事件与稳定会话归属](0007-agent-driven-task-events-and-session-ownership.md)
- [ADR-0008 主动任务监督与 Codex 执行闭环](0008-proactive-task-supervision-and-codex-loop.md)
- [ADR-0009 面向结果的持续推进与责任归属](0009-outcome-driven-continuation.md)
- [ADR-0010 事件优先与有界进度审计](0010-bounded-progress-audit.md)
- [ADR-0011 活跃会话快照采集与数据库失联自恢复](0011-snapshot-collection-and-db-recovery.md)
- [ADR-0012 用户提醒与内部任务复查分流](0012-user-reminders-vs-internal-task-review.md)
- [ADR-0013 统一直接输入与卡片跟进](0013-unified-direct-input-and-card-conversation.md)
- [ADR-0014 软关系会话路由与稳定 Codex 投影](0014-soft-relations-and-stable-codex-projection.md)
- [ADR-0015 真实数据优先的飞书评测](0015-real-first-feishu-evaluation.md)
- [ADR-0016 飞书群背景留存与有界激活](0016-feishu-background-retention-and-bounded-activation.md)
- [ADR-0017 图谱路由与有界一级证据检索](0017-graph-routed-primary-evidence-retrieval.md)
- [ADR-0018 活动知识债务与冷库存分层治理](0018-active-knowledge-debt-and-cold-inventory.md)
- [ADR-0019 统一人工入口的持久回执与自动续送](0019-durable-direct-input-receipts.md)
- [ADR-0020 活动任务结果检查点与确认门禁](0020-task-result-checkpoint.md)
- [ADR-0021 原生执行绑定与任务条件闭环](0021-native-execution-and-task-condition-binding.md)
- [ADR-0022 控制轮预算与可观测性](0022-controller-turn-budgets-and-observability.md)
- [ADR-0023 Codex 动态工具按需搜索](0023-codex-searchable-dynamic-tools.md)
- [ADR-0024 动态工具 A/B 与 direct 生产回退](0024-dynamic-tool-ab-and-direct-fallback.md)
- [ADR-0025 控制轮运行时限与非终态观察分离](0025-controller-run-deadline-and-observation.md)
- [ADR-0026 统一知识差量与专用维护会话](0026-unified-knowledge-delta-curation.md)
- [ADR-0027 有界摘要与正交知识状态](0027-bounded-digests-and-orthogonal-knowledge-state.md)
- [ADR-0028 多源适配、领域分离与业务汇合](0028-source-domain-adapters.md)
- [ADR-0029 来源规范存储一次性切换](0029-canonical-source-storage-cutover.md)
- [ADR-0030 规范任务处理权与内部推进权限](0030-canonical-task-handling-authority.md)
- [ADR-0031 隔离 Agent Codex Home 与个人历史只读监督](0031-isolated-agent-codex-home.md)
- [ADR-0032 记忆检索与执行恢复可靠性](0032-memory-and-execution-reliability.md)
- [ADR-0033 主对话与独立任务会话](0033-main-and-task-conversations.md)
- [ADR-0034 增量进展确认与 Gateway 读写职责分离](0034-attention-progress-and-gateway-read-plane.md)
- [ADR-0035 来源摄入与判断结果恢复](0035-intake-and-review-recovery.md)
- [ADR-0036 长期委托、独立执行器与原生能力扩展](0036-delegation-and-native-capability-growth.md)
- [ADR-0037 系统级本机高权限与执行继承](0037-system-wide-local-access.md)
- [ADR-0038 项目自有策略、同 Agent 历史可读与任务写入边界](0038-owned-policy-and-task-boundaries.md)
- [ADR-0039 通用策略与个人资料隔离](0039-personalization-boundary.md)
- [ADR-0040 用户知识投影与冷启动](0040-user-knowledge-projection-and-onboarding.md)
- [ADR-0041 本地语音识别选型、分段与初始化任务](0041-local-voice-provider-and-onboarding.md)
- [ADR-0042 录音到达队列与人物标注闭环](0042-voice-intake-and-identity-review.md)
- [ADR-0043 同源双路处理与运行中信息更新](0043-information-fanout-and-active-task-updates.md)
- [ADR-0044 派生知识入口的增量维护与历史修复](0044-derived-knowledge-entry-maintenance.md)
