# ADR-0021 原生执行绑定与任务条件闭环

- 状态：接受
- 日期：2026-08-31
- 决策者：项目维护者
- 关联契约：INV-02、INV-36、INV-38、INV-39、INV-47、INV-63、INV-64、INV-65
- 适用版本：V4.16.0+

## 背景

已有架构确定 OpenClaw 是唯一主控、Workboard 是唯一任务状态源，Codex 只承担有界执行，飞书外发统一经过 HITL 和可靠队列。但两个执行边界仍主要依赖提示词约束：`sessions_spawn` 返回的 run 与 child session 未被确定性写回 Workboard 原生 execution 字段；飞书消息发出后虽可创建回复跟踪，任务继续条件与候选决议仍可能脱节。

这会产生两类假推进：Codex 已运行但卡片无法证明由哪个 child 执行，或飞书收到局部回复后 condition 被关闭，但父任务没有新的结果核验和下一触发。

## 决定

1. 主控继续使用原生 `sessions_spawn` 创建 Agent 管理的 Codex child，不增加 Codex 任务库或代理调度器。
2. `sessions_spawn` 返回后，同一控制轮调用既有 `shadow_task_checkpoint`，以 `codex_run` continuation 保存 run id、child session key 和实际模型。
3. 检查点事务写入幂等 `bind_workboard_execution` outbox 动作；后台通过 Workboard Gateway 更新同一卡片原生 session、run 和 execution 字段。相同绑定重试无副作用，不同活动 run 不得覆盖。
4. Codex 完成事件仍回到原控制会话。主控按原验收标准复核结果，决定接受、向同一 child 续发一个有界差异、记录阻塞或请求用户；执行终态不直接改变业务完成语义。
5. 绑定任务且期望回复的飞书消息真实发送后，同一出站处理立即创建带超时的 condition watch，并更新同一卡片的任务关注 continuation。该操作不需要额外模型轮次。
6. task-bound condition 的候选和超时只是证据。活动任务调用 `shadow_condition_resolve` 前必须存在候选之后的新任务检查点；关闭 watch 时 continuation 不得继续引用该 watch。
7. Workboard 继续独占任务状态，`work_task_attention` 只保存审计和下一唤醒投影，`condition_watches` 只保存外部条件，`controller_outbox` 只保存可靠动作。

## 备选方案

- 新建 Codex 执行表并复制 Workboard 状态：拒绝，会制造第二任务源。
- 仅依赖 Agent 文本记录 run/session：拒绝，重启后不能可靠恢复，也无法数据级防覆盖。
- condition 收到候选即自动完成父任务：拒绝，外部回复只证明条件变化，不证明业务验收通过。
- 由周期巡检重新发现未绑定执行或未跟进回复：拒绝，延迟高且会扩大上下文和 Token 消耗。

## 影响

- Codex 执行在 Workboard 原生字段中可观测、可恢复、可幂等重试。
- 飞书发送、回复等待、候选复核和父任务 continuation 使用一条因果链。
- 插件对 task-bound condition 增加数据级门禁；旧的非任务 condition 行为不变。
- 不增加模型会话、任务状态机、定时全表扫描或自动外发权限。

## 数据迁移

不新增数据库表或列。新记录使用既有 `controller_outbox`、`work_task_attention`、`condition_watches` 和 Workboard 原生字段。历史 Codex 运行没有可靠 child 证据时不得推断补绑；历史已发送消息只在现有任务和回执足够明确时按需建立跟踪。

## 回退方案

可以停止处理新的 `bind_workboard_execution` 动作并恢复旧提示词，但已写入的 Workboard execution、检查点、发送回执和 condition watch 必须保留为审计证据。不得通过删除历史记录回退。

## 验证

- 插件测试验证 `codex_run` 检查点产生精确、幂等的绑定 outbox 动作。
- Workboard 操作测试验证原生 execution 字段写入、重放幂等和不同活动 run 防覆盖。
- 出站测试验证 HITL 发送成功后创建带超时的 task-bound watch 并更新同一卡 continuation。
- 条件测试验证活动任务缺少候选后检查点时拒绝决议，关闭 watch 时拒绝继续引用同一 watch。
- 项目契约测试验证版本、不变量、运行提示和关键代码入口保持一致。
