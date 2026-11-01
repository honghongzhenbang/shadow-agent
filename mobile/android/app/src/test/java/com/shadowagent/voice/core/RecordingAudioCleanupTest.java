package com.shadowagent.voice.core;

import org.junit.Rule;
import org.junit.Test;
import org.junit.Assume;
import org.junit.rules.TemporaryFolder;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import static org.junit.Assert.*;

public final class RecordingAudioCleanupTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();

    @Test public void deletesOnlyRegisteredAudioAndRetryIsIdempotent() throws Exception {
        File root = folder.newFolder("archive"), dir = new File(root, "recording");
        assertTrue(dir.mkdir());
        for (String name : new String[]{"audio.wav", "audio.wav.part", "audio.wav.gz", "audio-upload.part",
                "manifest.json", "capture.json", "state.json", "user-export.zip"}) Files.write(new File(dir, name).toPath(), new byte[]{1});
        RecordingAudioCleanup.delete(root, dir);
        RecordingAudioCleanup.delete(root, dir);
        assertFalse(new File(dir, "audio.wav").exists());
        assertFalse(new File(dir, "audio.wav.part").exists());
        assertFalse(new File(dir, "audio.wav.gz").exists());
        assertFalse(new File(dir, "audio-upload.part").exists());
        for (String name : new String[]{"manifest.json", "capture.json", "state.json", "user-export.zip"})
            assertTrue(new File(dir, name).isFile());
    }

    @Test public void outsideDirectoryAndUnexpectedAudioDirectoryFailBeforeDeletion() throws Exception {
        File root = folder.newFolder("archive"), dir = folder.newFolder("outside");
        assertThrows(IOException.class, () -> RecordingAudioCleanup.delete(root, dir));
        File item = new File(root, "recording");
        assertTrue(item.mkdir());
        File wav = new File(item, "audio.wav");
        Files.write(wav.toPath(), new byte[]{1});
        assertTrue(new File(item, "audio.wav.gz").mkdir());
        assertThrows(IOException.class, () -> RecordingAudioCleanup.delete(root, item));
        assertTrue(wav.isFile());
    }

    @Test public void symlinkIsRejectedWithoutTouchingTargetOrOriginal() throws Exception {
        File root = folder.newFolder("archive"), dir = new File(root, "recording");
        assertTrue(dir.mkdir());
        File outside = folder.newFile("outside.wav"), wav = new File(dir, "audio.wav");
        Files.write(wav.toPath(), new byte[]{1});
        try { Files.createSymbolicLink(new File(dir, "audio.wav.gz").toPath(), outside.toPath()); }
        catch (IOException | UnsupportedOperationException | SecurityException unavailable) {
            Assume.assumeNoException("Host does not permit symbolic links", unavailable);
        }
        assertThrows(IOException.class, () -> RecordingAudioCleanup.delete(root, dir));
        assertTrue(wav.isFile());
        assertTrue(outside.isFile());
    }
}
