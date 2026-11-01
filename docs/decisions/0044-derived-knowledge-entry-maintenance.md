# ADR-0044 派生知识入口的增量维护与历史修复

日期：2026-10-23。范围：仓库与本地项目文档入口；不改变事实可信度、任务生命周期和来源采集频率。

## 决定

1. Repository 保留原实体身份。当前 checkout 快照与有效历史摘要分别选取，组合为有界导航表示。历史线索不是当前 HEAD 已实现的证明；快照仍是采集时的观察。
2. 高优先级人工/模型简介保留。机器派生表示保存在 `metadata.knowledgeEntry`，两个实体写入入口共用 `entrySearchSummary`，使修改简介不会删除检索线索。不再让最后一个同优先级快照决定全部摘要。
3. DocumentSet 仅为项目文档目录，保留当前目录摘要代的全部块引用。目录现行 `summarizes` 所选文件各有一个 Document 入口；不是把历史文件扫描里的所有 JSON、日志、数据集都提升为知识实体。未选资料仍可从 Evidence/文件查找。
4. 本地 Document 身份使用来源 ID 与完整路径，内容版本不参与身份。来源 ID 隔离采集来源；未来跨主机接入必须提供各自来源 ID，不能复用本机来源伪称已支持跨主机。相同标题不能合并文件；同版本块归并，当前 `retrieval_source` 指向完整有效版本的原 Evidence，不复制整份正文。
5. 入口摘要有界，完整来源数量和精确块链接保留；摘要没有提到某内容不代表原件没有。每次只重建本批涉及的仓库/文档项目；查询使用相关来源索引，不遍历全部会话/工具日志。
6. 已建立的文档入口在后续项目更新中继续维护，不因目录候选预算暂时没选到它而失联。首次历史修复只提升已被有效目录选择的资料，不扩大采集范围。

## 实现与修复边界

- `knowledge-entries.mjs` 统一选择当前来源、版本/分块及派生表示。
- `materializeContextGraph` 和显式 `refreshKnowledgeEntries` 使用同一路径。普通 raw 文档不另产生一批重复语义整理唤醒；仍由项目目录摘要触发原有知识链路。
- `repair-knowledge-entries.mjs` 默认只读。正式应用要求指定新的完整 SQLite 备份路径，校验备份后事务执行，再校验入口、来源引用和非结构性事实摘要指纹。失败回滚；需要整体回退时停止所有写进程，恢复修复前备份。
- 不改原 Evidence、原 Evidence 关系、复核结果、任务和待消费事件；允许增补 Document 实体及其结构性项目归属，不将其提升成业务事实。
- 不自动启动后台，不切模型，不重新下载或训练向量模型。向量/混合检索四组对照、原文读取工具扩展及实时来源删除处理不是本次完成声明。

## 验证

维护代码先独立验证：snapshot/history 两种到达顺序、旧快照迟到、简介更新后 FTS 保留、同名异路径/来源、同文件多版本多块、目录多块、未选日志不提升、机械 digest 真实生成、重放和重启。随后在真实库副本应用同一修复函数，验证覆盖与引用，再追加来源变化证明维护持续有效。副本或人工修好的数据不能代替维护代码测试。

结果与正式库状态记在 验证报告。

## 操作入口

先停止数据库写进程，使用项目Node运行时。只读检查默认不修复；旧库缺新索引时先给出范围清单，精确差异在备份后的事务内检查，避免只读审计反复全扫旧库。

```powershell
node scripts/repair-knowledge-entries.mjs --database runtime/shadow-agent.sqlite --report runtime/entry-dry-run.json
node scripts/repair-knowledge-entries.mjs --database runtime/shadow-agent.sqlite --apply --backup E:/Backups/shadow-entry-before.sqlite --report runtime/entry-repair.json
```

备份路径必须不存在。全备份执行完整`quick_check`；修复后的graph及FTS表在事务内逐表校验，不重复检查未改动的海量执行历史。该命令不启动服务、不部署插件。若正式OpenClaw仍是旧安装副本，后续部署须使用现有安装脚本同步共享模块，不能把数据库修复等同于后台已升级。
