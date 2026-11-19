// Client-safe policy math; keyReset is pure and fixes cadence to Asia/Bangkok.
import { DEFAULT_RESET_DAY, isValidResetMode, isValidResetDay, getDueResetBoundary, nextResetAt } from "@/lib/db/keyReset.js";

/** Resolve a lazy reset without modifying the input; callers persist atomically. */
export function resolveConnectionTokenBudget(value, nowMs = Date.now()) {
  const budget = normalizeConnectionTokenBudget(value, nowMs);
  const boundary = getDueResetBoundary(budget, nowMs);
  return boundary ? { ...budget, usedTokens: 0, unknownUsageCount: 0, lastResetAt: boundary } : budget;
}

/** Status for the supplied counters. Use resolve first when a due reset is wanted. */
export function connectionTokenBudgetStatus(value, nowMs = Date.now()) {
  const budget = normalizeConnectionTokenBudget(value, nowMs);
  const next = nextResetAt({ resetMode: budget.resetMode, resetDay: budget.resetDay, from: nowMs });
  return {
    ...budget,
    nextResetAt: next === null ? null : new Date(next).toISOString(),
    atLimit: budget.tokenLimit > 0 && budget.usedTokens >= budget.tokenLimit,
    remainingTokens: budget.tokenLimit === 0 ? null : Math.max(0, budget.tokenLimit - budget.usedTokens),
  };
}

const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const counter = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** Sanitize persisted JSON, exposing only the budget (never connection secrets). */
export function normalizeConnectionTokenBudget(value, nowMs = Date.now()) {
  const raw = object(value);
  const resetMode = isValidResetMode(raw.resetMode) ? raw.resetMode : "none";
  const resetDay = resetMode === "none" ? null : isValidResetDay(resetMode, raw.resetDay)
    ? raw.resetDay : DEFAULT_RESET_DAY[resetMode];
  const baseline = typeof raw.lastResetAt === "string" ? Date.parse(raw.lastResetAt) : NaN;
  return {
    tokenLimit: counter(raw.tokenLimit),
    usedTokens: counter(raw.usedTokens),
    unknownUsageCount: counter(raw.unknownUsageCount),
    resetMode,
    resetDay,
    lastResetAt: new Date(Number.isFinite(baseline) ? baseline : nowMs).toISOString(),
  };
}
