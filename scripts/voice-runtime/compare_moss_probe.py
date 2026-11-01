"""Private same-audio comparison; cloud transcripts are proxies, not human labels."""
import argparse
import html
import json
from pathlib import Path
import unicodedata


def normalize(text):
    return "".join(c for c in text.lower() if not c.isspace() and not unicodedata.category(c).startswith("P"))


def edits(reference, hypothesis):
    previous = list(range(len(hypothesis) + 1))
    for i, a in enumerate(reference, 1):
        current = [i]
        for j, b in enumerate(hypothesis, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (a != b)))
        previous = current
    return previous[-1]


def rows(path):
    return {row["id"]: row for row in map(json.loads, path.read_text(encoding="utf-8-sig").splitlines())
            if row.get("event") == "transcript" or row.get("kind") == "transcript"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--fun", type=Path, required=True)
    parser.add_argument("--moss", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    inputs = json.loads(args.inputs.read_text(encoding="utf-8"))["inputs"]
    reference = {row["recordingId"]: row["reference"]["text"]
                 for row in json.loads(args.reference.read_text(encoding="utf-8"))["rows"]}
    fun, moss = rows(args.fun), rows(args.moss)
    result, tables = [], []
    score = {name: {"edits": 0, "referenceCharacters": 0, "samples": 0, "seconds": 0}
             for name in ("fun", "moss")}
    for index, item in enumerate(inputs):
        rid = item["id"]
        r, f, m = reference.get(rid), fun.get(rid), moss.get(rid)
        record = {"id": rid, "audioSeconds": item["seconds"], "reference": r, "fun": f, "moss": m}
        for name, entry in (("fun", f), ("moss", m)):
            if entry and entry["audioSha256"] != item["sha256"]:
                raise ValueError("Comparison audio mismatch")
            if r is not None and entry and not entry.get("error"):
                text = entry["text"] if name == "fun" else "".join(s["text"] for s in entry["segments"])
                distance = edits(normalize(r), normalize(text))
                record[name + "ProxyEdits"] = distance
                score[name]["edits"] += distance
                score[name]["referenceCharacters"] += len(normalize(r))
                score[name]["samples"] += 1
                score[name]["seconds"] += entry["seconds"]
        result.append(record)
        e = lambda value: html.escape(str(value or ""))
        segment_lines = "".join("<li>%s–%s s · %s · %s</li>" %
            (e(s["start"]), e(s["end"]), e(s["speaker"]), e(s["text"])) for s in (m or {}).get("segments", []))
        tables.append(f'<section><h2>{index + 1:02d} · {e(item["group"])} · {item["seconds"]:.3f} s</h2>'
            f'<audio controls preload="none" src="{e(Path(item["audio"]).as_uri())}"></audio>'
            f'<table><tr><th>Qwen reference (not human truth)</th><th>Fun-ASR-Nano</th><th>MOSS raw output</th></tr>'
            f'<tr><td>{e(r)}</td><td>{e((f or {}).get("text"))}</td><td>{e((m or {}).get("text", (m or {}).get("error")))}</td></tr></table>'
            f'<ol>{segment_lines}</ol></section>')
    for value in score.values():
        value["proxyCharacterErrorRate"] = value["edits"] / max(1, value["referenceCharacters"])
    (args.output / "comparison.private.json").write_text(json.dumps({"basis": "Qwen proxy only; no human CER or DER",
        "score": score, "rows": result}, ensure_ascii=False, indent=2), encoding="utf-8")
    page = '<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    page += '<title>MOSS / Fun local comparison</title><style>body{font:16px/1.6 system-ui;margin:24px;color:#182c25;background:#f7faf8}section{border-top:1px solid #bac9c2;padding:16px 0}table{width:100%;table-layout:fixed;border-collapse:collapse}td,th{border:1px solid #bac9c2;padding:12px;vertical-align:top;overflow-wrap:anywhere}h1{font-size:26px}h2{font-size:20px}audio{width:100%;max-width:500px}li{padding:4px 0}@media(max-width:700px){td,th{padding:5px;font-size:13px}body{margin:12px}}</style>'
    page += '<h1>MOSS / Fun · Local Audio Comparison</h1><p>Qwen output is a proxy, not human ground truth. Speaker labels are recording-local, not identities. Raw audio and results remain local.</p>'
    page += ''.join(tables) + '</html>'
    (args.output / "review.html").write_text(page, encoding="utf-8")
    print(json.dumps(score, indent=2))


if __name__ == "__main__":
    main()
