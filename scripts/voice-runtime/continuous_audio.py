"""Sample-addressable original timeline; file boundaries never reset VAD or resampling."""
from bisect import bisect_right
from datetime import datetime
from pathlib import Path
import tempfile

from runtime_common import read_audio_manifest, sha256


class ContinuousAudio:
    def __init__(self, paths, manifests, maximum, runtime, validate_path, formats):
        self.runtime = runtime
        self.temporary = None
        self.parts, self.sources, self.ends, self.warnings = [], [], [], []
        self.length = 0
        try:
            base_time = None
            for index, (path, manifest) in enumerate(zip(paths, manifests)):
                validate_path(path)
                info = runtime.sf.info(str(path))
                if info.format not in formats[path.suffix.lower()] or info.frames <= 0 \
                        or not 8000 <= info.samplerate <= 192000 or not 1 <= info.channels <= 8:
                    raise ValueError("Invalid source audio container or format")
                if (path.suffix.lower() == '.opus' and info.subtype != 'OPUS') or \
                        (path.suffix.lower() == '.ogg' and info.subtype not in {'VORBIS', 'OPUS'}):
                    raise ValueError("Unexpected Ogg codec")
                read_audio_manifest(path, info)
                if manifest:
                    if info.samplerate != 16000 or info.channels != 1 or manifest.get('sampleRateHz') != 16000 \
                            or manifest.get('channels') != 1 or manifest.get('sampleCount') != info.frames:
                        raise ValueError("Recording package sample metadata mismatch")
                    when = datetime.fromisoformat(manifest['recordedAt'].replace('Z', '+00:00'))
                    if when.tzinfo is None:
                        raise ValueError("Capture timestamp requires timezone")
                    base_time = when if base_time is None else base_time
                    if abs((when - base_time).total_seconds() - self.length / 16000) > .002:
                        raise ValueError("Non-contiguous recording package timestamps")
                elif len(paths) != 1:
                    raise ValueError("Multiple inputs require recording package manifests")
                length = round(info.frames * 16000 / info.samplerate)
                if (self.length + length) / 16000 > maximum:
                    raise ValueError("Recording exceeds duration limit")
                source_hash = sha256(path)
                original = path
                if info.samplerate != 16000 or info.channels != 1:
                    path, length = self._normalize(path, info)
                self.parts.append((path, self.length, self.length + length))
                self.sources.append({'recordingId': manifest.get('recordingId') if manifest else None,
                    'audioSha256': source_hash, 'partIndex': manifest.get('partIndex') if manifest else index,
                    'startSample': self.length, 'endSample': self.length + length,
                    'sourceSampleRateHz': info.samplerate, 'sourceSampleCount': info.frames})
                self.length += length
                self.ends.append(self.length)
                if sha256(original) != source_hash:
                    raise ValueError("Audio source changed during preparation")
        except BaseException:
            self.close()
            raise

    def _normalize(self, path, info):
        np, sf = self.runtime.np, self.runtime.sf
        self.temporary = tempfile.TemporaryDirectory(prefix='shadow-voice-normalized-')
        target = Path(self.temporary.name) / 'normalized.wav'
        converter = self.runtime.soxr.ResampleStream(info.samplerate, 16000, 1, dtype='float32', quality='HQ') \
            if info.samplerate != 16000 else None
        count = 0
        with sf.SoundFile(str(path)) as source, sf.SoundFile(str(target), mode='w', samplerate=16000,
                channels=1, subtype='FLOAT') as output:
            while source.tell() < info.frames:
                frame = source.read(min(info.samplerate * 10, info.frames - source.tell()), dtype='float32', always_2d=True)
                if not np.isfinite(frame).all():
                    raise ValueError("Nonfinite source audio")
                mono = np.mean(frame, axis=1, dtype=np.float32)
                if converter:
                    mono = converter.resample_chunk(mono, last=source.tell() == info.frames)
                output.write(mono)
                count += len(mono)
        if abs(count - round(info.frames * 16000 / info.samplerate)) > 1:
            raise ValueError("Continuous resampling duration mismatch")
        self.warnings.append('NORMALIZED_AUDIO_VIEW: continuous resampling/downmix; original retained')
        return target, count

    def __len__(self):
        return self.length

    def __getitem__(self, bounds):
        start, stop, step = bounds.indices(self.length)
        if step != 1 or stop <= start or stop - start > 120 * 16000:
            raise ValueError("Audio view must be contiguous, nonempty and at most 120 seconds")
        np, sf = self.runtime.np, self.runtime.sf
        result, cursor = np.empty(stop - start, dtype=np.float32), 0
        for path, first, last in self.parts[bisect_right(self.ends, start):]:
            if first >= stop:
                break
            begin, end = max(start, first), min(stop, last)
            values, rate = sf.read(str(path), start=begin-first, stop=end-first, dtype='float32')
            if rate != 16000 or values.ndim != 1 or len(values) != end - begin or not np.isfinite(values).all():
                raise ValueError("Audio source changed or contains nonfinite samples")
            result[cursor:cursor + len(values)] = values
            cursor += len(values)
        if cursor != len(result):
            raise ValueError("Incomplete audio range")
        return result

    def chunks(self, size=30 * 16000):
        if not isinstance(size, int) or not 0 < size <= 120 * 16000:
            raise ValueError("Invalid audio read size")
        for start in range(0, len(self), size):
            yield self[start:min(len(self), start + size)]

    def close(self):
        if self.temporary:
            self.temporary.cleanup()
            self.temporary = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
