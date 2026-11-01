package com.shadowagent.voice.core;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import com.shadowagent.voice.MainActivity;
import com.shadowagent.voice.R;

import org.json.JSONObject;

import java.io.IOException;
import java.util.Locale;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.Objects;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Started only by an explicit visible-activity action. No receiver, alarm, sticky restart, or boot path. */
public final class AutoCaptureService extends Service {
    public static final String ACTION_ENABLE = "com.shadowagent.voice.action.ENABLE";
    public static final String ACTION_DISABLE = "com.shadowagent.voice.action.DISABLE";
    private static final String CHANNEL = "voice_automatic_capture";
    private static final int NOTIFICATION = 3101;
    private static final String TAG = "ShadowVoiceAuto";
    private static volatile AutoCaptureService live;
    private static volatile RecordingStore snapshotStore;
    private volatile String published;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final RetryBackoff backoff = new RetryBackoff();
    private final CaptureRecovery captureRecovery = new CaptureRecovery();
    private String captureWarning = "";
    private final BridgeHealth health = new BridgeHealth();
    private final BridgeHealth bluetoothHealth = new BridgeHealth(45_000);
    private final EndpointCandidates candidates = new EndpointCandidates();
    private AppSettings settings;
    private RecordingStore store;
    private ProximityPolicy policy;
    private BleMonitor ble;
    private BridgeClient bridge;
    private BluetoothBridgeClient bluetooth;
    private RecordingTransport uploading;
    private String bluetoothAddress;
    private JSONObject pairing;
    private String bridgeEndpoint;
    private ExecutorService healthWorker;
    private ExecutorService uploadWorker;
    private PcmRecorder recorder;
    private PowerManager.WakeLock wakeLock;
    private boolean enabled;
    private boolean stopping;
    private boolean destroyed;
    private boolean normalStop;
    private boolean trustedBle;
    private boolean healthBusy;
    private boolean bluetoothHealthBusy;
    private boolean uploadBusy;
    private boolean storageBlocked;
    private String storageWarning = "";
    private volatile String syncOperation = "";
    private Integer rssi;
    private long rssiAt;
    private long nextHealth;
    private long nextBluetoothHealth;
    private long nextUpload;
    private final SyncSchedule syncSchedule = new SyncSchedule();
    private long nextCapacity;
    private long nextWakeRenewal;
    private long lastNotification;
    private String sessionId;
    private String error = "";
    private String bleWarning = "";
    private String stopMode = "disabled";

    /** Scheduling only: both work types still use the existing single upload worker. */
    static final class SyncSchedule {
        private boolean uploadTurn;
        private long nextCompletion;
        boolean completionDue(long now) { return now >= nextCompletion; }
        boolean completionFirst(long now) { return !uploadTurn && completionDue(now); }
        void finished(boolean completion, long now) {
            uploadTurn = completion;
            if (completion) nextCompletion = now + 5000;
        }
    }

    static void preparePairingChange() {
        AutoCaptureService service = live;
        if (service == null) return;
        if (Looper.myLooper() != Looper.getMainLooper() || service.settings.captureDesired() || service.recorder != null)
            throw new IllegalStateException("请先暂停并等待当前片段保存，再修改配对配置。");
        // Revoke old transport authority before the replacement credentials become visible.
        service.disable("paused", "");
    }

    public static JSONObject snapshot(Context context) {
        try {
            AppSettings settings = new AppSettings(context);
            AutoCaptureService service = live;
            if (service != null && service.published != null) return new JSONObject(service.published);
            if (snapshotStore == null) {
                synchronized (AutoCaptureService.class) {
                    if (snapshotStore == null) snapshotStore = new RecordingStore(context);
                }
            }
            RecordingStore.Stats stats = snapshotStore.stats();
            String mode = settings.captureDesired() ? "needs_restore" : "paused";
            String error = settings.lastError();
            JSONObject snapshot = baseSnapshot(mode, false, false, null, stats.queuedCount,
                    settings.captureDesired() ? "采集已中断，请从前台继续采集。" : "采集已暂停。",
                    error, false, 0, null);
            boolean blocked = false;
            try { snapshotStore.checkCapacity(); }
            catch (RecordingStore.CapacityException capacity) { blocked = true; }
            addCaptureSnapshot(snapshot, settings, false, blocked);
            addSyncSnapshot(snapshot, stats, false);
            return snapshot;
        } catch (Exception e) {
            return baseSnapshot("error", false, false, null, 0, "无法读取录音状态。",
                    "录音归档不可用，请检查手机存储空间。", false, 0, null);
        }
    }

    @Override public void onCreate() {
        super.onCreate();
        settings = new AppSettings(this);
        live = this;
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_DISABLE.equals(action)) {
            pauseCapture();
        } else if (ACTION_ENABLE.equals(action) && !stopping) {
            if (enabled) resumeCapture();
            else enable();
        } else if (!enabled && !stopping) {
            disable("disabled", "请从前台界面手动启用自动录音。");
        }
        return START_NOT_STICKY;
    }

    private void enable() {
        try {
            settings.captureDesired(true);
            pairing = settings.pairing();
            if (pairing == null) throw new IllegalStateException("请先导入电脑桥接配对配置。");
            requirePermissions();
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager == null || !manager.areNotificationsEnabled())
                throw new IllegalStateException("请开启应用通知，以便随时查看和停止录音。");
            manager.createNotificationChannel(new NotificationChannel(CHANNEL, "自动录音状态", NotificationManager.IMPORTANCE_LOW));
            NotificationChannel channel = manager.getNotificationChannel(CHANNEL);
            if (channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE)
                throw new IllegalStateException("请开启自动录音状态通知频道。");
            int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
            if (Build.VERSION.SDK_INT >= 30) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            startForeground(NOTIFICATION, notification("等待首次靠近已配对电脑并完成验证，当前未录音。", true), types);
            settings.autoEnabled(true);
            enabled = true;
            captureRecovery.resume();
            normalStop = false;
            store = new RecordingStore(this);
            store.recoverInterrupted();
            refreshCapacity();
            policy = new ProximityPolicy(settings.leaveRssi(), settings.returnRssi(), settings.pairingVerified());
            healthWorker = Executors.newFixedThreadPool(2);
            uploadWorker = Executors.newSingleThreadExecutor();
            PowerManager power = getSystemService(PowerManager.class);
            if (power == null) throw new IllegalStateException("无法取得电源管理服务。");
            // Keeps BLE timers/capture responsive with the screen off. This costs battery while enabled.
            // A bounded lease is renewed by the live loop; no alarm/job revives an expired service.
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ShadowVoice:automatic-capture");
            wakeLock.setReferenceCounted(false);
            renewWakeLock(SystemClock.elapsedRealtime());
            ble = new BleMonitor(this, main, pairing.getString("bridgeId"), new BleMonitor.Listener() {
                @Override public void onObservation(boolean trusted, Integer value, long sampledAt) {
                    if (!trusted || !trustedBle) {
                        health.connectionChanged();
                        bluetoothHealth.connectionChanged();
                    }
                    if (!trusted) {
                        updateEndpoints(Collections.emptyList());
                        updateBluetooth(null);
                    }
                    trustedBle = trusted;
                    rssi = value;
                    rssiAt = sampledAt;
                    if (trusted && value != null) bleWarning = "";
                }
                @Override public void onDiscovery(BridgeIdentity.Routes routes) {
                    updateEndpoints(routes.endpoints);
                    updateBluetooth(routes.bluetoothAddress);
                }
                @Override public void onWarning(String warning) { bleWarning = warning; }
                @Override public void onFatal(String warning) { disable("error", warning); }
            });
            publish();
            main.post(loop);
        } catch (Exception e) {
            disable("error", userError(e, "无法启用自动录音，请检查权限、通知、蓝牙和配对配置。"));
        }
    }

    private final Runnable loop = new Runnable() {
        @Override public void run() {
            if (!enabled || destroyed) return;
            try {
                requirePermissions();
                long now = SystemClock.elapsedRealtime();
                if (now >= nextWakeRenewal) renewWakeLock(now);
                if (now >= nextCapacity) { refreshCapacity(); nextCapacity = now + 5000; }
                ble.tick(now);
                if (!enabled) return;
                boolean observed = observed(now);
                if (observed && rssi >= settings.returnRssi() && candidates.current() != null
                        && now >= nextHealth && !healthBusy && (uploading == null || uploading != bridge)) requestHealth();
                if (observed && rssi >= settings.returnRssi() && bluetoothAddress != null
                        && now >= nextBluetoothHealth && !bluetoothHealthBusy && (uploading == null || uploading != bluetooth)
                        && !health.ready(now) && (bluetooth != null || TransportPolicy.shouldProbeBluetooth(
                                candidates.current() != null, health.state(now), bluetoothHealth.state(now)))) requestBluetoothHealth();
                advanceCaptureState(now);
                if (!enabled) return;
                boolean authenticated = observed && selectedTransport(now) != null;
                if ((!settings.captureDesired() || storageBlocked ? authenticated && rssi >= settings.returnRssi()
                        : policy.canUpload(observed, rssi, authenticated))
                        && recorder == null && !uploadBusy && now >= nextUpload) uploadNext();
                publish();
                if (now - lastNotification >= 5000) {
                    getSystemService(NotificationManager.class).notify(NOTIFICATION, notification(status(), true));
                    lastNotification = now;
                }
                main.postDelayed(this, 1000);
            } catch (Exception e) { disable("error", userError(e, "自动录音发生异常，已停止。请检查权限和存储后重新启用。")); }
        }
    };

    private boolean observed(long now) {
        return trustedBle && rssi != null && now >= rssiAt && now - rssiAt <= 12_000;
    }

    private void advanceCaptureState(long now) {
        if (!enabled || policy == null) return;
        try {
            boolean observed = observed(now);
            ProximityPolicy.Mode before = policy.mode();
            ProximityPolicy.Mode after = policy.update(now, observed, observed ? rssi : null,
                    observed && selectedTransport(now) != null);
            if (before != after) Log.i(TAG, "Proximity " + before + " -> " + after
                    + "; observed=" + observed + "; rssi=" + (observed ? rssi : "missing"));
            captureRecovery.observe(recorder != null && recorder.isRecording(), now);
            if (recorder != null && recorder.isRecording()) captureWarning = "";
            if (captureAllowed(enabled, settings.captureDesired(), storageBlocked) && policy.shouldRecord()
                    && recorder == null && captureRecovery.ready(now))
                startCapture();
            if (after == ProximityPolicy.Mode.NEAR && before == ProximityPolicy.Mode.AWAY && recorder != null)
                recorder.stop("");
        } catch (Exception e) {
            disable("error", userError(e, "自动录音状态处理失败，已停止。请检查权限和存储。"));
        }
    }

    private void updateEndpoints(List<String> endpoints) {
        if (!candidates.update(endpoints)) return;
        // Revoke the old proof before cancelling IO; proximity does not depend on this state.
        health.connectionChanged();
        if (bridge != null) bridge.close();
        bridge = null;
        bridgeEndpoint = null;
        nextHealth = 0;
        nextUpload = 0;
        backoff.reset();
    }

    private void updateBluetooth(String address) {
        if (Objects.equals(bluetoothAddress, address)) return;
        bluetoothHealth.connectionChanged();
        if (bluetooth != null) bluetooth.close();
        bluetooth = null;
        bluetoothAddress = address;
        nextBluetoothHealth = 0;
        nextUpload = 0;
        backoff.reset();
    }

    private RecordingTransport selectedTransport(long now) {
        TransportPolicy.Channel channel = TransportPolicy.select(health.state(now), bluetoothHealth.state(now));
        if (channel == TransportPolicy.Channel.LAN) return bridge;
        if (channel == TransportPolicy.Channel.BLUETOOTH) return bluetooth;
        return null;
    }

    private void requestHealth() throws Exception {
        String endpoint = candidates.current();
        if (endpoint == null) return;
        if (bridge == null || !endpoint.equals(bridgeEndpoint)) {
            health.connectionChanged();
            if (bridge != null) bridge.close();
            bridge = new BridgeClient(pairing, endpoint);
            bridgeEndpoint = endpoint;
        }
        healthBusy = true;
        nextHealth = SystemClock.elapsedRealtime() + 5000;
        int generation = health.begin();
        BridgeClient client = bridge;
        healthWorker.execute(() -> {
            BridgeHealth.State result;
            try { client.health(); result = BridgeHealth.State.READY; }
            catch (Exception e) { result = BridgeHealth.classify(e); }
            final BridgeHealth.State outcome = result;
            main.post(() -> {
                healthBusy = false;
                if (!enabled || destroyed || bridge != client) return;
                long now = SystemClock.elapsedRealtime();
                health.complete(generation, now, outcome);
                if (TransportPolicy.securityFailure(outcome)) { disable("error", BridgeHealth.warning(outcome)); return; }
                if (outcome == BridgeHealth.State.READY) {
                    rememberVerifiedBinding(health, now);
                    candidates.succeeded();
                    nextHealth = now + 5000;
                } else {
                    nextHealth = now + Math.max(candidates.failed(), bluetoothHealth.ready(now) ? 30_000 : 5000);
                    nextBluetoothHealth = TransportPolicy.bluetoothProbeAfterLanFailure(
                            nextBluetoothHealth, now, bluetoothHealth.state(now));
                }
                advanceCaptureState(now);
                publish();
            });
        });
    }

    private void requestBluetoothHealth() throws Exception {
        if (bluetoothAddress == null) return;
        if (bluetooth == null) bluetooth = new BluetoothBridgeClient(this, pairing, bluetoothAddress);
        bluetoothHealthBusy = true;
        nextBluetoothHealth = SystemClock.elapsedRealtime() + 20_000;
        int generation = bluetoothHealth.begin();
        BluetoothBridgeClient client = bluetooth;
        healthWorker.execute(() -> {
            BridgeHealth.State result;
            try { client.health(); result = BridgeHealth.State.READY; }
            catch (Exception e) { result = BridgeHealth.classify(e); }
            final BridgeHealth.State outcome = result;
            main.post(() -> {
                bluetoothHealthBusy = false;
                if (!enabled || destroyed || bluetooth != client) return;
                long now = SystemClock.elapsedRealtime();
                bluetoothHealth.complete(generation, now, outcome);
                if (TransportPolicy.securityFailure(outcome)) { disable("error", BridgeHealth.warning(outcome)); return; }
                if (outcome == BridgeHealth.State.READY) rememberVerifiedBinding(bluetoothHealth, now);
                nextBluetoothHealth = now + (outcome == BridgeHealth.State.READY ? 20_000 : 15_000);
                advanceCaptureState(now);
                publish();
            });
        });
    }

    private void startCapture() {
        if (!captureAllowed(enabled, settings.captureDesired(), storageBlocked) || recorder != null
                || !captureRecovery.ready(SystemClock.elapsedRealtime())) return;
        sessionId = UUID.randomUUID().toString();
        long generation = captureRecovery.generation();
        recorder = new PcmRecorder(this, store, main, (captureError, outcome) -> {
            recorder = null;
            if (destroyed) return;
            if (stopping) {
                if (error.isEmpty() && !captureError.isEmpty()) {
                    error = userError(new IllegalStateException(captureError), "保存录音时发生异常，原始片段已保留。");
                    stopMode = "error";
                    try { settings.stopped(stopMode, error); } catch (RuntimeException ignored) { }
                }
                finishShutdown();
            } else if (outcome == PcmRecorder.Outcome.STORAGE) {
                sessionId = null;
                blockCaptureForStorage(captureError);
                publish();
            } else if (outcome == PcmRecorder.Outcome.PERMISSION && captureRecovery.current(generation)) {
                disable("interrupted", "麦克风权限或后台访问被系统拒绝，请在前台检查权限并继续采集。");
            } else if (outcome == PcmRecorder.Outcome.FATAL) {
                disable("error", userError(new IllegalStateException(captureError), "麦克风采集异常，已停止并保留已写入的录音。"));
            } else {
                sessionId = null;
                if (outcome == PcmRecorder.Outcome.RETRY && captureRecovery.current(generation)) {
                    captureRecovery.failed(generation, SystemClock.elapsedRealtime());
                    captureWarning = captureError;
                }
                publish();
            }
        });
        recorder.start(sessionId);
        Log.i(TAG, "Capture requested after confirmed departure.");
    }

    private void uploadNext() {
        RecordingTransport client = selectedTransport(SystemClock.elapsedRealtime());
        if (client == null || (client == bridge ? healthBusy : bluetoothHealthBusy)) return;
        uploadBusy = true;
        uploading = client;
        long now = SystemClock.elapsedRealtime();
        boolean completionDue = syncSchedule.completionDue(now);
        boolean completionFirst = syncSchedule.completionFirst(now);
        uploadWorker.execute(() -> {
            RecordingStore.Upload upload = null;
            RecordingStore.Upload completion = null;
            boolean success = false;
            boolean empty = false;
            boolean fatal = false;
            BridgeHealth.State failure = null;
            String warning = "";
            try {
                if (completionFirst) completion = store.claimCompletion(System.currentTimeMillis());
                if (completion == null) upload = store.claimNext();
                if (completion == null && upload == null && completionDue && !completionFirst)
                    completion = store.claimCompletion(System.currentTimeMillis());
                if (completion != null) {
                    syncOperation = "cleanup";
                    if (store.complete(completion, client.status(completion))) {
                        store.acknowledgeCleanup(completion, client.cleanupAck(completion));
                    }
                    success = true;
                } else {
                    if (upload == null) empty = true;
                    else {
                        syncOperation = "upload";
                        JSONObject receipt = client.upload(upload);
                        store.acknowledge(upload, receipt);
                        success = true;
                    }
                }
            } catch (Exception e) {
                failure = BridgeHealth.classify(e);
                warning = completion == null ? "录音上传未获有效回执，原件已保留，将在靠近电脑时重试。"
                        : "处理状态或清理确认暂不可用，将自动重试；未确认完成的音频仍保留。";
                // Old receivers may not implement status. This must not revoke capture readiness.
                if (completion != null && !TransportPolicy.securityFailure(failure)) failure = null;
                if (upload != null) {
                    try { store.retry(upload, warning); }
                    catch (Exception failedState) {
                        fatal = true;
                        warning = "无法保存上传状态，原件已保留，请检查存储后重新启用。";
                    }
                }
            } finally {
                if (completion != null) {
                    try { store.releaseCompletion(completion, System.currentTimeMillis(), warning); }
                    catch (Exception stateFailure) { fatal = true; warning = "无法保存清理进度，请检查手机存储。"; }
                }
            }
            final boolean sent = success;
            final boolean noWork = empty;
            final boolean storageFailed = fatal;
            final String uploadWarning = warning;
            final BridgeHealth.State transferFailure = failure;
            final boolean completionAttempt = completion != null;
            final boolean hadWork = completion != null || upload != null;
            main.post(() -> {
                uploadBusy = false;
                syncOperation = "";
                uploading = null;
                if (destroyed || !enabled) return;
                if (hadWork) syncSchedule.finished(completionAttempt, SystemClock.elapsedRealtime());
                if (storageFailed) { disable("error", uploadWarning); return; }
                if (client != bridge && client != bluetooth) return;
                if (transferFailure != null) {
                    BridgeHealth failed = client == bridge ? health : bluetoothHealth;
                    failed.complete(failed.begin(), SystemClock.elapsedRealtime(), transferFailure);
                    if (TransportPolicy.securityFailure(transferFailure)) {
                        disable("error", BridgeHealth.warning(transferFailure)); return;
                    }
                }
                if (sent || noWork) {
                    backoff.reset();
                    nextUpload = SystemClock.elapsedRealtime() + (noWork ? 5000 : 1000);
                    error = "";
                } else if (completionAttempt) {
                    // Optional status support cannot starve queued audio uploads on an old PC.
                    nextUpload = SystemClock.elapsedRealtime() + 1000;
                    error = uploadWarning;
                } else {
                    nextUpload = SystemClock.elapsedRealtime() + backoff.nextDelayMs();
                    error = uploadWarning;
                }
                publish();
            });
        });
    }

    private void requirePermissions() {
        if (settings.captureDesired() && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
            throw new IllegalStateException("麦克风权限未授予或已撤回。");
        if (Build.VERSION.SDK_INT >= 31) {
            if (checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED
                    || checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED)
                throw new IllegalStateException("附近设备权限未授予或已撤回。");
        } else if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            throw new IllegalStateException("此 Android 版本需要定位权限才能发现蓝牙设备。");
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            throw new IllegalStateException("通知权限未授予或已撤回，自动录音已停用。");
        NotificationManager notifications = getSystemService(NotificationManager.class);
        if (notifications == null || !notifications.areNotificationsEnabled())
            throw new IllegalStateException("应用通知已关闭，自动录音已停用。");
        NotificationChannel channel = notifications.getNotificationChannel(CHANNEL);
        if (channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE)
            throw new IllegalStateException("自动录音通知频道已关闭，自动录音已停用。");
    }

    private void renewWakeLock(long now) {
        wakeLock.acquire(10 * 60_000L);
        nextWakeRenewal = now + 9 * 60_000L;
    }

    private void rememberVerifiedBinding(BridgeHealth channel, long now) {
        if (!channel.ready(now) || !observed(now) || rssi < settings.returnRssi()) return;
        try { if (!settings.pairingVerified()) settings.verifyPairing(pairing); }
        catch (RuntimeException failure) { disable("error", "无法保存已验证的配对，请在前台重新启用。"); }
    }

    private void pauseCapture() {
        try {
            settings.captureDesired(false);
            settings.autoEnabled(false);
            captureRecovery.suspend();
            captureWarning = "";
            if (recorder != null) recorder.stop("");
            if (!enabled) { disable("paused", ""); return; }
            startForeground(NOTIFICATION, notification("采集已暂停，已授权同步仍可继续。", true),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
            publish();
        } catch (Exception failure) { disable("error", "暂停采集时发生异常，录音已停止。"); }
    }

    private void resumeCapture() {
        try {
            refreshCapacity();
            if (settings.captureDesired()) { publish(); return; }
            settings.captureDesired(true);
            requirePermissions();
            int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
            if (Build.VERSION.SDK_INT >= 30) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            // ACTION_ENABLE must come from the visible activity. Android remains the authority
            // for upgrading the service to the microphone type; no background restart path exists.
            startForeground(NOTIFICATION, notification("正在观察电脑信号。", true), types);
            settings.autoEnabled(true);
            captureRecovery.resume();
            captureWarning = "";
            policy = new ProximityPolicy(settings.leaveRssi(), settings.returnRssi(), settings.pairingVerified());
            error = "";
            publish();
        } catch (Exception failure) { disable("error", userError(failure, "请从前台继续采集并检查系统权限。")); }
    }

    static boolean captureAllowed(boolean running, boolean desired, boolean storageBlocked) {
        return running && desired && !storageBlocked;
    }

    private void refreshCapacity() throws IOException {
        try {
            store.checkCapacity();
            storageBlocked = false;
            storageWarning = "";
        } catch (RecordingStore.CapacityException capacity) {
            blockCaptureForStorage(capacity.getMessage());
        }
    }

    private void blockCaptureForStorage(String warning) {
        storageBlocked = true;
        storageWarning = warning;
        if (recorder != null) recorder.stop("");
        // Neither captureDesired nor enabled changes: only the capture path is blocked.
    }

    private void disable(String mode, String reason) {
        if (destroyed) return;
        enabled = false;
        captureRecovery.suspend();
        stopping = true;
        stopMode = mode;
        error = reason;
        if (recorder != null) recorder.stop(reason);
        health.connectionChanged();
        bluetoothHealth.connectionChanged();
        main.removeCallbacks(loop);
        try { settings.stopped(mode, reason); } catch (RuntimeException ignored) { }
        if (ble != null) { ble.close(); ble = null; }
        if (bridge != null) { bridge.close(); bridge = null; }
        if (bluetooth != null) { bluetooth.close(); bluetooth = null; }
        if (healthWorker != null) healthWorker.shutdownNow();
        if (uploadWorker != null) uploadWorker.shutdownNow();
        if (recorder != null) {
            publish();
        } else finishShutdown();
    }

    private void finishShutdown() {
        if (destroyed) return;
        stopping = false;
        normalStop = true;
        sessionId = null;
        releaseWakeLock();
        publish();
        stopForeground(STOP_FOREGROUND_REMOVE);
        if (!error.isEmpty()) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null && manager.areNotificationsEnabled()) {
                try { manager.notify(NOTIFICATION, notification(error, false)); } catch (RuntimeException ignored) { }
            }
        }
        stopSelf();
    }

    private String status() {
        if (stopping) return "正在停止采集并保存录音。";
        if (!enabled) return "interrupted".equals(stopMode) ? "服务已中断，请手动重新启用。" : "自动录音已停用。";
        if (!settings.captureDesired()) return recorder != null ? "正在暂停采集并保存录音。"
                : "采集已暂停，已授权同步仍可继续。";
        if (storageBlocked) return "存储空间或队列容量不足，采集受阻；同步和清理仍可继续。";
        String suspended = captureSuspension();
        if (!suspended.isEmpty()) return suspended;
        if (policy == null || !policy.armed()) {
            if (settings.pairingVerified()) return "正在短暂观察电脑信号，离线时也将继续采集。";
            long now = SystemClock.elapsedRealtime();
            if (selectedTransport(now) != null)
                return "通道已验证，但尚未确认近场信号；自动录音未就绪。";
            return "尚未确认已配对电脑，自动录音未就绪，当前未录音。";
        }
        if (policy.mode() == ProximityPolicy.Mode.AWAY)
            return recorder != null && recorder.isRecording() ? "已离开电脑，正在录音并分段保存。" : "已离开电脑，正在准备录音。";
        if (recorder != null) return "已返回电脑，正在停止录音并保存。";
        long remaining = policy.departureRemainingMs(SystemClock.elapsedRealtime());
        if (remaining >= 0) return "信号减弱或连接中断，确认离开中，约 " + ((remaining + 999) / 1000) + " 秒后开始录音。";
        if (selectedTransport(SystemClock.elapsedRealtime()) == null && !uploadBusy) return "已靠近电脑，当前未录音；等待上传通道恢复。";
        return uploadBusy ? "已返回电脑，正在上传本地录音。" : "自动录音已就绪，离开电脑后将自动录音。";
    }

    private void publish() {
        int queued = 0;
        RecordingStore.Stats stats = null;
        try { if (store != null) { stats = store.stats(); queued = stats.queuedCount; } }
        catch (RuntimeException e) { error = "无法读取归档队列，请检查手机存储。"; }
        String suspended = captureSuspension();
        String mode = stopping ? "stopping" : !settings.captureDesired() ? "paused"
                : enabled && storageBlocked ? "storage_blocked" : !suspended.isEmpty() ? "capture_suspended" : enabled && policy != null
                ? policy.mode().name().toLowerCase(Locale.ROOT) : stopMode;
        long now = SystemClock.elapsedRealtime();
        BridgeHealth.State networkState = health.state(now);
        BridgeHealth.State btState = bluetoothHealth.state(now);
        RecordingTransport selected = selectedTransport(now);
        RecordingTransport visible = uploading != null ? uploading : selected;
        BridgeHealth.State channelState = TransportPolicy.displayState(enabled && visible != null,
                bluetoothAddress != null, networkState, btState);
        boolean departure = enabled && settings.captureDesired() && policy != null && policy.armed()
                && (policy.shouldRecord() || policy.departureRemainingMs(now) >= 0);
        String networkWarning = departure || selected != null || uploadBusy ? "" : BridgeHealth.warning(channelState);
        String warning = !error.isEmpty() ? error : storageBlocked ? storageWarning
                : !networkWarning.isEmpty() ? networkWarning : departure ? "" : bleWarning;
        JSONObject snapshot = baseSnapshot(mode, recorder != null && recorder.isRecording(), trustedBle, rssi, queued,
                status(), warning, enabled && settings.captureDesired(), recorder == null ? 0 : recorder.elapsedMs(), sessionId);
        try {
            addCaptureSnapshot(snapshot, settings, enabled, storageBlocked);
            snapshot.put("captureSuspended", !suspended.isEmpty())
                    .put("captureBlocked", settings.captureDesired() && (storageBlocked || !suspended.isEmpty()))
                    .put("captureRetryInMs", captureRecovery.remaining(now));
            addSyncSnapshot(snapshot, stats, uploadBusy);
            snapshot.put("uploadingCount", uploadBusy && "upload".equals(syncOperation) ? 1 : 0)
                    .put("cleanupInProgressCount", uploadBusy && "cleanup".equals(syncOperation) ? 1 : 0);
            String label = visible != null ? (visible == bridge ? "局域网" : "蓝牙") + (uploadBusy ? " · 同步中" : " · 已验证")
                    : BridgeHealth.label(channelState);
            snapshot.put("uploadChannel", enabled ? label : "未启用")
                    .put("armed", enabled && settings.captureDesired() && policy != null && policy.armed())
                    .put("departureRemainingMs", enabled && settings.captureDesired() && policy != null ? policy.departureRemainingMs(now) : -1)
                    .put("uploadChannelState", channelState.name().toLowerCase(Locale.ROOT))
                    .put("bluetoothTransferState", btState.name().toLowerCase(Locale.ROOT));
        } catch (Exception impossible) { throw new IllegalStateException(impossible); }
        published = snapshot.toString();
    }

    private String captureSuspension() {
        if (!enabled || !settings.captureDesired() || policy == null || !policy.shouldRecord()) return "";
        if (recorder != null) return recorder.suspension();
        if (captureWarning.isEmpty()) return "";
        long seconds = (captureRecovery.remaining(SystemClock.elapsedRealtime()) + 999) / 1000;
        return captureWarning + " 约 " + seconds + " 秒后重试；采集意愿已保留。";
    }

    static void addCaptureSnapshot(JSONObject snapshot, AppSettings settings, boolean running, boolean storageBlocked)
            throws org.json.JSONException {
        snapshot.put("captureDesired", settings.captureDesired()).put("paused", !settings.captureDesired())
                .put("needs_restore", settings.captureDesired() && !running).put("serviceRunning", running)
                .put("pairingVerified", settings.pairingVerified()).put("storageBlocked", storageBlocked)
                .put("captureBlocked", settings.captureDesired() && storageBlocked);
    }

    private static void addSyncSnapshot(JSONObject snapshot, RecordingStore.Stats stats, boolean uploading) throws org.json.JSONException {
        snapshot.put("processingCount", stats == null ? 0 : stats.processingCount)
                .put("completedCount", stats == null ? 0 : stats.completedCount)
                .put("cleanupPendingCount", stats == null ? 0 : stats.cleanupPendingCount)
                .put("cleanedCount", stats == null ? 0 : stats.cleanedCount)
                .put("failedCount", stats == null ? 0 : stats.failedCount)
                .put("syncingCount", uploading ? 1 : 0)
                .put("cleanupInProgressCount", 0)
                .put("uploadingCount", uploading ? 1 : 0);
    }

    private static JSONObject baseSnapshot(String mode, boolean recording, boolean connected, Integer rssi,
                                          int count, String status, String error, boolean enabled, long elapsed, String session) {
        try {
            JSONObject object = new JSONObject().put("mode", mode).put("recording", recording).put("connected", connected)
                    .put("rssi", rssi == null ? JSONObject.NULL : rssi).put("queuedCount", count)
                    .put("status", status).put("error", error).put("enabled", enabled).put("elapsedMs", elapsed)
                    .put("storageBlocked", false).put("captureBlocked", false);
            if (session != null) object.put("sessionId", session);
            return object;
        } catch (Exception impossible) { throw new IllegalStateException(impossible); }
    }

    private Notification notification(String status, boolean ongoing) {
        PendingIntent activity = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = new Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_mic)
                .setContentTitle(ongoing ? (settings.captureDesired() ? "自动采集" : "采集已暂停") : "采集已停止").setContentText(status)
                .setStyle(new Notification.BigTextStyle().bigText(status)).setContentIntent(activity)
                .setOngoing(ongoing).setOnlyAlertOnce(true).setShowWhen(false)
                .setVisibility(Notification.VISIBILITY_PRIVATE).setCategory(Notification.CATEGORY_SERVICE);
        if (ongoing && settings.captureDesired()) {
            PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, AutoCaptureService.class).setAction(ACTION_DISABLE),
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            builder.addAction(new Notification.Action.Builder(R.drawable.ic_mic, "暂停采集", stop).build());
        } else if (!ongoing) builder.setAutoCancel(true);
        return builder.build();
    }

    private static String userError(Exception error, String fallback) {
        String message = error.getMessage();
        if (message != null && message.matches("(?s).*[\\p{IsHan}].*")) return message;
        return fallback;
    }

    private void releaseWakeLock() {
        if (wakeLock != null) {
            try { if (wakeLock.isHeld()) wakeLock.release(); } catch (RuntimeException ignored) { }
            wakeLock = null;
        }
    }

    @Override public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
    }

    @Override public void onTimeout(int startId, int fgsType) {
        disable("interrupted", "系统限制了前台服务，录音已停止。请在前台重新启用。");
    }

    @Override public void onDestroy() {
        destroyed = true;
        enabled = false;
        captureRecovery.suspend();
        if (recorder != null) recorder.stop("服务中断，已保留可恢复的录音片段。");
        main.removeCallbacksAndMessages(null);
        if (!normalStop) {
            try { settings.stopped("interrupted", "服务被系统中断，已停止自动录音。请在前台重新启用。"); }
            catch (RuntimeException ignored) { }
        }
        if (ble != null) ble.close();
        if (bridge != null) bridge.close();
        if (bluetooth != null) bluetooth.close();
        if (healthWorker != null) healthWorker.shutdownNow();
        if (uploadWorker != null) uploadWorker.shutdownNow();
        releaseWakeLock();
        if (live == this) live = null;
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
