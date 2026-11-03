// Per-API-key spending windows (token / cost limits).
//
// Limits reset LAZILY — no cron. The request gate asks this module whether a
// reset boundary has passed since the key's lastResetAt, and the repo zeroes
// the counters once when it has.
//
// Boundaries are computed in the server's business timezone, Asia/Bangkok
// (fixed UTC+07:00, no DST), independent of the host TZ. That keeps the math
// deterministic across deployments and unit-testable with an injected `now`.
//
//   monthly: the configured day-of-month at local 00:00. Days 29–31 are
//            clamped to the last day of shorter months (day 31 → Feb 28/29),
//            and the boundary advances month by month: Jan 31 → Feb 28 →
//            Mar 31. It never goes backwards.
//   weekly:  the configured weekday (0=Sunday … 6=Saturday) at local 00:00.

export const RESET_MODES = Object.freeze(["none", "monthly", "weekly"]);

// Fallback day when a period mode is selected without an explicit resetDay.
export const DEFAULT_RESET_DAY = Object.freeze({ monthly: 1, weekly: 1 });

const LOCAL_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Bangkok, UTC+07:00
const DAY_MS = 24 * 60 * 60 * 1000;
// ~200 years of monthly steps — a hard stop so a corrupt timestamp cannot loop.
const MAX_BOUNDARY_STEPS = 2400;

export function isValidResetMode(mode) {
  return typeof mode === "string" && RESET_MODES.includes(mode);
}

export function isValidResetDay(resetMode, resetDay) {
  if (resetMode === "none") return resetDay === null;
  if (!Number.isInteger(resetDay)) return false;
  if (resetMode === "monthly") return resetDay >= 1 && resetDay <= 31;
  if (resetMode === "weekly") return resetDay >= 0 && resetDay <= 6;
  return false;
}

function localParts(ts) {
  const d = new Date(ts + LOCAL_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
  };
}

function localMidnight(year, month, day) {
  return Date.UTC(year, month, day) - LOCAL_OFFSET_MS;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function monthlyBoundary(year, month, resetDay) {
  const day = Math.min(resetDay, daysInMonth(year, month));
  return localMidnight(year, month, day);
}

/**
 * Timestamp of the first reset boundary strictly after `from`.
 * @param {{resetMode?: string, resetDay?: number|null, from: number}} opts
 * @returns {number|null} epoch ms, or null when the key never resets
 */
export function nextResetAt({ resetMode = "none", resetDay = null, from } = {}) {
  if (!resetMode || resetMode === "none") return null;

  const base = Number(from);
  if (!Number.isFinite(base)) throw new TypeError("nextResetAt: `from` must be a timestamp");

  const day = Number(resetDay);

  if (resetMode === "weekly") {
    if (!isValidResetDay("weekly", day)) {
      throw new RangeError(`nextResetAt: resetDay must be 0..6 for weekly (got ${resetDay})`);
    }
    const p = localParts(base);
    const today = localMidnight(p.year, p.month, p.day);
    let next = today + (((day - p.weekday) + 7) % 7) * DAY_MS;
    if (next <= base) next += 7 * DAY_MS;
    return next;
  }

  if (resetMode === "monthly") {
    if (!isValidResetDay("monthly", day)) {
      throw new RangeError(`nextResetAt: resetDay must be 1..31 for monthly (got ${resetDay})`);
    }
    const p = localParts(base);
    let year = p.year;
    let month = p.month;
    // At most two steps are needed (this month, then next); the loop keeps the
    // "advance month by month" guarantee explicit.
    for (let steps = 0; steps < 3; steps++) {
      const boundary = monthlyBoundary(year, month, day);
      if (boundary > base) return boundary;
      month += 1;
      if (month > 11) { month = 0; year += 1; }
    }
    throw new RangeError("nextResetAt: could not resolve a monthly boundary");
  }

  throw new RangeError(`nextResetAt: unknown resetMode ${resetMode}`);
}

/**
 * Most recent reset boundary at or before `now` that is later than
 * `lastResetAt`, or null when no boundary has been crossed yet.
 * @param {{resetMode?: string, resetDay?: number|null, lastResetAt?: string|number|null, now?: number}} opts
 * @returns {number|null} epoch ms of the boundary to record, or null
 */
export function calcResetBoundary({ resetMode = "none", resetDay = null, lastResetAt = null, now = Date.now() } = {}) {
  if (!resetMode || resetMode === "none") return null;

  const nowMs = Number(now);
  if (!Number.isFinite(nowMs)) throw new TypeError("calcResetBoundary: `now` must be a timestamp");

  const base = typeof lastResetAt === "number" ? lastResetAt : Date.parse(lastResetAt);
  if (!Number.isFinite(base)) return null; // no baseline → nothing to reset against

  let boundary = null;
  let cursor = base;
  for (let i = 0; i < MAX_BOUNDARY_STEPS; i++) {
    const next = nextResetAt({ resetMode, resetDay, from: cursor });
    if (next == null || next > nowMs) break;
    boundary = next;
    cursor = next;
  }
  return boundary;
}

/**
 * Due-reset decision for a key row. Returns the boundary to stamp into
 * lastResetAt (ISO string), or null when no reset is due.
 * @param {object|null} keyRow
 * @param {number} [now]
 * @returns {string|null}
 */
export function getDueResetBoundary(keyRow, now = Date.now()) {
  if (!keyRow?.resetMode || keyRow.resetMode === "none") return null;
  const baseline = keyRow.lastResetAt || keyRow.createdAt || null;
  const boundary = calcResetBoundary({
    resetMode: keyRow.resetMode,
    resetDay: keyRow.resetDay,
    lastResetAt: baseline,
    now,
  });
  return boundary == null ? null : new Date(boundary).toISOString();
}
