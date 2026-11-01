import assert from "node:assert/strict";
import test from "node:test";
import { readWorkboardProjection } from "../src/workboard-reader.mjs";

test("UI list and detail refreshes share one read-only request even when Gateway is slow", async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const client = { async request(method) {
    assert.equal(method, "workboard.cards.list");
    calls++;
    await barrier;
    return { cards: [{ id: "card", metadata: { comments: [{ body: "result" }] } }] };
  }, invokeTool() { assert.fail("UI must not invoke Agent tools"); } };
  const reads = Array.from({ length: 40 }, () => readWorkboardProjection(client));
  assert.equal(calls, 1);
  release();
  const cards = await Promise.all(reads);
  assert.ok(cards.every(value => value[0].metadata.comments[0].body === "result"));
  await readWorkboardProjection(client, { maxAgeMs: 2000 });
  assert.equal(calls, 1);
  await readWorkboardProjection(client);
  assert.equal(calls, 2);
});

test("a failed UI read does not replace the last snapshot with empty cards or prevent retry", async () => {
  let fails = false;
  const client = { async request() {
    if (fails) throw new Error("offline");
    return { cards: [{ id: "card" }] };
  } };
  await readWorkboardProjection(client);
  fails = true;
  await assert.rejects(readWorkboardProjection(client), /offline/);
  fails = false;
  assert.equal((await readWorkboardProjection(client))[0].id, "card");
});
