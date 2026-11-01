from array import array
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/voice-runtime"))
from prepare_moss_silence_diagnostic import main, metrics, read_pcm, write_audio
from runtime_common import sha256


class SilenceDiagnosticTests(unittest.TestCase):
    def test_zero_and_quiet_are_not_conflated(self):
        self.assertTrue(metrics(array("h", [0, 0]))["digitalZero"])
        quiet = metrics(array("h", [1, -1]))
        self.assertFalse(quiet["digitalZero"])
        self.assertLess(quiet["rmsDbfs"], -80)

    def test_pcm_round_trip_and_hash_guard(self):
        with tempfile.TemporaryDirectory() as temp:
            samples = array("h", [-32768, -1, 0, 1, 32767])
            item = write_audio(Path(temp), "control", samples, {"synthetic": True})
            self.assertEqual(read_pcm(item), samples)
            item["sha256"] = "wrong"
            with self.assertRaisesRegex(ValueError, "changed"):
                read_pcm(item)

    def test_reject_wrong_sample_rate(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "wrong-rate.wav"
            with wave.open(str(path), "wb") as writer:
                writer.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
                writer.writeframes(bytes(100))
            with self.assertRaisesRegex(ValueError, "16 kHz"):
                read_pcm({"audio": str(path), "sha256": sha256(path), "id": "wrong-rate"})

    def test_controls_have_exact_duration_provenance_and_no_source_write(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            samples = array("h", [0]) * (120 * 16000)
            samples[96 * 16000:106 * 16000] = array("h", [1000]) * (10 * 16000)
            suspect = write_audio(root, "suspect", samples, {})
            first = write_audio(root, "first", array("h", [100]) * (70 * 16000), {})
            second = write_audio(root, "second", array("h", [-100]) * (60 * 16000), {})
            first["group"] = "user-check"
            second["group"] = "one-meter"
            suspect["group"] = "engineering"
            source = root / "inputs.json"
            source.write_text(json.dumps({"inputs": [suspect, first, second]}), encoding="utf-8")
            output = root / "derived"
            argv = ["prepare", "--inputs", str(source), "--suspect-id", "suspect", "--output", str(output)]
            with patch.object(sys, "argv", argv):
                main()
            data = json.loads((output / "sdpa.inputs.private.json").read_text(encoding="utf-8"))
            self.assertEqual([row["seconds"] for row in data["inputs"]], [10, 10, 10, 120])
            self.assertEqual(data["inputs"][0]["provenance"]["startSeconds"], 96)
            self.assertTrue(data["inputs"][-1]["provenance"]["synthetic"])
            self.assertEqual(data["inputs"][-1]["provenance"]["sources"][-1]["seconds"], 50)
            for item in (suspect, first, second):
                self.assertEqual(sha256(item["audio"]), item["sha256"])
            with patch.object(sys, "argv", argv), self.assertRaises(FileExistsError):
                main()


if __name__ == "__main__":
    unittest.main()
