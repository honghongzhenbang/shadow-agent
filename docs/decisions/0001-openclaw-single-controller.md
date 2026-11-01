# ADR-0001 OpenClaw 单主控与 Workboard 单任务源

- 状态：接受
- 日期：2026-08-11
- 决策者：用户与 Codex
- 关联契约：INV-01、INV-02、INV-07、INV-11

## 背景

早期实现包含本地 Codex SDK 巡查器、SQLite `tasks` 表和独立执行记录。接入 OpenClaw 后，如果继续保留两套规划和任务状态，宠物统计、任务完成、人工确认和自动执行会产生冲突。

## 决定

OpenClaw 是唯一主动主控，Workboard 是唯一活动任务状态源。上下文服务只采集和物化知识；Codex 只作为推理与工程执行引擎；宠物只展示 Workboard 并提交人工反馈。

旧 `tasks`、`patrol_runs` 和 `knowledge_candidates` 作为迁移历史保留，但不得驱动主控或 UI。新的来源变化通过 `context_changes` 进入 OpenClaw，由主控去重并维护 Workboard。

## 备选方案

- 保留双主控：拒绝。会产生重复任务、相互覆盖和无法解释的状态。
- OpenClaw 仅作 Codex 前置调度：拒绝。中间层过多，授权与状态仍会分裂。
- 删除全部旧表：暂不采用。现有历史和飞书兼容写入尚未完成迁移。

## 影响

- 本地守护进程不再运行模型巡查。
- 宠物从 Workboard 读取任务和完成历史。
- Shadow Context 插件提供知识和变化，不拥有任务状态。
- 人工确认完成必须写入 Workboard 证明和事件。

## 数据迁移

历史活动任务已通过一次性脚本转入 Workboard backlog。后续只有新变化可以重新激活；旧表继续只读或兼容写入，直到 `DEBT-01` 完成。

## 回退方案

不允许无数据迁移地恢复双主控。若 OpenClaw 暂时不可用，只能停止主动执行并保持证据采集，不能让旧规划器接管任务状态。

## 验证

- `doctor` 检查 `openclaw-single-controller`、本地规划脚本缺失和旧工具移除。
- Gateway 联调检查 Shadow Context 与 Workboard 工具可用。
- 宠物 E2E 检查任务统计、历史和人工确认来自 Workboard。
