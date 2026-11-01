import assert from "node:assert/strict";
import test from "node:test";

import { timestampIso } from "../src/collectors/feishu.mjs";

test("Feishu timestamps accept epochs, ISO strings and China-local display strings", () => {
  assert.equal(timestampIso("2026-08-08 10:40"), "2026-08-08T02:40:00.000Z");
  assert.equal(timestampIso("2026-08-08T02:40:00.000Z"), "2026-08-08T02:40:00.000Z");
  assert.equal(timestampIso("1786156800"), "2026-08-08T02:40:00.000Z");
  assert.equal(timestampIso("not-a-date"), null);
});
