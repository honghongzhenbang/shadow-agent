import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase } from "../src/db.mjs";
import { feishuCapabilitySnapshot, feishuEventSpecs } from "../src/feishu-capabilities.mjs";

const config = {
  feishu: {
    personalSources: {
      messages: { enabled: true, pollSeconds: 60 },
      documents: { enabled: true, pollSeconds: 120 },
      tasks: { enabled: true, realtimeEvent: "task.task.update_user_access_v2" },
      approvals: { enabled: true, realtimeEvents: ["approval.task.status_changed_v4", "approval.instance.status_changed_v4"] },
    },
    botDialogue: { enabled: true, realtimeEvent: "im.message.receive_v1" },
  },
};

test("Feishu event specs distinguish personal events from bot dialogue", () => {
  const specs = feishuEventSpecs(config);
  assert.deepEqual(specs.map((item) => [item.key, item.identity, item.role]), [
    ["im.message.receive_v1", "bot", "bot_dialogue"],
    ["task.task.update_user_access_v2", "user", "personal_operational"],
    ["approval.task.status_changed_v4", "user", "personal_operational"],
    ["approval.instance.status_changed_v4", "user", "personal_operational"],
  ]);
});

test("pending console subscriptions are gaps while personal polling stays available", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-agent-feishu-capabilities-"));
  const store = openDatabase(path.join(root, "test.sqlite"));
  try {
    store.setSetting("runtime:feishu:quick:messages:state", "ready");
    store.setSetting("runtime:feishu:quick:documents:state", "ready");
    store.setSetting("runtime:feishu:event:im.message.receive_v1", "ready");
    store.setSetting("runtime:feishu:event:task.task.update_user_access_v2", "waiting_console_subscription");
    store.setSetting("runtime:feishu:event:approval.task.status_changed_v4", "waiting_console_subscription");
    store.setSetting("runtime:feishu:event:approval.instance.status_changed_v4", "waiting_console_subscription");
    const snapshot = feishuCapabilitySnapshot(store, config);
    assert.equal(snapshot.personalDataAvailable, true);
    assert.equal(snapshot.personalRealtimeComplete, false);
    assert.equal(snapshot.gaps.length, 2);
    assert.equal(snapshot.capabilities.find((item) => item.id === "botDialogue").available, true);
    assert.equal(snapshot.capabilities.find((item) => item.id === "personalTasks").mode, "personal_oauth_poll_fallback");
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
