import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/voice-runtime"))
from compare_moss_probe import edits, normalize
from prepare_moss_probe import main as prepare
from runtime_common import sha256


class MossProbeTests(unittest.TestCase):
    def test_proxy_metric_keeps_numeral_difference(self):
        self.assertEqual(normalize("A, b! 3"), "ab3")
        self.assertNotEqual(normalize("3"), normalize("three"))

    def test_edits(self):
        self.assertEqual(edits("abc", "abc"), 0)
        self.assertEqual(edits("abc", "ac"), 1)
        self.assertEqual(edits("", "abc"), 3)
        self.assertEqual(edits("kitten", "sitting"), 3)

    def test_input_manifest_excludes_answers_and_preserves_fingerprint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            audio = root / "audio.wav"
            with wave.open(str(audio), "wb") as stream:
                stream.setnchannels(1)
                stream.setsampwidth(2)
                stream.setframerate(16000)
                stream.writeframes(b"\0" * 32000)
            reference = root / "reference.json"
            reference.write_text(json.dumps({"rows": [{"recordingId": "sample", "group": "speech",
                "audioPath": str(audio), "reference": {"text": "secret-answer"}}]}), encoding="utf-8")
            output = root / "inputs.json"
            with patch.object(sys, "argv", ["probe", "--reference", str(reference), "--output", str(output)]):
                prepare()
                with self.assertRaises(ValueError):
                    prepare()
            text = output.read_text(encoding="utf-8")
            self.assertNotIn("secret-answer", text)
            item = json.loads(text)["inputs"][0]
            self.assertEqual(item["seconds"], 1)
            self.assertEqual(item["sha256"], hashlib.sha256(audio.read_bytes()).hexdigest())

    def test_large_hash_streams(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model"
            data = b"x" * (3 * 1024 * 1024 + 23)
            path.write_bytes(data)
            with patch.object(Path, "read_bytes", side_effect=AssertionError("Must not load whole weight")):
                self.assertEqual(sha256(path), hashlib.sha256(data).hexdigest())


if __name__ == "__main__":
    unittest.main()
