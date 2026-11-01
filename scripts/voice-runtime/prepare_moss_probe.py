"""Freeze existing comparison audio without putting reference answers in model inputs."""
import argparse
import json
from pathlib import Path
import wave

from runtime_common import sha256


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--extra", action="append", type=Path, default=[])
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("Input manifest already exists")
    reference = json.loads(args.reference.read_text(encoding="utf-8-sig"))
    inputs = [{"id": row["recordingId"], "group": row["group"], "audio": row["audioPath"]}
              for row in reference["rows"]]
    inputs += [{"id": "extra-%02d" % n, "group": "engineering", "audio": str(p.resolve())}
               for n, p in enumerate(args.extra)]
    for item in inputs:
        item["sha256"] = sha256(item["audio"])
        with wave.open(item["audio"], "rb") as audio:
            item.update(seconds=audio.getnframes() / audio.getframerate(), sampleRate=audio.getframerate(),
                        channels=audio.getnchannels())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"referenceFileSha256": sha256(args.reference), "inputs": inputs},
                                     indent=2), encoding="utf-8")
    print(json.dumps({"inputs": len(inputs), "seconds": sum(i["seconds"] for i in inputs),
                      "manifestSha256": sha256(args.output)}))


if __name__ == "__main__":
    main()
