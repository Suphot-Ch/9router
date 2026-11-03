// Client-safe helpers for per-API-key spending limits (tokens / USD cost).
//
// Pure math + formatting only — safe to import from client components. The
// reset-boundary math is delegated to src/lib/db/keyReset.js, which is
// dependency-free (no DB handle, no node builtins), so it can be pulled into the
// browser bundle without dragging the database layer along.
//
// Limits are stored 0 = unlimited, so every helper here treats 0 (and anything
// non-positive / missing) as "no cap" rather than "cap of zero".

import { nextResetAt, DEFAULT_RESET_DAY } from "@/lib/db/keyReset.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const RESET_MODES = Object.freeze(["none", "monthly", "weekly"]);

export const RESET_MODE_OPTIONS = Object.freeze([
  { value: "none", label: "Never" },
  { value: "monthly", label: "Monthly" },
  { value: "weekly", label: "Weekly" },
]);

// 0 = Sunday, matching keyReset.js / the server's resetDay contract.
export const WEEKDAY_OPTIONS = Object.freeze([
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
]);

// Colour states mirror the quota table (ProviderLimits/QuotaTable): the
// thresholds are on *remaining* budget — >70% green, 30–70% yellow, <30% red.
const TONES = {
  green: {
    key: "green",
    text: "text-green-600 dark:text-green-400",
    bg: "bg-green-500",
    track: "bg-green-500/10",
    badge: "bg-green-500/10 text-green-600 dark:text-green-400",
  },
  yellow: {
    key: "yellow",
    text: "text-yellow-600 dark:text-yellow-400",
    bg: "bg-yellow-500",
    track: "bg-yellow-500/10",
    badge: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
  },
  red: {
    key: "red",
    text: "text-red-600 dark:text-red-400",
    bg: "bg-red-500",
    track: "bg-red-500/10",
    badge: "bg-red-500/10 text-red-600 dark:text-red-400",
  },
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toNumber(value, fallback = 0) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Tone (colour state) for a *remaining* percentage. Unknown → green. */
export function getLimitTone(remainingPercent) {
  const p = Number(remainingPercent);
  if (!Number.isFinite(p)) return TONES.green;
  if (p > 70) return TONES.green;
  if (p >= 30) return TONES.yellow;
  return TONES.red;
}

/**
 * Usage snapshot for one capped dimension.
 * @param {number|string} used
 * @param {number|string} limit 0 / blank = unlimited
 */
export function getLimitUsage(used, limit) {
  const limitValue = Math.max(0, toNumber(limit));
  const usedValue = Math.max(0, toNumber(used));
  const unlimited = limitValue === 0;
  const rawRemaining = unlimited
    ? 100
    : clamp(((limitValue - usedValue) / limitValue) * 100, 0, 100);
  const remainingPercent = Math.round(rawRemaining);

  return {
    unlimited,
    limit: limitValue,
    used: usedValue,
    remaining: unlimited ? null : Math.max(0, limitValue - usedValue),
    remainingPercent,
    usedPercent: 100 - remainingPercent,
    atLimit: !unlimited && usedValue >= limitValue,
    // Tone follows the rounded number the UI prints, so a bar never shows 70%
    // while painted green.
    tone: getLimitTone(remainingPercent),
  };
}

/** Both dimensions for a key row + the "reached a limit" roll-up. */
export function getKeyLimitStats(key) {
  const tokens = getLimitUsage(key?.usedTokens, key?.tokenLimit);
  const cost = getLimitUsage(key?.usedCost, key?.costLimit);
  return { tokens, cost, atLimit: tokens.atLimit || cost.atLimit };
}

/** `12,345` — no currency, no rounding surprises for large token counts. */
export function formatTokens(value) {
  return Math.max(0, toNumber(value)).toLocaleString("en-US");
}

/**
 * `$1.50`, or 4 dp for sub-cent amounts so a tiny spend is not shown as $0.00.
 * @param {number|string} value
 * @param {{ precise?: boolean }} [opts]
 */
export function formatUsd(value, { precise = false } = {}) {
  const n = Math.max(0, toNumber(value));
  const digits = precise && n > 0 && n < 0.01 ? 4 : 2;
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

/**
 * Strip everything a token-count field must not accept, and normalise an empty
 * field to "". Keeps the input numeric without fighting the user's typing.
 */
export function digitsOnly(raw) {
  return String(raw ?? "").replace(/[^\d]/g, "");
}

/** Same, but allows a single decimal point (USD cost). */
export function decimalOnly(raw) {
  const cleaned = String(raw ?? "").replace(/[^\d.]/g, "");
  const [head, ...rest] = cleaned.split(".");
  return rest.length === 0 ? head : `${head}.${rest.join("")}`;
}

function limitFieldValue(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return 0; // blank = unlimited
  const n = Number(text);
  // Non-numeric text is forwarded untouched so the server's message (400) is
  // the one the user sees, instead of a second, drifting client-side copy.
  return Number.isFinite(n) ? n : text;
}

function costFieldValue(raw) {
  const value = limitFieldValue(raw);
  return typeof value === "number" ? Math.round(value * 100) / 100 : value;
}

/**
 * The reset day a blank field really means, so the selector and the request
 * body can never disagree about it.
 */
export function effectiveResetDay(resetMode, raw) {
  if (resetMode === "none") return null;
  const text = String(raw ?? "").trim();
  if (text === "") return DEFAULT_RESET_DAY[resetMode];
  const n = Number(text);
  return Number.isInteger(n) ? n : text;
}

/**
 * Request body for PATCH /api/keys/[id] (and the optional half of POST /api/keys).
 * Blank / 0 limits become literal 0, i.e. unlimited.
 */
export function buildLimitsPayload({ tokenLimit, costLimit, resetMode = "none", resetDay = null } = {}) {
  const mode = RESET_MODES.includes(resetMode) ? resetMode : "none";
  return {
    tokenLimit: limitFieldValue(tokenLimit),
    costLimit: costFieldValue(costLimit),
    resetMode: mode,
    resetDay: effectiveResetDay(mode, resetDay),
  };
}

/**
 * POST /api/keys body. Limits are optional at creation time: when nothing was
 * set we send exactly `{ name }`, leaving the previous behaviour untouched.
 */
export function buildCreateKeyPayload(name, values = {}) {
  const payload = { name };
  const limits = buildLimitsPayload(values);
  const untouched = limits.tokenLimit === 0 && limits.costLimit === 0 && limits.resetMode === "none";
  if (!untouched) Object.assign(payload, limits);
  return payload;
}

/** Body for the "reset usage now" action on PATCH /api/keys/[id]. */
export function buildResetUsagePayload() {
  return { resetUsage: true };
}

/** Day options for the reset selector: 1..31, or the seven weekdays. */
export function resetDayOptions(resetMode) {
  if (resetMode === "monthly") {
    return Array.from({ length: 31 }, (_, i) => ({ value: i + 1, label: `Day ${i + 1}` }));
  }
  if (resetMode === "weekly") return WEEKDAY_OPTIONS.map((o) => ({ ...o }));
  return [];
}

// Boundaries are computed in the server's business timezone (Asia/Bangkok,
// UTC+07:00), so the date we print must be formatted there too — otherwise a
// browser west of UTC shows the previous day.
function formatResetDate(timestamp) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Bangkok",
  }).format(new Date(timestamp));
}

/**
 * Next reset for a key, or null when the key never resets.
 * @param {{resetMode?: string, resetDay?: number|null, now?: number}} opts
 * @returns {{ at: string, days: number, dateLabel: string } | null}
 */
export function nextResetInfo({ resetMode = "none", resetDay = null, now = Date.now() } = {}) {
  if (!resetMode || resetMode === "none") return null;

  const from = typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(from)) return null;

  let at = null;
  try {
    at = nextResetAt({ resetMode, resetDay, from });
  } catch {
    // Incomplete monthly/weekly configuration mid-edit: show nothing rather
    // than throwing inside render.
    return null;
  }
  if (at == null) return null;

  return {
    at: new Date(at).toISOString(),
    days: Math.max(0, Math.ceil((at - from) / DAY_MS)),
    dateLabel: formatResetDate(at),
  };
}

/** "Resets in 12 days, 1 Dec 2026" / "Resets today, 3 Nov 2026". */
export function describeNextReset(info) {
  if (!info) return null;
  if (info.days <= 0) return `Resets today, ${info.dateLabel}`;
  return `Resets in ${info.days} day${info.days === 1 ? "" : "s"}, ${info.dateLabel}`;
}
