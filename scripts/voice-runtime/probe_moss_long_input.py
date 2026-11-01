"""Synthetic long-input resource gate through the real common VAD/MOSS entry.

Silence deliberately never loads MOSS. This measures reader/VAD memory, not
long-meeting recognition accuracy or the loaded GPU model's memory stability.
"""
import argparse
import json
from pathlib import Path
import time
import wave

import psutil

import asr
from runtime_common import sha256, write_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--seconds', type=int, required=True)
    parser.add_argument('--model-dir', type=Path, required=True)
    args = parser.parse_args()
    if not 1 <= args.seconds <= 7200:
        parser.error('Resource probe is bounded to two hours')
    args.output.mkdir(parents=True, exist_ok=False)
    audio = args.output / 'synthetic-silence.wav'
    # Generate on disk in bounded chunks; never allocate duration-sized PCM.
    with wave.open(str(audio), 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        block = b'\0' * (10 * 16000 * 2)
        left = args.seconds * 16000
        while left:
            frames = min(left, 10 * 16000)
            output.writeframesraw(block[:frames * 2])
            left -= frames
    hashes = {p.name: sha256(p) for p in Path(__file__).parent.glob('*.py')}
    original_hash = sha256(audio)
    invocation = asr.arguments(['--audio', str(audio), '--model-dir', str(args.model_dir),
        '--asr-provider', 'moss-local', '--output', 'json'])
    process = psutil.Process()
    before = process.memory_info()._asdict()
    runtime = None
    started = time.monotonic()
    try:
        runtime = asr.AsrRuntime(invocation)
        loaded = process.memory_info()._asdict()
        result = asr.run(invocation, runtime)
        after = process.memory_info()._asdict()
        receipt = {'syntheticResourceTest': True, 'audioSeconds': args.seconds,
            'audioSha256': original_hash, 'audioFileBytes': audio.stat().st_size,
            'wallSeconds': time.monotonic() - started, 'beforeMemory': before,
            'cpuRuntimeReadyMemory': loaded, 'afterMemory': after,
            'attempts': runtime.provider.attempts, 'result': result, 'sourceHashes': hashes}
        write_json(args.output / 'results.private.json', receipt)
        assert result['durationMs'] == args.seconds * 1000
        assert result['completion'] == 'complete' and not result['segments']
        assert not runtime.provider.attempts and runtime.provider.worker is None
        assert sha256(audio) == original_hash
        assert all(sha256(Path(__file__).with_name(name)) == digest for name, digest in hashes.items())
        print(json.dumps({'passed': True, 'seconds': args.seconds,
            'wallSeconds': receipt['wallSeconds'], 'peakWorkingSetBytes': after.get('peak_wset'),
            'rssBytes': after['rss'], 'modelCalls': 0}), flush=True)
    finally:
        if runtime:
            runtime.release_heavy()


if __name__ == '__main__':
    main()
