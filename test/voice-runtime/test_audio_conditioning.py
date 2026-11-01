"""Gain is bounded, monotonic in sample time and never mutates source audio."""
import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts/voice-runtime'))
import numpy as np
from audio_conditioning import bounded_gain


class Conditioning(unittest.TestCase):
    def test_silence_stays_silence(self):
        out, info = bounded_gain(np.zeros(16000), np)
        self.assertFalse(out.any())
        self.assertEqual(info['gainDb'], 0)

    def test_weak_speech_bounded_without_source_mutation(self):
        source = (.001*np.sin(np.arange(16000)*.1)).astype(np.float32)
        before = source.copy()
        out, info = bounded_gain(source, np)
        self.assertTrue(np.array_equal(source, before))
        self.assertEqual(len(out), len(source))
        self.assertAlmostEqual(info['gainDb'], 12)
        self.assertTrue(np.allclose(out, source*info['gainFactor']))

    def test_peak_headroom_and_disabled_gain(self):
        source = np.zeros(16000, dtype=np.float32)
        source[3] = .9
        out, info = bounded_gain(source, np)
        self.assertLessEqual(float(np.max(out)), .950001)
        self.assertTrue(np.array_equal(bounded_gain(source, np, 0)[0], source))
        loud = np.array([1.0,-1.0], dtype=np.float32)
        self.assertTrue(np.array_equal(bounded_gain(loud,np)[0], loud))

    def test_invalid_samples_or_gains_rejected(self):
        for value in (math.inf, math.nan, -1, 19):
            with self.assertRaises(ValueError):
                bounded_gain(np.ones(4), np, value)
        for values in ([], [math.nan], [[1,2]]):
            with self.assertRaises(ValueError):
                bounded_gain(values, np)


if __name__ == '__main__':
    unittest.main()
