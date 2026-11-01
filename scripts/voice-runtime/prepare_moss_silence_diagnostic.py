"""Freeze content/backend controls; synthetic concatenation is not a speech benchmark."""
import argparse
from array import array
import json
import math
from pathlib import Path
import sys
import wave

from runtime_common import sha256


RATE = 16000


def read_pcm(item):
    path = Path(item["audio"])
    if sha256(path) != item["sha256"]:
        raise ValueError("Source audio changed: " + item["id"])
    with wave.open(str(path), "rb") as reader:
        if (reader.getframerate(), reader.getnchannels(), reader.getsampwidth()) != (RATE, 1, 2):
            raise ValueError("Expected mono 16 kHz PCM16")
        samples = array("h", reader.readframes(reader.getnframes()))
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def metrics(samples):
    rms = math.sqrt(sum(float(x) * x for x in samples) / len(samples))
    return {"seconds": len(samples) / RATE, "rmsDbfs": 20 * math.log10(rms / 32768) if rms else None,
            "peakPcm": max(abs(x) for x in samples), "digitalZero": not any(samples)}


def write_audio(root, name, samples, provenance):
    path = root / (name + ".wav")
    payload = array("h", samples)
    if sys.byteorder != "little":
        payload.byteswap()
    with wave.open(str(path), "wb") as writer:
        writer.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
        writer.writeframes(payload.tobytes())
    return {"id": name, "audio": str(path.resolve()), "sha256": sha256(path),
            "sampleRate": RATE, "channels": 1, **metrics(samples), "provenance": provenance}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inputs", required=True, type=Path)
    parser.add_argument("--suspect-id", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    items = json.loads(args.inputs.read_text(encoding="utf-8-sig"))["inputs"]
    suspect = next(item for item in items if item["id"] == args.suspect_id)
    pcm = read_pcm(suspect)
    if len(pcm) != 120 * RATE:
        raise ValueError("This diagnostic expects the recorded 120-second failure")
    speech_items = [item for item in items if item["group"] in ("user-check", "one-meter")]
    speech = array("h")
    source_spans = []
    for item in speech_items:
        if len(speech) >= 120 * RATE:
            break
        part = read_pcm(item)[:120 * RATE - len(speech)]
        source_spans.append({"sourceId": item["id"], "sourceSha256": item["sha256"],
            "sourceStartSeconds": 0, "seconds": len(part) / RATE, "outputStartSeconds": len(speech) / RATE})
        speech.extend(part)
    if len(speech) != 120 * RATE:
        raise ValueError("Insufficient previously transcribed content")
    # Selection depends only on signal energy, not the model's output or reference answer.
    window = 10 * RATE
    start = max(range(0, len(pcm) - window + 1, RATE),
                key=lambda pos: sum(float(x) * x for x in pcm[pos:pos + window]))
    args.output.mkdir(parents=True, exist_ok=False)
    crop = pcm[start:start + window]
    short = [
        write_audio(args.output, "suspect-loudest-10s", crop,
                    {"sourceSha256": suspect["sha256"], "startSeconds": start / RATE, "selection": "max RMS at 1s stride"}),
        write_audio(args.output, "digital-silence-10s", array("h", [0]) * window,
                    {"synthetic": True, "operation": "all-zero PCM"}),
        write_audio(args.output, "speech-control-10s", speech[:window],
                    {"source": source_spans[0], "croppedSeconds": 10}),
    ]
    long = write_audio(args.output, "speech-concatenation-120s", speech,
                       {"synthetic": True, "operation": "different real clips concatenated without gaps; final clip cropped", "sources": source_spans})
    fun = []
    for seconds in range(0, 120, 30):
        fun.append(write_audio(args.output, "suspect-%03d-%03ds" % (seconds, seconds + 30),
            pcm[seconds * RATE:(seconds + 30) * RATE],
            {"sourceSha256": suspect["sha256"], "startSeconds": seconds, "gain": 1}))
    peak = max(abs(x) for x in crop)
    gain = min(10.0, 32700 / peak) if peak else 1.0
    amplified = array("h", (round(x * gain) for x in crop))
    fun.append(write_audio(args.output, "suspect-loudest-10s-amplified", amplified,
        {"sourceSha256": suspect["sha256"], "startSeconds": start / RATE, "gain": gain, "clipping": False}))
    common = {"sourceManifestSha256": sha256(args.inputs), "prepareSha256": sha256(__file__),
              "suspect": {"id": suspect["id"], "sha256": suspect["sha256"], **metrics(pcm)},
              "notGroundTruth": "No-speech status remains a hypothesis; concatenation is a content/duration control, not meeting accuracy acceptance."}
    for name, data in (("short", short), ("sdpa", short + [long]), ("fun", fun + [short[2]])):
        (args.output / (name + ".inputs.private.json")).write_text(
            json.dumps({**common, "inputs": data}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(args.output), "suspect": common["suspect"],
        "loudestStartSeconds": start / RATE, "sdpaCases": len(short) + 1, "eagerCases": len(short), "funCases": len(fun) + 1}))


if __name__ == "__main__":
    main()
