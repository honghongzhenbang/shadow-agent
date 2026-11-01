package com.shadowagent.voice.ui;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;

/** Presentation groups never change recording identities or transport receipts. */
public final class RecordingPresentation {
    private RecordingPresentation() { }

    public static List<List<JSONObject>> groups(JSONArray rows) {
        LinkedHashMap<String, List<JSONObject>> groups = new LinkedHashMap<>();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            String key = row.optString("sessionId", row.optString("id", "row-" + i));
            if (key.isBlank()) key = row.optString("id", "row-" + i);
            groups.computeIfAbsent(key, ignored -> new ArrayList<>()).add(row);
        }
        return new ArrayList<>(groups.values());
    }

    public static String label(JSONObject row) {
        if (row.optBoolean("phoneAudioDeleted")) {
            return row.optBoolean("audioDeleted") ? "文字已保存 · 两端音频已清理" : "手机已清理 · 电脑待清理";
        }
        String processing = row.optString("processingStatus");
        if (processing.equals("completed")) return row.optBoolean("retainAudio")
                ? "文字已保存 · 测试原音保留" : "文字已保存 · 等待清理";
        if (processing.equals("failed")) return "识别失败 · 原件保留";
        if (processing.equals("processing")) return "电脑正在识别";
        return switch (row.optString("state", "pending")) {
            case "sent", "uploaded" -> row.optBoolean("cleanupAfterTranscription") ? "已上传 · 等待处理" : "已上传 · 旧录音保留";
            case "recording" -> "录音中";
            case "uploading" -> "正在上传";
            case "failed", "error" -> "等待重试 · 原件保留";
            default -> "等待上传";
        };
    }
}
