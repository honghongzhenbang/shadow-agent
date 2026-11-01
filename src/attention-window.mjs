export const ATTENTION_SCHEDULE_SETTING_KEY = "controller:attention:schedule";

export const DEFAULT_ATTENTION_SCHEDULE = Object.freeze({
  enabled: true,
  start: "08:00",
  end: "19:00",
});

function parseClock(value, label) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ""));
  if (!match) throw new Error(`${label} must use HH:mm format.`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error(`${label} is outside the local day.`);
  return { text: `${match[1]}:${match[2]}`, minutes: hours * 60 + minutes };
}

export function normalizeAttentionSchedule(input = {}, fallback = DEFAULT_ATTENTION_SCHEDULE) {
  const source = input && typeof input === "object" ? input : {};
  const defaults = fallback && typeof fallback === "object" ? fallback : DEFAULT_ATTENTION_SCHEDULE;
  const start = parseClock(source.start ?? defaults.start ?? DEFAULT_ATTENTION_SCHEDULE.start, "Attention start");
  const end = parseClock(source.end ?? defaults.end ?? DEFAULT_ATTENTION_SCHEDULE.end, "Attention end");
  if (start.minutes === end.minutes) throw new Error("Attention start and end must be different.");
  return {
    enabled: source.enabled === undefined ? defaults.enabled !== false : source.enabled !== false,
    start: start.text,
    end: end.text,
  };
}

export function readAttentionSchedule(store, attentionConfig = {}) {
  const fallback = normalizeAttentionSchedule(attentionConfig.schedule ?? DEFAULT_ATTENTION_SCHEDULE);
  const raw = store?.getSetting?.(ATTENTION_SCHEDULE_SETTING_KEY, "") ?? "";
  if (!raw) return fallback;
  try {
    return normalizeAttentionSchedule(JSON.parse(raw), fallback);
  } catch {
    return fallback;
  }
}

function localMinute(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function dateAtMinute(date, minute, dayOffset = 0) {
  const result = new Date(date);
  result.setDate(result.getDate() + dayOffset);
  result.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
  return result;
}

export function attentionScheduleStatus(scheduleInput, nowInput = new Date()) {
  const schedule = normalizeAttentionSchedule(scheduleInput);
  const now = new Date(nowInput);
  if (!Number.isFinite(now.getTime())) throw new Error("Attention schedule requires a valid current time.");
  if (!schedule.enabled) {
    return { allowed: false, reason: "disabled", nextStartAt: null, schedule };
  }

  const start = parseClock(schedule.start, "Attention start").minutes;
  const end = parseClock(schedule.end, "Attention end").minutes;
  const minute = localMinute(now);
  const wrapsMidnight = start > end;
  const allowed = wrapsMidnight
    ? minute >= start || minute < end
    : minute >= start && minute < end;
  if (allowed) return { allowed: true, reason: "inside_window", nextStartAt: null, schedule };

  const dayOffset = wrapsMidnight || minute < start ? 0 : 1;
  return {
    allowed: false,
    reason: "outside_window",
    nextStartAt: dateAtMinute(now, start, dayOffset).toISOString(),
    schedule,
  };
}

export function attentionScheduleSignature(scheduleInput) {
  const schedule = normalizeAttentionSchedule(scheduleInput);
  return `${schedule.enabled ? "on" : "off"}:${schedule.start}-${schedule.end}`;
}
