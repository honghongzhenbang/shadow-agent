package com.shadowagent.voice.core;

import org.junit.Test;
import static org.junit.Assert.*;
import static com.shadowagent.voice.core.CaptureInputState.Event.*;
import static com.shadowagent.voice.core.CaptureInputState.State.*;

public final class CaptureInputStateTest {
    @Test public void startingIsNotRecordingUntilDataArrives() {
        CaptureInputState input = new CaptureInputState(0);
        input.accept(AVAILABLE, 0);
        assertEquals(STARTING, input.state(1));
        input.accept(DATA, 10);
        assertEquals(RECORDING, input.state(10));
    }

    @Test public void transientPlaybackFocusAndDuckDoNotDenyMicrophoneInput() {
        CaptureInputState input = new CaptureInputState(0);
        input.accept(DATA, 0);
        input.accept(FOCUS_LOSS_TRANSIENT, 1);
        assertEquals(RECORDING, input.state(1));
        input.accept(FOCUS_DUCK, 2);
        assertEquals(RECORDING, input.state(2));
    }

    @Test public void permanentPlaybackFocusLossDoesNotEndInputOrWaitForGain() {
        CaptureInputState input = new CaptureInputState(0);
        input.accept(FOCUS_LOSS, 1);
        input.accept(DATA, 2);
        assertEquals(RECORDING, input.state(2));
        input.accept(DATA, 60_000);
        assertEquals(RECORDING, input.state(60_000));
    }

    @Test public void silencedBuffersAreNotRecordingAndUnsilenceNeedsFreshData() {
        CaptureInputState input = new CaptureInputState(0);
        input.accept(DATA, 0);
        input.accept(CaptureInputState.Event.SILENCED, 1);
        input.accept(DATA, 2);
        input.accept(FOCUS_GAIN, 3);
        assertEquals(CaptureInputState.State.SILENCED, input.state(60_000));
        assertTrue(input.takeInterruption());
        assertFalse(input.takeInterruption());
        input.accept(AVAILABLE, 60_000);
        assertEquals(STARTING, input.state(60_000));
        input.accept(DATA, 60_010);
        assertEquals(RECORDING, input.state(60_010));
    }

    @Test public void shortSilenceStillSplitsChunkWhenCallbackClearsBeforeRead() {
        CaptureInputState input = new CaptureInputState(0);
        input.accept(DATA, 0);
        input.accept(CaptureInputState.Event.SILENCED, 1);
        input.accept(AVAILABLE, 2);
        assertTrue(input.takeInterruption());
        assertEquals(STARTING, input.state(2));
    }

    @Test public void missingAudioCannotRemainRecordingIndefinitely() {
        CaptureInputState input = new CaptureInputState(0);
        input.accept(DATA, 100);
        assertEquals(RECORDING, input.state(5099));
        assertEquals(NO_DATA, input.state(5100));
        input.accept(FOCUS_GAIN, 6000);
        input.accept(AVAILABLE, 6000);
        assertEquals(NO_DATA, input.state(6000));
    }

    @Test public void noInitialAudioTimesOutAndSilenceIsNotARestartLoop() {
        assertEquals(NO_DATA, new CaptureInputState(0).state(5000));
        CaptureInputState input = new CaptureInputState(0);
        input.accept(CaptureInputState.Event.SILENCED, 0);
        assertEquals(CaptureInputState.State.SILENCED, input.state(3_600_000));
    }

    @Test public void pauseWinsAgainstLateUnsilenceDataAndFocusGain() {
        CaptureInputState input = new CaptureInputState(0);
        input.accept(CaptureInputState.Event.SILENCED, 0);
        input.accept(STOP, 1);
        input.accept(AVAILABLE, 2);
        input.accept(DATA, 3);
        input.accept(FOCUS_GAIN, 4);
        assertEquals(STOPPED, input.state(100_000));
    }
}
