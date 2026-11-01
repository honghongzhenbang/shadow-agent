import assert from "node:assert/strict";
import test from "node:test";

import { SessionDispatchQueue } from "../src/controller-dispatch.mjs";

test("session dispatch serializes one session while allowing different sessions to progress", async () => {
  const queue = new SessionDispatchQueue();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  const first = queue.run("session-a", async () => {
    events.push("a1:start");
    await firstGate;
    events.push("a1:end");
  });
  const second = queue.run("session-a", async () => { events.push("a2"); });
  const other = queue.run("session-b", async () => { events.push("b1"); });

  await other;
  assert.deepEqual(events, ["a1:start", "b1"]);
  assert.equal(queue.pending("session-a"), 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["a1:start", "b1", "a1:end", "a2"]);
  assert.equal(queue.pending(), 0);
});
