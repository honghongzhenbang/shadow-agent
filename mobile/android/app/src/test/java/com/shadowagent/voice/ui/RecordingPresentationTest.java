package com.shadowagent.voice.ui;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class RecordingPresentationTest {
    @Test public void groupingKeepsEveryOriginalAndDoesNotMergeUnknownSessions() throws Exception {
        JSONArray rows = new JSONArray("[{id:'a',sessionId:'session-a'},{id:'b',sessionId:'session-a'},{id:'c'},{id:'d'}]");
        var groups = RecordingPresentation.groups(rows);
        assertEquals(3, groups.size()); assertEquals(2, groups.get(0).size());
        assertSame(rows.getJSONObject(0), groups.get(0).get(0));
    }
    @Test public void uploadedIsNotTranscribedOrDeleted() throws Exception {
        assertEquals("已上传 · 等待处理", RecordingPresentation.label(new JSONObject("{state:'sent',cleanupAfterTranscription:true}")));
        assertEquals("已上传 · 旧录音保留", RecordingPresentation.label(new JSONObject("{state:'sent'}")));
    }
    @Test public void bothEndpointsMustBeDeletedBeforeClaimingIt() throws Exception {
        assertEquals("手机已清理 · 电脑待清理", RecordingPresentation.label(new JSONObject("{state:'cleaned',phoneAudioDeleted:true,audioDeleted:false}")));
        assertEquals("文字已保存 · 两端音频已清理", RecordingPresentation.label(new JSONObject("{phoneAudioDeleted:true,audioDeleted:true}")));
    }
    @Test public void failedProcessingIsVisible() throws Exception {
        assertEquals("识别失败 · 原件保留", RecordingPresentation.label(new JSONObject("{state:'sent',processingStatus:'failed'}")));
    }
}
