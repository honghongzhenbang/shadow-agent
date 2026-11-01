# ADR-0020 活动任务结果检查点与确认门禁

- 状态：接受
- 日期：2026-08-31
- 适用版本：V4.15.0+
- 关联契约：INV-02、INV-33、INV-36、INV-39、INV-41、INV-63
- 规范依据：[项目契约](../PROJECT_CONTRACT.md)

## 背景

有界进度审计会为到期卡片产生 `task_progress_due`，并提前写入下一次内部复查时间。此前主控可以只复述任务或沿用该时间后确认变化，数据层无法证明它检查过 Codex 结果、外部条件或验收差异，也无法证明活动卡仍有真实唤醒来源。

## 决定

1. 新增 `shadow_task_checkpoint`，只接受精确 Workboard 卡和已租赁变化。它保存本轮结果状态、摘要、Evidence ID，以及 `codex_run`、`condition_watch`、`outbound_draft`、`internal_review` 或 `requires_user` 中唯一一种 continuation。
2. 检查点写入既有 `work_task_attention` 覆盖层，并复制一份不可歧义的快照到变化元数据。它不是任务状态，不创建卡片，也不关闭或重开任务。
3. `shadow_context_ack` 对活动卡的 `task_progress_due` 和 `human_agent_operation` 校验同一 `change_seq` 的检查点。没有检查点、续接引用不属于该卡或内部复查没有未来时间时，确认失败。
4. Workboard 已处于终态时允许直接确认；卡片缺失只能以 `ignored` 和明确原因结束。暂时故障继续使用 `deferred`，不得伪造检查点。

## 备选方案

- 只强化提示词：无法阻止模型遗漏或旧会话沿用过时规则。
- 新建任务推进状态机：会复制 Workboard 生命周期并制造双状态源。
- 由审计器直接判定进度：确定性审计没有足够语义，不能替代主控核验。

## 影响

- 活动任务变化从“模型说已处理”升级为可查询的数据级闭环。
- 任务状态仍只有 Workboard；覆盖层只保存注意力、结果核验和下一触发。
- 模型必须先留下真实 continuation 才能确认任务变化，空转会显式失败并保留租约重试。

## 数据迁移

SQLite 启动时为 `work_task_attention` 增量增加结果和 continuation 字段。历史卡片不伪造检查点；只有升级后处理的受保护变化写入新字段。

## 回退方案

可停止确认门禁并保留新增字段作为只读审计。不得删除 Workboard 卡片或把覆盖层提升为任务状态源。

## 验证

- 插件测试覆盖活动卡无检查点拒绝、无 continuation 拒绝、同变化检查点后通过和终态卡例外。
- 契约测试校验 INV-63、工具清单、运行规则和统一版本号。
