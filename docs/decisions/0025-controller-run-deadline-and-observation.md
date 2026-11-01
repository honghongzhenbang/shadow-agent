# ADR-0025 控制轮运行时限与非终态观察分离

- 状态：接受
- 日期：2026-08-31
- 决策者：项目维护者
- 关联契约：INV-36、INV-62、INV-66、INV-68
- 适用版本：V4.18.2+

## 背景

控制器此前把同一个 `timeoutSeconds` 同时传给 Gateway run 和本地 `agent.wait`。180 秒到期既终止模型轮，又让调用方把“尚未产生最终文本”记为失败。这个规则无法区分长任务、非终态观察、模型流卡死和工具循环，也会让可靠 outbox 对仍在执行的工作产生错误重试。

## 决定

1. 生产 Gateway run 使用 `runTimeoutSeconds: 0`，不设置应用层累计墙钟截止。
2. 本地等待按 60 秒观察片调用 `agent.wait`；`pending`，以及无 `endedAt` 且 `timeoutPhase` 为 `queue/gateway_draining` 的 `timeout`，都是非终态，继续等待且不写失败或释放任务语义状态。
3. 只有 Gateway 明确返回 `ok`、`error` 或 `timeout` 才结束控制轮。模型流无输出和重复无进展分别交给 OpenClaw 原生 idle watchdog 与 loop detection。
4. 编程、构建和其他长执行由主控创建独立 child session，使用完成事件回到原任务；主控轮只负责派发、核验和决定下一步。
5. 冒烟与基准使用独立 600 秒运行预算，防止测试作业无限占用资源；测试超时不得写成生产任务失败。

## 备选方案

- 把 180 秒改成 3600 秒：拒绝。它只推迟同一种误判，仍把墙钟时间同时当作观察窗口和任务截止。
- 完全不观察 run：拒绝。调用方无法可靠取得终态回复和指标，也不能区分 Gateway 断线。
- 在 Shadow 层另写模型进度判定器：拒绝。OpenClaw 已提供 run 终态、模型流空闲看门狗和循环检测，重复实现会形成第二套运行时语义。

## 影响

- 长控制轮不会在固定三分钟被误杀，非终态观察不会触发 outbox 重试。
- 同一稳定会话在当前 run 终态前仍保持串行；其他会话可以并行。
- 真正长执行必须使用 child session，否则会不必要地占用主控会话。这是调度约束，不是新的任务状态源。

## 数据迁移

无需修改 Evidence、知识图谱、Workboard 或会话数据。部署新的 `config/agent.json` 并重启上下文服务即可。

## 回退方案

若 OpenClaw 版本不接受 `timeout: 0`，先恢复继承 runtime 默认截止，不得恢复 180 秒生产上限；保留分片 `agent.wait` 和 `pending` 非终态语义。

## 验证

- 单元测试连续返回两次 `pending` 后收到 `ok`，证明观察片不会提前结束。
- 单元测试明确 `timeout` 终态只返回一次，不被误当成 `pending` 重试。
- 配置、契约和运维文档共同校验生产 `runTimeoutSeconds=0` 与 `waitSliceSeconds=60`。
