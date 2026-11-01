# ADR-0028 多源适配、领域分离与业务汇合

- 状态：接受；数据迁移策略由 ADR-0029 取代
- 日期：2026-09-02
- 决策者：项目用户、Codex
- 关联契约：INV-12、INV-15、INV-26、INV-60、INV-73、INV-74、INV-75、INV-76、INV-77

## 背景

系统已经同时采集飞书和 Codex，但当前公共抽象主要停留在 `sources/evidence`，中间处理仍以供应商命名。后续还要接入钉钉、企业微信、Slack、Teams、Cursor、Claude Code、TRAE 等来源。

飞书和 Codex 都有会话，却不具有相同语义。飞书会话围绕人员、回复、指派、承诺和组织权限；Codex 会话围绕目标、回合、工具、文件、测试和执行状态。把两者压成同一种通用消息会降低归属判断、检索和审计质量。

## 决定

1. 所有来源统一使用最小 Observation/Evidence 信封，复用来源、事件身份、时间、游标、哈希、权限、因果关系和回源定位。
2. 中间语义分为 Collaboration 与 Execution 两个领域投影，不建立一个万能 Conversation/Message 模型。
3. 飞书、钉钉等企业协作平台在 Collaboration 内统一 Communication、Content、Work 和 Organization；Codex、Cursor 等编程 Agent 在 Execution 内统一 Session、Run、Turn、Tool、Artifact 和 Status。
4. 两个领域只通过 Task、Decision、Commitment、Artifact、Person、Project、Knowledge 和 Evidence 关系汇合。Workboard 继续是任务权威源，图谱继续是知识与证据关系层。
5. 适配器使用能力声明。实时、增量、回填、恢复、工具观察、发送和用户身份能力均可独立缺失；核心按能力降级，不以供应商名称硬编码能力。
6. 当前 Codex、飞书数据不迁移。先为现有 Evidence 建只读规范投影，再用第二个 Execution 和 Collaboration 供应商验证抽象。
7. 未承诺稳定的供应商内部数据库不得成为生产必需接口；优先使用官方 Hook、SDK、事件、API、结构化输出或导出。

## 备选方案

### 一个通用会话与消息模型

驳回。它能复用少量存储和 UI 代码，但会把工具调用伪装成消息、把消息回复误作执行父子关系，并迫使所有来源承担不适用字段。

### 每个供应商完全独立

驳回。它会复制去重、重试、权限、HITL、任务提取和证据审计，并使跨平台任务无法形成统一因果链。

### 只在 Workboard 汇合

不足。它能统一任务状态，却不能统一证据定位、决定、人员、项目、产物和长期知识。

## 影响

- 当前 Evidence、Workboard 和图谱边界保持不变。
- 飞书专有实现可以逐步下沉到适配器，不要求一次性重构。
- 编程 Agent 接入不再依赖复制 Codex JSONL 格式。
- 企业协作平台共享语义和可靠基础设施，但保留各自权限、卡片、文档和线程差异。
- 检索规划器必须先选择领域，再按需展开一级证据。

## 数据迁移

本决定不迁移现有数据。后续增加规范投影字段或索引时，必须从现有 `source/evidence/thread/conversation_binding` 可重建，并保留原 Evidence ID 和 locator。

## 回退方案

规范投影是可重建派生层。若第二供应商验证失败，可以删除或停用投影，不影响现有 Codex/飞书采集、Workboard、图谱和出站链路。

## 验证

- 契约测试确认领域设计、ADR、架构和当前 Codex/飞书实现入口一致。
- 第二供应商接入必须覆盖事件重复、断线恢复、历史补采、身份、线程、权限和回源。
- 跨来源场景必须证明飞书指派、Workboard 任务、Codex 执行和回复证据可以关联，但原始正文没有互相复制。
