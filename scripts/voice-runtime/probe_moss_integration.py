"""Isolated common-entry MOSS verification; never records, uploads or updates the Agent DB."""
import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import time

import asr
from runtime_common import bootstrap, sha256, write_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--inputs', type=Path, required=True)
    parser.add_argument('--ids', nargs='+', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--model-dir', type=Path, required=True)
    parser.add_argument('--moss-python', required=True)
    parser.add_argument('--moss-model-dir', type=Path, required=True)
    parser.add_argument('--moss-upstream', type=Path, required=True)
    parser.add_argument('--split-id')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    bootstrap()
    import soundfile as sf
    items = {i['id']: i for i in json.loads(args.inputs.read_text(encoding='utf-8-sig'))['inputs']}
    hashes = {p.name: sha256(p) for p in Path(__file__).parent.glob('*.py')}
    rows, runtime = [], None
    try:
        for identity in args.ids:
            item = items[identity]
            if sha256(item['audio']) != item['sha256']:
                raise ValueError('Frozen input changed')
            variants = ['single','parts'] if identity == args.split_id else ['single']
            for variant in variants:
                paths = [Path(item['audio'])]
                if variant == 'parts':
                    data, rate = sf.read(str(paths[0]),dtype='float32')
                    if rate != 16000 or data.ndim != 1:
                        raise ValueError('Split control requires mono 16kHz original')
                    paths, first, previous = [], 0, None
                    # Deliberately not multiples of VAD frame size; only storage boundaries change.
                    cuts = sorted(set([min(len(data)-1, 7001), len(data)//2 + 3, len(data)]))
                    base = datetime(2026,10,25,tzinfo=timezone.utc)
                    for index,last in enumerate(cuts):
                        path = args.output / ('split-%d.wav' % index)
                        sf.write(str(path),data[first:last],rate,subtype='FLOAT')
                        recording_id = 'split-%d' % index
                        manifest = {'schemaVersion':1,'kind':'voice-recording-package-part',
                            'audioFile':path.name,'audioPath':path.name,'sha256':sha256(path),
                            'sampleRateHz':16000,'channels':1,'sampleCount':last-first,'sampleCountUnit':'frames-per-channel',
                            'recordedAt':(base+timedelta(seconds=first/rate)).isoformat(),'testOnly':True,
                            'deviceId':'isolated-moss-probe','recordingId':recording_id,'packageId':'split-control',
                            'partIndex':index,'finalPart':last==len(data),'previousRecordingId':previous}
                        write_json(Path(str(path)+'.manifest.json'),manifest)
                        paths.append(path)
                        previous,first=recording_id,last
                cli = ['--audio',str(paths[0]),'--model-dir',str(args.model_dir),'--output','json',
                    '--asr-provider','moss-local','--moss-python',args.moss_python,
                    '--moss-model-dir',str(args.moss_model_dir),'--moss-upstream',str(args.moss_upstream),
                    '--moss-cache-dir',str((args.output/'modules').resolve()),'--language','auto']
                for path in paths[1:]:
                    cli.extend(['--continuation-audio',str(path)])
                invocation=asr.arguments(cli)
                start=time.monotonic()
                if runtime is None:
                    runtime=asr.AsrRuntime(invocation)
                first=len(runtime.provider.attempts)
                result=asr.run(invocation,runtime)
                attempts=runtime.provider.attempts[first:]
                row={'id':identity,'variant':variant,'sourceSha256':item['sha256'],
                    'wallSeconds':time.monotonic()-start,'result':result,'attempts':attempts}
                rows.append(row)
                write_json(args.output/'results.private.json',{'rows':rows,'sourceHashes':hashes})
                print(json.dumps({'id':identity,'variant':variant,'seconds':row['wallSeconds'],
                    'completion':result['completion'],'segments':len(result['segments']),
                    'speakers':len(result['speakers']),'embeddings':sum('embedding' in s for s in result['speakers']),
                    'windows':result['segmentation']['recognitionWindows'],'attempts':len(attempts)}),flush=True)
    finally:
        process=runtime.provider.worker.process if runtime and runtime.provider.worker else None
        if runtime:
            runtime.release_heavy()
        write_json(args.output/'exit.private.json',{'processExited':process is None or process.poll() is not None})
    if any(sha256(Path(__file__).with_name(name)) != digest for name,digest in hashes.items()):
        raise RuntimeError('Inference source changed during test')


if __name__=='__main__':
    main()
