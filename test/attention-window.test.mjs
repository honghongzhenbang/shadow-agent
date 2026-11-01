import assert from "node:assert/strict";
import test from "node:test";

import {
  attentionScheduleSignature,
  attentionScheduleStatus,
  normalizeAttentionSchedule,
  readAttentionSchedule,
} from "../src/attention-window.mjs";

function localDate(hours, minutes) {
  const value = new Date(2026, 8, 3, hours, minutes, 0, 0);
  return value;
}

test("attention schedule defaults to the local 08:00-19:00 window", () => {
  assert.deepEqual(normalizeAttentionSchedule(), { enabled: true, start: "08:00", end: "19:00" });
  assert.equal(attentionScheduleStatus(normalizeAttentionSchedule(), localDate(8, 0)).allowed, true);
  assert.equal(attentionScheduleStatus(normalizeAttentionSchedule(), localDate(18, 59)).allowed, true);
  assert.equal(attentionScheduleStatus(normalizeAttentionSchedule(), localDate(19, 0)).allowed, false);
});

test("outside-window attention is deferred to the next local opening", () => {
  const morning = attentionScheduleStatus(normalizeAttentionSchedule(), localDate(7, 30));
  assert.equal(morning.allowed, false);
  assert.equal(new Date(morning.nextStartAt).getHours(), 8);
  assert.equal(new Date(morning.nextStartAt).getDate(), localDate(7, 30).getDate());

  const evening = attentionScheduleStatus(normalizeAttentionSchedule(), localDate(20, 0));
  assert.equal(evening.allowed, false);
  assert.equal(new Date(evening.nextStartAt).getHours(), 8);
  assert.equal(new Date(evening.nextStartAt).getDate(), localDate(20, 0).getDate() + 1);
});

test("cross-midnight windows and disabled schedules are explicit", () => {
  const overnight = normalizeAttentionSchedule({ enabled: true, start: "22:00", end: "06:00" });
  assert.equal(attentionScheduleStatus(overnight, localDate(23, 0)).allowed, true);
  assert.equal(attentionScheduleStatus(overnight, localDate(3, 0)).allowed, true);
  assert.equal(attentionScheduleStatus(overnight, localDate(12, 0)).allowed, false);

  const disabled = attentionScheduleStatus({ enabled: false, start: "08:00", end: "19:00" }, localDate(10, 0));
  assert.equal(disabled.reason, "disabled");
  assert.equal(disabled.nextStartAt, null);
});

test("persisted settings override config defaults without accepting malformed values", () => {
  const values = new Map();
  const store = { getSetting: (key, fallback) => values.get(key) ?? fallback };
  assert.deepEqual(readAttentionSchedule(store, { schedule: { enabled: true, start: "09:00", end: "18:00" } }), {
    enabled: true,
    start: "09:00",
    end: "18:00",
  });
  values.set("controller:attention:schedule", JSON.stringify({ enabled: true, start: "10:15", end: "17:45" }));
  const saved = readAttentionSchedule(store, { schedule: { enabled: true, start: "09:00", end: "18:00" } });
  assert.equal(attentionScheduleSignature(saved), "on:10:15-17:45");
  values.set("controller:attention:schedule", "not-json");
  assert.equal(readAttentionSchedule(store, { schedule: { enabled: true, start: "09:00", end: "18:00" } }).start, "09:00");
  assert.throws(() => normalizeAttentionSchedule({ start: "08:00", end: "08:00" }), /different/);
});
