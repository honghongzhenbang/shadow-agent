import assert from "node:assert/strict";
import test from "node:test";

import {
  createSerializedJobQueue,
  feishuQuickCollectionOptions,
  routePersonalMessageChanges,
  shouldRestartAfterDatabaseFailures,
} from "../src/daemon.mjs";

test("quick Feishu collectors request exactly one bounded source", () => {
  assert.deepEqual(feishuQuickCollectionOptions("messages"), {
    messages: true, approvals: false, tasks: false, drive: false,
  });
  assert.deepEqual(feishuQuickCollectionOptions("documents"), {
    messages: false, approvals: false, tasks: false, drive: true,
  });
  assert.deepEqual(feishuQuickCollectionOptions("tasks"), {
    messages: false, approvals: false, tasks: true, drive: false,
  });
  assert.deepEqual(feishuQuickCollectionOptions("approvals"), {
    messages: false, approvals: true, tasks: false, drive: false,
  });
  assert.throws(() => feishuQuickCollectionOptions("unknown"), /Unknown Feishu quick collection kind/);
});

test("shared state jobs are serialized and duplicate timer ticks are coalesced", async () => {
  const failures = [];
  const enqueue = createSerializedJobQueue((key, error) => failures.push({ key, error }));
  const events = [];
  let active = 0;
  let maximumActive = 0;
  const job = (name, delay = 5) => async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    events.push(`start:${name}`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    events.push(`end:${name}`);
    active -= 1;
  };
  const first = enqueue("collection", job("collection"));
  const duplicate = enqueue("collection", job("duplicate"));
  const second = enqueue("condition", job("condition"));
  await Promise.all([first, duplicate, second]);
  assert.equal(maximumActive, 1);
  assert.deepEqual(events, ["start:collection", "end:collection", "start:condition", "end:condition"]);
  assert.deepEqual(failures, []);
});

test("database health guard restarts only after the configured consecutive failure threshold", () => {
  assert.equal(shouldRestartAfterDatabaseFailures(1, 3), false);
  assert.equal(shouldRestartAfterDatabaseFailures(2, 3), false);
  assert.equal(shouldRestartAfterDatabaseFailures(3, 3), true);
  assert.equal(shouldRestartAfterDatabaseFailures(4, 3), true);
});

test("personal message routing retains inactive group background without semantic wake", () => {
  let binding = null;
  const acknowledged = [];
  const scheduled = [];
  const store = {
    db: {
      prepare: () => ({ get: () => binding }),
    },
    bindWorkSession: (input) => {
      binding = {
        session_key: input.sessionKey,
        metadata_json: JSON.stringify(input.metadata),
      };
      return binding;
    },
    retainInactiveSourceBackground: (evidenceIds) => acknowledged.push(...evidenceIds),
  };
  const config = { attention: { groupConversationActivationHours: 24 } };
  routePersonalMessageChanges(store, config, [{
    conversationKey: "im:oc_group:thread:main",
    evidenceId: "evidence-background",
    externalId: "message-background",
    occurredAt: "2026-08-29T01:00:00Z",
    signal: "unassigned_group",
    immediate: false,
  }], (input) => scheduled.push(input));
  assert.deepEqual(acknowledged, ["evidence-background"]);
  assert.deepEqual(scheduled, []);
  assert.equal(JSON.parse(binding.metadata_json).attentionDecision, "background_evidence_only");

  routePersonalMessageChanges(store, config, [{
    conversationKey: "im:oc_group:thread:main",
    evidenceId: "evidence-mention",
    externalId: "message-mention",
    occurredAt: "2026-08-29T02:00:00Z",
    signal: "explicit_self_mention",
    immediate: true,
  }], (input) => scheduled.push(input));
  assert.equal(scheduled.length, 1);
  assert.equal(JSON.parse(binding.metadata_json).attentionDecision, "explicit_personal_signal");
  assert.ok(JSON.parse(binding.metadata_json).ownershipActivatedUntil);
});
