package com.shadowagent.voice.core;

import android.content.Context;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioRecordingConfiguration;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.SystemClock;

import java.io.IOException;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** One audio thread, bounded nonblocking reads, no network work on the capture path. */
final class PcmRecorder {
    enum Outcome { STOPPED, RETRY, PERMISSION, STORAGE, FATAL }
    interface Listener { void onFinished(String error, Outcome outcome); }
    private final RecordingStore store;
    private final AudioManager audioManager;
    private final Handler main;
    private final Listener listener;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final StartStopGate audioGate = new StartStopGate();
    private final CaptureInputState input = new CaptureInputState(SystemClock.elapsedRealtime());
    private volatile String failure = "";
    private volatile long startElapsed;
    private volatile long capturedSamples;
    private volatile AudioRecord activeAudio;
    private Outcome outcome = Outcome.STOPPED;

    /** The stop barrier and physical microphone start share one lock, including state publication. */
    static final class StartStopGate {
        interface Start { void run() throws IOException; }
        private volatile boolean stopping;
        synchronized boolean start(Start action) throws IOException {
            if (stopping) return false;
            action.run();
            return true;
        }
        synchronized void stop(Runnable action) {
            stopping = true;
            action.run();
        }
        boolean stopping() { return stopping; }
    }

    PcmRecorder(Context context, RecordingStore store, Handler main, Listener listener) {
        this.store = store; this.main = main; this.listener = listener;
        audioManager = context.getSystemService(AudioManager.class);
    }

    void start(String conversationId) {
        // Input-only: do not request playback focus or interpret focus loss as input denial.
        worker.execute(() -> capture(conversationId));
        worker.shutdown();
    }

    void stop(String error) {
        audioGate.stop(() -> {
            if (error != null && !error.isEmpty() && failure.isEmpty()) failure = error;
            AudioRecord audio = activeAudio;
            if (audio != null) {
                try { audio.stop(); } catch (RuntimeException ignored) { }
            }
            input.accept(CaptureInputState.Event.STOP, SystemClock.elapsedRealtime());
        });
    }
    boolean isRecording() { return input.state(SystemClock.elapsedRealtime()) == CaptureInputState.State.RECORDING; }
    String suspension() {
        CaptureInputState.State state = input.state(SystemClock.elapsedRealtime());
        if (state == CaptureInputState.State.SILENCED) return "系统已将麦克风静音，采集挂起；等待系统允许后自动恢复。";
        if (state == CaptureInputState.State.NO_DATA) return "麦克风没有返回音频，采集挂起；等待重试。";
        return "";
    }
    long elapsedMs() { return isRecording() ? capturedSamples * 1000 / WavFile.RATE : 0; }

    private void observeInput(AudioRecord audio) {
        AudioRecordingConfiguration config = audio.getActiveRecordingConfiguration();
        boolean silenced = (config != null && config.isClientSilenced())
                || (audioManager != null && audioManager.isMicrophoneMute());
        if (silenced || config != null) {
            input.accept(silenced ? CaptureInputState.Event.SILENCED : CaptureInputState.Event.AVAILABLE,
                    SystemClock.elapsedRealtime());
        }
    }

    private static final class InputUnavailable extends IOException {
        InputUnavailable(String message) { super(message); }
    }

    private void capture(String conversationId) {
        AudioRecord audio = null;
        RecordingStore.Chunk chunk = null;
        String packageId = UUID.randomUUID().toString();
        int partIndex = 0;
        AudioManager.AudioRecordingCallback callback = new AudioManager.AudioRecordingCallback() {
            @Override public void onRecordingConfigChanged(List<AudioRecordingConfiguration> configs) {
                synchronized (audioGate) {
                    // Re-query our own recorder; never act on another client's or stale callback state.
                    if (audioGate.stopping() || activeAudio == null) return;
                    try { observeInput(activeAudio); } catch (RuntimeException ignored) { }
                }
            }
        };
        boolean registered = false;
        try {
            if (audioGate.stopping()) return;
            store.checkCapacity();
            int minimum = AudioRecord.getMinBufferSize(WavFile.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (minimum <= 0) throw new IOException("设备不支持 16 kHz 单声道录音。");
            try {
                audio = new AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.MIC)
                        .setAudioFormat(new AudioFormat.Builder().setSampleRate(WavFile.RATE)
                                .setChannelMask(AudioFormat.CHANNEL_IN_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                        .setBufferSizeInBytes(Math.max(minimum * 2, WavFile.RATE * 4)).build();
                activeAudio = audio;
                if (audio.getState() != AudioRecord.STATE_INITIALIZED) throw new InputUnavailable("麦克风暂不可用，采集挂起，稍后重试。");
                audio.registerAudioRecordingCallback(command -> main.post(command), callback);
                registered = true;
                AudioRecord ready = audio;
                if (!audioGate.start(() -> {
                    ready.startRecording();
                    if (ready.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING)
                        throw new InputUnavailable("麦克风未能开始采集，稍后重试。");
                    startElapsed = SystemClock.elapsedRealtime();
                })) return;
            } catch (SecurityException denied) { throw denied; }
            catch (IllegalStateException | UnsupportedOperationException unavailable) {
                throw new InputUnavailable("麦克风暂不可用，采集挂起，稍后重试。");
            }
            byte[] buffer = new byte[3200];
            long lastCapacity = startElapsed;
            long lastSync = startElapsed;
            while (!audioGate.stopping()) {
                observeInput(audio);
                boolean wasSilenced = input.state(SystemClock.elapsedRealtime()) == CaptureInputState.State.SILENCED;
                int read;
                try { read = audio.read(buffer, 0, buffer.length, AudioRecord.READ_NON_BLOCKING); }
                catch (IllegalStateException unavailable) { throw new InputUnavailable("麦克风读取中断，采集挂起，稍后重试。"); }
                observeInput(audio);
                if (audioGate.stopping()) break;
                if (read < 0) {
                    throw new InputUnavailable("麦克风采集暂不可用（" + read + "），稍后重试。");
                }
                long now = SystemClock.elapsedRealtime();
                boolean interrupted = input.takeInterruption();
                if (wasSilenced || interrupted || input.state(now) == CaptureInputState.State.SILENCED) {
                    if (chunk != null) {
                        RecordingStore.Chunk interruptedChunk = chunk;
                        chunk = null;
                        store.finish(interruptedChunk, "系统静音，片段在挂起前结束。",
                                true);
                    }
                    packageId = UUID.randomUUID().toString();
                    partIndex = 0;
                    // Drain and discard system-silenced buffers, preserving the platform's arbitration.
                    Thread.sleep(50);
                    continue;
                }
                if (read == 0) {
                    if (input.state(now) == CaptureInputState.State.NO_DATA)
                        throw new InputUnavailable("麦克风连续 5 秒没有返回音频，采集挂起，稍后重试。");
                    Thread.sleep(10);
                } else {
                    if ((read & 1) != 0) throw new IOException("麦克风返回不完整的 PCM 样本，已停止录音。");
                    input.accept(CaptureInputState.Event.DATA, now);
                    int offset = 0;
                    while (offset < read && !audioGate.stopping()
                            && input.state(now) == CaptureInputState.State.RECORDING) {
                        if (chunk == null) {
                            chunk = store.begin(conversationId, packageId, partIndex++, null);
                        }
                        if (chunk.wav.samples() >= WavFile.MAX_SAMPLES) {
                            RecordingStore.Chunk complete = chunk;
                            // Do not publish a nonterminal full part until the next sample proves
                            // that a continuation exists. An exact-boundary stop therefore closes
                            // the current part as terminal without a manifest/upload race.
                            chunk = store.begin(conversationId, packageId, partIndex++,
                                    complete.metadata.optString("recordingId"));
                            store.finish(complete, "", false);
                            continue;
                        }
                        int length = (int) Math.min(read - offset, (WavFile.MAX_SAMPLES - chunk.wav.samples()) * 2);
                        chunk.wav.append(buffer, offset, length);
                        capturedSamples += length / 2;
                        offset += length;
                    }
                }
                if (now - lastCapacity >= 1000) { store.checkCapacity(); lastCapacity = now; }
                if (chunk != null && now - lastSync >= 5000) { chunk.wav.sync(); lastSync = now; }
            }
        } catch (RecordingStore.CapacityException e) {
            outcome = Outcome.STORAGE;
            failure = e.getMessage();
        } catch (SecurityException e) {
            outcome = Outcome.PERMISSION;
            failure = "麦克风权限已撤回，录音已停止。";
        } catch (InputUnavailable e) {
            if (!audioGate.stopping()) { outcome = Outcome.RETRY; failure = e.getMessage(); }
        } catch (IOException e) {
            outcome = Outcome.FATAL;
            failure = safeError(e);
        } catch (Exception e) {
            if (!audioGate.stopping()) { outcome = Outcome.FATAL; failure = safeError(e); }
        } finally {
            stop("");
            if (audio != null) {
                if (registered) try { audio.unregisterAudioRecordingCallback(callback); } catch (RuntimeException ignored) { }
                synchronized (audioGate) {
                    activeAudio = null;
                    try { audio.release(); }
                    catch (RuntimeException e) { outcome = Outcome.FATAL; failure = "释放麦克风时发生异常，录音已停止。"; }
                }
            }
            if (chunk != null) {
                try { store.finish(chunk, failure, true); }
                catch (Exception e) { outcome = Outcome.FATAL; failure = safeError(e); }
            }
            String result = failure;
            Outcome finished = outcome;
            main.post(() -> listener.onFinished(result, finished));
        }
    }

    static String safeError(Exception e) {
        String value = e.getMessage();
        return value == null || value.isEmpty() ? e.getClass().getSimpleName() : value;
    }
}
