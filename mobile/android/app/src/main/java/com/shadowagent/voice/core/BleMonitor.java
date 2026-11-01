package com.shadowagent.voice.core;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.ParcelUuid;
import android.os.SystemClock;
import android.util.Log;

import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** All GATT operations and state transitions are serialized on the service's main handler. */
final class BleMonitor {
    private static final String TAG = "ShadowVoiceBle";
    interface Listener {
        void onObservation(boolean trusted, Integer rssi, long sampledAt);
        void onDiscovery(BridgeIdentity.Routes routes);
        void onWarning(String message);
        void onFatal(String message);
    }
    private final Context context;
    private final Handler main;
    private final Listener listener;
    private final String bridgeId;
    private final BluetoothAdapter adapter;
    private final UUID serviceUuid = UUID.fromString(AppSettings.SERVICE_UUID);
    private final UUID identityUuid = UUID.fromString(AppSettings.IDENTITY_UUID);
    private final Map<String, Long> rejected = new HashMap<>();
    private final GattOperations operations = new GattOperations();
    private final BluetoothAvailability availability = new BluetoothAvailability();
    private BluetoothLeScanner scanner;
    private BluetoothGatt gatt;
    private boolean closed;
    private boolean scanning;
    private boolean trusted;
    private BluetoothGattCharacteristic identityCharacteristic;
    private long nextScan;
    private long scanStarted;

    BleMonitor(Context context, Handler main, String bridgeId, Listener listener) {
        this.context = context; this.main = main; this.bridgeId = bridgeId; this.listener = listener;
        BluetoothManager manager = context.getSystemService(BluetoothManager.class);
        adapter = manager == null ? null : manager.getAdapter();
    }

    void tick(long now) {
        if (closed) return;
        try {
            boolean powered = adapter != null && adapter.isEnabled();
            boolean changed = availability.update(powered);
            if (!powered) {
                if (changed) {
                    stopScan();
                    drop("蓝牙未开启，连接已挂起；采集意愿已保留，开启后自动重连。");
                }
                return;
            }
            if (changed) {
                // Reacquire the scanner after adapter power cycling; stale GATT proof is never reused.
                scanner = null;
                nextScan = now;
            }
            if (gatt != null && operations.expired(now)) drop("蓝牙操作超时，正在重连。");
            if (gatt != null && trusted) {
                GattOperations.Kind next = operations.poll(now);
                if (next != null) {
                    operations.begin(next, now);
                    boolean accepted = next == GattOperations.Kind.IDENTITY
                            ? gatt.readCharacteristic(identityCharacteristic) : gatt.readRemoteRssi();
                    if (!accepted) drop("无法刷新蓝牙身份或信号，正在重连。");
                }
            }
            if (scanning && now - scanStarted >= 20_000) {
                stopScan();
                nextScan = now + 5000;
            }
            if (gatt == null && !scanning && now >= nextScan) {
                scanner = adapter.getBluetoothLeScanner();
                if (scanner == null) { drop("蓝牙扫描器暂不可用，稍后重试。"); return; }
                scanner.startScan(Collections.singletonList(new ScanFilter.Builder()
                                .setServiceUuid(new ParcelUuid(serviceUuid)).build()),
                        new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                                .setReportDelay(0).build(), scanCallback);
                scanning = true;
                scanStarted = now;
                Log.d(TAG, "Filtered scan started");
            }
        } catch (SecurityException e) { listener.onFatal("蓝牙权限已撤回，自动录音已停用。"); }
        catch (RuntimeException e) { stopScan(); drop("蓝牙组件暂不可用，稍后重试。"); }
    }

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override public void onScanResult(int callbackType, ScanResult result) {
            main.post(() -> connect(result.getDevice()));
        }
        @Override public void onScanFailed(int errorCode) {
            main.post(() -> {
                if (closed) return;
                scanning = false;
                nextScan = SystemClock.elapsedRealtime() + 30_000;
                Log.w(TAG, "Scan failed: status=" + errorCode);
                listener.onWarning("蓝牙扫描失败（" + errorCode + "），30 秒后重试。");
            });
        }
    };

    private void connect(BluetoothDevice device) {
        if (closed || !scanning || gatt != null) return;
        try {
            long now = SystemClock.elapsedRealtime();
            rejected.entrySet().removeIf(entry -> entry.getValue() <= now);
            if (rejected.containsKey(device.getAddress())) return;
            stopScan();
            operations.begin(GattOperations.Kind.CONNECT, now);
            // A fresh scan may contain a rotating private address; Android rejects it in
            // the background autoConnect list. Reconnect through a new scan after loss.
            Log.i(TAG, "Matching advertisement received; starting direct GATT connection");
            gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE);
            if (gatt == null) drop("无法建立桥接蓝牙连接，正在重试。");
        } catch (SecurityException e) { listener.onFatal("蓝牙连接权限已撤回。"); }
        catch (RuntimeException e) { drop("蓝牙连接失败，正在重试。"); }
    }

    private final BluetoothGattCallback callback = new BluetoothGattCallback() {
        @Override public void onConnectionStateChange(BluetoothGatt source, int status, int newState) {
            main.post(() -> {
                if (!current(source)) return;
                Log.i(TAG, "Connection state: status=" + status + ", state=" + newState);
                if (status != BluetoothGatt.GATT_SUCCESS || newState == BluetoothProfile.STATE_DISCONNECTED) {
                    drop(status == BluetoothGatt.GATT_SUCCESS ? "" : "蓝牙连接失败（" + status + "），正在重试。");
                } else if (newState == BluetoothProfile.STATE_CONNECTED) {
                    try {
                        long now = SystemClock.elapsedRealtime();
                        if (!operations.complete(GattOperations.Kind.CONNECT, now)) return;
                        operations.begin(GattOperations.Kind.DISCOVER, now);
                        if (!source.discoverServices()) drop("无法发现桥接服务，正在重试。");
                    } catch (SecurityException e) { listener.onFatal("蓝牙权限已撤回。"); }
                }
            });
        }
        @Override public void onServicesDiscovered(BluetoothGatt source, int status) {
            main.post(() -> {
                if (!current(source)) return;
                Log.i(TAG, "Service discovery: status=" + status);
                try {
                    long now = SystemClock.elapsedRealtime();
                    if (!operations.complete(GattOperations.Kind.DISCOVER, now)) return;
                    BluetoothGattService service = source.getService(serviceUuid);
                    identityCharacteristic = service == null ? null : service.getCharacteristic(identityUuid);
                    if (status != BluetoothGatt.GATT_SUCCESS || identityCharacteristic == null) {
                        reject(source, "桥接缺少身份特征值，已忽略该设备。");
                        return;
                    }
                    operations.begin(GattOperations.Kind.IDENTITY, now);
                    if (!source.readCharacteristic(identityCharacteristic)) drop("无法读取桥接身份，正在重试。");
                } catch (SecurityException e) { listener.onFatal("蓝牙权限已撤回。"); }
            });
        }
        @Override public void onCharacteristicRead(BluetoothGatt source, BluetoothGattCharacteristic characteristic, int status) {
            if (Build.VERSION.SDK_INT >= 33) return;
            byte[] bytes = characteristic.getValue();
            byte[] copy = boundedCopy(bytes);
            main.post(() -> identity(source, characteristic.getUuid(), copy, status));
        }
        @Override public void onCharacteristicRead(BluetoothGatt source, BluetoothGattCharacteristic characteristic,
                                                   byte[] value, int status) {
            byte[] copy = boundedCopy(value);
            main.post(() -> identity(source, characteristic.getUuid(), copy, status));
        }
        @Override public void onReadRemoteRssi(BluetoothGatt source, int rssi, int status) {
            main.post(() -> {
                if (!current(source) || !trusted) return;
                long now = SystemClock.elapsedRealtime();
                if (!operations.complete(GattOperations.Kind.RSSI, now)) return;
                if (status != BluetoothGatt.GATT_SUCCESS || rssi < -127 || rssi > 20) {
                    drop("蓝牙信号样本无效，正在重连。");
                    return;
                }
                listener.onObservation(true, rssi, now);
            });
        }
    };

    private void identity(BluetoothGatt source, UUID characteristic, byte[] value, int status) {
        if (!current(source) || !identityUuid.equals(characteristic)) return;
        if (!operations.complete(GattOperations.Kind.IDENTITY, SystemClock.elapsedRealtime())) return;
        if (status != BluetoothGatt.GATT_SUCCESS) {
            Log.w(TAG, "Identity read failed: status=" + status);
            reject(source, "桥接蓝牙身份无效，已忽略该设备。");
            return;
        }
        BridgeIdentity.Routes routes;
        try { routes = BridgeIdentity.parse(value, bridgeId); }
        catch (IllegalArgumentException invalid) {
            Log.w(TAG, "Identity rejected: bytes=" + value.length);
            reject(source, "蓝牙身份或局域网地址与配对协议不符，已忽略。");
            return;
        }
        boolean first = !trusted;
        trusted = true;
        if (first) {
            Log.i(TAG, "Paired bridge identity verified; endpoints=" + routes.endpoints.size()
                    + ", bluetoothTransfer=" + (routes.bluetoothAddress != null));
            listener.onObservation(true, null, 0);
        }
        listener.onDiscovery(routes);
    }

    private static byte[] boundedCopy(byte[] value) {
        return value == null || value.length > BridgeIdentity.MAX_BYTES ? new byte[0] : value.clone();
    }

    private void reject(BluetoothGatt source, String reason) {
        try {
            if (rejected.size() >= 64) rejected.clear();
            rejected.put(source.getDevice().getAddress(), SystemClock.elapsedRealtime() + 60_000);
        } catch (SecurityException ignored) { }
        drop(reason);
    }
    private boolean current(BluetoothGatt source) { return !closed && source == gatt; }
    private void stopScan() {
        if (scanning && scanner != null) {
            try { scanner.stopScan(scanCallback); }
            catch (SecurityException ignored) { }
            catch (RuntimeException ignored) { }
        }
        scanning = false;
    }
    private void drop(String warning) {
        BluetoothGatt previous = gatt;
        gatt = null;
        trusted = false;
        identityCharacteristic = null;
        operations.clear();
        nextScan = SystemClock.elapsedRealtime() + 5000;
        if (previous != null) {
            try { previous.disconnect(); }
            catch (SecurityException ignored) { }
            catch (RuntimeException ignored) { }
            try { previous.close(); }
            catch (SecurityException ignored) { }
            catch (RuntimeException ignored) { }
        }
        listener.onObservation(false, null, 0);
        if (!warning.isEmpty()) listener.onWarning(warning);
    }
    void close() {
        closed = true;
        stopScan();
        drop("");
        rejected.clear();
    }
}
