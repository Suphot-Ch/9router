// Weekly enable/disable window for a single provider connection (account).
//
// A schedule is stored inside the connection's `data` JSON:
//   { enabled, days: [0..6], start: "HH:MM", end: "HH:MM", timezone,
//     lastAppliedState?: "active" | "disabled", lastAppliedAt?: ISO }
//
// Semantics
//  - `days` are local weekdays where the window *starts* (0 = Sunday, JS numbering).
//  - The window is half-open: [start, end). Exactly at `start` → active,
//    exactly at `end` → inactive.
//  - `end <= start` wraps past midnight into the next local day (end == start is a
//    full 24h window), so a Friday 22:00-06:00 window covers Saturday 00:00-06:00
//    while still being attributed to Friday for weekday selection.
//
// Everything here is pure: no DB, no clock reads unless `now` is omitted.

import { CONNECTION_SCHEDULE_CONFIG } from "@/shared/constants/config";
import {
  civilDayMs,
  civilWeekday,
  getLocalTimezone,
  isValidTimezone,
  shiftCivilDay,
  zonedParts,
  zonedWallClockToUtcMs,
} from "./zonedTime.js";

const C = CONNECTION_SCHEDULE_CONFIG;
const MINUTES_PER_DAY = 1440;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

// Monday-first display order (the week starts on Monday in most of the world).
export const CONNECTION_SCHEDULE_WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export const CONNECTION_SCHEDULE_DAY_LABELS = {
  0: "Sun",
  1: "Mon",
  2: "Tue",
  3: "Wed",
  4: "Thu",
  5: "Fri",
  6: "Sat",
};

// "HH:MM" (also accepts a single-digit hour) → minutes since local midnight.
export function parseTimeOfDay(value) {
  const match = TIME_RE.exec(String(value ?? "").trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export function formatTimeOfDay(totalMinutes) {
  const normalized = ((totalMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function isValidAppliedState(value) {
  return value === "active" || value === "disabled";
}

// Trust-boundary validation. Returns { schedule } on success, { error } otherwise.
export function validateConnectionSchedule(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "schedule must be an object" };
  }
  if (typeof raw.enabled !== "boolean") {
    return { error: "enabled must be a boolean" };
  }
  if (!Array.isArray(raw.days)) {
    return { error: "days must be an array of unique integers 0-6 (0 = Sunday)" };
  }

  const days = [];
  for (const day of raw.days) {
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      return { error: `days contains an invalid weekday ${JSON.stringify(day)} — use integers 0-6 (0 = Sunday)` };
    }
    if (days.includes(day)) {
      return { error: `days contains the weekday ${day} twice` };
    }
    days.push(day);
  }
  if (raw.enabled === true && days.length === 0) {
    return { error: "days must not be empty when the schedule is enabled" };
  }

  if (parseTimeOfDay(raw.start) === null) {
    return { error: "start must be a 24h time in HH:MM form (00:00-23:59)" };
  }
  if (parseTimeOfDay(raw.end) === null) {
    return { error: "end must be a 24h time in HH:MM form (00:00-23:59)" };
  }

  const timezone = raw.timezone === undefined || raw.timezone === null || raw.timezone === ""
    ? C.defaultTimezone || getLocalTimezone()
    : String(raw.timezone);
  if (!isValidTimezone(timezone)) {
    return { error: `timezone must be a valid IANA timezone (received ${JSON.stringify(raw.timezone)})` };
  }

  const schedule = {
    enabled: raw.enabled,
    days: [...days].sort((a, b) => a - b),
    start: formatTimeOfDay(parseTimeOfDay(raw.start)),
    end: formatTimeOfDay(parseTimeOfDay(raw.end)),
    timezone,
  };
  if (isValidAppliedState(raw.lastAppliedState)) schedule.lastAppliedState = raw.lastAppliedState;
  if (typeof raw.lastAppliedAt === "string") schedule.lastAppliedAt = raw.lastAppliedAt;

  return { schedule };
}

// Stored value → normalized schedule, or null when absent/disabled/invalid.
export function normalizeConnectionSchedule(raw) {
  if (!raw || raw.enabled !== true) return null;
  const { schedule } = validateConnectionSchedule(raw);
  return schedule || null;
}

// Window length in minutes; `end <= start` wraps to the next day.
export function getWindowDurationMinutes(start, end) {
  const startMinutes = parseTimeOfDay(start);
  const endMinutes = parseTimeOfDay(end);
  if (startMinutes === null || endMinutes === null) return 0;
  return endMinutes > startMinutes
    ? endMinutes - startMinutes
    : MINUTES_PER_DAY - startMinutes + endMinutes;
}

// Both endpoints of the window anchored on a local calendar date.
function windowForLocalDate(schedule, localDate) {
  const startMinutes = parseTimeOfDay(schedule.start);
  const endMinutes = parseTimeOfDay(schedule.end);
  const wraps = endMinutes <= startMinutes;

  const startAt = zonedWallClockToUtcMs({
    ...localDate,
    hour: Math.floor(startMinutes / 60),
    minute: startMinutes % 60,
  }, schedule.timezone);

  // end == start is a full 24h window, so it always lands on the next local date.
  const endAt = zonedWallClockToUtcMs({
    ...localDate,
    day: localDate.day + (wraps ? 1 : 0),
    hour: Math.floor(endMinutes / 60),
    minute: endMinutes % 60,
  }, schedule.timezone);

  return { startAt, endAt };
}

// Evaluation result for a stored schedule.
//   null                              → no automation in effect (absent, disabled or invalid)
//   { active, nextChangeAt }          → nextChangeAt is an ISO timestamp of the next
//                                       window edge (or null when none is reachable)
export function evaluateConnectionSchedule(schedule, nowMs = Date.now()) {
  const normalized = normalizeConnectionSchedule(schedule);
  if (!normalized) return null;

  const now = typeof nowMs === "number" ? nowMs : new Date(nowMs).getTime();
  if (!Number.isFinite(now)) return null;

  const localNow = zonedParts(now, normalized.timezone);
  const today = civilDayMs(localNow);

  let active = false;
  let nextChangeAt = null;

  // A window can only be open from yesterday at the earliest (max length 24h), and
  // every selected weekday recurs within 7 days.
  for (let offset = -(C.lookbackDays ?? 1); offset <= (C.lookaheadDays ?? 8); offset += 1) {
    const localDate = shiftCivilDay(today, offset);
    if (!normalized.days.includes(civilWeekday(localDate))) continue;

    const { startAt, endAt } = windowForLocalDate(normalized, localDate);
    if (startAt <= now && now < endAt) active = true;

    for (const edge of [startAt, endAt]) {
      if (edge > now && (nextChangeAt === null || edge < nextChangeAt)) nextChangeAt = edge;
    }
  }

  return {
    active,
    nextChangeAt: nextChangeAt === null ? null : new Date(nextChangeAt).toISOString(),
  };
}

function compressWeekdays(days, dayLabels) {
  const ordered = CONNECTION_SCHEDULE_WEEK_ORDER.filter((day) => days.includes(day));
  if (ordered.length === 7) return "Every day";

  const runs = [];
  for (const day of ordered) {
    const last = runs[runs.length - 1];
    const index = CONNECTION_SCHEDULE_WEEK_ORDER.indexOf(day);
    if (last && last.endIndex === index - 1) {
      last.endIndex = index;
      last.end = day;
    } else {
      runs.push({ startIndex: index, endIndex: index, start: day, end: day });
    }
  }

  return runs
    .map((run) => (run.start === run.end
      ? dayLabels[run.start]
      : `${dayLabels[run.start]}-${dayLabels[run.end]}`))
    .join(", ");
}

// "Mon-Fri 09:00-18:00 (Asia/Bangkok)" — the human summary shown in the UI.
export function formatScheduleSummary(schedule, { dayLabels = CONNECTION_SCHEDULE_DAY_LABELS } = {}) {
  if (!schedule || typeof schedule !== "object") return "";
  const { schedule: normalized } = validateConnectionSchedule({
    enabled: typeof schedule.enabled === "boolean" ? schedule.enabled : true,
    days: Array.isArray(schedule.days) ? schedule.days : [],
    start: schedule.start,
    end: schedule.end,
    timezone: schedule.timezone || C.defaultTimezone,
  });
  if (!normalized) return "";

  const days = normalized.days.length === 0
    ? ""
    : compressWeekdays(normalized.days, dayLabels);
  if (!days) return "";
  return `${days} ${normalized.start}-${normalized.end} (${normalized.timezone})`;
}

// "Auto 09:00-18:00" while running, "Auto off" when parked.
export function getScheduleBadgeLabel(schedule) {
  if (!schedule || typeof schedule !== "object") return null;
  if (schedule.enabled !== true) return "Auto off";
  const start = parseTimeOfDay(schedule.start);
  const end = parseTimeOfDay(schedule.end);
  if (start === null || end === null) return "Auto off";
  return `Auto ${formatTimeOfDay(start)}-${formatTimeOfDay(end)}`;
}

// A local noon is always the same local weekday, whatever the runtime zone is;
// 2024-01-07 was a Sunday.
const WEEKDAY_REFERENCE_MS = Date.UTC(2024, 0, 7, 12);

// { [day]: { short, long } } for the seven day toggles, in the UI locale.
export function getLocalizedDayLabels(locale = "en") {
  const fallback = Object.fromEntries(CONNECTION_SCHEDULE_WEEK_ORDER.map((day) => (
    [day, { short: CONNECTION_SCHEDULE_DAY_LABELS[day], long: CONNECTION_SCHEDULE_DAY_LABELS[day] }]
  )));

  try {
    const short = new Intl.DateTimeFormat(locale, { weekday: "short" });
    const long = new Intl.DateTimeFormat(locale, { weekday: "long" });
    const labels = {};
    for (const day of CONNECTION_SCHEDULE_WEEK_ORDER) {
      const date = new Date(WEEKDAY_REFERENCE_MS + day * 86400000);
      labels[day] = { short: short.format(date), long: long.format(date) };
    }
    return labels;
  } catch {
    return fallback;
  }
}
