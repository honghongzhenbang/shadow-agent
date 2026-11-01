"""Small real-input controls through the actual VAD -> gain -> ASR pipeline."""
import argparse
import json
from pathlib import Path
import time

from runtime_common import bootstrap, sha256, write_json
import asr


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--model-dir', type=Path, required=True)
    parser.add_argument('--inputs', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    bootstrap()
    import numpy as np
    import soundfile as sf
    settings = json.loads(args.config.read_text(encoding='utf-8-sig'))['voice']
    items = {i['id']: i for i in json.loads(args.inputs.read_text(encoding='utf-8-sig'))['inputs']}
    cases = [items['speech-control-10s'], items['suspect-060-090s']]
    positive, rate = sf.read(cases[0]['audio'], dtype='float32')
    for name, data in [('weak-control', positive * 10 ** (-18/20)), ('zero-control', np.zeros_like(positive))]:
        file = args.output / (name + '.wav')
        sf.write(str(file), data, rate, subtype='FLOAT')
        cases.append({'id': name, 'audio': str(file), 'sha256': sha256(file), 'syntheticControl': True})
    hashes = {name: sha256(Path(__file__).with_name(name)) for name in
        ('asr.py','fun_worker.py','local_provider.py','streaming_deadline.py','audio_conditioning.py','probe_gated_asr.py')}
    rows, runtime = [], None
    try:
        for case in cases:
            for gain in (0,12):
                if sha256(case['audio']) != case['sha256']:
                    raise ValueError('Source audio changed')
                invocation = asr.arguments(['--audio',case['audio'],'--model-dir',str(args.model_dir),'--output','json',
                    '--diarization','none','--asr-provider','fun-asr-nano','--fallback','none',
                    '--fun-python',settings['funPython'],'--fun-model-dir',settings['funModelDir'],
                    '--fun-weight-sha256',settings['funWeightSha256'],'--max-gain-db',str(gain)])
                if runtime is None:
                    runtime = asr.AsrRuntime(invocation)
                first = len(runtime.provider.attempts)
                start = time.monotonic()
                result = asr.run(invocation, runtime)
                elapsed = time.monotonic()-start
                rows.append({'id':case['id'], 'maxGainDb':gain,'sourceSha256':case['sha256'],
                    'syntheticControl':case.get('syntheticControl',False), 'result':result,
                    'attempts':runtime.provider.attempts[first:], 'wallSeconds':elapsed})
                write_json(args.output/'results.private.json', {'rows':rows,'sourceHashes':hashes})
                print(json.dumps({'id':case['id'],'maxGainDb':gain,'completion':result['completion'],
                    'segments':len(result['segments']),'partials':len(result['partialResults']),
                    'seconds':elapsed,'asrMs':result['timings']['asrMs']}),flush=True)
    finally:
        if runtime:
            runtime.release_heavy()
    if any(sha256(Path(__file__).with_name(name)) != digest for name,digest in hashes.items()):
        raise RuntimeError('Tested source changed')


if __name__ == '__main__':
    main()
