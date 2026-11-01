"""Serial, offline history worker; retain one ASR runtime across recordings."""
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from asr import arguments, AsrRuntime, run
from runtime_common import sha256, write_json


def main():
    args = arguments()
    runtime = None
    try:
        runtime = AsrRuntime(args)
        for line in sys.stdin:
            item = json.loads(line)
            if item.get("stop"):
                break
            try:
                args.audio = Path(item["audioPath"])
                args.output_file = Path(item["outputPath"])
                if sha256(args.audio) != item["audioSha256"]:
                    raise ValueError("Archived audio checksum changed")
                if args.output_file.exists():
                    raise ValueError("Result already exists; resume from the persisted receipt")
                runtime.provider.attempts.clear()
                result = run(args, runtime)
                if sha256(args.audio) != item["audioSha256"]:
                    raise ValueError("Archived audio changed during transcription")
                write_json(args.output_file, {"schemaVersion": 1, "audioSha256": item["audioSha256"], "result": result})
                write_json(Path(str(args.output_file) + ".attempts.json"), {"attempts": runtime.provider.attempts})
                reply = {"recordingId": item["recordingId"], "ok": True}
            except Exception as error:
                runtime.release_heavy()
                reply = {"recordingId": item.get("recordingId"), "ok": False, "error": str(error)}
            print("HISTORY_RESULT " + json.dumps(reply, ensure_ascii=False), flush=True)
    finally:
        if runtime:
            runtime.release_heavy()


if __name__ == "__main__":
    main()
