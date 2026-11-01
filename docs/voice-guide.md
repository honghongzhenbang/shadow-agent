# 语音模型与两端配置

语音是可选功能。先让主对话与任务卡正常运行，再按需求接入电脑麦克风、Android 手机或已有录音。

## 选择识别方式

| `voice.asrProvider` | 运行方式 | 说话人 | 输入窗口 |
|---|---|---|---|
| `moss-local` | 独立 Python + CUDA/BF16，SDPA | 模型输出局部说话人，跨窗再匹配声纹 | 默认 60 秒，可配 5~120 秒 |
| `fun-asr-nano` | 独立 Python 3.11 + CUDA | 由前处理与声纹链路提供候选 | 不超过 35 秒 |
| `sensevoice-local` | Windows CPU | VAD 分组与声纹候选，不等同专业说话人分离 | 不超过 35 秒 |
| `auto-local` | 优先已配置 Fun，不能运行时按策略转 SenseVoice | 同上 | 不超过 35 秒 |

`auto-local` 不会自动选择 MOSS。MOSS 失败不隐式切换模型。API 目前是扩展接口，不是填一个 URL 就兼容所有厂商的现成配置项。

手机按 120 秒保存物理分片，不等于 ASR 必须吃 120 秒。电脑校验连续包后有界组装、VAD 检测并按所选模型切窗；时间保留为原录制时间。强制边界的重叠和不确定内容保留来源，不把半句当作两次发言。

## CPU 基础环境

VAD、声纹和 SenseVoice 使用 Windows x64 CPython **3.9.12** 的锁定环境。选择自己电脑的解释器，设置环境变量后执行：

```powershell
$env:SHADOW_VOICE_PYTHON = 'C:/Python3912/python.exe'
& $env:SHADOW_VOICE_PYTHON -I -B scripts/voice-runtime/setup.py --with-capture
```

它将依赖和模型安装到项目 `runtime/voice`；`--with-capture` 安装麦克风依赖，但不会开始录音。`requirements.txt`、`requirements-capture.txt` 与 `assets.lock.json` 记录版本、哈希和来源。

在 `config/agent.local.json` 中合并 `voice`，不要覆盖其他配置。先用 CPU 线路确认流程：

```json
{
  "voice": {
    "python": "C:/Python3912/python.exe",
    "assetsRoot": "runtime/voice",
    "runtimeRoot": "runtime/voice",
    "asrProvider": "sensevoice-local",
    "asrTimeBudgetFactor": 2,
    "maxGainDb": 12,
    "intake": {"enabled": false, "sources": []}
  }
}
```

路径应换成实际路径。模型下载与运行是不同阶段；声卡、CUDA 驱动、系统内存和显存需要在目标电脑检查。不能只按参数量或显卡标称容量判断能否使用。

## Fun-ASR-Nano

另备 Python 3.11，使用新目录：

```powershell
./scripts/voice-runtime/setup-fun.ps1 -Python311 C:/Python311/python.exe -RuntimeRoot runtime/voice-fun -DownloadModel
```

在 `voice` 中设置：

```json
{
  "asrProvider": "auto-local",
  "funPython": "runtime/voice-fun/venv/Scripts/python.exe",
  "funModelDir": "runtime/voice-fun/model",
  "funWeightSha256": "1bbb6dcc5d8b75084a399d48c4d4b0f3aa1d3f09f2616ae40ed2c4fba03d89c9",
  "fallback": "sensevoice-local"
}
```

需要确认 GPU 确实运行时，用 `fun-asr-nano` 和 `fallback: "none"`，查看实际 engine 与错误，不把后备运行当 GPU 验证。安装脚本锁定依赖和模型 revision；不要随意替换版本。

## MOSS

MOSS 模型下载器在 `scripts/voice-runtime/setup_moss.py`；它只获取固定版本并写 `verified-files.json`，**不创建 Python 环境**。推理还需要官方 Python 代码与 CUDA 环境。

1. 建立独立 Python 3.11 环境，安装匹配驱动的 PyTorch/CUDA、Transformers、accelerate、soundfile、psutil、requests 等依赖。
2. 获取 [官方推理代码](https://github.com/OpenMOSS/MOSS-Transcribe-Diarize)，当前对照版本为 `79c675f0670cc2f824bcbcdd98263704f40f1f7e`。按该版本 `pyproject.toml` 配置依赖，不要求安装 Flash Attention。
3. 使用该环境运行 `python scripts/voice-runtime/setup_moss.py runtime/voice-moss/model`。模型固定为 `704aa4a9c304e8520be88901e0d1960158ef5b15`。
4. 在 `voice` 中补充以下配置，CPU 基础环境仍保留用于 VAD 和声纹。

```json
{
  "asrProvider": "moss-local",
  "mossPython": "runtime/voice-moss/venv/Scripts/python.exe",
  "mossModelDir": "runtime/voice-moss/model",
  "mossUpstream": "runtime/voice-moss/upstream",
  "mossMaxSeconds": 60,
  "asrTimeBudgetFactor": 2
}
```

当前 worker 使用 SDPA/BF16 全 GPU。`trust_remote_code` 会执行取得的模型代码，使用前应核对来源与版本。超过时间预算、输出上限或格式不完整会保留部分输出，不当作完整转写。该环境尚无完整的一键安装脚本，建议把配置与实测作为 Agent 的独立任务。

## 电脑录音

```powershell
./scripts/start-pc-voice.ps1 -Listen -Seconds 30
# 持续录音：显式启动，Ctrl+C 停止
./scripts/start-pc-voice.ps1 -Listen -UntilStopped
```

采集进程只保存片段，不同时运行第二套识别/导入。将实际输出目录加入 `voice.intake.sources`，开启 `intake.enabled`，由 `npm run serve` 中的队列处理。`since` 使用开始接收时刻，带时区，例如 `2026-11-01T09:00:00+08:00`。

```json
{"intake":{"enabled":true,"sources":[
  {"path":"runtime/voice/live","since":"2026-11-01T09:00:00+08:00"},
  {"path":"runtime/voice/mobile-inbox","since":"2026-11-01T09:00:00+08:00"}
]}}
```

## Android 与 Windows 接收桥

Android 工程位于 `mobile/android`；Windows .NET 工程位于 `companion/voice-bridge`。Android 10 起可安装，当前源版本为 0.2.3。手机不运行 ASR，也不保存知识库。

构建依赖：JDK 17、Gradle 8.13、Android SDK 36 / build-tools 35.0.0，Windows 桥使用 .NET 8 SDK。设置 `JAVA_HOME`、`ANDROID_HOME`，在 Android 工程用自己安装的 Gradle：

```powershell
gradle -p mobile/android --no-daemon testDebugUnitTest assembleDebug
dotnet build companion/voice-bridge/VoiceBridge.csproj -c Release --disable-build-servers
```

调试 APK 在 `mobile/android/app/build/outputs/apk/debug/`。自己的发布签名通过 `VOICE_KEYSTORE`、`VOICE_KEY_PASSWORD` 和别名 `shadow-voice` 提供；后续升级应保留同一签名。不要用 debug 包覆盖另一签名的安装。

在电脑上显式生成自己的配对，再启动仅接收模式：

```powershell
./scripts/start-voice-bridge.ps1 -Setup -RuntimeRoot runtime/voice
./scripts/start-voice-bridge.ps1 -Serve -NoTranscribe -RetainAudio -RuntimeRoot runtime/voice
```

把生成的 `runtime/voice/bridge/pairing.json` 私下导入手机，在手机前台授予麦克风、附近设备及通知权限，明确开启采集。配对文件含连接凭据，不应分享给其他人。BLE 用于近场判断和发现；音频走经过认证的 HTTPS 或 RFCOMM/TLS。桥可能监听局域网，请按需要配置私人网络防火墙，不开放公网。

本指南使用接收桥 `-NoTranscribe`，再由主项目 intake 统一识别，避免桥旧转写器和 Agent 同时消费。手机“已传输”不等于主项目已经识别、整理知识或完成任务。本版本手机返回电脑附近会停录，但不核对电脑麦克风已经接管；需要连续录音时分别检查两端状态。

## 标注与声纹

托盘打开“声音与人物”，试听整段或单条文字，修订文本和人物。可以只标注部分发言，不必给所有人命名。

- 只确认人物：修改当前录音对应声音组，不自动训练声纹。
- 勾选“同时保存为声纹样本”：登记可用于后续匹配的样本，适合清晰的单人声音。
- 多个样本选择同一人物：积累同一人的声音变化；自动匹配只是候选，不等于批量人工确认。
- “人员与声纹”：试听、移除样本；标错可撤销或改选。
- 混合说话未正确分离时：暂留未知，不把整段强行登记给其中一个人。当前界面不支持段内手工重新切分。

语音纠正保存为可追溯信息，后台在线时进入知识维护与相关任务链路。采集、识别、人工确认和 Agent 处理是不同状态，可分别查看。

## 外部 API 与许可

外部 API 可通过现有转写适配或 `{schemaVersion:1,audioSha256,result}` 结果导入接入，仍须校验录制时间、来源与音频指纹。可把接入某一服务交给 Agent 实施和测试；先确认上传范围、账号、预算与数据政策。

项目代码为 MIT；模型、推理框架与第三方资产各自授权。固定资源来源与许可见 `scripts/voice-runtime/assets.lock.json`，其他说明见 [第三方声明](../THIRD_PARTY_NOTICES.md)。
