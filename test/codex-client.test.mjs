import assert from "node:assert/strict";
import test from "node:test";

import { compactCodexItems } from "../src/codex-client.mjs";

test("compactCodexItems preserves useful execution steps and redacts secrets", () => {
  const trace = compactCodexItems([
    {
      type: "command_execution",
      status: "completed",
      command: "npm test",
      aggregated_output: "10 tests passed access_token=secret-value-that-should-be-hidden",
      exit_code: 0,
    },
    {
      type: "file_change",
      status: "completed",
      changes: [{ path: "desktop/renderer.js", kind: "update" }],
    },
    { type: "agent_message", text: "duplicate final response" },
  ]);

  assert.equal(trace.length, 2);
  assert.equal(trace[0].command, "npm test");
  assert.equal(trace[0].exitCode, 0);
  assert.doesNotMatch(trace[0].output, /secret-value-that-should-be-hidden/);
  assert.deepEqual(trace[1].changes, [{ path: "desktop/renderer.js", kind: "update" }]);
});
