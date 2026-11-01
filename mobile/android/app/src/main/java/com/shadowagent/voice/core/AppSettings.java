package com.shadowagent.voice.core;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Locale;
import java.util.UUID;

/** Pairing is an explicit trust decision; import only from the visible activity. */
public final class AppSettings {
    public static final String SERVICE_UUID = "7f8d8f60-7147-4a92-a23b-0cb593d41210";
    public static final String IDENTITY_UUID = "7f8d8f61-7147-4a92-a23b-0cb593d41210";
    private static final Object LOCK = new Object();
    private static boolean processInitialized;
    private final SharedPreferences prefs;

    AppSettings(SharedPreferences preferences) { prefs = preferences; }

    public AppSettings(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences("voice_core", Context.MODE_PRIVATE);
        synchronized (LOCK) {
            if (!processInitialized) {
                initializeProcess(prefs);
                processInitialized = true;
            }
            if (!prefs.contains("deviceId")) {
                commit(prefs.edit().putString("deviceId", UUID.randomUUID().toString()));
            }
        }
    }

    /** Returns null until paired; returned JSON is a defensive copy. */
    public JSONObject pairing() {
        String raw = prefs.getString("pairing", null);
        if (raw == null) return null;
        return validatePairing(raw);
    }

    public void importPairing(String rawJson) {
        JSONObject validated = validatePairing(rawJson);
        synchronized (LOCK) {
            if (autoEnabled()) throw new IllegalStateException("请先停用自动录音，再修改配对配置。");
            SharedPreferences.Editor edit = prefs.edit().putString("pairing", validated.toString());
            if (!validated.toString().equals(prefs.getString("pairing", null))) {
                AutoCaptureService.preparePairingChange();
                edit.remove("verifiedPairing");
            }
            commit(edit);
        }
    }

    static JSONObject validatePairing(String raw) {
        try {
            if (raw == null || raw.length() > 16384) throw new IllegalArgumentException("配对配置为空或超过大小限制。");
            JSONObject in = new JSONObject(raw);
            if (in.opt("schemaVersion") instanceof Number && in.optDouble("schemaVersion") == 1)
                throw new IllegalArgumentException("旧版配对需要升级。请升级电脑接收端，重新生成并导入 schemaVersion=2 配对文件。");
            if (!(in.get("schemaVersion") instanceof Number) || in.getDouble("schemaVersion") != 2)
                throw new IllegalArgumentException("配对配置版本不受支持，需要 schemaVersion=2。");
            String bridge = string(in, "bridgeId");
            if (!bridge.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))
                throw new IllegalArgumentException("电脑桥接标识 bridgeId 无效。");
            if (!SERVICE_UUID.equalsIgnoreCase(string(in, "serviceUuid"))
                    || !IDENTITY_UUID.equalsIgnoreCase(string(in, "identityCharacteristicUuid")))
                throw new IllegalArgumentException("配对配置的蓝牙服务或身份特征 UUID 不匹配。");
            String serverName = string(in, "serverName");
            if (!serverName.equals("voice-" + bridge + ".local") || in.has("serverUrl"))
                throw new IllegalArgumentException("配对必须包含固定电脑名称 serverName，不能包含旧版 serverUrl。");
            String token = string(in, "token");
            if (!token.matches("[!-~]{1,4096}")) throw new IllegalArgumentException("配对口令为空、过长或含不支持的字符。");
            String pin = string(in, "certificateSha256").replace(":", "").toLowerCase(Locale.ROOT);
            if (!pin.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("证书 SHA-256 指纹必须为 64 位十六进制字符。");
            return new JSONObject().put("schemaVersion", 2).put("bridgeId", bridge)
                    .put("serviceUuid", SERVICE_UUID).put("identityCharacteristicUuid", IDENTITY_UUID)
                    .put("serverName", serverName)
                    .put("token", token).put("certificateSha256", pin);
        } catch (Exception e) {
            if (e instanceof IllegalArgumentException) throw (IllegalArgumentException) e;
            throw new IllegalArgumentException("配对 JSON 格式错误或缺少必要字段。", e);
        }
    }

    private static String string(JSONObject object, String key) throws JSONException {
        Object value = object.get(key);
        if (!(value instanceof String)) throw new IllegalArgumentException("配对字段 " + key + " 必须为字符串。");
        return (String) value;
    }

    static boolean isLanIpv4(String host) {
        if (host == null) return false;
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) return false;
        int[] a = new int[4];
        for (int i = 0; i < 4; i++) {
            if (!parts[i].matches("0|[1-9][0-9]{0,2}")) return false;
            a[i] = Integer.parseInt(parts[i]);
            if (a[i] > 255) return false;
        }
        return a[0] == 10 || (a[0] == 172 && a[1] >= 16 && a[1] <= 31)
                || (a[0] == 192 && a[1] == 168) || (a[0] == 169 && a[1] == 254);
    }

    public boolean autoEnabled() { return prefs.getBoolean("autoEnabled", false); }
    public void autoEnabled(boolean enabled) { commit(prefs.edit().putBoolean("autoEnabled", enabled)); }
    /** User intent only. This never starts a service or authorizes a background microphone. */
    public boolean captureDesired() { return prefs.getBoolean("captureDesired", false); }
    public void captureDesired(boolean desired) { commit(prefs.edit().putBoolean("captureDesired", desired)); }
    /** Durable binding fact, not a reusable transport authorization. */
    public boolean pairingVerified() {
        String current = prefs.getString("pairing", null);
        return current != null && current.equals(prefs.getString("verifiedPairing", null));
    }
    void verifyPairing(JSONObject authenticatedPairing) {
        synchronized (LOCK) {
            String current = prefs.getString("pairing", null);
            if (current == null || !current.equals(authenticatedPairing.toString()))
                throw new IllegalStateException("配对已变更，请在前台重新启用。");
            commit(prefs.edit().putString("verifiedPairing", current));
        }
    }
    static void initializeProcess(SharedPreferences prefs) {
        boolean desired = prefs.getBoolean("captureDesired", prefs.getBoolean("autoEnabled", false));
        SharedPreferences.Editor edit = prefs.edit().putBoolean("captureDesired", desired).putBoolean("autoEnabled", false);
        if (desired) edit.putString("lastMode", "needs_restore")
                .putString("lastError", "采集服务已中断，请从前台继续采集。");
        commit(edit);
    }
    public int leaveRssi() { return prefs.getInt("leaveRssi", -80); }
    public int returnRssi() { return prefs.getInt("returnRssi", -65); }
    public void setThresholds(int leave, int near) {
        ProximityPolicy.validateThresholds(leave, near);
        if (autoEnabled()) throw new IllegalStateException("请先停用自动录音，再修改信号阈值。");
        commit(prefs.edit().putInt("leaveRssi", leave).putInt("returnRssi", near));
    }
    public String deviceId() { return prefs.getString("deviceId", ""); }
    String lastMode() { return prefs.getString("lastMode", "disabled"); }
    String lastError() { return prefs.getString("lastError", ""); }
    void stopped(String mode, String error) {
        commit(prefs.edit().putBoolean("autoEnabled", false).putString("lastMode", mode).putString("lastError", error));
    }
    private static void commit(SharedPreferences.Editor editor) {
        if (!editor.commit()) throw new IllegalStateException("无法保存应用设置，请检查手机存储空间。");
    }
}
