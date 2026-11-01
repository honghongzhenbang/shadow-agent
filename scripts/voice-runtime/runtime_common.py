"""Shared local-only paths, integrity checks, and portable audio manifests."""

import hashlib
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / "runtime" / "voice"
ASSETS = Path(os.environ.get("SHADOW_VOICE_ASSETS_ROOT", str(RUNTIME))).resolve()
PACKAGES = ASSETS / "python-packages"
PYTHON = Path(os.environ.get("SHADOW_VOICE_PYTHON", sys.executable))


def bootstrap():
    if Path(sys.executable).resolve() != PYTHON.resolve():
        raise RuntimeError("Use the explicitly configured SHADOW_VOICE_PYTHON interpreter")
    if sys.version_info[:3] != (3, 9, 12):
        raise RuntimeError("This runtime is locked to CPython 3.9.12 Windows x64")
    sys.dont_write_bytecode = True
    # Do not inherit Anaconda's numpy/scipy or user site packages.
    sys.path[:] = [p for p in sys.path if p and
                   "site-packages" not in p.lower() and
                   "dist-packages" not in p.lower()]
    sys.path.insert(0, str(PACKAGES))
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    if not PACKAGES.is_dir():
        raise RuntimeError("Missing local packages. Run scripts/voice-runtime/setup.py")


def deny_network():
    def audit(event, args):
        if event.startswith("socket.") or event == "urllib.Request":
            raise RuntimeError("Network is disabled during voice inference/capture")
    sys.addaudithook(audit)


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def contained(root, relative):
    root = Path(root).resolve()
    path = (root / relative).resolve()
    if path == root or root not in path.parents:
        raise ValueError("Path escapes the permitted directory: " + str(relative))
    return path


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2,
                                    allow_nan=False) + "\n", encoding="utf-8")
    os.replace(str(temporary), str(path))


def audio_manifest(path, *, started_at, sample_rate, sample_count, channels,
                   source_type, test_only, details=None):
    return {
        "schemaVersion": 1,
        "kind": "voice-audio-file",
        "audioFile": Path(path).name,
        "sha256": sha256(path),
        "startedAtUtc": started_at,
        "sampleRateHz": int(sample_rate),
        "sampleCount": int(sample_count),
        "channels": int(channels),
        "sampleCountUnit": "frames-per-channel",
        "durationMs": round(sample_count * 1000 / sample_rate),
        "sourceType": source_type,
        "testOnly": bool(test_only),
        "details": details or {},
    }


def sidecar(path):
    return Path(str(path) + ".manifest.json")


def read_audio_manifest(path, info):
    manifest_path = sidecar(path)
    if not manifest_path.exists():
        return None
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    kind = manifest.get("kind")
    if kind not in {"voice-audio-file", "voice-recording-package-part"}:
        raise ValueError("Audio manifest mismatch: kind")
    expected = {"schemaVersion": 1,
                "audioFile": Path(path).name, "sha256": sha256(path),
                "sampleRateHz": info.samplerate, "sampleCount": info.frames,
                "channels": info.channels,
                "sampleCountUnit": "frames-per-channel"}
    for key, value in expected.items():
        if manifest.get(key) != value:
            raise ValueError("Audio manifest mismatch: " + key)
    return manifest


def emit_error(exc):
    print(json.dumps({"schemaVersion": 1, "error": {
        "code": "VOICE_RUNTIME_ERROR", "message": str(exc)}},
        ensure_ascii=False), file=sys.stderr)
