package com.shadowagent.voice.core;

/** Input arbitration, independent of playback focus. STOP is terminal for one recorder. */
final class CaptureInputState {
    enum Event { DATA, SILENCED, AVAILABLE, STOP, FOCUS_LOSS_TRANSIENT, FOCUS_LOSS, FOCUS_DUCK, FOCUS_GAIN }
    enum State { STARTING, RECORDING, SILENCED, NO_DATA, STOPPED }
    static final long NO_DATA_MS = 5000;
    private State state = State.STARTING;
    private long lastData;
    private boolean interruption;

    CaptureInputState(long now) { lastData = now; }

    synchronized void accept(Event event, long now) {
        if (state == State.STOPPED) return;
        switch (event) {
            case STOP: state = State.STOPPED; break;
            case SILENCED:
                if (state != State.SILENCED) interruption = true;
                state = State.SILENCED;
                break;
            case AVAILABLE:
                if (state == State.SILENCED) { state = State.STARTING; lastData = now; }
                break;
            case DATA:
                if (state != State.SILENCED) { state = State.RECORDING; lastData = now; }
                break;
            // No playback in this recorder: focus is not permission to capture audio.
            case FOCUS_LOSS_TRANSIENT: case FOCUS_LOSS: case FOCUS_DUCK: case FOCUS_GAIN: break;
        }
    }

    synchronized boolean takeInterruption() {
        boolean value = interruption;
        interruption = false;
        return value;
    }

    synchronized State state(long now) {
        if ((state == State.STARTING || state == State.RECORDING) && now - lastData >= NO_DATA_MS)
            state = State.NO_DATA;
        return state;
    }
}
