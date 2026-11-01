package com.shadowagent.voice.core;

import android.content.SharedPreferences;
import org.json.JSONObject;
import org.junit.Test;
import java.lang.reflect.Proxy;
import java.util.HashMap;
import java.util.Map;
import static org.junit.Assert.*;

/** In-memory preferences only; no service, microphone, or Android runtime is started. */
public final class CaptureSettingsTest {
    @Test public void storageBlockPreservesIntentAndLiveSyncWithoutPretendingUserPaused() throws Exception {
        AppSettings settings = new AppSettings(preferences());
        settings.captureDesired(true);
        settings.autoEnabled(true);
        JSONObject snapshot = new JSONObject();
        AutoCaptureService.addCaptureSnapshot(snapshot, settings, true, true);
        assertTrue(snapshot.getBoolean("captureDesired"));
        assertTrue(snapshot.getBoolean("storageBlocked"));
        assertTrue(snapshot.getBoolean("captureBlocked"));
        assertTrue(snapshot.getBoolean("serviceRunning"));
        assertFalse(snapshot.getBoolean("paused"));
        assertFalse(snapshot.getBoolean("needs_restore"));
        assertTrue(settings.autoEnabled());
        assertFalse(AutoCaptureService.captureAllowed(true, settings.captureDesired(), true));
        AutoCaptureService.addCaptureSnapshot(snapshot, settings, true, false);
        assertFalse(snapshot.getBoolean("captureBlocked"));
        assertTrue(AutoCaptureService.captureAllowed(true, settings.captureDesired(), false));
    }

    @Test public void storageRecoveryCannotOverrideUserPauseOrRestartADeadService() throws Exception {
        AppSettings settings = new AppSettings(preferences());
        settings.captureDesired(false);
        JSONObject snapshot = new JSONObject();
        AutoCaptureService.addCaptureSnapshot(snapshot, settings, true, true);
        assertTrue(snapshot.getBoolean("paused"));
        assertTrue(snapshot.getBoolean("storageBlocked"));
        assertFalse(snapshot.getBoolean("captureBlocked"));
        AutoCaptureService.addCaptureSnapshot(snapshot, settings, true, false);
        assertTrue(snapshot.getBoolean("paused"));
        assertFalse(AutoCaptureService.captureAllowed(true, settings.captureDesired(), false));
        settings.captureDesired(true);
        AutoCaptureService.addCaptureSnapshot(snapshot, settings, false, false);
        assertTrue(snapshot.getBoolean("needs_restore"));
        assertFalse(AutoCaptureService.captureAllowed(false, settings.captureDesired(), false));
    }

    @Test public void interruptedProcessRetainsDesiredCaptureButNotActualEnabled() {
        SharedPreferences prefs = preferences();
        AppSettings settings = new AppSettings(prefs);
        settings.captureDesired(true);
        settings.autoEnabled(true);
        AppSettings.initializeProcess(prefs);
        assertTrue(settings.captureDesired());
        assertFalse(settings.autoEnabled());
        assertEquals("needs_restore", settings.lastMode());
    }

    @Test public void pausePersistsAcrossStopAndRepeatedProcessInitialization() {
        SharedPreferences prefs = preferences();
        AppSettings settings = new AppSettings(prefs);
        settings.captureDesired(false);
        settings.autoEnabled(true);
        settings.stopped("interrupted", "synthetic interruption");
        for (int i = 0; i < 3; i++) AppSettings.initializeProcess(prefs);
        assertFalse(settings.captureDesired());
        assertFalse(settings.autoEnabled());
    }

    @Test public void oldEnabledPreferenceMigratesOnlyToIntentNeverToMicrophoneAuthority() {
        SharedPreferences prefs = preferences();
        prefs.edit().putBoolean("autoEnabled", true).commit();
        AppSettings.initializeProcess(prefs);
        AppSettings settings = new AppSettings(prefs);
        assertTrue(settings.captureDesired());
        assertFalse(settings.autoEnabled());
        assertFalse(settings.pairingVerified());
    }

    @Test public void verificationPersistsButAnyCredentialChangeRevokesIt() throws Exception {
        SharedPreferences prefs = preferences();
        AppSettings settings = new AppSettings(prefs);
        String original = AppSettings.validatePairing(PairingFixture.pairing().toString()).toString();
        prefs.edit().putString("pairing", original).commit();
        assertFalse(settings.pairingVerified());
        settings.verifyPairing(settings.pairing());
        AppSettings.initializeProcess(prefs);
        assertTrue(settings.pairingVerified());
        prefs.edit().putString("pairing", settings.pairing().put("token", "replacement-token").toString()).commit();
        assertFalse(settings.pairingVerified());
        assertThrows(IllegalStateException.class, () -> settings.verifyPairing(PairingFixture.pairing()));
    }

    private static SharedPreferences preferences() {
        Map<String, Object> values = new HashMap<>();
        return (SharedPreferences) Proxy.newProxyInstance(SharedPreferences.class.getClassLoader(),
                new Class<?>[]{SharedPreferences.class}, (proxy, method, args) -> {
                    if (method.getName().equals("contains")) return values.containsKey(args[0]);
                    if (method.getName().equals("getAll")) return new HashMap<>(values);
                    if (method.getName().startsWith("get")) return values.getOrDefault(args[0], args[1]);
                    if (!method.getName().equals("edit")) throw new UnsupportedOperationException(method.getName());
                    Map<String, Object> pending = new HashMap<>(values);
                    return Proxy.newProxyInstance(SharedPreferences.Editor.class.getClassLoader(),
                            new Class<?>[]{SharedPreferences.Editor.class}, (editor, edit, arguments) -> {
                                String name = edit.getName();
                                if (name.equals("commit") || name.equals("apply")) {
                                    values.clear(); values.putAll(pending);
                                    return name.equals("commit") ? true : null;
                                }
                                if (name.equals("remove")) pending.remove(arguments[0]);
                                else if (name.equals("clear")) pending.clear();
                                else if (name.startsWith("put")) pending.put((String) arguments[0], arguments[1]);
                                else throw new UnsupportedOperationException(name);
                                return editor;
                            });
                });
    }
}
