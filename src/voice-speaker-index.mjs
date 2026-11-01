import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// Acoustic identity only. Names, authorization and Evidence remain in voice-input.
const schema = `
CREATE TABLE IF NOT EXISTS voices(
 id TEXT PRIMARY KEY, model TEXT NOT NULL, vector TEXT NOT NULL, source_key TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS voices_model ON voices(model);
CREATE TABLE IF NOT EXISTS links(
 source_key TEXT NOT NULL, label TEXT NOT NULL, digest TEXT NOT NULL,
 result TEXT NOT NULL, PRIMARY KEY(source_key,label)
);`;
const hash = (value) => createHash("sha256").update(value).digest("hex");
function vector(values) {
  if (!Array.isArray(values) || values.length < 2 || values.length > 4096
      || values.some((v) => !Number.isFinite(v))) throw new Error("Invalid acoustic embedding.");
  const norm = Math.hypot(...values);
  if (!norm) throw new Error("Empty acoustic embedding.");
  return values.map((v) => v / norm);
}

export function associateSpeakers(indexPath, { sourceKey, audioSha256, transcript }) {
  if (typeof sourceKey !== "string" || !sourceKey || sourceKey.length > 500
      || !/^[a-f0-9]{64}$/i.test(audioSha256)) throw new Error("Invalid acoustic source identity.");
  if (!Array.isArray(transcript.segments) || !Array.isArray(transcript.speakers ?? [])) {
    throw new Error("Invalid acoustic transcript.");
  }
  const speakers = transcript.speakers ?? [];
  if (speakers.length > 256 || new Set(speakers.map((s) => s.label)).size !== speakers.length) {
    throw new Error("Invalid acoustic labels.");
  }
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  const db = new DatabaseSync(indexPath);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.exec(schema);
    db.exec("BEGIN IMMEDIATE");
    const results = [];
    const used = new Set();
    // Reserve old assignments before evaluating new labels during idempotent retries.
    for (const old of db.prepare("SELECT result FROM links WHERE source_key=?").all(sourceKey)) {
      const link = JSON.parse(old.result);
      if (link.voiceId) used.add(`${link.acousticScope ?? 'recording'}:${link.voiceId}`);
    }
    for (const speaker of speakers) {
      const { label, embedding } = speaker;
      const scope = speaker.acousticScope ?? "recording";
      if (typeof scope !== "string" || !scope || scope.length > 100) throw new Error("Invalid acoustic scope.");
      const embeddingModel = speaker.embeddingModel ?? transcript.embeddingModel;
      if (typeof label !== "string" || !label || label.length > 200) throw new Error("Invalid acoustic label.");
      const digest = hash(JSON.stringify([audioSha256, speaker, transcript.segments.filter((s) => s.speakerLabel === label)]));
      const previous = db.prepare("SELECT digest,result FROM links WHERE source_key=? AND label=?").get(sourceKey, label);
      if (previous) {
        if (previous.digest !== digest) throw new Error("Acoustic source changed; explicit reanalysis required.");
        results.push(JSON.parse(previous.result));
        continue;
      }
      const duration = transcript.segments.filter((s) => s.speakerLabel === label)
        .reduce((sum, s) => sum + Math.max(0, s.endMs - s.startMs), 0);
      if (speaker.speechDurationMs != null && (!Number.isFinite(speaker.speechDurationMs)
          || speaker.speechDurationMs < 0 || speaker.speechDurationMs > transcript.durationMs + 100)) {
        throw new Error("Invalid acoustic speech duration.");
      }
      let result = { label, acousticScope: scope, voiceId: null, status: "insufficient_audio", candidates: [],
        identityConfirmed: false, scoreMeaning: "cosine_similarity_not_probability" };
      if (label !== "unknown" && embedding && embeddingModel && (speaker.speechDurationMs ?? duration) >= 2000) {
        if (typeof embeddingModel !== "string" || embeddingModel.length > 500) throw new Error("Invalid embedding model.");
        const sample = vector(embedding);
        const anchors = db.prepare("SELECT id,vector FROM voices WHERE model=? ORDER BY id LIMIT 4097").all(embeddingModel);
        if (anchors.length > 4096) {
          result.status = "index_capacity_review";
        } else {
          const ranked = anchors.map((a) => ({ id: a.id, v: JSON.parse(a.vector) }))
            .filter((a) => a.v.length === sample.length)
            .map((a) => ({ voiceId: a.id, score: sample.reduce((sum, v, i) => sum + v*a.v[i], 0) }))
            .sort((a,b) => b.score-a.score);
          const best = ranked[0];
          result.candidates = ranked.slice(0,3).filter((a) => a.score >= 0.6);
          if (best?.score >= 0.75 && best.score-(ranked[1]?.score ?? -1) >= 0.1 && !used.has(`${scope}:${best.voiceId}`)) {
            result = { ...result, voiceId: best.voiceId, status: "acoustic_match", score: best.score };
          } else if (!best || best.score < 0.6) {
            const id = "voice_" + hash(JSON.stringify([sourceKey, label, embeddingModel])).slice(0,24);
            db.prepare("INSERT INTO voices(id,model,vector,source_key) VALUES(?,?,?,?)")
              .run(id, embeddingModel, JSON.stringify(sample), sourceKey);
            result = { ...result, voiceId: id, status: "new_anonymous" };
          } else {
            result.status = "ambiguous";
          }
          // Automatic matches never train anchors: one mistaken link cannot drift the registry.
          if (result.voiceId) used.add(`${scope}:${result.voiceId}`);
        }
      }
      db.prepare("INSERT INTO links(source_key,label,digest,result) VALUES(?,?,?,?)")
        .run(sourceKey, label, digest, JSON.stringify(result));
      results.push(result);
    }
    db.exec("COMMIT");
    return { schemaVersion: 1, policy: "fixed-anchor-v1", sourceKey, audioSha256, speakers: results };
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally { db.close(); }
}

export function voiceSourceKey(deviceId, recordingId) {
  if (!deviceId || !recordingId) throw new Error("Acoustic association requires device and recording IDs.");
  return hash(JSON.stringify([deviceId, recordingId]));
}
