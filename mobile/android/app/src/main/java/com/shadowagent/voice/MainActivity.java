package com.shadowagent.voice;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.bluetooth.BluetoothAdapter;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;
import com.shadowagent.voice.core.AppSettings;
import com.shadowagent.voice.core.AutoCaptureService;
import com.shadowagent.voice.core.RecordingStore;
import com.shadowagent.voice.ui.RecordingPresentation;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int INK = Color.rgb(23, 32, 35), MUTED = Color.rgb(109, 121, 127);
    private static final int GREEN = Color.rgb(13, 127, 102), BG = Color.rgb(244, 247, 248);
    private static final int ORANGE = Color.rgb(176, 103, 31), RED = Color.rgb(185, 63, 58);
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private LinearLayout root, body, navigation;
    private TextView status, detail, connection, uploadChannel, queued, elapsed, error;
    private Button captureButton;
    private ImageView mascot;
    private LinearLayout recent;
    private ImageButton settingsButton;
    private int tab = 0;
    private boolean loadingRecords;
    private long lastRecordsRefresh;
    private MediaPlayer player;
    private String playingId;
    private final java.util.HashSet<String> expandedSessions = new java.util.HashSet<>();
    private final Runnable refresh = new Runnable() {
        public void run() {
            if (tab == 0) updateStatus();
            if (tab < 2 && System.currentTimeMillis() - lastRecordsRefresh > 10000) loadRecords();
            handler.postDelayed(this, 1000);
        }
    };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if (state != null) tab = state.getInt("tab", 0);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        root = column(); root.setBackgroundColor(BG);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                root.setPadding(i.left, i.top, i.right, i.bottom);
            } else root.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        LinearLayout header = row(); header.setPadding(dp(24), dp(16), dp(16), dp(12));
        LinearLayout brand = column(); brand.addView(text("SHADOW AGENT", 11, GREEN, true));
        brand.addView(text("随行录音", 22, INK, true)); header.addView(brand, weight());
        settingsButton = icon(android.R.drawable.ic_menu_preferences, "设置", () -> { tab = tab == 2 ? 0 : 2; showTab(); });
        header.addView(settingsButton); root.addView(header);
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true);
        body = column(); body.setPadding(dp(24), dp(8), dp(24), dp(24)); scroll.addView(body);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        root.addView(divider()); navigation = row(); navigation.setBackgroundColor(Color.WHITE);
        String[] labels = {"状态", "记录"};
        int[] icons = {android.R.drawable.ic_menu_mylocation, android.R.drawable.ic_menu_recent_history};
        for (int i = 0; i < labels.length; i++) {
            final int index = i;
            TextView item = text(labels[i], 13, MUTED, true); item.setGravity(Gravity.CENTER);
            android.graphics.drawable.Drawable glyph = getDrawable(icons[i]).mutate();
            glyph.setBounds(0, 0, dp(20), dp(20)); glyph.setTint(MUTED);
            item.setCompoundDrawables(null, glyph, null, null); item.setCompoundDrawablePadding(dp(3));
            item.setContentDescription(labels[i]); item.setFocusable(true);
            item.setOnClickListener(v -> { tab = index; showTab(); });
            navigation.addView(item, new LinearLayout.LayoutParams(0, dp(64), 1));
        }
        root.addView(navigation); setContentView(root); showTab();
    }

    @Override protected void onResume() { super.onResume(); handler.removeCallbacks(refresh); handler.post(refresh); }
    @Override protected void onPause() { handler.removeCallbacks(refresh); stopPlayback(); super.onPause(); }
    @Override protected void onSaveInstanceState(Bundle state) { state.putInt("tab", tab); super.onSaveInstanceState(state); }
    @Override protected void onDestroy() { stopPlayback(); io.shutdown(); super.onDestroy(); }
    @Override public void onBackPressed() { if (tab != 0) { tab = 0; showTab(); } else super.onBackPressed(); }

    private void showTab() {
        stopPlayback();
        body.removeAllViews();
        for (int i = 0; i < 2; i++) {
            TextView item = (TextView) navigation.getChildAt(i);
            item.setTextColor(tab == i ? GREEN : MUTED);
            item.getCompoundDrawables()[1].setTint(tab == i ? GREEN : MUTED);
            item.setSelected(tab == i);
        }
        settingsButton.setImageResource(tab == 2 ? android.R.drawable.ic_menu_revert : android.R.drawable.ic_menu_preferences);
        settingsButton.setContentDescription(tab == 2 ? "返回状态" : "设置");
        if (tab == 0) showAutomatic(); else if (tab == 1) showRecordings(); else showSettings();
    }

    private void showAutomatic() {
        LinearLayout hero = row(); LinearLayout words = column();
        words.addView(text("随身采集", 12, MUTED, false));
        status = text("采集已暂停", 26, INK, true); words.addView(status);
        hero.addView(words, weight());
        mascot = new ImageView(this); mascot.setImageResource(R.drawable.shadow_idle);
        mascot.setContentDescription("影子 Agent"); mascot.setScaleType(ImageView.ScaleType.FIT_CENTER);
        hero.addView(mascot, new LinearLayout.LayoutParams(dp(104), dp(104))); body.addView(hero);
        detail = text("", 14, MUTED, false); detail.setMinHeight(dp(32)); addSpaced(detail, 4);
        elapsed = text("00:00:00", 36, INK, true); elapsed.setTypeface(Typeface.create("sans-serif-light", Typeface.NORMAL));
        elapsed.setMaxLines(1); elapsed.setAutoSizeTextTypeUniformWithConfiguration(20, 36, 1, android.util.TypedValue.COMPLEX_UNIT_SP);
        elapsed.setContentDescription("本次录音时长"); addSpaced(elapsed, 12);
        addSpaced(text("本次录音", 12, MUTED, false), 2);
        captureButton = button("继续采集", true); addSpaced(captureButton, 14);
        captureButton.setOnClickListener(v -> {
            JSONObject s = AutoCaptureService.snapshot(this);
            if (s.optBoolean("enabled")) disable(); else requestEnable();
        });
        error = text("", 13, RED, false); addSpaced(error, 12);
        addSpaced(divider(), 20, 1);
        addSpaced(text("设备与同步", 16, INK, true), 16);
        connection = metric("电脑连接"); uploadChannel = metric("上传通道"); queued = metric("处理进度");
        LinearLayout heading = row(); heading.addView(text("最近记录", 16, INK, true), weight());
        heading.addView(icon(android.R.drawable.ic_menu_recent_history, "查看全部记录", () -> { tab = 1; showTab(); }));
        addSpaced(heading, 20); recent = column(); body.addView(recent);
        updateStatus(); loadRecords();
    }

    private void updateStatus() {
        if (status == null || tab != 0) return;
        renderStatus(AutoCaptureService.snapshot(this));
    }

    void renderStatus(JSONObject s) {
        boolean enabled = s.optBoolean("enabled"), recording = s.optBoolean("recording");
        String mode = s.optString("mode", "disabled");
        String label = switch (mode) {
            case "near", "monitoring" -> s.optLong("departureRemainingMs", -1) >= 0 ? "正在确认离开" : "在电脑旁";
            case "away", "recording" -> recording ? "外出录音中" : "正在启动录音";
            case "uploading" -> "正在同步";
            case "connecting", "waiting", "waiting_baseline", "seeking" -> "正在寻找电脑";
            case "stopping" -> "正在保存录音";
            case "error", "interrupted" -> "需要处理";
            default -> enabled ? (recording ? "外出录音中" : "采集已就绪") : "采集已暂停";
        };
        if (!enabled && !recording && !mode.equals("stopping")) label = s.optBoolean("captureDesired") ? "采集需要恢复" : "采集已暂停";
        if (s.optBoolean("captureBlocked")) label = s.optBoolean("storageBlocked") ? "存储空间不足" : "采集暂挂起";
        status.setText(label); status.setTextColor(recording ? RED : s.optBoolean("captureBlocked") ? ORANGE : INK);
        detail.setText(s.optString("status", enabled ? "离开后录音，返回后同步。" : "已停止新录音，待处理片段仍会同步。"));
        connection.setText(s.optBoolean("connected") ? "已连接" : enabled ? "正在重连" : "未连接");
        uploadChannel.setText(s.optString("uploadChannel", "等待连接"));
        queued.setText("待传 " + s.optInt("queuedCount", 0) + " · 处理中 " + s.optInt("processingCount", 0)
            + (s.optInt("cleanupPendingCount", 0) > 0 ? "\n待清理 " + s.optInt("cleanupPendingCount") : "")
            + (s.optInt("failedCount", 0) > 0 ? "\n失败 " + s.optInt("failedCount") : ""));
        elapsed.setText(formatDuration(s.optLong("elapsedMs", 0)));
        String message = s.optString("error", ""); error.setText(message); error.setVisibility(message.isEmpty() ? View.GONE : View.VISIBLE);
        captureButton.setText(enabled ? "暂停采集" : "继续采集");
        captureButton.setContentDescription(enabled ? "暂停采集" : "继续采集");
        android.graphics.drawable.Drawable glyph = getDrawable(enabled ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play).mutate();
        glyph.setTint(Color.WHITE); glyph.setBounds(0, 0, dp(20), dp(20)); captureButton.setCompoundDrawables(glyph, null, null, null);
        captureButton.setEnabled(!mode.equals("stopping"));
        mascot.setImageResource(recording ? R.drawable.shadow_running : enabled && !s.optBoolean("captureBlocked") ? R.drawable.shadow_idle : R.drawable.shadow_waiting);
    }

    private void requestEnable() {
        AppSettings settings = new AppSettings(this);
        JSONObject pairing;
        try { pairing = settings.pairing(); }
        catch (IllegalArgumentException invalid) { resetSwitch(); showError(invalid.getMessage()); return; }
        if (pairing == null) {
            resetSwitch(); new AlertDialog.Builder(this).setTitle("尚未配对电脑").setMessage("请先导入电脑端生成的配对文件。")
                .setPositiveButton("去配对", (d, w) -> { tab = 2; showTab(); }).setNegativeButton("取消", null).show(); return;
        }
        if (getPreferences(MODE_PRIVATE).getBoolean("captureConsent", false)) { checkPermissions(); return; }
        new AlertDialog.Builder(this).setTitle("开始随身采集")
            .setMessage("离开电脑后录音，返回后同步。转写并保存文字后，将自动删除两端音频。仅在参与者知情且允许录音的场合使用；可随时暂停。")
            .setPositiveButton("同意并继续", (d, w) -> { getPreferences(MODE_PRIVATE).edit().putBoolean("captureConsent", true).apply(); checkPermissions(); })
            .setNegativeButton("取消", null).show();
    }

    private void checkPermissions() {
        ArrayList<String> needed = new ArrayList<>(); needed.add(Manifest.permission.RECORD_AUDIO);
        if (Build.VERSION.SDK_INT >= 31) { needed.add(Manifest.permission.BLUETOOTH_SCAN); needed.add(Manifest.permission.BLUETOOTH_CONNECT); }
        else needed.add(Manifest.permission.ACCESS_FINE_LOCATION);
        if (Build.VERSION.SDK_INT >= 33) needed.add(Manifest.permission.POST_NOTIFICATIONS);
        needed.removeIf(p -> checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED);
        if (!needed.isEmpty()) requestPermissions(needed.toArray(new String[0]), 30); else startAutomatic();
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request != 30) return;
        for (int result : results) if (result != PackageManager.PERMISSION_GRANTED) { resetSwitch(); showError("采集需要麦克风、附近设备和通知权限。请在应用设置中授权。"); return; }
        if (results.length == 0) { resetSwitch(); return; }
        startAutomatic();
    }

    private void startAutomatic() {
        try {
            stopPlayback();
            if (Build.VERSION.SDK_INT >= 31 && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED)
                throw new SecurityException("附近设备权限未授予，请重新授权。");
            BluetoothAdapter adapter = getSystemService(android.bluetooth.BluetoothManager.class).getAdapter();
            if (adapter == null) throw new IllegalStateException("设备不支持蓝牙");
            if (!adapter.isEnabled()) { startActivityForResult(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), 31); return; }
            startForegroundService(new Intent(this, AutoCaptureService.class).setAction(AutoCaptureService.ACTION_ENABLE));
            handler.postDelayed(this::updateStatus, 300);
        } catch (SecurityException e) { resetSwitch(); showError("权限已变更，请重新授予附近设备和麦克风权限。"); }
        catch (Exception e) { resetSwitch(); showError(e.getMessage()); }
    }

    private void resetSwitch() { updateStatus(); }
    private void disable() {
        startService(new Intent(this, AutoCaptureService.class).setAction(AutoCaptureService.ACTION_DISABLE));
        handler.postDelayed(this::updateStatus, 300);
    }

    private void showRecordings() {
        LinearLayout heading = row(); heading.addView(text("采集记录", 22, INK, true), weight());
        heading.addView(icon(android.R.drawable.ic_popup_sync, "刷新", this::showRecordingsFresh)); body.addView(heading);
        addSpaced(text("正在读取…", 14, MUTED, false), 20); loadRecords();
    }

    private void loadRecords() {
        if (loadingRecords || io.isShutdown()) return;
        loadingRecords = true; lastRecordsRefresh = System.currentTimeMillis();
        io.execute(() -> {
            try { JSONArray rows = new RecordingStore(this).list(); runOnUiThread(() -> {
                loadingRecords = false;
                if (isDestroyed()) return;
                if (tab == 1) renderRecordings(rows); else if (tab == 0) renderRecent(rows);
            }); }
            catch (Exception e) { runOnUiThread(() -> { loadingRecords = false; if (!isDestroyed()) toast("记录读取失败，请稍后刷新"); }); }
        });
    }

    private void showRecordingsFresh() { body.removeAllViews(); showRecordings(); }

    private void renderRecordings(JSONArray rows) {
        while (body.getChildCount() > 1) body.removeViewAt(1);
        if (rows.length() == 0) { addSpaced(text("还没有采集记录", 16, MUTED, false), 32); return; }
        for (java.util.List<JSONObject> group : RecordingPresentation.groups(rows)) {
            JSONObject first = group.get(0);
            String session = first.optString("sessionId", first.optString("id"));
            if (group.size() > 1) {
                long duration = 0; int cleaned = 0;
                for (JSONObject item : group) { duration += item.optLong("durationMs"); if (item.optBoolean("phoneAudioDeleted") && item.optBoolean("audioDeleted")) cleaned++; }
                LinearLayout heading = row(); heading.setPadding(0, dp(16), 0, dp(8));
                LinearLayout caption = column(); caption.addView(text(localTime(first.optString("recordedAt")), 16, INK, true));
                caption.addView(text(formatDuration(duration) + " · " + group.size() + " 段 · 已清理 " + cleaned + " 段", 12, MUTED, false));
                heading.addView(caption, weight());
                heading.addView(icon(expandedSessions.contains(session) ? android.R.drawable.arrow_up_float : android.R.drawable.arrow_down_float,
                    expandedSessions.contains(session) ? "收起片段" : "展开片段", () -> {
                        if (!expandedSessions.remove(session)) expandedSessions.add(session);
                        renderRecordings(rows);
                    }));
                body.addView(heading); body.addView(divider());
                if (!expandedSessions.contains(session)) continue;
            }
            for (JSONObject r : group) {
            String id = r.optString("id"); LinearLayout section = column(); section.setPadding(0, dp(18), 0, dp(14));
            TextView name = text(group.size() > 1 ? "录音片段" : "随身采集", 16, INK, true); section.addView(name);
            String when = localTime(r.optString("recordedAt", ""));
            TextView date = text(when + "   " + formatDuration(r.optLong("durationMs")), 13, MUTED, false); section.addView(date);
            String state = r.optString("state", "pending");
            String label = recordingLabel(r);
            LinearLayout actions = row(); actions.addView(text(label, 13, GREEN, false), weight());
            boolean available = r.optBoolean("audioAvailable", !r.optString("audioPath").isEmpty()) && !state.equals("recording");
            if (available) {
                actions.addView(icon(id.equals(playingId) ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play, "播放录音", () -> play(r)));
                actions.addView(icon(android.R.drawable.ic_menu_share, "导出录音", () -> export(id)));
            }
            actions.addView(icon(android.R.drawable.ic_menu_delete, "删除录音", () -> confirmDelete(id)));
            section.addView(actions);
            if (!r.optString("lastError").isEmpty()) section.addView(text(r.optString("lastError"), 12, RED, false));
            body.addView(section); body.addView(divider());
            }
        }
    }

    private void renderRecent(JSONArray rows) {
        if (recent == null) return;
        recent.removeAllViews();
        if (rows.length() == 0) { recent.addView(text("暂无记录", 14, MUTED, false)); return; }
        for (int i = 0; i < Math.min(3, rows.length()); i++) {
            JSONObject r = rows.optJSONObject(i); if (r == null) continue;
            LinearLayout line = column(); line.setPadding(0, dp(12), 0, dp(12));
            LinearLayout summary = row();
            summary.addView(text(localTime(r.optString("recordedAt")), 14, INK, true), weight());
            summary.addView(text(formatDuration(r.optLong("durationMs")), 13, MUTED, false));
            line.addView(summary); line.addView(text(recordingLabel(r), 12, GREEN, false));
            line.setContentDescription("查看记录 " + localTime(r.optString("recordedAt")));
            line.setOnClickListener(v -> { tab = 1; showTab(); });
            recent.addView(line); recent.addView(divider());
        }
    }

    static String recordingLabel(JSONObject r) {
        return RecordingPresentation.label(r);
    }

    private static String localTime(String raw) {
        try { return java.time.Instant.parse(raw).atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("MM月dd日 HH:mm")); }
        catch (Exception invalid) { return raw.isEmpty() ? "时间待确认" : raw; }
    }

    private void play(JSONObject row) {
        String id = row.optString("id");
        if (id.equals(playingId)) { stopPlayback(); showRecordingsFresh(); return; }
        if (AutoCaptureService.snapshot(this).optBoolean("recording")) { showError("请等待录音结束后回听，避免声音重新录入。"); return; }
        try {
            stopPlayback(); player = new MediaPlayer(); player.setDataSource(row.getString("audioPath"));
            player.setOnPreparedListener(mp -> { playingId = id; mp.start(); showRecordingsFresh(); });
            player.setOnCompletionListener(mp -> { stopPlayback(); if (tab == 1) showRecordingsFresh(); });
            player.setOnErrorListener((mp, what, extra) -> { stopPlayback(); showError("录音暂时无法播放"); return true; });
            player.prepareAsync();
        } catch (Exception e) { stopPlayback(); showError(e.getMessage()); }
    }

    private void stopPlayback() { if (player != null) { player.release(); player = null; } playingId = null; }
    private void export(String id) {
        io.execute(() -> {
            try {
                File file = new RecordingStore(this).exportZip(id);
                Uri uri = ExportProvider.uri(this, file);
                runOnUiThread(() -> {
                    Intent share = new Intent(Intent.ACTION_SEND).setType("application/zip").putExtra(Intent.EXTRA_STREAM, uri)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    share.setClipData(ClipData.newRawUri("录音文件", uri));
                    startActivity(Intent.createChooser(share, "导出录音"));
                });
            } catch (Exception e) { runOnUiThread(() -> showError(e.getMessage())); }
        });
    }

    private void confirmDelete(String id) {
        new AlertDialog.Builder(this).setTitle("删除本机录音？").setMessage("尚未上传的录音删除后无法恢复，电脑已有副本不受影响。")
            .setNegativeButton("取消", null).setPositiveButton("删除", (d, w) -> io.execute(() -> {
                try {
                    if (id.equals(playingId)) runOnUiThread(this::stopPlayback);
                    boolean deleted = new RecordingStore(this).delete(id);
                    runOnUiThread(() -> {
                        if (deleted) { if (tab == 1) showRecordingsFresh(); }
                        else showError("片段正在录制或上传，暂时不能删除。");
                    });
                }
                catch (Exception e) { runOnUiThread(() -> showError(e.getMessage())); }
            })).show();
    }

    private void showSettings() {
        AppSettings settings = new AppSettings(this);
        body.addView(text("电脑配对", 22, INK, true));
        String pairingStatus;
        try { pairingStatus = settings.pairing() == null ? "未导入电脑配置" : "已导入电脑配置"; }
        catch (IllegalArgumentException invalid) { pairingStatus = invalid.getMessage(); }
        addSpaced(text(pairingStatus, 14, MUTED, false), 8);
        Button importButton = button("导入配对文件", false); addSpaced(importButton, 18);
        importButton.setOnClickListener(v -> {
            if (AutoCaptureService.snapshot(this).optBoolean("enabled")) { showError("更换配对前请先暂停采集。"); return; }
            Intent select = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);
            startActivityForResult(select, 40);
        });
        Button pasteButton = button("粘贴配对配置", false); addSpaced(pasteButton, 8); pasteButton.setOnClickListener(v -> pastePairing());
        Button bluetooth = button("系统蓝牙配对", false); addSpaced(bluetooth, 8);
        bluetooth.setCompoundDrawablesWithIntrinsicBounds(android.R.drawable.ic_menu_manage, 0, 0, 0);
        bluetooth.setOnClickListener(v -> {
            try { startActivity(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS)); }
            catch (Exception unavailable) { showError("无法打开蓝牙设置，请从手机系统设置进入蓝牙并配对电脑。"); }
        });
        addSpaced(divider(), 24, 1);
        Button advanced = button("距离与诊断", false); addSpaced(advanced, 16);
        advanced.setOnClickListener(v -> showAdvanced());
        addSpaced(text("音频清理", 18, INK, true), 24);
        addSpaced(text("新录音转写成功并保存文字后，自动清理手机和电脑音频；失败片段保留等待重试。旧录音不会自动删除。", 14, MUTED, false), 8);
        addSpaced(divider(), 24, 1); addSpaced(text("系统设置", 18, INK, true), 22);
        Button app = button("权限与通知", false); addSpaced(app, 14);
        app.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))));
        Button battery = button("电池与后台运行", false); addSpaced(battery, 8);
        battery.setOnClickListener(v -> { try { startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); } catch (Exception e) { startActivity(new Intent(Settings.ACTION_SETTINGS)); } });
        addSpaced(text("随行录音 " + BuildConfig.VERSION_NAME + " · SHADOW AGENT", 12, MUTED, false), 24);
        addSpaced(text(Build.MANUFACTURER + " " + Build.MODEL + " · Android " + Build.VERSION.RELEASE, 12, MUTED, false), 4);
    }

    private void showAdvanced() {
        body.removeAllViews(); AppSettings settings = new AppSettings(this);
        Button back = button("返回设置", false); body.addView(back); back.setOnClickListener(v -> showTab());
        addSpaced(text("距离灵敏度", 20, INK, true), 22);
        TextView leave = text("离开阈值  " + settings.leaveRssi() + " dBm", 14, INK, false); addSpaced(leave, 14);
        SeekBar farBar = new SeekBar(this); farBar.setMax(55); farBar.setProgress(settings.leaveRssi() + 100); body.addView(farBar);
        TextView near = text("返回阈值  " + settings.returnRssi() + " dBm", 14, INK, false); addSpaced(near, 10);
        SeekBar nearBar = new SeekBar(this); nearBar.setMax(55); nearBar.setProgress(settings.returnRssi() + 100); body.addView(nearBar);
        SeekBar.OnSeekBarChangeListener change = new SeekBar.OnSeekBarChangeListener() {
            public void onProgressChanged(SeekBar b, int n, boolean user) { leave.setText("离开阈值  " + (farBar.getProgress() - 100) + " dBm"); near.setText("返回阈值  " + (nearBar.getProgress() - 100) + " dBm"); }
            public void onStartTrackingTouch(SeekBar b) { }
            public void onStopTrackingTouch(SeekBar b) { }
        };
        farBar.setOnSeekBarChangeListener(change); nearBar.setOnSeekBarChangeListener(change);
        Button save = button("保存阈值", false); addSpaced(save, 10); save.setOnClickListener(v -> {
            try {
                if (AutoCaptureService.snapshot(this).optBoolean("enabled")) throw new IllegalStateException("修改阈值前请先暂停采集。");
                settings.setThresholds(farBar.getProgress() - 100, nearBar.getProgress() - 100); toast("已保存");
            } catch (Exception e) { showError(e.getMessage()); }
        });
        JSONObject s = AutoCaptureService.snapshot(this);
        addSpaced(text("蓝牙信号  " + (s.optInt("rssi", 0) < 0 ? s.optInt("rssi") + " dBm" : "未知"), 14, MUTED, false), 24);
        addSpaced(text("上传通道  " + s.optString("uploadChannel", "等待连接"), 14, MUTED, false), 8);
    }

    private void pastePairing() {
        if (AutoCaptureService.snapshot(this).optBoolean("enabled")) { showError("更换配对前请先暂停采集。"); return; }
        EditText input = new EditText(this); input.setHint("配对 JSON"); input.setMinLines(4); input.setMaxLines(8); input.setTextSize(14);
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE | android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        input.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("配对电脑").setView(input).setPositiveButton("保存", null).setNegativeButton("取消", null).create();
        dialog.setOnShowListener(d -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            try { new AppSettings(this).importPairing(input.getText().toString()); dialog.dismiss(); showTab(); toast("电脑配置已导入"); }
            catch (Exception e) { input.setError(e.getMessage()); }
        })); dialog.show();
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 31) { if (result == RESULT_OK) startAutomatic(); else resetSwitch(); return; }
        if (request != 40 || result != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        io.execute(() -> {
            try (InputStream in = getContentResolver().openInputStream(uri); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                if (in == null) throw new IllegalArgumentException("无法读取配对文件");
                byte[] buf = new byte[4096]; int n;
                while ((n = in.read(buf)) != -1) { if (out.size() + n > 16384) throw new IllegalArgumentException("配对文件过大"); out.write(buf, 0, n); }
                String config = new String(out.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
                runOnUiThread(() -> {
                    try { new AppSettings(this).importPairing(config); if (tab == 2) showTab(); toast("电脑配置已导入"); }
                    catch (Exception invalid) { showError(invalid.getMessage()); }
                });
            } catch (Exception e) { runOnUiThread(() -> showError(e.getMessage())); }
        });
    }

    private TextView metric(String name) {
        LinearLayout line = row(); line.setPadding(0, dp(12), 0, dp(12)); line.addView(text(name, 14, MUTED, false), weight());
        TextView value = text("--", 14, INK, true); value.setGravity(Gravity.END);
        line.addView(value, new LinearLayout.LayoutParams(0, -2, 1.4f)); body.addView(line); body.addView(divider()); return value;
    }
    private Button button(String label, boolean primary) {
        Button b = new Button(this); b.setText(label); b.setTextSize(15); b.setAllCaps(false); b.setMinHeight(dp(primary ? 56 : 48));
        b.setPadding(dp(20), dp(12), dp(20), dp(12)); b.setLetterSpacing(0);
        b.setTextColor(primary ? Color.WHITE : INK); b.setBackground(background(primary ? INK : Color.WHITE, 8)); return b;
    }
    private ImageButton icon(int resource, String label, Runnable action) {
        ImageButton b = new ImageButton(this); b.setImageResource(resource); b.setColorFilter(MUTED);
        b.setBackground(background(Color.TRANSPARENT, 6)); b.setContentDescription(label); b.setTooltipText(label);
        b.setLayoutParams(new LinearLayout.LayoutParams(dp(48), dp(48))); b.setOnClickListener(v -> action.run()); return b;
    }
    private TextView text(String content, int size, int color, boolean bold) {
        TextView t = new TextView(this); t.setText(content); t.setTextSize(size); t.setTextColor(color); t.setLetterSpacing(0);
        t.setIncludeFontPadding(true); if (bold) t.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); return t;
    }
    private LinearLayout column() { LinearLayout v = new LinearLayout(this); v.setOrientation(LinearLayout.VERTICAL); return v; }
    private LinearLayout row() { LinearLayout v = new LinearLayout(this); v.setOrientation(LinearLayout.HORIZONTAL); v.setGravity(Gravity.CENTER_VERTICAL); return v; }
    private LinearLayout.LayoutParams weight() { return new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1); }
    private View divider() { View v = new View(this); v.setBackgroundColor(Color.rgb(225, 232, 228)); v.setLayoutParams(new LinearLayout.LayoutParams(-1, dp(1))); return v; }
    private GradientDrawable background(int color, int radius) { GradientDrawable d = new GradientDrawable(); d.setColor(color); d.setCornerRadius(dp(radius)); return d; }
    private void addSpaced(View v, int margin) { addSpaced(v, margin, -2); }
    private void addSpaced(View v, int margin, int height) { LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, height < 0 ? height : dp(height)); p.topMargin = dp(margin); body.addView(v, p); }
    private int dp(float n) { return Math.round(n * getResources().getDisplayMetrics().density); }
    private void toast(String value) { Toast.makeText(this, value, Toast.LENGTH_SHORT).show(); }
    private void showError(String message) { if (!isFinishing() && !isDestroyed()) new AlertDialog.Builder(this).setTitle("暂时无法继续").setMessage(message == null ? "请查看权限和系统设置。" : message).setPositiveButton("知道了", null).show(); }
    private static String formatDuration(long millis) { long s = millis / 1000; return String.format(Locale.ROOT, "%02d:%02d:%02d", s / 3600, (s / 60) % 60, s % 60); }

}
