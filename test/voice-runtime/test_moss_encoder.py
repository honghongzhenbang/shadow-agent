from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/voice-runtime"))


class EncoderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import torch
            import transformers
        except ImportError:
            raise unittest.SkipTest("Run in the explicitly provisioned MOSS CUDA environment")
        cls.torch = torch

    def test_independent_chunks_keep_order_and_joint_shape(self):
        torch = self.torch
        from moss_runtime import install_encoder_microbatch
        calls = []
        class Encoder(torch.nn.Module):
            def forward(self, features, return_dict=True):
                calls.append(features.shape[0])
                return SimpleNamespace(last_hidden_state=features * 2 + 1)
        model = SimpleNamespace(model=SimpleNamespace(whisper_encoder=Encoder()))
        features = torch.arange(48).reshape(4, 3, 4).float()
        expected = model.model.whisper_encoder(features).last_hidden_state
        install_encoder_microbatch(model)
        actual = model.model.whisper_encoder(features, return_dict=True).last_hidden_state
        self.assertTrue(torch.equal(actual, expected))
        self.assertEqual(calls, [4, 1, 1, 1, 1])
        with self.assertRaises(ValueError):
            model.model.whisper_encoder(features, return_dict=False)


if __name__ == "__main__":
    unittest.main()
