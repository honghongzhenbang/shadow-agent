"""Offline VAD/gain controls; never claims that VAD output is human ground truth."""
import argparse
import json
from pathlib import Path
import time

from runtime_common import bootstrap, deny_network, sha256, write_json
from audio_conditioning import bounded_gain
from asr import create_vad, speech_intervals


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--inputs', type=Path, required=True)
    parser.add_argument('--model-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    bootstrap()
    deny_network()
    import numpy as np
    import soundfile as sf
    import sherpa_onnx as sherpa
    manifest = json.loads((args.model_dir / 'manifest.json').read_text(encoding='utf8'))
    vad = args.model_dir / manifest['files']['vad']['path']
    if sha256(vad) != manifest['files']['vad']['sha256']:
        raise ValueError('VAD fingerprint changed')
    detector = create_vad(str(vad), 2, sherpa)
    items = json.loads(args.inputs.read_text(encoding='utf-8-sig'))['inputs']
    samples = {}
    for item in items:
        if sha256(item['audio']) != item['sha256']:
            raise ValueError('Audio changed')
        data, rate = sf.read(item['audio'], dtype='float32')
        if rate != 16000:
            raise ValueError('Expected 16kHz')
        samples[item['id']] = data
    positive = samples['speech-control-10s']
    samples['weak-speech-control-minus18db'] = positive * 10 ** (-18/20)
    rng = np.random.default_rng(20261025)
    noise = rng.normal(size=len(positive)).astype(np.float32)
    noise *= np.sqrt(np.mean(positive ** 2)) / np.sqrt(np.mean(noise ** 2))
    samples['synthetic-noise-positive-rms'] = noise
    samples['digital-zero-control'] = np.zeros_like(positive)
    rows = []
    for identity, data in samples.items():
        original = data.copy()
        for mode in ('original', 'pre-vad-gain-12db'):
            view, gain = bounded_gain(data, np, 12 if mode.startswith('pre') else 0)
            started = time.monotonic()
            intervals = speech_intervals(view, str(vad), 2, sherpa, np, detector)
            post_gains = [bounded_gain(data[start:end], np)[1] for start, end in intervals]
            rows.append({'id': identity, 'mode': mode, 'audioSeconds': len(data)/16000,
                'speechSeconds': sum(end-start for start,end in intervals)/16000,
                'intervalsMs': [[start/16,end/16] for start,end in intervals],
                'preGain': gain, 'postVadGains': post_gains, 'seconds': time.monotonic()-started})
            print(json.dumps({k:v for k,v in rows[-1].items() if k not in {'preGain','postVadGains','intervalsMs'}}), flush=True)
        if not np.array_equal(original, data):
            raise RuntimeError('Conditioning mutated original samples')
    write_json(args.output / 'results.private.json', {'rows': rows, 'vadSha256': sha256(vad),
        'sourceHashes': {name: sha256(Path(__file__).with_name(name)) for name in
            ('asr.py','audio_conditioning.py','probe_speech_gating.py')},
        'limitation': 'Synthetic weak/noise controls are not independent business samples; suspect speech not human verified.'})


if __name__ == '__main__':
    main()
