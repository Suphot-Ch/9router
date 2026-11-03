// Timezone helpers shared by the schedulers.
//
// Everything here works on wall-clock parts in a named IANA timezone, so a
// schedule anchored at "09:00 Asia/Bangkok" keeps meaning 09:00 local time even
// when the zone's UTC offset changes (DST).

const DAY_MS = 86400000;

export function isValidTimezone(timezone) {
  if (!timezone || typeof timezone !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function getLocalTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// Epoch ms → { year, month, day, hour, minute, second } in `timezone`.
export function zonedParts(utcMs, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));

  const out = {};
  for (const part of parts) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return out;
}

export function zoneOffsetMs(utcMs, timezone) {
  const p = zonedParts(utcMs, timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
}

// Wall-clock time in `timezone` → UTC epoch ms (second pass covers DST shifts).
// `day` may overflow (e.g. day + 1) — Date.UTC normalizes it across month/year.
export function zonedWallClockToUtcMs({ year, month, day, hour, minute }, timezone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const offset = zoneOffsetMs(naive, timezone);
  const candidate = naive - offset;
  const refinedOffset = zoneOffsetMs(candidate, timezone);
  return refinedOffset === offset ? candidate : naive - refinedOffset;
}

// Civil (calendar) day number in UTC terms — DST-independent date arithmetic.
export function civilDayMs({ year, month, day }) {
  return Date.UTC(year, month - 1, day);
}

// Shift a civil day number by whole days.
export function shiftCivilDay(dayMs, days) {
  const d = new Date(dayMs + days * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// 0 = Sunday … 6 = Saturday for a civil date.
export function civilWeekday({ year, month, day }) {
  return new Date(civilDayMs({ year, month, day })).getUTCDay();
}

export { DAY_MS as ZONED_DAY_MS };
