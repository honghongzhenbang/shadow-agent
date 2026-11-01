# 运行依赖与发布边界

## 哪些由本项目提供

- `src/`：证据、知识、来源、变化路由和任务协同代码。
- `desktop/`：桌面、任务交互和声音/人物标注。
- `openclaw/shadow-work/` 与 `openclaw/shadow-policy/`：业务工具、上下文和策略插件。
- `openclaw/workspace-template/`：通用规则和工作技能，不是开发者私人资料。
- `scripts/`：安装、验证、维护与受控补丁。

模型、OpenClaw 原生工具/会话/Workboard、Codex 执行器及第三方语音模型不是本项目原创实现。

## OpenClaw 不只是配置依赖

当前安装版为 `2026.8.1`。除了配置和插件，本项目包含修改已安装 JavaScript 的受控脚本：

| 脚本 | 范围 |
|---|---|
| `apply-shadow-policy-boundary.mjs` | 检查 Shadow 策略实际应用到模型提示边界 |
| `apply-codex-session-read-boundary.mjs` | Codex 历史读取分页、大小限制及遗漏提示 |
| `apply-codex-route-context.mjs` | 工具路由上下文相关补丁；以调用方和版本检查为准 |
| `apply-run-wait-presence.mjs` | 原生运行等待/存在性处理 |
| `apply-codex-shell-alias.mjs` | Codex shell 工具别名处理 |

`run-openclaw-poc.ps1` 在启动路径调用策略、历史读取、等待存在性和 shell 别名四项；route-context 是独立的离线安装入口，并未由该启动脚本自动调用。版本或源码形状变化会拒绝应用；不要擅自去掉校验。补丁脚本不是独立完整的上游发行版，也不是“完全没有改过上游”。

## 公开包的选择

优先分发自己的源码、配置模板、补丁与安装文档，由用户取得明确版本的上游依赖。不分发开发机 `tools/`、`node_modules/`、`runtime/`、登录库和完整私有 Git。

如果将来提供附带上游运行时的二进制/便携包，要另行清点实际附带的代码、依赖与许可。不能把一份 MIT 文件当作全部依赖均已审核的证明。

## 版权与许可

本机 OpenClaw `2026.8.1` 包声明 MIT，并附 `Copyright (c) 2026 OpenClaw Foundation`。其许可要求保留版权和许可声明；MIT 本身没有要求下游自有代码必须采用 MIT。

本候选保留上游声明，见 [OpenClaw 许可](../third_party/openclaw/LICENSE)。Shadow Agent 自有部分已由作者选择 MIT，见根目录 [LICENSE](../LICENSE)。这不代表语音权重、其他模型、数据集或插件均使用 MIT。第三方材料分别核对；没有随包重新分发模型权重。相关参考：

- [MIT 许可说明](https://choosealicense.com/licenses/mit/)
- [GitHub 仓库许可说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)

## 不附带什么

公开源码不能包含私人知识库、真实人员档案、同事关系、内部项目资料、原始录音/声纹、真实评测输入、凭据或本机日志。新公开仓库不携带原私有历史；原始历史在本机保留，不篡改或伪造旧日期。
