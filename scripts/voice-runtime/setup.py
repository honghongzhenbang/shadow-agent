"""Install hash-locked Windows CPU wheels/models only in this worktree's runtime/voice."""

import argparse
from datetime import datetime, timezone
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time
import urllib.request

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from runtime_common import (PACKAGES, PYTHON, RUNTIME, audio_manifest, bootstrap,
                            contained, emit_error, sha256, sidecar, write_json)

HERE = Path(__file__).resolve().parent


def installed_versions():
    return {d.metadata["Name"].lower().replace("_", "-"): d.version
            for d in importlib.metadata.distributions(path=[str(PACKAGES)])}


def expected_versions(requirements):
    versions = {}
    for line in requirements.read_text(encoding="utf-8").splitlines():
        if line.startswith("-r "):
            versions.update(expected_versions(HERE / line[3:]))
        elif line and not line.startswith("#"):
            name, version = line.split()[0].split("==")
            versions[name] = version
    return versions


def install_packages(with_capture, skip):
    requirements = HERE / ("requirements-capture.txt" if with_capture else "requirements.txt")
    expected = expected_versions(requirements)
    installed = installed_versions()
    missing = {name: version for name, version in expected.items()
               if installed.get(name) != version}
    if missing:
        if skip:
            raise RuntimeError("Missing/wrong local package versions: " + repr(missing))
        temp = contained(RUNTIME, "tmp")
        temp.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ, TMP=str(temp), TEMP=str(temp), PYTHONDONTWRITEBYTECODE="1")
        subprocess.run([str(PYTHON), "-I", "-m", "pip", "--isolated", "install",
                        "--target", str(PACKAGES), "--upgrade", "--ignore-installed",
                        "--no-deps", "--require-hashes", "--only-binary=:all:",
                        "--no-compile", "--no-cache-dir", "--disable-pip-version-check",
                        "--index-url", "https://pypi.org/simple", "-r", str(requirements)],
                       check=True, env=env, stdout=sys.stderr)
    installed = installed_versions()
    if any(installed.get(k) != v for k, v in expected.items()):
        raise RuntimeError("Local wheel installation did not match requirements")
    return installed


def download(asset):
    path = contained(RUNTIME, asset["path"])
    if path.is_file() and path.stat().st_size == asset["bytes"] and sha256(path) == asset["sha256"]:
        return path
    if not asset["url"].startswith("https://"):
        raise ValueError("Only pinned HTTPS download sources are allowed")
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + ".part")
    for attempt in range(3):
        try:
            print("Downloading " + asset["path"], file=sys.stderr)
            request = urllib.request.Request(asset["url"], headers={"User-Agent": "voice-runtime-setup/1"})
            with urllib.request.urlopen(request, timeout=60) as response, part.open("wb") as out:
                total = 0
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > asset["bytes"]:
                        raise ValueError("Download exceeds pinned size: " + asset["path"])
                    out.write(chunk)
            if part.stat().st_size != asset["bytes"] or sha256(part) != asset["sha256"]:
                raise ValueError("SHA-256/size mismatch: " + asset["path"])
            os.replace(str(part), str(path))
            return path
        except Exception:
            if part.exists():
                part.unlink()
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--with-capture", action="store_true", help="Install sounddevice; does not open a device")
    parser.add_argument("--fixtures", action="store_true", help="Fetch public test-only AISHELL fixtures")
    parser.add_argument("--skip-packages", action="store_true", help="Verify installed local wheels without pip")
    args = parser.parse_args(argv)
    try:
        if Path(sys.executable).resolve() != PYTHON.resolve() or sys.version_info[:3] != (3, 9, 12):
            raise RuntimeError("Run with the configured isolated CPython 3.9.12 interpreter")
        if sys.platform != "win32" or platform.architecture()[0] != "64bit":
            raise RuntimeError("The wheel lock is for Windows x64 only")
        RUNTIME.mkdir(parents=True, exist_ok=True)
        versions = install_packages(args.with_capture, args.skip_packages)
        bootstrap()
        import sherpa_onnx as sherpa
        import soundfile as sf

        lock = json.loads((HERE / "assets.lock.json").read_text(encoding="utf-8"))
        files, fixtures = {}, []
        for asset in lock["assets"]:
            if asset["path"].startswith("fixtures/") and not args.fixtures:
                continue
            path = download(asset)
            if "role" in asset:
                files[asset["role"]] = dict(asset, path=asset["path"][len("models/"):])
            if asset.get("testOnly") and path.suffix == ".wav":
                info = sf.info(str(path))
                write_json(sidecar(path), audio_manifest(
                    path, started_at=None, sample_rate=info.samplerate,
                    sample_count=info.frames, channels=info.channels,
                    source_type="public-dataset", test_only=True, details=asset))
                fixtures.append(asset)
        extractor = sherpa.SpeakerEmbeddingExtractor(sherpa.SpeakerEmbeddingExtractorConfig(
            model=str(RUNTIME / "models" / files["embedding"]["path"]), provider="cpu"))
        if extractor.dim != files["embedding"]["dimension"]:
            raise RuntimeError("Embedding dimension disagrees with pinned model")
        manifest = {"schemaVersion": 1, "provider": "cpu", "engineVersion": sherpa.__version__,
                    "onnxruntimeVersion": sherpa.onnxruntime_version, "files": files,
                    "diarizationMode": "vad-cluster",
                    "fullSpeakerDiarization": False, "notDeployed": lock["notDeployed"],
                    "assetLockSha256": sha256(HERE / "assets.lock.json")}
        write_json(RUNTIME / "models" / "manifest.json", manifest)
        if args.fixtures:
            write_json(RUNTIME / "fixtures" / "sources.json", {"schemaVersion": 1, "testOnly": True, "fixtures": fixtures})
        deployment = {"schemaVersion": 1, "installedAtUtc": datetime.now(timezone.utc).isoformat(),
                      "python": sys.executable, "pythonVersion": platform.python_version(),
                      "platform": platform.platform(), "packageDirectory": str(PACKAGES),
                      "packages": versions, "provider": "cpu", "captureOpened": False,
                      "libsndfileVersion": sf.__libsndfile_version__,
                      "supportedExtensions": [".wav", ".flac", ".mp3", ".ogg", ".opus"],
                      "modelDirectory": str(RUNTIME / "models"), "fixtures": len(fixtures),
                      "requirementsSha256": sha256(HERE / "requirements.txt"),
                      "captureRequirementsSha256": sha256(HERE / "requirements-capture.txt") if args.with_capture else None,
                      "assetLockSha256": manifest["assetLockSha256"]}
        write_json(RUNTIME / "deployment.json", deployment)
        print(json.dumps(deployment, ensure_ascii=False))
        return 0
    except Exception as exc:
        emit_error(exc)
        return 1


if __name__ == "__main__":
    sys.exit(main())
