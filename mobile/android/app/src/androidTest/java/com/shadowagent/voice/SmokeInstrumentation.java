package com.shadowagent.voice;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;
import com.shadowagent.voice.core.AppSettings;
import com.shadowagent.voice.core.AutoCaptureService;
import com.shadowagent.voice.core.BluetoothBridgeClient;
import com.shadowagent.voice.core.BluetoothTransportSmoke;
import com.shadowagent.voice.core.BridgeHealth;
import com.shadowagent.voice.core.RecordingStore;

/** Runs only when explicitly installed as a separate instrumentation APK. */
public final class SmokeInstrumentation extends Instrumentation {
    private Bundle arguments;
    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); this.arguments = arguments; start(); }

    @Override public void onStart() {
        Bundle result = new Bundle(); Activity activity = null;
        if (arguments != null && (arguments.containsKey("bluetoothPairingFile") || arguments.containsKey("bluetoothAddress"))) {
            try {
                BluetoothTransportSmoke.run(getTargetContext(), arguments.getString("bluetoothPairingFile"),
                        arguments.getString("bluetoothAddress"), result);
                result.putString("stream", "PASS: Bluetooth pinned TLS health, testOnly gzip upload, duplicate receipt, isolated store cleanup\n");
                finish(Activity.RESULT_OK, result);
            } catch (Throwable error) {
                String category = error instanceof BluetoothBridgeClient.PermissionRequiredException
                        ? "PERMISSION_REQUIRED" : BridgeHealth.classify(error).name();
                result.putString("exceptionType", error.getClass().getName());
                StringBuilder locations = new StringBuilder();
                for (StackTraceElement frame : error.getStackTrace()) {
                    if (!frame.getClassName().startsWith("com.shadowagent.voice.")) continue;
                    if (locations.length() > 0) locations.append("; ");
                    locations.append(frame.getClassName()).append('.').append(frame.getMethodName())
                            .append(':').append(frame.getLineNumber());
                    if (locations.length() > 1200) break;
                }
                result.putString("appStack", locations.toString());
                result.putString("stream", "FAIL: Bluetooth smoke stage=" + result.getString("stage", "input")
                        + " category=" + category + "\n");
                finish(Activity.RESULT_CANCELED, result);
            }
            return;
        }
        try {
            Intent launch = new Intent(getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity = startActivitySync(launch); waitForIdleSync();
            Activity app = activity;
            require(find(app.getWindow().getDecorView(), "继续采集") != null, "single capture control");
            require(find(app.getWindow().getDecorView(), "自动模式") == null, "no redundant mode selector");
            require(!AutoCaptureService.snapshot(getTargetContext()).optBoolean("enabled"), "must not auto-start microphone");
            require(find(app.getWindow().getDecorView(), "电脑连接") != null, "BLE status separated from network status");
            require(find(app.getWindow().getDecorView(), "上传通道") != null, "network status visible");
            runOnMainSync(() -> find(app.getWindow().getDecorView(), "记录").performClick()); waitForIdleSync();
            require(find(app.getWindow().getDecorView(), "采集记录") != null, "recordings tab");
            require(new RecordingStore(getTargetContext()).list() != null, "persistent recording store");
            int lifecycleChecks = com.shadowagent.voice.core.RecordingLifecycleSmoke.run(getTargetContext());
            runOnMainSync(() -> find(app.getWindow().getDecorView(), "设置").performClick()); waitForIdleSync();
            require(find(app.getWindow().getDecorView(), "电脑配对") != null, "settings tab");
            boolean rejected = false;
            try { new AppSettings(getTargetContext()).importPairing("{\"serverUrl\":\"http://evil.example\"}"); }
            catch (IllegalArgumentException expected) { rejected = true; }
            require(rejected, "reject unsafe pairing");
            boolean traversal = false;
            try { ExportProvider.uri(getTargetContext(), new java.io.File(getTargetContext().getCacheDir(), "../secret.zip")); }
            catch (java.io.IOException expected) { traversal = true; }
            require(traversal, "reject exporting outside cache");
            int transportChecks = 0;
            if (arguments != null && arguments.containsKey("pairing"))
                transportChecks = com.shadowagent.voice.core.TransportSmoke.run(getTargetContext(), arguments.getString("pairing"));
            runOnMainSync(() -> find(app.getWindow().getDecorView(), "状态").performClick()); waitForIdleSync();
            require(find(app.getWindow().getDecorView(), "影子 Agent") != null, "canonical mascot visible");
            if (arguments != null && arguments.containsKey("preview")) {
                require(BuildConfig.DEBUG, "previews only available in debug instrumentation");
                java.lang.reflect.Field timer = MainActivity.class.getDeclaredField("refresh"); timer.setAccessible(true);
                java.lang.reflect.Field handler = MainActivity.class.getDeclaredField("handler"); handler.setAccessible(true);
                ((android.os.Handler) handler.get(app)).removeCallbacks((Runnable) timer.get(app));
                String preview = arguments.getString("preview");
                org.json.JSONObject sample = new org.json.JSONObject();
                sample.put("enabled", !preview.equals("paused")); sample.put("recording", preview.equals("recording"));
                sample.put("mode", preview.equals("recording") ? "away" : preview.equals("paused") ? "disabled" : "near");
                sample.put("status", preview.equals("recording") ? "正在保存声音，返回电脑后同步。" : preview.equals("paused") ? "已停止新录音，待处理片段仍会同步。" : "离开后录音，返回后同步。");
                sample.put("elapsedMs", preview.equals("recording") ? 752000 : 0);
                sample.put("connected", preview.equals("near")); sample.put("uploadChannel", preview.equals("near") ? "蓝牙已验证" : "等待连接");
                sample.put("queuedCount", 2);
                runOnMainSync(() -> ((MainActivity) app).renderStatus(sample)); waitForIdleSync();
                if (preview.equals("settings")) {
                    runOnMainSync(() -> find(app.getWindow().getDecorView(), "设置").performClick()); waitForIdleSync();
                }
                if (preview.equals("records")) {
                    runOnMainSync(() -> find(app.getWindow().getDecorView(), "记录").performClick()); waitForIdleSync();
                    android.os.SystemClock.sleep(300);
                    org.json.JSONArray records = new org.json.JSONArray();
                    for (int i = 0; i < 3; i++) records.put(new org.json.JSONObject()
                        .put("id", "preview-" + i).put("sessionId", "preview-session").put("recordedAt", "2026-10-17T08:30:00Z")
                        .put("durationMs", 120000).put("state", "cleaned").put("processingStatus", "completed")
                        .put("phoneAudioDeleted", true).put("audioDeleted", true).put("audioAvailable", false));
                    java.lang.reflect.Method render = MainActivity.class.getDeclaredMethod("renderRecordings", org.json.JSONArray.class); render.setAccessible(true);
                    runOnMainSync(() -> { try { render.invoke(app, records); } catch (Exception e) { throw new RuntimeException(e); } }); waitForIdleSync();
                    require(find(app.getWindow().getDecorView(), "展开片段") != null, "session grouped");
                    runOnMainSync(() -> find(app.getWindow().getDecorView(), "展开片段").performClick()); waitForIdleSync();
                    require(find(app.getWindow().getDecorView(), "收起片段") != null, "session expands");
                    require(find(app.getWindow().getDecorView(), "播放录音") == null, "cleaned audio has no play action");
                    require(find(app.getWindow().getDecorView(), "导出录音") == null, "cleaned audio has no export action");
                }
                android.os.SystemClock.sleep(350);
                String output = arguments.getString("screenshot");
                if (output != null) {
                    android.graphics.Bitmap bitmap = getUiAutomation().takeScreenshot();
                    try (java.io.FileOutputStream file = new java.io.FileOutputStream(output)) { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, file); }
                    bitmap.recycle();
                }
                require(!AutoCaptureService.snapshot(getTargetContext()).optBoolean("recording"), "preview never starts microphone");
            }
            result.putString("stream", "PASS: UI navigation, no implicit recording, durable cleanup lifecycle=" + lifecycleChecks + ", pairing validation, export boundary; transport checks=" + transportChecks + "\n");
            result.putInt("checks", 11 + transportChecks + lifecycleChecks); finish(Activity.RESULT_OK, result);
        } catch (Throwable error) {
            result.putString("stream", "FAIL: " + android.util.Log.getStackTraceString(error));
            finish(Activity.RESULT_CANCELED, result);
        }
    }

    private static View find(View view, String text) {
        if (text.contentEquals(view.getContentDescription() == null ? "" : view.getContentDescription())) return view;
        if (view instanceof TextView && text.contentEquals(((TextView) view).getText())) return view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) { View found = find(group.getChildAt(i), text); if (found != null) return found; }
        }
        return null;
    }
    private static void require(boolean value, String check) { if (!value) throw new AssertionError(check); }
}
