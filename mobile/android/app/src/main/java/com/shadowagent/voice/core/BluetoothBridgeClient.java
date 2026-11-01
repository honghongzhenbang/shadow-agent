package com.shadowagent.voice.core;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;

import org.json.JSONObject;

import java.io.IOException;
import java.net.ConnectException;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.UUID;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.SSLException;
import javax.net.ssl.TrustManager;

/** Bonded secure RFCOMM plus pinned TLS, with no discovery or automatic pairing request. */
public final class BluetoothBridgeClient implements RecordingTransport {
    public static final String RFCOMM_SERVICE_UUID = "7f8d8f62-7147-4a92-a23b-0cb593d41210";
    private final Context context;
    private final String address;
    private final String bridgeId;
    private final String serverName;
    private final String token;
    private final SSLContext tls;
    private final TransportGuard operations = new TransportGuard();

    public BluetoothBridgeClient(Context context, JSONObject pairing, String bluetoothAddress) throws IOException {
        validateAddress(bluetoothAddress);
        this.context = context == null ? null : context.getApplicationContext();
        JSONObject valid = AppSettings.validatePairing(pairing.toString());
        address = bluetoothAddress;
        bridgeId = valid.optString("bridgeId");
        serverName = valid.optString("serverName");
        token = valid.optString("token");
        try {
            tls = SSLContext.getInstance("TLS");
            tls.init(null, new TrustManager[]{PinnedBridgeTls.trustManager(valid.optString("certificateSha256"), serverName)},
                    new SecureRandom());
        } catch (GeneralSecurityException unavailable) { throw new SSLException("Cannot initialize bridge TLS."); }
    }

    @Override public void health() throws IOException {
        try (TransportGuard.Operation operation = operations.begin(TransportGuard.HEALTH_MS)) {
            try { connect(operation).health(bridgeId); operation.check(); }
            catch (IOException error) { operation.check(); throw error; }
        }
    }

    @Override public JSONObject upload(RecordingStore.Upload upload) throws IOException {
        try (TransportGuard.Operation operation = operations.begin(TransportGuard.UPLOAD_MS)) {
            try {
                LosslessUpload compressed = LosslessUpload.prepare(upload, operation);
                RfcommSession session = connect(operation);
                JSONObject receipt = session.upload(upload, compressed, operation);
                operation.check();
                return receipt;
            } catch (IOException error) { operation.check(); throw error; }
        }
    }

    @Override public JSONObject status(RecordingStore.Upload recording) throws IOException {
        return completion(recording, false);
    }

    @Override public JSONObject cleanupAck(RecordingStore.Upload recording) throws IOException {
        return completion(recording, true);
    }

    private JSONObject completion(RecordingStore.Upload recording, boolean acknowledge) throws IOException {
        try (TransportGuard.Operation operation = operations.begin(TransportGuard.HEALTH_MS)) {
            try {
                JSONObject result = connect(operation).completion(recording, acknowledge);
                operation.check();
                return result;
            } catch (IOException error) { operation.check(); throw error; }
        }
    }

    @SuppressLint("MissingPermission")
    private RfcommSession connect(TransportGuard.Operation operation) throws IOException {
        operation.phase(TransportGuard.HEALTH_MS);
        try {
            BluetoothDevice device = adapter(context).getRemoteDevice(address);
            requireBonded(device.getBondState());
            BluetoothSocket socket = device.createRfcommSocketToServiceRecord(UUID.fromString(RFCOMM_SERVICE_UUID));
            operation.attach(socket::close);
            operation.check();
            // Check again immediately before connect, without ever invoking createBond().
            requireBonded(device.getBondState());
            socket.connect();
            operation.progress();
            SSLEngine engine = tls.createSSLEngine(serverName, -1);
            engine.setUseClientMode(true);
            TlsEngineStream stream = new TlsEngineStream(engine, operation.input(socket.getInputStream()),
                    operation.output(socket.getOutputStream()), socket::close);
            stream.handshake();
            operation.check();
            RfcommSession session = new RfcommSession(new BridgeFrames(stream.input(), stream.output()));
            session.authenticate(token, bridgeId);
            operation.phase(0);
            return session;
        } catch (SecurityException denied) { throw new PermissionRequiredException(); }
    }

    /** Read-only; context may be null. Missing CONNECT permission is distinct from an unbonded device. */
    @SuppressLint("MissingPermission")
    public static boolean isBonded(Context context, String address) throws IOException {
        validateAddress(address);
        try { return adapter(context).getRemoteDevice(address).getBondState() == BluetoothDevice.BOND_BONDED; }
        catch (SecurityException denied) { throw new PermissionRequiredException(); }
    }

    public static boolean isBonded(String address) throws IOException { return isBonded(null, address); }

    @SuppressWarnings("deprecation")
    @SuppressLint("MissingPermission")
    private static BluetoothAdapter adapter(Context context) throws IOException {
        BluetoothAdapter adapter;
        if (context == null) adapter = BluetoothAdapter.getDefaultAdapter();
        else {
            BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
            adapter = manager == null ? null : manager.getAdapter();
        }
        if (adapter == null || !adapter.isEnabled()) throw new ConnectException("Bluetooth is unavailable or disabled.");
        return adapter;
    }

    private static void validateAddress(String address) {
        if (address == null || !address.matches("(?:[0-9A-F]{2}:){5}[0-9A-F]{2}"))
            throw new IllegalArgumentException("Invalid Bluetooth address format.");
    }

    static void requireBonded(int state) throws IOException {
        if (state != BluetoothDevice.BOND_BONDED) throw BridgeHealth.failure(BridgeHealth.State.NEEDS_PAIRING);
    }

    public static final class PermissionRequiredException extends IOException {
        private PermissionRequiredException() { super("Bluetooth connect permission is required."); }
    }

    @Override public void close() { operations.close(); }
}
