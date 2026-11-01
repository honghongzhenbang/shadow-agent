"""Prepare isolated PCM package controls from existing audio, without model inference."""
import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path

from runtime_common import bootstrap, sha256, write_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--inputs', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--pc-id', required=True)
    parser.add_argument('--phone-id', required=True)
    parser.add_argument('--silent-id', required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    bootstrap()
    import soundfile as sf
    import numpy as np
    inputs = {i['id']: i for i in json.loads(args.inputs.read_text(encoding='utf-8-sig'))['inputs']}
    cases = []
    base = datetime(2026, 10, 25, tzinfo=timezone.utc)
    for kind, identity in [('pc', args.pc_id), ('phone', args.phone_id), ('silent', args.silent_id)]:
        item = inputs[identity]
        if sha256(item['audio']) != item['sha256']:
            raise ValueError('Frozen source changed')
        data, rate = sf.read(item['audio'], dtype='int16')
        info = sf.info(item['audio'])
        if rate != 16000 or data.ndim != 1 or info.subtype != 'PCM_16':
            raise ValueError('Queue replay requires an unchanged mono 16kHz PCM16 source')
        # Non-frame-aligned physical cuts test the package assembler, not ASR quality.
        cuts = [7001, len(data)//2+3, len(data)] if kind == 'phone' else [len(data)]
        case_root, first, previous, parts = args.output/kind, 0, None, []
        for index, last in enumerate(cuts):
            folder = case_root/('part-%d' % index)
            folder.mkdir(parents=True)
            audio = folder/'audio.wav'
            sf.write(str(audio), data[first:last], rate, subtype='PCM_16')
            np.testing.assert_array_equal(sf.read(str(audio), dtype='int16')[0], data[first:last])
            record_id = '%s-part-%d' % (kind, index)
            manifest = {'schemaVersion': 1, 'kind': 'voice-recording-package-part' if kind == 'phone' else 'voice-audio-file',
                'deviceId': 'isolated-'+kind, 'recordingId': record_id, 'conversationId': 'test-'+kind,
                'audioPath': 'audio.wav', 'recordedAt': (base+timedelta(seconds=first/rate)).isoformat(),
                'sha256': sha256(audio), 'sampleRateHz': rate, 'channels': 1, 'sampleCount': last-first,
                'durationMs': (last-first)/16, 'testOnly': True}
            if kind == 'phone':
                manifest.update(packageId='phone-package', partIndex=index, finalPart=last==len(data),
                    previousRecordingId=previous)
            write_json(folder/'manifest.json', manifest)
            parts.append({'manifest': str((folder/'manifest.json').resolve()), 'audio': str(audio.resolve()),
                          'sha256': manifest['sha256']})
            previous, first = record_id, last
        cases.append({'kind': kind, 'inputId': identity, 'originalAudio': item['audio'], 'sourceSha256': item['sha256'],
            'root': str(case_root.resolve()), 'parts': parts, 'sampleCount': len(data),
            'mossMaxSeconds': 30 if kind == 'phone' else 60, 'expectedSpeech': kind != 'silent'})
        if sha256(item['audio']) != item['sha256']:
            raise ValueError('Source changed during preparation')
    write_json(args.output/'cases.private.json', {'cases': cases,
        'scope': 'Replayed existing PCM with synthetic capture times; no microphone or real phone transfer.',
        'inputsSha256': sha256(args.inputs), 'preparerSha256': sha256(__file__)})
    print(json.dumps({'cases': len(cases), 'output': str(args.output)}))


if __name__ == '__main__':
    main()
