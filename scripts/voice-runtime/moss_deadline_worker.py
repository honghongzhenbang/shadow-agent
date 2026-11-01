"""Offline MOSS worker using the same supervised request protocol as Fun."""
import argparse
from dataclasses import asdict
import json
import os
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fun_worker import watch_parent
from runtime_common import sha256, contained
from streaming_deadline import AudioDeadline, TranscriptStreamer, audio_budget, generation_status


def transcript_result(text, status, parser_factory):
    if status['completion'] == 'partial':
        return {**status, 'segments': []}
    parser = parser_factory()
    segments = parser.feed(text)
    # The pinned upstream parser intentionally discards an unfinished tail on
    # close(). Inspect its terminal state first; do not invent missing words.
    closed_tail = not text.strip() or parser._state == parser._AFTER_END
    segments.extend(parser.close())
    if not closed_tail:
        return {**status, 'completion': 'partial', 'stopReason': 'invalid_model_output',
                'segments': [], 'error': 'MOSS transcript ended without a complete final segment'}
    return {**status, 'segments': [asdict(segment) for segment in segments]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir', type=Path, required=True)
    parser.add_argument('--upstream', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--parent-pid', type=int, required=True)
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding='utf8')
    sys.stdin.reconfigure(encoding='utf8')
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1',
        TOKENIZERS_PARALLELISM='false', OMP_NUM_THREADS='2', MKL_NUM_THREADS='2', HF_MODULES_CACHE=str(args.cache))
    def emit(row):
        print(json.dumps(row, ensure_ascii=False), flush=True)
    try:
        import psutil
        watch_parent(psutil.Process(args.parent_pid))
        import torch
        import soundfile as sf
        from transformers import AutoModelForCausalLM, AutoProcessor, StoppingCriteria, StoppingCriteriaList
        sys.path.insert(0, str(args.upstream.resolve()))
        from moss_transcribe_diarize import TranscriptStreamParser
        import moss_transcribe_diarize.transcript_parser as parser_module
        from moss_transcribe_diarize.inference_utils import build_transcription_messages, prepare_inputs
        def deny(event, details):
            if event in {'socket.connect','socket.connect_ex','socket.getaddrinfo','socket.bind',
                         'socket.sendto','socket.sendmsg','urllib.Request'}:
                raise RuntimeError('Offline MOSS worker forbids network access')
        sys.addaudithook(deny)
        if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
            raise RuntimeError('CUDA BF16 required')
        torch.set_num_threads(2)
        torch.set_num_interop_threads(1)
        manifest = json.loads((args.model_dir / 'verified-files.json').read_text(encoding='utf8'))
        for entry in manifest['files']:
            if sha256(contained(args.model_dir, entry['name'])) != entry['sha256']:
                raise ValueError('MOSS asset changed')
        start = time.monotonic()
        processor = AutoProcessor.from_pretrained(args.model_dir, trust_remote_code=True, local_files_only=True)
        model = AutoModelForCausalLM.from_pretrained(args.model_dir, trust_remote_code=True, local_files_only=True,
            dtype=torch.bfloat16, device_map='cuda', attn_implementation='sdpa').eval()
        if any(p.device.type != 'cuda' for p in model.parameters()):
            raise RuntimeError('Unexpected CPU offload')
        emit({'ready': True, 'engine': 'moss-local', 'loadSeconds': time.monotonic()-start,
              'revision': manifest['revision'], 'attention': 'sdpa', 'dtype': 'bfloat16',
              'transcriptParserSha256': sha256(parser_module.__file__)})
        for line in sys.stdin:
            request = json.loads(line)
            audio = Path(request['audio'])
            info = sf.info(str(audio))
            if info.samplerate != 16000 or info.channels != 1 or not 0 < info.duration <= 120:
                raise ValueError('MOSS worker accepts mono 16kHz audio up to 120s')
            factor = request['budgetFactor']
            deadline = AudioDeadline(audio_budget(info.duration, factor), started=float(request['startedMonotonic']))
            deadline.ends = min(deadline.ends, float(request['deadlineMonotonic']))
            request_id = request['requestId']
            streamer = TranscriptStreamer(lambda ids: processor.tokenizer.decode(ids, skip_special_tokens=True),
                lambda row: emit({**row, 'requestId': request_id}), deadline)
            class StopAtDeadline(StoppingCriteria):
                def __call__(self, input_ids, scores, **kwargs):
                    return deadline.expired()
            token_limit = max(512, round(info.duration * 18))
            with torch.inference_mode(), torch.amp.autocast('cuda', dtype=torch.bfloat16):
                batch = prepare_inputs(processor, build_transcription_messages(audio), device=torch.device('cuda:0')).to('cuda:0')
                prompt_length = int(batch['attention_mask'][0].sum())
                generated = model.generate(**batch, do_sample=False, max_new_tokens=token_limit,
                    streamer=streamer, stopping_criteria=StoppingCriteriaList([StopAtDeadline()]))
            new = generated[0][prompt_length:]
            eos = model.generation_config.eos_token_id
            eos = eos if isinstance(eos, list) else [eos]
            expired = deadline.expired()
            status = generation_status(expired=expired, tokens=int(new.numel()), max_tokens=token_limit,
                reached_eos=bool(new.numel() and int(new[-1]) in eos))
            text = streamer.text if expired else processor.tokenizer.decode(new, skip_special_tokens=True).strip()
            emit({'event': 'result', 'requestId': request_id, 'engine': 'moss-local', 'text': text,
                **transcript_result(text, status, TranscriptStreamParser),
                'budgetSeconds': deadline.seconds, 'budgetFactor': factor,
                'gpuAllocatedPeakBytes': torch.cuda.max_memory_allocated(),
                'gpuReservedPeakBytes': torch.cuda.max_memory_reserved(),
                'processRssBytes': psutil.Process().memory_info().rss})
            del batch, generated, new
    except Exception as error:
        emit({'error': str(error), 'errorType': type(error).__name__})
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
