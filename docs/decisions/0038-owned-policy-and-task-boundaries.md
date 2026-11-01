# ADR-0038 项目自有策略、同 Agent 历史可读与任务写入边界

- 日期：2026-10-20
- 状态：已批准并实现；实际部署与模型验收见上线验收。
- 取代范围：ADR-0036/0037 中强制 Workshop 路由及“框架即主控身份”的表述，不取代授权与任务唯一真相源。

## 证据与决策

框架主提示、工作区人格文件和项目控制规则存在多层注入。移除几个 Markdown 并不能删除框架主提示，也不能修复业务状态覆盖。此前 A/B/C 测试未证明替换一定更快，但暴露了真实的旧 checkpoint 重放、终态 continuation 和迟到绑定风险。

历史执行的 `parentSessionKey/spawnedBy` 未丢失；默认 tree 的动态子会话集合会受执行结束后的保留窗口影响。故不通过重建任务解决“可续写树”限制。

采用：

1. 一个 Shadow Agent，多条独立稳定工作会话。OpenClaw 留作运行设施，不创建第二主控。
2. 自有 `shadow-policy` 替换主提示，按可信 session key 分 controller/engineer/curator。现有工具协议继续有效；原始历史不改写。
3. 同一私有 Agent 使用 `visibility=agent`。跨任务读结果/证据可以；写卡和续写执行必须核对当前卡绑定。不同 Agent 与 incognito 不扩大权限。
4. checkpoint 持有 revision、owner generation、执行快照和幂等收据。冲突保留证据、返回未应用；终态拒绝活动 continuation。队列投递前复核同一版本；不由 run 状态直接改业务卡状态。
5. 已授权本地能力建设直接走现有 Skill/MCP/CLI，不强制 Workshop；外部 HITL、部署和设备边界不变。
6. 策略 hook 失败不能静默降级。仅在当前受支持 OpenClaw 版本的两处模型输入入口加入受管检查；版本或结构漂移拒绝启动。
7. 可发布策略不固化开发者个人业务背景。协作模板只放通用规则，个人事实保留在各自私有知识库并按需读取；知识 curator 可 ACK 自己租用的增量，不可改变任务卡状态。

## 不做什么

- 不迁移 Workboard，不重写调度器，不整体替换 OpenClaw。
- 不实施尚未决定的全量上下文效率提案，不给每张卡加载其他卡全文。
- 不删任务历史、不批量重建 Codex thread；Context Engine 的既有 projection fingerprint 保持，避免仅因身份措辞更新触发历史重投。其旧 bootstrap 文本被当前自有主提示替换，不再作为身份定义。
- 不声称全权限本机执行被工具 hook 安全沙箱隔离；hook 是受控应用路径的业务校验。
- 不声称 Gateway 的跨库 read→update 已具备原子 CAS。当前版本核对显著缩小旧回执覆盖风险，但严格跨库原子保证需要 Workboard 原生条件更新支持。

## 部署与回滚

先定向与全量自动化测试，再核对在途执行。profile 应用复制短 bootstrap、保留本机偏好，并将旧 SOUL/IDENTITY/USER/BOOTSTRAP 移到 `runtime/policy-history`，不进入 Git。不迁移/复制业务库正文，仅增加可重复迁移的 checkpoint revision。

受管 host 补丁保存一份 pristine 文件，版本固定 2026.8.1。部署错误保留事件，先恢复上一个配置/源码并重启，不把任务标为完成。关闭 required 策略不是正常自动恢复手段。

已有运行需完成或取得检查点后切换；新策略从后续轮次生效。不得为验收主动续写已由新执行取代的旧 worker；旧历史读取与当前执行续接分别验证。

## 验收

- 正式输入含项目身份与角色规则，不含框架人格主段；偏好保留。
- 角色及卡片边界拒绝伪造 sessionKey、跨卡写入；同 Agent 历史可读。
- 既有登录方式可由授权本机 helper 消费，不在模型输入/输出泄露密钥。
- checkpoint 重试、乱序、终态、回滚、旧队列绑定均有反例测试。
- 网络观察超时不判业务失败；模型性能和长周期成功率只依据实际观测，不从单元测试推导。
