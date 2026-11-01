import assert from "node:assert/strict";
import test from "node:test";
import { reviseProgressPlan, compactProgressPlan } from "../src/task-progress-plan.mjs";

const plan = { expectedRevision: 0, outcome: "Deliver useful output", successCriteria: "Reproducible evidence", authorizedScope: "Local tests only",
  approach: "Check existing evidence", nextAction: "Run one local experiment", stopCondition: "Stop when evidence meets acceptance", whyNow: "Unblocks the assigned work" };

test("bounded task plan uses revision and does not become a task state machine", () => {
  const first = reviseProgressPlan(null, plan);
  const second = reviseProgressPlan(first, { ...plan, expectedRevision: 1, nextAction: "Review experiment result" });
  assert.equal(second.revision, 2);
  assert.throws(() => reviseProgressPlan(second, plan), /revision 2/);
  assert.throws(() => reviseProgressPlan(first, { ...plan, expectedRevision: 1, state: "done" }), /Unknown/);
  assert.throws(() => reviseProgressPlan(null, { ...plan, whyNow: "" }), /whyNow/);
  assert.ok(JSON.stringify(compactProgressPlan(second)).length < 1000);
});
