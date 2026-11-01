# 源码组件导航

| 目录 | 内容 |
|---|---|
| `src/` | 证据、知识图谱、变化队列、任务协同、来源采集、语音导入与身份修订 |
| `desktop/` | Windows Electron 主界面、任务卡、设置、录音与人员声纹管理 |
| `openclaw/` | 主控工具/上下文插件、策略插件、通用工作区模板和 Skill |
| `mobile/android/` | Android 录音、近场判断、加密传输、断线恢复、录音列表与测试 |
| `companion/voice-bridge/` | Windows .NET 接收器、配对、HTTPS/RFCOMM、上传校验与测试 |
| `scripts/voice-runtime/` | 电脑录音、VAD、声纹、MOSS/Fun/SenseVoice 运行与资源下载校验 |
| `scripts/` | 初始化、启动、安装、诊断、迁移及受控 OpenClaw 补丁 |
| `config/` | 通用配置和用户基本资料示例 |
| `knowledge/ontology/` | 通用知识类型与关系定义 |
| `test/` | Node、Python 与桌面交互测试 |

入口：[安装](getting-started.md)、[个人初始化](operations/user-knowledge-onboarding.md)、[语音与手机](voice-guide.md)、[能力扩展](operations/capability-growth.md)。

主项目与录音伴随端原本独立开发；此源码树组合主项目 4.27.0 与 Android/Bridge 0.2.3 线路。以各组件实际配置和协议为准，不把未采用实验当作默认能力。Android 返回电脑附近停录不保证电脑已接管麦克风；当前没有 iOS 客户端。
