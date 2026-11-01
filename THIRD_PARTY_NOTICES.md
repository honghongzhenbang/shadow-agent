# Third-party notices

Shadow Agent's original code is licensed under the root MIT LICENSE. Dependencies,
model weights, and incorporated assets retain their own licenses.

## OpenClaw

The integration targets OpenClaw 2026.8.1, including its native Codex plugin.
Managed patch scripts modify selected installed JavaScript modules; the complete
upstream runtime is obtained separately. Preserve the upstream notices when
redistributing its code or substantial portions.

- Upstream: https://github.com/openclaw/openclaw
- License: MIT, Copyright (c) 2026 OpenClaw Foundation
- Local notice: [OpenClaw LICENSE](third_party/openclaw/LICENSE)
- Incorporated upstream notices: [Pi and other notices](third_party/openclaw/THIRD_PARTY_NOTICES.md)

## Android microphone icon

`mobile/android/app/src/main/res/drawable/ic_mic.xml` uses the Google Material
Icons microphone vector, represented as an Android drawable.

- Upstream: https://github.com/google/material-design-icons
- Copyright: Google LLC
- License: Apache-2.0; [license text](third_party/material-icons/LICENSE)
- Representation: Android vector XML with a white path fill.

The robot images are generated from this project's canvas drawing, not from a
third-party character pack.

## Optional speech models and runtimes

Models and downloaded inference code are separate dependencies. Check the exact
revision's terms before installing or redistributing them.

| Component | Source / license reference |
|---|---|
| MOSS-Transcribe-Diarize | [OpenMOSS](https://github.com/OpenMOSS/MOSS-Transcribe-Diarize), [model card](https://huggingface.co/OpenMOSS-Team/MOSS-Transcribe-Diarize); Apache-2.0 |
| Fun-ASR-Nano-2512-hf | [model card](https://huggingface.co/FunAudioLLM/Fun-ASR-Nano-2512-hf); Apache-2.0 |
| SenseVoice ONNX | Exact model license and conversion provenance in `scripts/voice-runtime/assets.lock.json`; do not infer MIT from the surrounding code |
| Silero VAD / CAM++ | Exact sources, checksums and notices in `scripts/voice-runtime/assets.lock.json` |
| PyTorch / Transformers / sherpa-onnx | Installed separately; retain their package licenses and transitive notices |

The root `package-lock.json` records Node dependency versions and license metadata.
Installed packages supply their own license files. This inventory is not a license
grant for external accounts, datasets, recordings, voices, or provider services.
