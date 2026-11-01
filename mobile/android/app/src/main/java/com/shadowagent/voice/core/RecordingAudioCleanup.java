package com.shadowagent.voice.core;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;

/** Only application-owned audio in one registered archive; user exports are not included. */
final class RecordingAudioCleanup {
    private static final String[] AUDIO_FILES = {"audio.wav", "audio.wav.part", "audio.wav.gz", "audio-upload.part"};

    static void validateDirectory(File root, File dir) throws IOException {
        if (Files.isSymbolicLink(root.toPath()) || Files.isSymbolicLink(dir.toPath())
                || !root.getCanonicalFile().equals(dir.getCanonicalFile().getParentFile())
                || !dir.isDirectory()) throw new IOException("Unsafe recording directory.");
    }

    static void validateFile(File dir, File file) throws IOException {
        if (Files.isSymbolicLink(file.toPath()) || !dir.getCanonicalFile().equals(file.getCanonicalFile().getParentFile())
                || (Files.exists(file.toPath(), LinkOption.NOFOLLOW_LINKS) && !file.isFile()))
            throw new IOException("Unsafe recording file.");
    }

    static void delete(File root, File dir) throws IOException {
        validateDirectory(root, dir);
        // Validate the complete allowlist before deleting any member.
        for (String name : AUDIO_FILES) validateFile(dir, new File(dir, name));
        for (String name : AUDIO_FILES) Files.deleteIfExists(new File(dir, name).toPath());
    }
}
