from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/voice-runtime"))
from probe_diarization import Monitor


class MonitorCleanupTests(unittest.TestCase):
    def fixture(self):
        monitor = Monitor.__new__(Monitor)
        monitor.stop = Mock()
        monitor.gpu_process = Mock()
        monitor.gpu_process.poll.return_value = None
        monitor.threads = [Mock(), Mock()]
        for thread in monitor.threads:
            thread.is_alive.return_value = False
        return monitor

    def test_hung_monitor_killed_without_masking_inference_result(self):
        monitor = self.fixture()
        monitor.gpu_process.wait.side_effect = [subprocess.TimeoutExpired("monitor", 10), 0]
        monitor.close()
        monitor.gpu_process.kill.assert_called_once()
        monitor.gpu_process.stdout.close.assert_called_once()
        self.assertEqual(monitor.cleanup_errors, [])

    def test_uninterruptible_driver_monitor_is_reported(self):
        monitor = self.fixture()
        monitor.gpu_process.wait.side_effect = subprocess.TimeoutExpired("monitor", 10)
        monitor.threads[0].is_alive.return_value = True
        monitor.close()
        self.assertEqual(len(monitor.cleanup_errors), 1)
        monitor.gpu_process.stdout.close.assert_not_called()


if __name__ == "__main__":
    unittest.main()
