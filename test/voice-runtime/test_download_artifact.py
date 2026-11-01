import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/voice-runtime"))
from download_artifact import download


class Response:
    status_code = 206

    def __init__(self, data, start, end, size, wrong_range=False):
        self.data = data
        self.headers = {"Content-Range": "bytes %d-%d/%d" % (0 if wrong_range else start, end, size)}

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def raise_for_status(self):
        pass

    def iter_content(self, _):
        yield self.data


class DownloadTests(unittest.TestCase):
    def test_resumes_and_verifies(self):
        data = b"a" * (1024 * 1024) + b"last"
        digest = hashlib.sha256(data).hexdigest()
        requests = []
        def get(url, headers, **_):
            start, end = map(int, headers["Range"].removeprefix("bytes=").split("-"))
            requests.append((start, end))
            return Response(data[start:end + 1], start, end, len(data))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model"
            parts = path.with_name(path.name + ".parts")
            parts.mkdir()
            (parts / "0").write_bytes(data[:27])
            with patch("download_artifact.requests.get", get):
                download("https://example.test/file", path, len(data), digest, workers=2)
            self.assertEqual(path.read_bytes(), data)
            self.assertIn((27, 1048575), requests)
            with patch("download_artifact.requests.get", side_effect=AssertionError("Unexpected network")), \
                    patch.object(Path, "read_bytes", side_effect=AssertionError("Cached weights must stream")):
                download("https://example.test/file", path, len(data), digest)

    def test_wrong_range_is_not_published(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model"
            parts = path.with_name(path.name + ".parts")
            parts.mkdir()
            (parts / "0").write_bytes(b"a")
            response = Response(b"bc", 1, 2, 3, wrong_range=True)
            with patch("download_artifact.requests.get", return_value=response), patch("download_artifact.time.sleep"):
                with self.assertRaises(RuntimeError):
                    download("https://example.test/file", path, 3, hashlib.sha256(b"abc").hexdigest())
            self.assertFalse(path.exists())
            self.assertEqual((parts / "0").read_bytes(), b"a")

    def test_wrong_hash_is_not_published(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model"
            with patch("download_artifact.requests.get", return_value=Response(b"abc", 0, 2, 3)):
                with self.assertRaises(ValueError):
                    download("https://example.test/file", path, 3, "0" * 64)
            self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
