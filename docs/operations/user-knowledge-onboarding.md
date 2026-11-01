# 用户知识与冷启动

## 数据位置

- 通用事实、来源、冲突仍在现有数据库。`user_profile_binding` 只绑定本人实体，不保存姓名/职责副本。
- `runtime/private-profile/USER.md` 是默认数据库位置下的私有输出。实际路径为数据库同目录的 `private-profile/USER.md`。
- `.USER.generated.md` 是编辑比较基线，不是另一份可维护资料。删除后可重建。两个文件均不入 Git，也不自动采集为知识。
- `shadow_context_focus` 与 USER.md 使用相同生成器。模型的 `before_prompt_build.prependContext` 提供当前有界投影；静态系统策略仍然通用，原生 thread bootstrap 指纹不变。

## 新用户

先通过主对话询问称呼、岗位、团队、负责/不负责的范围和首个目标。信息可来自用户提供的文件；不能由助手把猜测填成已确认。软件和资料来源由用户选择，例如指定目录、Codex 记忆、某办公软件会话；可稍后补充，不能默认全盘调查。

将回答整理到私有 `config/user-basics.local.json`，格式参照 `config/user-basics.example.json`，替换示例并删除 `exampleOnly`。不存在独立 onboarding 业务库。

```powershell
node scripts/user-profile.mjs preview --file config/user-basics.local.json
node scripts/user-profile.mjs confirm --file config/user-basics.local.json --confirm <预览输出的完整确认哈希>
node scripts/user-profile.mjs status
node scripts/user-profile.mjs sync
```

预览不打开或写入数据库。用户确认必须覆盖基本资料及初始化任务计划；助手不得替用户默许。确认命令原子保存 Evidence、图谱与已有 direct-input outbox。`taskRequest.status=queued` 只表示受理，主控处理后才有真实卡片，不得报告“已建卡”。模型离线时保留原请求恢复，不丢任务、不反复重复创建。

同一确认重放返回原回执和当前投影，不重新写入旧资料；后续事实纠正使用知识维护入口。`user-basics.local.json` 是待导入输入，不是长期配置主数据；修改文件本身不会改变用户知识。

初始化计划复用现有 Workboard 总卡/关联卡：

- 用户任务：补充缺少的职责与同事协作关系；确认软件/目录；在官方或本机安全入口登录。卡片不存密码、Token、Cookie。
- Agent 任务：先验收对应来源只读能力，再有界调查文件、编程记忆、办公会话。只保存有价值的知识/检索入口，发现差量交现有知识维护会话。
- 用户首个目标也进入同一任务链路；用户补充信息、Agent 调查和后续知识修订均不会直接重写 USER.md。

目前交互入口复用主对话和本机 CLI，没有额外的首次启动弹窗。用户可在主对话回答，Codex 整理预览后由用户确认。资料不全时明确交办仍然可用；外部会话的推测性建卡会提示补充基础资料。

## 既有用户

```powershell
node scripts/user-profile.mjs migrate
node scripts/migrate-user-profile.mjs
```

第一条只查看本人候选与旧简况条数。第二条建立一致 SQLite 备份，在副本迁移并核对原 Fact 全行指纹、Evidence 数量和 `quick_check`，删除演练副本而保留备份与私有报告。不会写正式库。

确认回滚备份可用、相关后台无在途任务且停稳后，执行 `node scripts/user-profile.mjs migrate --apply`，再 `sync`。也可使用 `migrate-user-profile.mjs --apply` 一次完成备份、演练和正式迁移。多本人标记时停止，不按姓名猜测；`--owner` 仅用于明确实体 ID。旧表内容作为历史助手摘要 Evidence 进入待复核队列后删除旧表；不复制当前 Fact，不重新导入整个组织资料。

已有资料缺少排除项或当前目标时，只报告缺项。不要通过读取旧简况就把它升级为可信职责，不把退休待办重新建立为当前任务。缺项可以在主对话补充，复用现有知识维护工具，选择对应 Fact 的展示类别即可。

## 更新与恢复

人工知识、任务反馈、文件输入仍走原有知识工具。维护会话处理新增/冲突/修订后，下一轮投影立即读到数据库新事实；无需单独更新 USER.md。未知谓词可用 `shadow_context_focus_update({entries:[{factId,section}]})` 选择展示类别，但该工具既不能改事实正文，也不能让未证实或争议事实变可信。

文件手改先保存完整修改和原生成基线为待复核 Evidence，再恢复当前事实视图；可由反馈 Evidence ID 找回，不能把待审修改误认为已生效。后台每 30 秒尝试刷新文件，写失败会记录警告，图谱不回滚。模型每轮从库读而非磁盘旧文件；无数据库时不退回过期 USER.md。

模型看到最多 16 条短事实及当前缺项/冲突提示；完整 focus 查询最多 512 条本人相邻事实，超限显式标记，不扫描几百万条原始 Evidence。此版本只自动发现本人直接关系；跨多跳关系继续由模型按任务检索，不把整个同事网络注入每一轮。
