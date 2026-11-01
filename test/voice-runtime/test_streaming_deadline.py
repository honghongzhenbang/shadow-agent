"""Deadline and partial snapshots without model imports or a GPU."""
import queue
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/voice-runtime"))
from local_provider import FunProcess
from streaming_deadline import AudioDeadline, TranscriptStreamer, audio_budget, generation_status


class Tensor:
    def __init__(self, values):
        self.values = values

    def tolist(self):
        return self.values


class Deadlines(unittest.TestCase):
    def test_token_limit_is_partial_but_eos_on_last_token_is_complete(self):
        status = generation_status(expired=False, tokens=512, max_tokens=512, reached_eos=False)
        self.assertEqual(status['completion'], 'partial')
        self.assertEqual(status['stopReason'], 'output_token_limit')
        self.assertEqual(generation_status(expired=False, tokens=512, max_tokens=512, reached_eos=True)['completion'], 'complete')
        self.assertEqual(generation_status(expired=True, tokens=512, max_tokens=512, reached_eos=False)['stopReason'], 'audio_duration_deadline')

    def test_configurable_budget_does_not_change_audio_duration(self):
        self.assertEqual(audio_budget(21.39), 42.78)
        self.assertEqual(audio_budget(35, 1), 35)
        for factor in (0, .5, 11, float('inf'), float('nan'), True, '2'):
            with self.assertRaises(ValueError):
                audio_budget(1, factor)

    def test_parent_request_carries_factor_and_respects_shared_deadline(self):
        worker = FunProcess.__new__(FunProcess)
        worker.process = SimpleNamespace(stdin=io.StringIO())
        worker.temporary = SimpleNamespace(name='test-unused')
        worker.sf = SimpleNamespace(write=lambda *args, **kwargs: None)
        worker.budget_factor = 2
        worker._receive_decode = lambda rid, deadline: deadline
        end = time.monotonic() + .1
        result = worker.decode([0] * 16000, 'zh', not_after=end)
        request = json.loads(worker.process.stdin.getvalue())
        self.assertEqual(result.seconds, 2)
        self.assertEqual(result.ends, end)
        self.assertEqual(request['budgetFactor'], 2)
        self.assertEqual(request['deadlineMonotonic'], end)

    def test_duration_validation(self):
        for duration in (0, -1, float("inf"), float("nan")):
            with self.assertRaises(ValueError):
                AudioDeadline(duration)

    def test_monotonic_boundary(self):
        now = [100.0]
        deadline = AudioDeadline(3, clock=lambda: now[0])
        self.assertEqual(deadline.remaining(), 3)
        now[0] = 103
        self.assertTrue(deadline.expired())
        self.assertEqual(deadline.remaining(), 0)

    def test_prompt_and_late_tokens_are_not_preserved(self):
        now, rows = [0], []
        deadline = AudioDeadline(3, clock=lambda: now[0])
        stream = TranscriptStreamer(lambda ids: "".join(chr(i) for i in ids), rows.append, deadline)
        stream.put(Tensor([[99, 99]]))
        stream.put(Tensor([0x4e2d]))
        stream.put(Tensor([0x6587]))
        now[0] = 3
        stream.put(Tensor([42]))
        stream.end()
        self.assertEqual(stream.text, "\u4e2d\u6587")
        self.assertEqual(rows[-1], {"event": "progress", "text": "\u4e2d\u6587", "tokens": 2})
        self.assertEqual(len(rows), 2)

    def test_partial_utf8_can_complete_on_next_token(self):
        rows = []
        stream = TranscriptStreamer(lambda ids: "\u4e2d" if len(ids) == 2 else "\ufffd",
                                     rows.append, AudioDeadline(5))
        stream.put(Tensor([[99]]))
        stream.put(Tensor([1]))
        self.assertEqual(stream.text, "")
        stream.put(Tensor([2]))
        self.assertEqual(stream.text, "\u4e2d")

    def receiver(self, rows):
        worker = FunProcess.__new__(FunProcess)
        worker.responses = queue.Queue()
        for row in rows:
            worker.responses.put(row)
        worker.closed = False
        worker.close = lambda: setattr(worker, "closed", True)
        return worker

    def test_normal_result_and_next_request(self):
        deadline = AudioDeadline(1)
        worker = self.receiver([(deadline.started, {"event": "result", "requestId": "a", "text": "ok"})])
        self.assertEqual(worker._receive_decode("a", deadline)["text"], "ok")
        self.assertFalse(worker.closed)
        worker.responses.put((time.monotonic(), {"event": "result", "requestId": "b", "text": "next"}))
        self.assertEqual(worker._receive_decode("b", AudioDeadline(1))["text"], "next")

    def test_late_final_keeps_only_predeadline_snapshot(self):
        deadline = AudioDeadline(.01)
        worker = self.receiver([
            (deadline.started, {"event": "progress", "requestId": "a", "text": "partial", "tokens": 2}),
            (deadline.ends, {"event": "result", "requestId": "a", "text": "late"})])
        result = worker._receive_decode("a", deadline)
        self.assertEqual(result["text"], "partial")
        self.assertEqual(result["completion"], "partial")
        self.assertTrue(worker.closed)

    def test_empty_timeout_is_not_success_or_no_speech(self):
        result = self.receiver([])._receive_decode("a", AudioDeadline(.005))
        self.assertEqual(result["text"], "")
        self.assertEqual(result["stopReason"], "audio_duration_deadline")
        self.assertFalse(result["reachedEos"])

    def test_wrong_request_rejected(self):
        worker = self.receiver([(time.monotonic(), {"event": "result", "requestId": "old", "text": "old"})])
        with self.assertRaisesRegex(RuntimeError, "identity"):
            worker._receive_decode("new", AudioDeadline(1))

    def test_worker_error_retains_received_text_without_a_retry(self):
        deadline = AudioDeadline(1)
        worker = self.receiver([
            (deadline.started, {"event": "progress", "requestId": "a", "text": "kept", "tokens": 2}),
            (deadline.started, {"error": "ASR worker exited"})])
        result = worker._receive_decode("a", deadline)
        self.assertEqual(result['text'], 'kept')
        self.assertEqual(result['tokens'], 2)
        self.assertEqual(result['completion'], 'partial')
        self.assertEqual(result['stopReason'], 'worker_error')
        self.assertEqual(result['error'], 'ASR worker exited')
        self.assertTrue(worker.closed)

    def test_empty_worker_error_is_not_no_speech_or_completed(self):
        worker = self.receiver([(time.monotonic(), {"error": "worker failed"})])
        result = worker._receive_decode('a', AudioDeadline(1))
        self.assertEqual(result['text'], '')
        self.assertEqual(result['completion'], 'partial')
        self.assertEqual(result['stopReason'], 'worker_error')
        self.assertTrue(worker.closed)

    def test_stuck_process_is_actually_reaped(self):
        worker = FunProcess.__new__(FunProcess)
        worker.sf = None
        worker.temporary = tempfile.TemporaryDirectory(prefix="test-voice-deadline-")
        worker.stderr = open(Path(worker.temporary.name) / "stderr.log", "w+b")
        worker.responses = queue.Queue()
        worker.process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=worker.stderr,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        process = worker.process
        try:
            result = worker._receive_decode("a", AudioDeadline(.03))
            self.assertEqual(result["completion"], "partial")
            self.assertIsNotNone(process.poll())
            self.assertIsNone(worker.process)
            self.assertLess(result["seconds"], 1)
            worker.close()
        finally:
            worker.close()

    @unittest.skipUnless(sys.platform == 'win32', 'Windows worker launchers have descendant processes')
    def test_timeout_reaps_descendants_while_controller_is_still_alive(self):
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        worker = FunProcess.__new__(FunProcess)
        child_handle = None
        code = ("import subprocess,sys,json,time; "
            "p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],"
            "stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,"
            "creationflags=subprocess.CREATE_NO_WINDOW); "
            "print(json.dumps({'ready':True,'childPid':p.pid}),flush=True); "
            "print(json.dumps({'event':'progress','requestId':'a','text':'kept','tokens':1}),flush=True); "
            "time.sleep(60)")
        try:
            worker._start([sys.executable, '-c', code], None)
            child_handle = kernel.OpenProcess(0x100000 | 0x0001, False, worker.receipt['childPid'])
            self.assertTrue(child_handle)
            result = worker._receive_decode('a', AudioDeadline(.05))
            self.assertEqual(result['text'], 'kept')
            self.assertEqual(result['completion'], 'partial')
            self.assertEqual(kernel.WaitForSingleObject(child_handle, 1000), 0,
                             'Native worker descendant is still running after the launcher was stopped')
            self.assertLess(result['cleanupSeconds'], 10)
        finally:
            if child_handle:
                kernel.TerminateProcess(child_handle, 1)
                kernel.WaitForSingleObject(child_handle, 3000)
                kernel.CloseHandle(child_handle)
            worker.close()


if __name__ == "__main__":
    unittest.main()
