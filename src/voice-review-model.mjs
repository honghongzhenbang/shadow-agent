// Read-only projection: no enrollment, Evidence writes, model calls or new clusters.
const MIN_SPEECH_MS = 2000;
const EPSILON = 1e-12;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const hasId = (value) => typeof value === "string" && value.trim().length > 0;
const amount = (value) => Number.isFinite(value) && value > 0 ? value : 0;
const unknown = (group) => group.speakerLabel === "unknown" || group.disabledReason === "unknown_speaker";
const humanIds = (group) => new Set([group.personId, ...(group.confirmedPersonIds ?? [])].filter(hasId));
const mixed = (group) => group.disabledReason === "mixed_confirmed_people" || humanIds(group).size > 1;
const confirmed = (group) => hasId(group.personId) && !group.partialConfirmation && !mixed(group);

function validEmbedding(embedding) {
  return Array.isArray(embedding) && embedding.length > 0
    && embedding.every(Number.isFinite) && embedding.some((value) => value !== 0);
}

function hasEmbedding(group) {
  return hasId(group.embeddingModel) && validEmbedding(group.embedding);
}

function canEnroll(group) {
  return !unknown(group) && !mixed(group) && !group.partialConfirmation && hasEmbedding(group);
}

function sameSamples(a, b) {
  return a.length === b.length && a.every((item, i) => item.personId === b[i].personId
    && item.embeddingModel === b[i].embeddingModel && item.embedding === b[i].embedding);
}

function acousticScores(group, samples, sampleVersion, matchCache) {
  const key = JSON.stringify([group.key, sampleVersion, group.embeddingModel ?? null]);
  const cached = matchCache.get(key);
  if (cached && cached.embedding === group.embedding && sameSamples(cached.samples, samples)) return cached.scores;
  const byPerson = new Map();
  if (hasEmbedding(group)) {
    for (const sample of samples) {
      if (!hasId(sample.personId) || sample.embeddingModel !== group.embeddingModel
          || !validEmbedding(sample.embedding) || sample.embedding.length !== group.embedding.length) continue;
      // Inputs are normalized. A cosine is a signed similarity, not a probability.
      const dot = group.embedding.reduce((sum, value, i) => sum + value * sample.embedding[i], 0);
      const score = Math.max(-1, Math.min(1, dot));
      if (!byPerson.has(sample.personId) || score > byPerson.get(sample.personId)) byPerson.set(sample.personId, score);
    }
  }
  const scores = [...byPerson].map(([personId, score]) => ({ personId, score }))
    .sort((a, b) => b.score - a.score || compare(a.personId, b.personId));
  matchCache.set(key, { embedding: group.embedding, samples, scores });
  return scores;
}

function identityIndex(groups) {
  const voices = new Map();
  for (const group of groups) {
    // Unknown labels cannot donate or receive a stable-voice identity.
    if (unknown(group) || !hasId(group.stableVoiceId)) continue;
    let voice = voices.get(group.stableVoiceId);
    if (!voice) {
      voice = { people: new Set(), anchors: new Set(), conflict: false };
      voices.set(group.stableVoiceId, voice);
    }
    for (const id of humanIds(group)) voice.people.add(id);
    voice.conflict ||= mixed(group);
    if (confirmed(group) && group.personActive !== false) voice.anchors.add(group.personId);
  }
  for (const voice of voices.values()) voice.conflict ||= voice.people.size > 1;
  return voices;
}

function assign(group, voice, names, samples, options) {
  const personName = (personId) => names.get(personId) ?? personId;
  if (confirmed(group)) {
    return { kind: "confirmed", personId: group.personId,
      personName: group.personName || personName(group.personId), candidates: [],
      ...(voice?.conflict ? { reason: "identity_conflict" } : {}) };
  }
  if (unknown(group)) return { kind: "unassigned", candidates: [], reason: "unknown_speaker" };
  if (mixed(group)) return { kind: "ambiguous", candidates: [], reason: "mixed_confirmed_people" };
  if (group.partialConfirmation && !voice?.conflict) {
    return { kind: "ambiguous", candidates: [], reason: "partial_confirmation" };
  }
  const candidates = acousticScores(group, samples, options.sampleVersion, options.matchCache)
    .map(({ personId, score }) => ({ personId, personName: personName(personId), score }));
  if (voice?.conflict) return { kind: "ambiguous", candidates, reason: "identity_conflict" };
  const anchor = voice?.anchors.size === 1 ? [...voice.anchors][0] : null;
  const best = candidates[0];
  if (best && best.score + EPSILON >= options.matchThreshold) {
    if (anchor && anchor !== best.personId) return { kind: "ambiguous", candidates, reason: "identity_conflict" };
    if (candidates[1] && best.score - candidates[1].score + EPSILON < options.matchMargin) {
      return { kind: "ambiguous", candidates, reason: "ambiguous_match" };
    }
    return { kind: "matched", personId: best.personId, personName: best.personName, candidates };
  }
  // Only a current whole-group human confirmation can propagate without an acoustic match.
  if (anchor) return { kind: "matched", personId: anchor, personName: personName(anchor),
    candidates, reason: "stable_voice_confirmation" };
  return { kind: "unassigned", candidates,
    reason: !hasEmbedding(group) ? "no_embedding" : candidates.length ? "below_threshold" : "no_compatible_samples" };
}

function representative(groups, assignments) {
  const pending = groups.filter((group) => assignments[group.key].kind !== "confirmed");
  // Fully confirmed person buckets are not recommendations; only those need this fallback.
  const choices = pending.length ? pending : groups;
  const tier = (group) => amount(group.speechMs) >= MIN_SPEECH_MS
    ? canEnroll(group) ? 3 : !unknown(group) && !mixed(group) && !group.partialConfirmation ? 2 : 1 : 0;
  const chosen = [...choices].sort((a, b) => tier(b) - tier(a)
    || amount(b.speechMs) - amount(a.speechMs) || compare(a.key, b.key))[0];
  return { recordingId: chosen.recordingId, speakerLabel: chosen.speakerLabel, key: chosen.key };
}

/**
 * Pure review projection, except for the caller-owned acoustic memoization Map.
 * Embeddings must be normalized immutable Arrays: replace the Array after changes.
 * sampleVersion invalidates scores; names, text, revisions and matching policy do not.
 * recommended contains bucket objects, not IDs. No automatic result becomes a sample.
 */
export function buildVoiceReview(groups, samples, {
  matchThreshold = 0.75, matchMargin = 0.1, matchCache = new Map(), sampleVersion = "",
} = {}) {
  const keys = new Set();
  for (const group of groups) {
    if (!hasId(group.key) || keys.has(group.key)) throw new TypeError("Voice group keys must be unique nonempty strings.");
    keys.add(group.key);
  }
  const names = new Map();
  for (const sample of samples) if (hasId(sample.personName)) names.set(sample.personId, sample.personName);
  for (const group of groups) if (confirmed(group) && hasId(group.personName)) names.set(group.personId, group.personName);
  const sampleRefs = samples.map(({ personId, embeddingModel, embedding }) => ({ personId, embeddingModel, embedding }));
  const voices = identityIndex(groups);
  const options = { matchThreshold, matchMargin, matchCache, sampleVersion };
  // fromEntries preserves a normal prototype while safely handling keys such as __proto__.
  const assignments = Object.fromEntries(groups.map((group) => [group.key,
    assign(group, unknown(group) ? null : voices.get(group.stableVoiceId), names, sampleRefs, options)]));
  const counts = { groups: groups.length, confirmed: 0, matched: 0, ambiguous: 0, unassigned: 0,
    buckets: 0, recommended: 0 };
  const entries = new Map();
  for (const group of groups) {
    const assignment = assignments[group.key];
    counts[assignment.kind]++;
    const person = assignment.kind === "confirmed" || assignment.kind === "matched";
    const stable = !unknown(group) && hasId(group.stableVoiceId);
    const id = person ? `person:${JSON.stringify(assignment.personId)}`
      : stable ? `voice:${JSON.stringify(group.stableVoiceId)}` : `group:${JSON.stringify(group.key)}`;
    let entry = entries.get(id);
    if (!entry) {
      entry = { bucket: { id, kind: person ? "person" : stable ? "voice" : "unassigned",
        ...(person ? { personId: assignment.personId, name: names.get(assignment.personId) ?? assignment.personName } : {}),
        confirmedCount: 0, matchedCount: 0, unassignedCount: 0, ambiguousCount: 0,
        groupCount: 0, recordingCount: 0, taskCount: 0, representative: null, reasonCodes: [], groups: [] },
      groups: [], recordings: new Set(), reasons: new Set() };
      entries.set(id, entry);
    }
    entry.groups.push(group);
    entry.recordings.add(group.recordingId);
    entry.bucket.groups.push(group.key);
    entry.bucket[`${assignment.kind}Count`]++;
    entry.bucket.taskCount += amount(group.taskCount);
    if (!person && assignment.kind === "ambiguous") entry.bucket.kind = "ambiguous";
    if (["identity_conflict", "mixed_confirmed_people"].includes(assignment.reason)) entry.reasons.add("identity_conflict");
    if (assignment.reason === "ambiguous_match") entry.reasons.add("ambiguous_match");
  }
  const priorities = new Map();
  const recommended = [];
  for (const { bucket, groups: members, recordings, reasons } of entries.values()) {
    bucket.groupCount = members.length;
    bucket.recordingCount = recordings.size;
    bucket.groups.sort(compare);
    bucket.representative = representative(members, assignments);
    const pending = members.filter((group) => assignments[group.key].kind !== "confirmed");
    const useful = pending.filter((group) => canEnroll(group) && amount(group.speechMs) >= MIN_SPEECH_MS);
    const coverage = new Set(useful.map((group) => group.recordingId)).size;
    if (bucket.taskCount > 0) reasons.add("task_related");
    if (coverage > 1) reasons.add("coverage");
    if (useful.length) reasons.add("voice_sample");
    if (pending.length && !pending.some((group) => amount(group.speechMs) >= MIN_SPEECH_MS)) reasons.add("insufficient_audio");
    bucket.reasonCodes = ["task_related", "identity_conflict", "ambiguous_match", "coverage", "voice_sample", "insufficient_audio"]
      .filter((reason) => reasons.has(reason));
    priorities.set(bucket.id, { conflict: useful.length ? reasons.has("identity_conflict") ? 2
      : reasons.has("ambiguous_match") ? 1 : 0 : 0, coverage,
    speechMs: useful.reduce((sum, group) => sum + amount(group.speechMs), 0) });
    // Low-information sources stay in buckets/counts, without becoming default homework.
    if (bucket.unassignedCount + bucket.ambiguousCount > 0
        && (bucket.taskCount > 0 || reasons.has("identity_conflict")
          || pending.some((group) => !unknown(group) && hasEmbedding(group)))) recommended.push(bucket);
  }
  const kindOrder = { person: 0, ambiguous: 1, voice: 2, unassigned: 3 };
  const buckets = [...entries.values()].map(({ bucket }) => bucket).sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind]
    || compare(a.name ?? a.id, b.name ?? b.id) || compare(a.id, b.id));
  recommended.sort((a, b) => {
    const left = priorities.get(a.id), right = priorities.get(b.id);
    return b.taskCount - a.taskCount || right.conflict - left.conflict || right.coverage - left.coverage
      || right.speechMs - left.speechMs || compare(a.id, b.id);
  });
  counts.buckets = buckets.length;
  counts.recommended = recommended.length;
  return { buckets, recommended, assignments, counts };
}
