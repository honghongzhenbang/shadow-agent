"""Fetch pinned public MOSS artifacts; no audio upload or environment mutation."""
import argparse
import hashlib
import json
from pathlib import Path

import requests

from download_artifact import download
from runtime_common import sha256

REPO = "OpenMOSS-Team/MOSS-Transcribe-Diarize"
REVISION = "704aa4a9c304e8520be88901e0d1960158ef5b15"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    response = requests.get(f"https://huggingface.co/api/models/{REPO}/revision/{REVISION}?blobs=true", timeout=60)
    response.raise_for_status()
    info = response.json()
    if info["sha"] != REVISION:
        raise ValueError("Model revision mismatch")
    args.destination.mkdir(parents=True, exist_ok=True)
    manifest = {"repository": REPO, "revision": REVISION, "files": []}
    selected = [f for f in info["siblings"] if "/" not in f["rfilename"]
                and Path(f["rfilename"]).suffix in {".json", ".py", ".jinja", ".txt", ".safetensors"}]
    # Review source and metadata while large, hash-verified weights download last.
    for entry in sorted(selected, key=lambda e: e["size"]):
        name = entry["rfilename"]
        target = args.destination / name
        url = f"https://huggingface.co/{REPO}/resolve/{REVISION}/{name}"
        if "lfs" in entry:
            download(url, target, entry["size"], entry["lfs"]["sha256"])
        else:
            if not target.exists():
                result = requests.get(url, timeout=60)
                result.raise_for_status()
                data = result.content
            else:
                data = target.read_bytes()
            blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
            if len(data) != entry["size"] or blob != entry["blobId"]:
                raise ValueError("Git blob integrity mismatch: " + name)
            if not target.exists():
                target.write_bytes(data)
        manifest["files"].append({"name": name, "size": entry["size"],
                                  "sha256": sha256(target)})
        (args.destination / "verified-files.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        print("Verified " + name, flush=True)


if __name__ == "__main__":
    main()
