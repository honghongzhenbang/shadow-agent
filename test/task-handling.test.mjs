import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyTaskHandling,
  planTaskHandlingCutover,
} from "../src/task-handling.mjs";

const now = Date.parse("2026-09-02T04:00:00.000Z");
const card = (overrides = {}) => ({
  id: "task-1",
  title: "修复本地产品缺陷",
  status: "todo",
  archived_at: null,
  execution_status: null,
  execution_run_id: null,
  execution_session_key: null,
  ...overrides,
});

test("native RPC metadata archive is terminal even when the card retains todo status", () => {
  assert.equal(classifyTaskHandling({ card: card({ metadata: { archivedAt: "2026-10-16T00:00:00Z" } }) }).lane, "completed");
});

test("task handling uses structured continuation as the single next-actor source", () => {
  const validUser = classifyTaskHandling({
    card: card(),
    attention: {
      continuation_kind: "requires_user",
      continuation_user_action_json: JSON.stringify({
        reason: "external_authorization",
        request: "确认是否推送当前提交",
        blockedAction: "git_commit_push",
      }),
    },
    now,
  });
  assert.equal(validUser.lane, "user");
  assert.equal(validUser.userAction.blockedAction, "git_commit_push");

  const vagueUser = classifyTaskHandling({
    card: card(),
    attention: { continuation_kind: "requires_user", continuation_summary: "等待用户授权" },
    now,
  });
  assert.deepEqual(
    { lane: vagueUser.lane, state: vagueUser.state, reason: vagueUser.reason },
    { lane: "agent", state: "recovery", reason: "invalid_user_gate" },
  );

  const watching = classifyTaskHandling({
    card: card(),
    attention: { continuation_kind: "condition_watch", continuation_reference_id: "watch-1" },
    watch: { id: "watch-1", status: "active", timeout_at: "2026-09-02T05:00:00.000Z" },
    now,
  });
  assert.equal(watching.state, "watching");

  const timedOut = classifyTaskHandling({
    card: card(),
    attention: { continuation_kind: "condition_watch", continuation_reference_id: "watch-1" },
    watch: { id: "watch-1", status: "timed_out", timeout_at: "2026-09-02T03:00:00.000Z" },
    now,
  });
  assert.equal(timedOut.state, "recovery");

  const review = classifyTaskHandling({ card: card({ status: "review" }), now });
  assert.equal(review.lane, "user");
});

test("task progress lease is the boundary between queued review and active verification", () => {
  const attention = { continuation_kind: "condition_watch", continuation_reference_id: "watch-1" };
  const watch = { id: "watch-1", status: "candidate", timeout_at: "2026-09-02T03:00:00.000Z" };
  const queued = classifyTaskHandling({
    card: card(),
    attention,
    watch,
    progressChange: { status: "pending" },
    now,
  });
  assert.deepEqual(
    { lane: queued.lane, state: queued.state },
    { lane: "agent", state: "queued_review" },
  );

  const active = classifyTaskHandling({
    card: card(),
    attention,
    watch,
    progressChange: { status: "leased", lease_until: "2026-09-02T05:00:00Z" },
    now,
  });
  assert.deepEqual(
    { lane: active.lane, state: active.state },
    { lane: "agent", state: "verifying" },
  );
});

test("cached running state expires into observation, never automatically fails the task", () => {
  const execution = card({ status: "running", execution_status: "running", execution_run_id: "run-1", updated_at: now - 43 * 86_400_000 });
  const attention = { continuation_kind: "codex_run", continuation_reference_id: "run-1" };
  assert.equal(classifyTaskHandling({ card: execution, attention, now }).reason, "codex_status_due");
  assert.equal(classifyTaskHandling({ card: execution, attention: { ...attention, next_review_at: "2026-09-02T05:00:00Z" }, now }).state, "running");
  const expiredLease = classifyTaskHandling({ card: execution, attention, progressChange: { status: "leased", lease_until: "2026-09-02T03:00:00Z" }, now });
  assert.equal(expiredLease.reason, "progress_review_lease_expired");
  assert.equal(execution.status, "running");
});

test("task handling cutover only replans invalid active continuations", () => {
  const cards = [
    card({ id: "vague" }),
    card({ id: "watching" }),
    card({ id: "review", status: "review" }),
  ];
  const attentions = [
    { card_id: "vague", continuation_kind: "requires_user", continuation_summary: "等待授权" },
    { card_id: "watching", continuation_kind: "condition_watch", continuation_reference_id: "watch-1" },
  ];
  const plan = planTaskHandlingCutover({
    cards,
    attentions,
    watches: [{ id: "watch-1", status: "active", timeout_at: "2026-09-02T05:00:00.000Z" }],
    now: "2026-09-02T04:00:00.000Z",
  });
  assert.deepEqual(plan.changes.map((item) => item.taskId), ["vague"]);
  assert.equal(plan.changes[0].continuationKind, "internal_review");
  assert.equal(plan.changes[0].reason, "invalid_user_gate");
  assert.equal(plan.retained.length, 2);
});
