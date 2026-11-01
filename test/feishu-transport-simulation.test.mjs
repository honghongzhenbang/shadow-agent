import assert from "node:assert/strict";
import test from "node:test";

import { feishuMessageIdentity } from "../src/feishu-message-identity.mjs";
import { deriveTransportSimulations, TRANSPORT_FAULTS } from "../src/feishu-transport-simulation.mjs";

const dataset = {
  schema: "shadow-agent/feishu-evaluation-dataset/v2",
  episodes: [
    {
      episodeId: "episode-development",
      split: "development",
      messages: [
        { messageKey: "m1", occurredAt: "2026-08-29T01:00:00Z" },
        { messageKey: "m2", occurredAt: "2026-08-29T02:00:00Z" },
      ],
    },
    {
      episodeId: "episode-holdout",
      split: "holdout",
      messages: [{ messageKey: "secret", occurredAt: "2026-08-29T03:00:00Z" }],
    },
  ],
};

test("polling and realtime use one Feishu message evidence identity", () => {
  const polling = { message_id: "om_123", create_time: "2026-08-29T01:00:00Z" };
  const realtime = { id: "om_123", create_time: "2026-08-29T01:00:00Z" };
  assert.deepEqual(feishuMessageIdentity(polling), feishuMessageIdentity(realtime));
});

test("transport simulations derive faults without business content or holdout", () => {
  const result = deriveTransportSimulations(dataset, { perFault: 1 });
  assert.equal(result.containsBusinessContent, false);
  assert.equal(result.holdoutExcluded, true);
  assert.deepEqual(new Set(result.cases.map((item) => item.fault)), new Set(TRANSPORT_FAULTS));
  assert.equal(result.cases.some((item) => item.sourceEpisodeId === "episode-holdout"), false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(result.cases.every((item) => item.syntheticTransport), true);
});
