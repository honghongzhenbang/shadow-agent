"""MOSS window, identity and persistence boundaries without downloading/running a model."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts/voice-runtime'))
from runtime_common import bootstrap
bootstrap()
import numpy as np
import soundfile as sf
import soxr
from continuous_audio import ContinuousAudio
from asr import SUPPORTED_FORMATS, validate_audio_path, streamed_speech_intervals, arguments
from local_provider import MossProvider
from moss_pipeline import moss_windows, project_segments, exclusive_ranges, speaker_embeddings, transcribe_moss


def parsed(start=0, end=2, label='S01', text='speech'):
    return {'start': start, 'end': end, 'speaker': label, 'text': text}


def options(**extra):
    return SimpleNamespace(**{**dict(moss_max_seconds=60, max_gain_db=0, asr_time_budget_factor=2,
                                    language='auto', diarization='none'), **extra})


class Windows(unittest.TestCase):
    def test_cli_selects_moss_with_independent_duration(self):
        args = arguments(['--audio', 'fake.wav', '--model-dir', '.', '--output', 'json', '--asr-provider', 'moss-local'])
        self.assertEqual(args.moss_max_seconds, 60)
        for value in ['nan', '0', '121']:
            with self.assertRaises(SystemExit):
                arguments(['--audio', 'fake.wav', '--model-dir', '.', '--output', 'json', '--moss-max-seconds', value])

    def test_continuous_speech_has_bounded_context_without_core_gaps(self):
        plan = moss_windows([(0, 190 * 16000)], 190 * 16000)
        self.assertEqual(plan[0]['start'], 0)
        self.assertEqual(plan[-1]['end'], 190 * 16000)
        for index, window in enumerate(plan):
            self.assertLessEqual(window['end'] - window['start'], 60 * 16000)
            if index:
                self.assertEqual(window['coreStart'], plan[index - 1]['end'])
                self.assertEqual(window['coreStart'] - window['start'], 16000)

    def test_short_pauses_and_speaker_turns_share_a_window(self):
        plan = moss_windows([(0, 2*16000), (3*16000, 6*16000), (7*16000, 18*16000)], 20*16000)
        self.assertEqual(len(plan), 1)
        self.assertEqual(plan[0]['end'], round(18.2*16000))

    def test_real_pause_near_limit_preferred_not_vad_forced_boundaries(self):
        plan = moss_windows([(0,48*16000), (49*16000,100*16000)],100*16000)
        self.assertEqual(plan[0]['end'], round(48.5*16000))
        self.assertFalse(plan[1]['forcedStart'])
        plan = moss_windows([(0,50*16000), (50*16000,100*16000)],100*16000)
        self.assertEqual(plan[0]['end'],60*16000)
        self.assertTrue(plan[1]['forcedStart'])

    def test_empty_and_long_silence_never_make_a_silent_window(self):
        self.assertEqual(moss_windows([], 16000), [])
        plan = moss_windows([(16000,32000),(100*16000,102*16000)],105*16000)
        self.assertEqual(len(plan),2)
        self.assertLess(plan[0]['end'],plan[1]['start'])

    def test_projection_context_and_window_local_identity(self):
        window = {'start':59*16000,'coreStart':60*16000,'end':119*16000,'forcedStart':True}
        result = project_segments({'text':'raw', 'segments':[parsed(0,.8), parsed(.5,2), parsed(2,5,'S02')]},window,1)
        self.assertEqual(len(result),2)
        self.assertEqual(result[0]['startMs'],59500)
        self.assertEqual(result[0]['contextOverlapMs'],500)
        self.assertEqual(result[0]['speakerLabel'],'window_0001_S01')
        other = project_segments({'text':'raw', 'segments':[parsed()]},window,2)
        self.assertNotEqual(other[0]['speakerLabel'],result[0]['speakerLabel'])

    def test_invalid_output_is_not_silently_clamped_to_the_audio(self):
        window = {'start':0,'coreStart':0,'end':10*16000,'forcedStart':False}
        for row in [parsed(-1,2), parsed(0,20), parsed(0,float('nan')), parsed(1,1)]:
            with self.assertRaises(ValueError):
                project_segments({'text':'raw','segments':[row]},window,0)
        with self.assertRaises(ValueError):
            project_segments({'text':'unparsed','segments':[]},window,0)


class Embeddings(unittest.TestCase):
    def test_overlap_is_subtracted_before_sample_extraction(self):
        a = {'startMs':0,'endMs':5000,'speakerLabel':'A'}
        b = {'startMs':2000,'endMs':4000,'speakerLabel':'B'}
        self.assertEqual(exclusive_ranges(a,[a,b]),[(0,32000),(64000,80000)])
        self.assertEqual(exclusive_ranges(b,[a,b]),[])

    def test_original_samples_and_no_embedding_for_fully_mixed_speaker(self):
        captured = []
        def stream():
            return SimpleNamespace(accept_waveform=lambda **kw:captured.append(kw['waveform'].copy()), input_finished=lambda:None)
        extractor = SimpleNamespace(create_stream=stream,is_ready=lambda s:True,compute=lambda s:[1.,0.])
        runtime = SimpleNamespace(np=np,get_extractor=lambda args:extractor,
            manifest={'files':{'embedding':{'sha256':'abc'}}})
        samples = np.arange(80000,dtype=np.float32)/80000
        people, _ = speaker_embeddings(samples,[{'startMs':0,'endMs':5000,'speakerLabel':'A'},
            {'startMs':2000,'endMs':4000,'speakerLabel':'B'}],runtime,options(diarization='vad-cluster'))
        np.testing.assert_array_equal(captured[0],samples[:32000])
        np.testing.assert_array_equal(captured[1],samples[64000:])
        self.assertEqual(people[0]['embeddingModel'],'3dspeaker-campplus-zh-cn-16k@sha256:abc')
        self.assertEqual(people[0]['speechDurationMs'],3000)
        self.assertNotIn('embedding',people[1])


class Pipeline(unittest.TestCase):
    def run_pipeline(self, results, duration=130, intervals=None):
        outputs, calls = iter(results), []
        def decode(data,start):
            calls.append((len(data),start))
            row = next(outputs)
            if isinstance(row,Exception):
                raise row
            return row
        provider = SimpleNamespace(decode=decode,close=lambda:None)
        runtime = SimpleNamespace(provider=provider,np=np)
        result = transcribe_moss(options(),runtime,np.zeros(duration*16000,dtype=np.float32),
            [(0,duration*16000)] if intervals is None else intervals,
            SimpleNamespace(duration=duration,samplerate=16000,frames=duration*16000,channels=1),[],[])
        return result,calls

    def test_silence_never_loads_the_worker(self):
        result,calls = self.run_pipeline([],intervals=[])
        self.assertEqual(calls,[])
        self.assertEqual(result['engine'],'local-no-speech')

    def test_completed_text_survives_later_worker_failure_and_unattempted_tail(self):
        result,calls = self.run_pipeline([{'text':'raw','segments':[parsed()]},RuntimeError('stopped')])
        self.assertEqual(len(calls),2)
        self.assertEqual(len(result['segments']),1)
        self.assertEqual(result['completion'],'partial')
        self.assertEqual([p['stopReason'] for p in result['partialResults']],['worker_error','worker_error'])
        self.assertEqual(result['partialResults'][0]['startMs'],59000)
        self.assertEqual(result['partialResults'][1]['endMs'],130000)

    def test_token_limit_retains_raw_and_next_different_window_can_finish(self):
        result,calls = self.run_pipeline([{'completion':'partial','stopReason':'output_token_limit',
            'text':'partial raw','tokens':1080,'maxNewTokens':1080}, {'text':'raw','segments':[parsed(1,2)]}], duration=90)
        self.assertEqual(len(calls),2)
        self.assertEqual(result['partialResults'][0]['text'],'partial raw')
        self.assertEqual(result['segments'][0]['startMs'],60000)
        self.assertEqual(result['partialResults'][0]['budgetSeconds'],120)

    def test_window_local_labels_pass_the_existing_acoustic_scope(self):
        result,_ = self.run_pipeline([{'text':'raw','segments':[parsed()]},
            {'text':'raw','segments':[parsed(1,4)]}],duration=90)
        self.assertEqual([s.get('acousticScope') for s in result['speakers']],
                         ['moss-window-0','moss-window-1'])

    def test_parse_failure_keeps_raw_text_not_a_fake_completed_transcript(self):
        result,_ = self.run_pipeline([{'text':'not parsed','segments':[]}],duration=10)
        self.assertEqual(result['segments'],[])
        self.assertEqual(result['partialResults'][0]['stopReason'],'invalid_model_output')
        self.assertEqual(result['partialResults'][0]['text'],'not parsed')

    def test_unclosed_tail_keeps_raw_prefix_and_tail_for_review(self):
        raw = '[0][S01]complete[1][1][S02]unfinished'
        result,calls = self.run_pipeline([{'text':raw, 'segments':[], 'completion':'partial',
            'stopReason':'invalid_model_output', 'error':'Unclosed final segment'}],duration=10)
        self.assertEqual(len(calls),1)
        self.assertEqual(result['segments'],[])
        self.assertEqual(result['completion'],'partial')
        self.assertEqual(result['partialResults'][0]['text'],raw)
        self.assertEqual(result['partialResults'][0]['stopReason'],'invalid_model_output')

    def test_moss_provider_does_not_retry_or_fallback_on_partial(self):
        calls = []
        worker = SimpleNamespace(receipt={'ready':True},close=lambda:calls.append('close'),
            decode=lambda *a: {'completion':'partial','stopReason':'output_token_limit','text':'partial'})
        provider = MossProvider(options(),None,factory=lambda *a:worker)
        result = provider.decode([0]*16000,0)
        self.assertEqual(result['engine'],'moss-local')
        self.assertEqual(calls,['close'])
        self.assertIsNone(provider.worker)
        self.assertEqual(len(provider.attempts),2)


class AudioViews(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.runtime = SimpleNamespace(np=np,sf=sf,soxr=soxr)

    def tearDown(self):
        self.temp.cleanup()

    def parts(self, data, cuts):
        paths, manifests, first = [],[],0
        epoch = datetime(2026,10,25,tzinfo=timezone.utc)
        for index,last in enumerate([*cuts,len(data)]):
            path = self.root / ('part-%d.wav' % index)
            sf.write(str(path),data[first:last],16000,subtype='FLOAT')
            paths.append(path)
            manifests.append({'recordingId':str(index),'partIndex':index,'sampleCount':last-first,
                'sampleRateHz':16000,'channels':1,'recordedAt':(epoch+timedelta(seconds=first/16000)).isoformat()})
            first=last
        return paths,manifests

    def view(self,paths,manifests):
        return ContinuousAudio(paths,manifests,43200,self.runtime,validate_audio_path,SUPPORTED_FORMATS)

    def test_non_frame_aligned_parts_and_read_sizes_preserve_every_sample(self):
        data = np.linspace(-.1,.1,65037,dtype=np.float32)
        paths,manifests = self.parts(data,[513,16387,33001])
        with self.view(paths,manifests) as reader:
            for size in [511,8000,16001]:
                np.testing.assert_array_equal(np.concatenate(list(reader.chunks(size))),data)
            np.testing.assert_array_equal(reader[510:16400],data[510:16400])
            self.assertEqual(reader.sources[-1]['endSample'],len(data))

    def test_capture_gap_is_not_hidden_by_concatenation(self):
        paths,manifests = self.parts(np.zeros(32000,dtype=np.float32),[16000])
        manifests[1]['recordedAt']='2026-10-25T00:00:02+00:00'
        with self.assertRaisesRegex(ValueError,'Non-contiguous'):
            self.view(paths,manifests)

    def test_stateful_resampling_matches_full_reference_across_read_blocks(self):
        rate=44100
        data=(np.sin(np.arange(rate*11,dtype=np.float64)*.031)*.1).astype(np.float32)
        path=self.root/'external.wav'
        sf.write(str(path),data,rate,subtype='FLOAT')
        with self.view([path],[None]) as reader:
            actual=np.concatenate(list(reader.chunks(7777)))
            target=reader.parts[0][0]
            np.testing.assert_allclose(actual,soxr.resample(data,rate,16000,quality='HQ'),atol=1e-6)
            self.assertEqual(len(actual),176000)
        self.assertFalse(target.exists())
        self.assertTrue(path.exists())

    def test_vad_keeps_one_state_and_pads_only_final_tail(self):
        data=np.linspace(-.1,.1,10003,dtype=np.float32)
        frames=[]
        detector=SimpleNamespace(config=SimpleNamespace(silero_vad=SimpleNamespace(window_size=512)),
            reset=lambda:frames.clear(), empty=lambda:True, flush=lambda:None,
            accept_waveform=lambda row:frames.append(row.copy()))
        for chunks in [[data],[data[:513],data[513:5001],data[5001:]]]:
            streamed_speech_intervals(chunks,len(data),None,1,None,np,detector)
            current=np.concatenate(frames)
            expected=np.clip(np.rint(data*32768),-32768,32767)/32768
            np.testing.assert_array_equal(current[:len(data)],expected)
            self.assertTrue(np.all(current[len(data):]==0))
            self.assertEqual(len(current),20*512)


if __name__=='__main__':
    unittest.main()
