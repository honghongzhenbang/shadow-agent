from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/voice-runtime"))
from moss_attention_probe import attention_signature, backend_context, process_memory, trace_attention


class AttentionProbeTests(unittest.TestCase):
    def test_forced_flash_has_no_other_fallback(self):
        attention = SimpleNamespace(SDPBackend=SimpleNamespace(FLASH_ATTENTION="flash"), sdpa_kernel=Mock())
        torch = SimpleNamespace(nn=SimpleNamespace(attention=attention))
        backend_context(torch, "flash")
        attention.sdpa_kernel.assert_called_once_with(["flash"])
        with self.assertRaises(ValueError):
            backend_context(torch, "invented")

    def test_auto_does_not_change_global_backend(self):
        with backend_context(None, "auto"):
            pass

    def test_decode_trace_does_not_expand_per_token(self):
        q = SimpleNamespace(dtype="bf16", shape=[1, 16, 1, 128])
        k = SimpleNamespace(shape=[1, 8, 300, 128])
        key = attention_signature(q, k, None, False)
        k.shape[-2] = 400
        self.assertEqual(key, attention_signature(q, k, None, False))
        self.assertNotEqual(key, attention_signature(q, k, object(), False))

    def test_tracing_restores_function_after_failure(self):
        original = Mock()
        torch = SimpleNamespace(nn=SimpleNamespace(functional=SimpleNamespace(scaled_dot_product_attention=original)))
        with self.assertRaises(RuntimeError):
            with trace_attention(torch, True, []):
                self.assertIsNot(torch.nn.functional.scaled_dot_product_attention, original)
                raise RuntimeError("model failed")
        self.assertIs(torch.nn.functional.scaled_dot_product_attention, original)

    def test_private_commit_is_not_named_rss(self):
        process = Mock()
        process.memory_info.return_value = SimpleNamespace(rss=10, private=30, num_page_faults=5)
        self.assertEqual(process_memory(process), {"rssBytes": 10, "privateBytes": 30, "pageFaults": 5})


if __name__ == "__main__":
    unittest.main()
