# 飞书真实评测数据

本文定义 Shadow Agent 如何使用真实飞书材料评估注意力、任务归属、回复和持续推进。它受[项目契约](PROJECT_CONTRACT.md)和 [ADR-0015](decisions/0015-real-first-feishu-evaluation.md)约束，不是生产消息采集的第二套架构。

## 1. 评测问题

评测必须分别回答：

1. 这条变化应忽略、只留证据、唤醒已有会话，还是启动新的语义处理？
2. 内容与用户业务是否相关，用户是否承担结果责任，当前是否存在用户动作？
3. 是否需要回复，草稿是否有足够上下文，发送后应建立什么继续条件？
4. 同一飞书对话、Workboard 任务和项目软关系是否正确续接？
5. 得出结论读取了哪些消息、图谱节点和工具结果，耗时与 Token 是否符合预算？

“能解析 JSON”“调用成功”“生成了一张卡”都不是上述问题的正确答案。

## 2. 数据流水线

```text
用户身份只读 API
  -> 最近活跃 P2P / 群聊
  -> 首次落盘前哈希与脱敏
  -> reply/thread + 时间边界 Episode
  -> 用途适用性审计
  -> development / validation / holdout
  -> Codex 抽样复核与 gold label
  -> 隔离回放
  -> 分项准确率、性能与安全报告
```

采集默认读取最近 90 天、每会话最近 300 条；高活跃会话只把最早一个 Episode 标为抓取边界风险。附件只保留经过脱敏的引用，不下载二进制资源。

## 3. Episode

Episode 是评测输入单元，不是永久业务实体。群聊优先按 `thread_id`、`reply_to` 和根消息隔离；主流消息再按无消息间隔切分。默认边界：

| 类型 | 空闲间隔 | 消息上限 | 字节上限 |
|---|---:|---:|---:|
| P2P | 4 小时 | 30 | 12 KiB |
| 群聊 | 2 小时 | 30 | 12 KiB |

单条消息可能超过字节上限，此时保留并标记，不静默截断。需要更早上下文时，被测 Agent 只能沿精确会话键按需补取相邻窗口，不能加载整段历史。

## 4. 进入模式

v2 数据至少保留下列可组合模式：P2P 收到/发出、群内提及本人、回复本人、本人群发言、群背景、机器人实时事件候选、轮询补偿、线程活动、编辑、删除和附件引用。

进入模式是运输与句法事实，不直接决定任务归属。群里提到项目、出现本人姓名、机器人卡片列出负责人或本人曾发言，都仍需结合当前动作、承诺、职责和已有任务判断。

机器人/应用消息不得在采集或 Episode 构建阶段人工删除。混合窗口必须同时保留首写脱敏后的真人正文、机器人文本或卡片正文、发送者类型和时间顺序；这里的“原始内容”是可供语义判断的消息体，不包含凭据、资源令牌或附件二进制。机器人状态、卡片字段或自动通知本身不证明用户负责，也不能单独创建用户任务。

## 5. 用途审计

每个 Episode 可以适合多个用途：

| 用途 | 最低条件 | 不代表 |
|---|---|---|
| 触发路由 | 有有效消息 | 应创建任务 |
| 任务归属 | 有人类入站和足够文字 | 用户确实负责 |
| 回复草拟 | 以人类入站结束且有上下文 | 必须回复 |
| 持续会话 | 双方往来、至少三条消息 | 必须复用某项目会话 |
| 真人/机器人混合窗口 | 同一 Episode 同时包含人类和 bot/app 消息 | 机器人结论等于业务事实或用户责任 |
| 负样本 | 群背景且未提及/回复本人 | 永远与用户无关 |

审计同时记录单边、单消息、文字不足、系统消息、未知发送者、附件主导、超大消息和抓取边界风险。规则只筛选样本用途，gold label 仍由复核给出。

## 6. 数据拆分与标签

Episode ID 经稳定哈希分为约 60% development、20% validation、20% holdout。development 用于错误分析，validation 用于阶段验收，holdout 在候选方案冻结前不得进入抽样清单、提示词或人工调优。

gold label 至少包含：

- `ingressDecision`：ignore、evidence_only、wake_existing、wake_new、review_reply；
- `businessRelevance` 与依据；
- `resultResponsibility` 与正向/反向依据；
- `activeUserActions`、`completedUserWork`、`waitingOnOthers`；
- `replyNeeded`、回复目的和禁止编造的事实；
- `continuation`：执行、条件跟踪、复查、等待用户或无；
- 支持结论的消息范围；
- `contextSufficient` 和不确定性。

模型生成的预标注必须由 Codex 或人工复核后才算 gold。上下文不足是合法标签，不应逼模型猜测。

## 7. 模拟数据

当前真实数据已经覆盖所有声明的业务进入模式，不需要为任务归属或回复内容编造语料。需要模拟的是历史 API 难以稳定重现的运输故障：

- 同一事件重复投递；
- 消息乱序与延迟；
- 进程重启后的游标重放；
- 实时事件与轮询同时命中；
- 外部接口瞬时失败和退避重试。

这些案例必须从真实 Episode 复制结构、替换投递顺序或次数，标记 `syntheticTransport=true`。它们只验证幂等、顺序和恢复，不计入真实语义准确率。

顺序恢复以时间戳非递减和消息集合完整为准；多条消息时间戳完全相同时，除非来源提供额外序号，否则不得假定或伪造同时间戳内的绝对顺序。

## 8. 指标与放行

指标分开报告：

- 触发 precision/recall；
- 用户活动动作 precision/recall；
- 回复必要性 precision/recall；
- 继续条件正确率；
- 上下文充分率与证据引用正确率；
- P50/P95 延迟、新输入 Token、缓存读取 Token、工具次数；
- 解析率、租约确认率和零副作用；
- P2P、群提及、群回复、群背景、真人/机器人混合窗口、附件等分层结果。

没有 gold label 时只报告数据适用性、格式、安全和性能。优化方案只有在 validation 改进且关键分层不退化时才可进入 holdout；holdout 退化则不得合入生产。

## 9. 命令与私有边界

```powershell
npm run eval:feishu:dataset:capture -- --days 90 --max-p2p-chats 40 --max-group-chats 40 --max-messages 300
npm run eval:feishu:dataset:build -- --capture <private-capture.json>
npm run eval:feishu:dataset:audit -- --capture <private-capture.json>
npm run eval:feishu:dataset:run -- --sample-per-stratum 1 --max-episodes 3
npm run eval:feishu:dataset:run -- --stratum mixed_human_bot_context --sample-per-stratum 5 --max-episodes 3
npm run eval:feishu:dataset:score -- --run <private-run-directory>
npm run eval:feishu:dataset:transport -- --per-fault 3
```

`dataset:run` 默认只从复核队列按场景分层抽样，拒绝包含 holdout 的队列；可重复使用 `--stratum` 只回放指定分层。每个 Episode 使用独立稳定会话和隔离数据库；首次烟雾建议限制为 3 条，确认输入、结构化输出、租约确认和零副作用后再扩到每层 1 条。

`dataset:score` 只读取预先复核的私有标签并生成匿名聚合报告；`dataset:transport` 只派生投递操作并通过真实 SQLite Evidence 链验证，不调用语义模型。

完整数据位于 `runtime/evaluations/feishu-dataset-v2/`，由 `.gitignore` 排除。仓库中的 `docs/evaluations/` 只能保存匿名聚合结果，禁止包含姓名、消息正文、会话 ID、资源键、访问参数或模型完整输出。

初次基线全量抓取后，日常更新应按来源游标增量采集并只重建受影响会话；不得每轮重新读取全部历史。
