import assert from "node:assert/strict";
import test from "node:test";

import { parseJsonLoose, redactSecrets, safeTraceText, sha256, stableJson } from "../src/utils.mjs";

test("secret redaction covers common token forms", () => {
  const redacted = redactSecrets("Authorization: Bearer abcdefghijklmnop app_secret=topsecret sk-abcdefghijklmnop");
  assert.doesNotMatch(redacted, /abcdefghijklmnop|topsecret/);
});

test("stable JSON produces deterministic fingerprints", () => {
  assert.equal(sha256(stableJson({ b: 2, a: 1 })), sha256(stableJson({ a: 1, b: 2 })));
  assert.equal(stableJson({ b: undefined, a: 1 }), '{"a":1}');
  assert.equal(stableJson([1, undefined, 3]), '[1,null,3]');
});

test("loose JSON accepts a fenced response", () => {
  assert.deepEqual(parseJsonLoose("```json\n{\"ok\":true}\n```"), { ok: true });
});

test("trace compaction preserves both the beginning and end", () => {
  const value = `HEAD-${"x".repeat(4000)}-TAIL`;
  const compacted = safeTraceText(value, 1000);
  assert.match(compacted, /^HEAD-/);
  assert.match(compacted, /-TAIL$/);
  assert.ok(compacted.length < 1200);
});
