/**
 * Native Android automatic capture core (min 29, compile 36, target 35).
 *
 * <p>Integration: MainActivity must obtain runtime permissions and send ACTION_ENABLE while visible.
 * Declare INTERNET, WAKE_LOCK, FOREGROUND_SERVICE, FOREGROUND_SERVICE_MICROPHONE,
 * FOREGROUND_SERVICE_CONNECTED_DEVICE and the microphone/connectedDevice service types.
 * API 29 does not have the microphone FGS type bit; connectedDevice is used there.
 * No boot receiver, background restart, alarm, job, or sticky service is provided.
 * START_NOT_STICKY plus a process-start stale-enable check requires a fresh visible enable after death.
 * settings.pairing() returns null when unpaired. Import and thresholds require auto mode disabled.
 *
 * <p>Safety: the initial policy waits for 10 seconds of identity-verified BLE plus pinned authenticated
 * health; initial absence never records. RSSI is read every 5 seconds, expires after 12 seconds,
 * and authenticated health expires after 15 seconds. Weak signal takes 15 seconds, disconnect
 * takes 20 seconds, and authenticated return takes 10 seconds. Threshold changes require disable.
 *
 * <p>Power: a PARTIAL_WAKE_LOCK is held throughout enabled monitoring, not only capture, so CPU timers
 * and GATT polling can continue with the screen off. A 10-minute lease is renewed every 9 minutes
 * and released on every stop/destroy/error path. This uses more battery than opportunistic BLE;
 * it does not bypass Doze networking restrictions, Android force-stop, or Xiaomi power management.
 * Screen-off capture/resume, Android 29/30 location-dependent scanning, OEM endurance and power
 * consumption still require device acceptance. Never treat compilation/emulator UI tests as proof.
 *
 * <p>Archive: app-private no-backup storage, PCM16 mono 16 kHz, maximum 120 seconds per WAV.
 * Chunks share one conversationId per outing; each has its own recordingId, offset-bearing recordedAt,
 * SHA-256 and exact sample-count-derived duration. Wall-clock duration/mtime are never recovery input.
 * A synced capture journal precedes the PCM file; audio is synced every 5 seconds and finalized via
 * rename plus synced manifest/state. Recovery may salvage only complete samples in our WAV format.
 * Power loss may lose PCM not yet persisted; missing/invalid audio is retained as failed, not fabricated.
 * Queued data is capped conservatively at 2 GiB, free space must stay above 256 MiB.
 * Failed/unacknowledged and acknowledged originals are never automatically deleted.
 *
 * <p>Transport: private LAN IPv4 HTTPS:8787 only, pinned exact leaf SHA-256, certificate validity and
 * normal IP SAN verification, no redirects/proxy/DNS/cloud fallback. Self-signed leaf pins are supported
 * when the leaf has the paired IPv4 in its SAN. Health is GET /v1/health with bearer authorization;
 * multipart POST /v1/recordings uses parts manifest (manifest.json) and audio (audio.wav).
 * Success requires exact original recordingId and SHA-256 plus offset-bearing storedAt in the receipt.
 * Retry waits are 5, 10, 20, 40, 80, 160, then 300 seconds; new attempts occur only when near and
 * authenticated. Metadata/receipt persistence failure cannot mark a recording sent.
 * Health, upload and capture use separate executors; BLE/state transitions run on the main handler.
 *
 * <p>Public UI contract: AppSettings(Context), pairing(), importPairing(String), autoEnabled(),
 * autoEnabled(boolean), leaveRssi(), returnRssi(), setThresholds(int,int), deviceId();
 * AutoCaptureService.ACTION_ENABLE/ACTION_DISABLE and snapshot(Context);
 * RecordingStore(Context).list(), delete(String):boolean, exportZip(String):File.
 * list rows contain id,title,recordedAt,durationMs,state,sha256,audioPath,manifestPath,lastError.
 * File paths in list are absolute; ZIP contains manifest.json and audio.wav with a relative audioPath.
 * delete refuses active capture/upload. Export refuses active capture and verifies file integrity.
 * States are recording, queued, uploading, sent, failed. No hardware is accessed by list/export/tests.
 */
package com.shadowagent.voice.core;
