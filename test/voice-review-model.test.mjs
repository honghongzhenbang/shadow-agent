import test from "node:test";
import assert from "node:assert/strict";
import { buildVoiceReview } from "../src/voice-review-model.mjs";

// Synthetic mechanism fixtures only; these tests do not measure speaker accuracy.
const group = (key, extra = {}) => ({ key, recordingId: `recording-${key}`, speakerLabel: "speaker_0",
  stableVoiceId: null, personId: null, personName: null, confirmedPersonIds: [], partialConfirmation: false,
  disabledReason: null, segmentCount: 1, speechMs: 3000, embeddingModel: "synthetic",
  embedding: [1, 0], taskCount: 0, revisionToken: "v1", ...extra });
const sample = (personId, embedding = [1, 0], extra = {}) => ({ personId, personName: personId,
  embeddingModel: "synthetic", embedding, ...extra });
const atScore = (score) => [score, Math.sqrt(1 - score * score)];

test("same-person samples use their maximum, while two close people remain ambiguous", () => {
  const g = group("a");
  const samples = [sample("p", atScore(0.8)), sample("p"), sample("p", atScore(0.99))];
  const one = buildVoiceReview([g], samples);
  assert.equal(one.assignments.a.kind, "matched");
  assert.deepEqual(one.assignments.a.candidates, [{ personId: "p", personName: "p", score: 1 }]);
  assert.equal(one.recommended.length, 0);
  const two = buildVoiceReview([g], [...samples, sample("q", atScore(0.95))]);
  assert.equal(two.assignments.a.kind, "ambiguous");
  assert.equal(two.assignments.a.reason, "ambiguous_match");
  assert.ok(two.recommended[0].reasonCodes.includes("ambiguous_match"));
  assert.strictEqual(two.recommended[0], two.buckets[0]);
  assert.equal(Object.getPrototypeOf(two.assignments), Object.prototype);
});

test("model and dimension boundaries, signed scores and undefined defaults", () => {
  const g = group("a");
  const incompatible = [sample("missing", [1, 0], { embeddingModel: null }),
    sample("other", [1, 0], { embeddingModel: "other" }), sample("dimension", [1, 0, 0])];
  assert.deepEqual(buildVoiceReview([g], incompatible).assignments.a.candidates, []);
  assert.equal(buildVoiceReview([group("a", { embeddingModel: null })], [sample("p")]).counts.matched, 0);
  const negative = buildVoiceReview([g], [sample("p", [-1, 0])]);
  assert.equal(negative.assignments.a.candidates[0].score, -1);
  assert.equal(negative.counts.unassigned, 1);
  const options = { matchThreshold: undefined, matchMargin: undefined };
  assert.equal(buildVoiceReview([g], [sample("p", atScore(0.7))], options).counts.unassigned, 1);
  assert.equal(buildVoiceReview([g], [sample("p", atScore(0.8)), sample("q", atScore(0.75))], options).counts.ambiguous, 1);
});

test("manual identities win; stable-voice conflicts are not decided by a majority", () => {
  const groups = [group("a", { stableVoiceId: "v", personId: "p" }),
    group("b", { stableVoiceId: "v", personId: "p" }),
    group("c", { stableVoiceId: "v", personId: "q" }),
    group("pending", { stableVoiceId: "v", embedding: null })];
  const result = buildVoiceReview(groups, [sample("p")]);
  assert.equal(result.assignments.c.kind, "confirmed");
  assert.equal(result.assignments.c.personId, "q");
  assert.equal(result.assignments.c.reason, "identity_conflict");
  assert.equal(result.assignments.pending.kind, "ambiguous");
  assert.equal(result.assignments.pending.reason, "identity_conflict");
  assert.equal(result.recommended.length, 1);
  assert.ok(result.recommended[0].reasonCodes.includes("identity_conflict"));
  assert.equal(result.counts.confirmed, 3);
});

test("only active full confirmations propagate, including to groups without an embedding", () => {
  const anchor = group("anchor", { stableVoiceId: "v", personId: "p", personName: "Person" });
  const pending = group("pending", { stableVoiceId: "v", embedding: null });
  const active = buildVoiceReview([anchor, pending], []);
  assert.equal(active.assignments.pending.kind, "matched");
  assert.equal(active.assignments.pending.personName, "Person");
  assert.deepEqual(active.assignments.pending.candidates, []);
  assert.equal(active.assignments.pending.reason, "stable_voice_confirmation");
  const inactive = buildVoiceReview([{ ...anchor, personActive: false }, pending], []);
  assert.equal(inactive.assignments.anchor.kind, "confirmed");
  assert.equal(inactive.assignments.anchor.personId, "p");
  assert.equal(inactive.assignments.pending.kind, "unassigned");
  const partial = { ...anchor, personId: null, partialConfirmation: true, confirmedPersonIds: ["p"] };
  const result = buildVoiceReview([partial, pending], [sample("p")]);
  assert.equal(result.assignments.anchor.kind, "ambiguous");
  assert.equal(result.assignments.pending.kind, "unassigned");
  const conflict = buildVoiceReview([anchor, pending,
    group("partial", { stableVoiceId: "v", partialConfirmation: true, confirmedPersonIds: ["q"] })], []);
  assert.equal(conflict.assignments.pending.reason, "identity_conflict");
  const inactiveConflict = buildVoiceReview([anchor, pending,
    group("old", { stableVoiceId: "v", personId: "q", personActive: false })], []);
  assert.equal(inactiveConflict.assignments.pending.reason, "identity_conflict");
});

test("unknown and mixed groups cannot receive or donate automatic whole-group identity", () => {
  const result = buildVoiceReview([
    group("anchor", { stableVoiceId: "v", personId: "p" }),
    group("unknown", { stableVoiceId: "v", speakerLabel: "unknown" }),
    group("disabled", { stableVoiceId: "v", disabledReason: "unknown_speaker" }),
    group("mixed", { disabledReason: "mixed_confirmed_people", confirmedPersonIds: ["p", "q"] }),
  ], [sample("p")]);
  assert.equal(result.assignments.unknown.kind, "unassigned");
  assert.equal(result.assignments.disabled.kind, "unassigned");
  assert.equal(result.assignments.mixed.kind, "ambiguous");
  const donor = buildVoiceReview([group("unknown", { stableVoiceId: "u", speakerLabel: "unknown", personId: "p" }),
    group("pending", { stableVoiceId: "u", embedding: null })], []);
  assert.equal(donor.assignments.unknown.kind, "confirmed");
  assert.equal(donor.assignments.pending.kind, "unassigned");
});

test("automatic candidates neither train samples nor propagate to an embedding-less sibling", () => {
  const groups = [group("matched", { stableVoiceId: "v" }), group("pending", { stableVoiceId: "v", embedding: null })];
  const samples = [sample("p")];
  const before = structuredClone({ groups, samples });
  for (const item of [...groups, ...samples]) {
    if (item.embedding) Object.freeze(item.embedding);
    Object.freeze(item);
  }
  Object.freeze(groups); Object.freeze(samples);
  const result = buildVoiceReview(groups, samples);
  assert.equal(result.assignments.matched.kind, "matched");
  assert.equal(result.assignments.pending.kind, "unassigned");
  assert.deepEqual({ groups, samples }, before);
  const conflict = buildVoiceReview([group("anchor", { stableVoiceId: "v", personId: "q" }), groups[0]], samples);
  assert.equal(conflict.assignments.matched.reason, "identity_conflict");
});

test("sample or manual revocation restores original source buckets without merging clusters", () => {
  const groups = [group("a", { stableVoiceId: "v1" }), group("b", { stableVoiceId: "v2" })];
  const matchCache = new Map();
  const initial = buildVoiceReview(groups, [], { matchCache });
  const matched = buildVoiceReview(groups, [sample("p")], { matchCache });
  assert.equal(matched.buckets.length, 1);
  assert.deepEqual(matched.buckets[0].groups, ["a", "b"]);
  assert.equal(matched.recommended.length, 0);
  assert.deepEqual(buildVoiceReview(groups, [], { matchCache }), initial);
  const pending = group("pending", { stableVoiceId: "v1", embedding: null });
  const confirmed = { ...groups[0], personId: "p" };
  assert.equal(buildVoiceReview([confirmed, pending], [], { matchCache }).counts.matched, 1);
  const revoked = buildVoiceReview([groups[0], pending], [], { matchCache });
  assert.equal(revoked.counts.unassigned, 2);
  assert.deepEqual(revoked.buckets[0].groups, ["a", "pending"]);
});

test("people sort first, then ambiguity, voices and unassigned, with stable name/id ordering", () => {
  const result = buildVoiceReview([
    group("unknown", { speakerLabel: "unknown" }), group("voice", { stableVoiceId: "v" }),
    group("partial", { partialConfirmation: true, confirmedPersonIds: ["p"] }),
    group("z", { personId: "z", personName: "Zed" }),
    group("a2", { personId: "a2", personName: "Alice" }),
    group("a1", { personId: "a1", personName: "Alice" }),
  ], []);
  assert.deepEqual(result.buckets.map((b) => b.kind), ["person", "person", "person", "ambiguous", "voice", "unassigned"]);
  assert.deepEqual(result.buckets.slice(0, 3).map((b) => b.personId), ["a1", "a2", "z"]);
});

test("unknown and missing stable IDs stay separate; low-information exclusions never drop sources", () => {
  const groups = [group("u1", { speakerLabel: "unknown", stableVoiceId: "same", speechMs: 100 }),
    group("u2", { speakerLabel: "unknown", stableVoiceId: "same", speechMs: 100 }),
    group("missing", { embedding: null }), group("usable"), group("usable2"),
    group("task", { speakerLabel: "unknown", embedding: null, taskCount: 1 })];
  const result = buildVoiceReview(groups, []);
  assert.deepEqual(result.counts, { groups: 6, confirmed: 0, matched: 0, ambiguous: 0, unassigned: 6, buckets: 6, recommended: 3 });
  assert.deepEqual(result.recommended.map((b) => b.groups[0]).sort(), ["task", "usable", "usable2"]);
  assert.deepEqual(result.buckets.flatMap((b) => b.groups).sort(), groups.map((g) => g.key).sort());
  assert.equal(Object.keys(result.assignments).length, 6);
  assert.equal(result.recommended[0].groups[0], "task");
});

test("recommendations prefer task links, actionable conflicts, recording coverage and audible enrollment representatives", () => {
  const groups = [group("long", { speechMs: 90000 }),
    group("c1", { stableVoiceId: "coverage" }), group("c2", { stableVoiceId: "coverage" }),
    group("short", { stableVoiceId: "coverage", speechMs: 200 }),
    group("no-vector", { stableVoiceId: "coverage", embedding: null, speechMs: 100000 }),
    group("old", { stableVoiceId: "coverage", personId: "old", personActive: false, speechMs: 200000 }),
    group("task", { speakerLabel: "unknown", embedding: null, speechMs: 100, taskCount: 1 }),
    group("p", { stableVoiceId: "conflict", personId: "p" }),
    group("q", { stableVoiceId: "conflict", personId: "q" }),
    group("conflict", { stableVoiceId: "conflict" })];
  const result = buildVoiceReview(groups, []);
  assert.equal(result.recommended[0].groups[0], "task");
  assert.equal(result.recommended[1].groups[0], "conflict");
  assert.equal(result.recommended[2].representative.key, "c1");
  assert.ok(result.recommended[2].reasonCodes.includes("coverage"));
  assert.ok(result.recommended[2].reasonCodes.includes("voice_sample"));
  assert.ok(result.recommended[0].reasonCodes.includes("insufficient_audio"));
  assert.equal(result.recommended.at(-1).groups[0], "long");
  for (const bucket of result.recommended) assert.notEqual(result.assignments[bucket.representative.key].kind, "confirmed");
});

test("one bucket per person counts distinct recordings and sums supplied task associations", () => {
  const result = buildVoiceReview([group("a", { personId: "p", recordingId: "r", taskCount: 2 }),
    group("b", { recordingId: "r", taskCount: 1 }), group("c")], [sample("p")]);
  const bucket = result.buckets[0];
  assert.equal(bucket.groupCount, 3);
  assert.equal(bucket.recordingCount, 2);
  assert.equal(bucket.confirmedCount, 1);
  assert.equal(bucket.matchedCount, 2);
  assert.equal(bucket.taskCount, 3);
  assert.equal(result.recommended.length, 0);
});

test("cache stores only scores: text, names and thresholds refresh without acoustic recomputation", () => {
  let reads = 0;
  const embedding = new Proxy(atScore(0.8), { get(target, property, receiver) {
    if (property === "0" || property === "1") reads++;
    return Reflect.get(target, property, receiver);
  } });
  const samples = [sample("p", embedding)];
  const g = group("a"), matchCache = new Map();
  const first = buildVoiceReview([g], samples, { matchCache });
  assert.equal(first.assignments.a.kind, "matched");
  const count = reads;
  assert.ok(count > 0);
  const renamed = buildVoiceReview([{ ...g, excerpt: "new text", revisionToken: "v2", taskCount: 2 }],
    [{ ...samples[0], personName: "New name" }], { matchCache, matchThreshold: 0.9 });
  assert.equal(reads, count);
  assert.equal(renamed.assignments.a.kind, "unassigned");
  assert.equal(renamed.assignments.a.candidates[0].personName, "New name");
  assert.equal(renamed.recommended[0].taskCount, 2);
  first.assignments.a.candidates[0].score = -1;
  assert.equal(buildVoiceReview([g], samples, { matchCache }).assignments.a.candidates[0].score, 0.8);
  buildVoiceReview([g], samples, { matchCache, sampleVersion: "v2" });
  assert.ok(reads > count);
});

test("embedding reference, model, group key and sample changes invalidate cached scores", () => {
  const matchCache = new Map(), options = { matchCache }, g = group("a"), samples = [sample("p")];
  assert.equal(buildVoiceReview([g], samples, options).counts.matched, 1);
  assert.equal(buildVoiceReview([{ ...g, embedding: [0, 1] }], samples, options).counts.unassigned, 1);
  assert.equal(buildVoiceReview([g], samples, options).counts.matched, 1);
  assert.equal(buildVoiceReview([{ ...g, embeddingModel: "other" }], samples, options).counts.unassigned, 1);
  assert.equal(buildVoiceReview([group("b", { embedding: [0, 1] })], samples, options).counts.unassigned, 1);
  assert.equal(buildVoiceReview([g], [sample("q", [0, 1])], options).counts.unassigned, 1);
  assert.equal(buildVoiceReview([g], [], options).counts.unassigned, 1);
  assert.equal(buildVoiceReview([g], [sample("q")], options).assignments.a.personId, "q");
});

test("empty inputs and special object keys preserve the exact output contract", () => {
  assert.deepEqual(buildVoiceReview([], []), { buckets: [], recommended: [], assignments: {},
    counts: { groups: 0, confirmed: 0, matched: 0, ambiguous: 0, unassigned: 0, buckets: 0, recommended: 0 } });
  const result = buildVoiceReview([group("__proto__")], []);
  assert.equal(Object.getPrototypeOf(result.assignments), Object.prototype);
  assert.equal(Object.hasOwn(result.assignments, "__proto__"), true);
  assert.equal(result.assignments.__proto__.kind, "unassigned");
});
