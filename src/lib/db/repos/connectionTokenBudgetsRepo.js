import { DEFAULT_RESET_DAY, isValidResetDay, isValidResetMode } from "../keyReset.js";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { normalizeConnectionTokenBudget, resolveConnectionTokenBudget, connectionTokenBudgetStatus } from "@/shared/utils/connectionTokenBudget.js";

function readData(db, id) {
  const row = db.get("SELECT data FROM providerConnections WHERE id = ?", [id]);
  if (!row) return null;
  const value = parseJson(row.data, {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function writeBudget(db, id, data, budget, nowMs) {
  // data was freshly read INSIDE the transaction; never write a cached connection.
  db.run("UPDATE providerConnections SET data = ?, updatedAt = ? WHERE id = ?", [
    stringifyJson({ ...data, tokenBudget: budget }), new Date(nowMs).toISOString(), id,
  ]);
}

/** Lazy-reset and initialize the epoch atomically; no Usage history backfill. */
export async function applyConnectionTokenBudget(id) {
  const db = await getAdapter();
  return db.transaction(() => {
    const data = readData(db, id);
    if (!data) return null;
    const nowMs = Date.now();
    const budget = resolveConnectionTokenBudget(data.tokenBudget, nowMs);
    if (stringifyJson(data.tokenBudget) !== stringifyJson(budget)) writeBudget(db, id, data, budget, nowMs);
    return connectionTokenBudgetStatus(budget, nowMs);
  });
}

export async function getConnectionTokenBudget(id) {
  return applyConnectionTokenBudget(id);
}

export class ConnectionTokenBudgetValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConnectionTokenBudgetValidationError";
    this.status = 400;
  }
}

function validateInput(input, current) {
  const invalid = (message) => { throw new ConnectionTokenBudgetValidationError(message); };
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("Budget must be an object");
  const allowed = ["tokenLimit", "resetMode", "resetDay", "resetUsage"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) invalid("Unknown or read-only budget field");
  if (Object.hasOwn(input, "tokenLimit") && !validCount(input.tokenLimit)) invalid("tokenLimit must be a nonnegative safe integer (0 = unlimited)");
  if (Object.hasOwn(input, "resetMode") && !isValidResetMode(input.resetMode)) invalid("resetMode must be none, weekly or monthly");
  if (Object.hasOwn(input, "resetUsage") && typeof input.resetUsage !== "boolean") invalid("resetUsage must be boolean");
  const resetMode = input.resetMode ?? current.resetMode;
  const resetDay = Object.hasOwn(input, "resetDay") ? input.resetDay
    : resetMode === "none" ? null
    : resetMode === current.resetMode ? current.resetDay : DEFAULT_RESET_DAY[resetMode];
  if (!isValidResetDay(resetMode, resetDay)) invalid("resetDay must be null for none, 0..6 for weekly or 1..31 for monthly");
  return { tokenLimit: input.tokenLimit ?? current.tokenLimit, resetMode, resetDay };
}

export async function updateConnectionTokenBudget(id, input) {
  const db = await getAdapter();
  return db.transaction(() => {
    const data = readData(db, id);
    if (!data) return null;
    const nowMs = Date.now();
    const current = normalizeConnectionTokenBudget(data.tokenBudget, nowMs);
    const policy = validateInput(input, current);
    // Edits do not implicitly wipe counters, even when replacing an old cadence.
    const cadenceChanged = current.resetMode !== policy.resetMode || current.resetDay !== policy.resetDay;
    const budget = { ...current, ...policy };
    if (cadenceChanged || input.resetUsage === true) budget.lastResetAt = new Date(nowMs).toISOString();
    if (input.resetUsage === true) { budget.usedTokens = 0; budget.unknownUsageCount = 0; }
    writeBudget(db, id, data, budget, nowMs);
    return connectionTokenBudgetStatus(budget, nowMs);
  });
}

/** Disable policy without deleting its accounting epoch or counters. */
export async function deleteConnectionTokenBudget(id) {
  return updateConnectionTokenBudget(id, { tokenLimit: 0, resetMode: "none", resetDay: null });
}

const validCount = (value) => Number.isSafeInteger(value) && value >= 0;
const addCount = (a, b) => Math.min(Number.MAX_SAFE_INTEGER, a + b);

/** Synchronous canonical hook: caller MUST own the transaction and deduplication. */
export function accountConnectionTokenUsage(db, connectionId, tokens, nowMs = Date.now()) {
  if (typeof connectionId !== "string" || !connectionId) return null;
  const data = readData(db, connectionId);
  if (!data) return null;
  const budget = resolveConnectionTokenBudget(data.tokenBudget, nowMs);
  // Canonical totals already include cache/reasoning subsets. Prefer an explicit
  // zero over an alias; never turn absent/invalid/estimated totals into actual 0.
  const prompt = tokens?.prompt_tokens ?? tokens?.input_tokens;
  const completion = tokens?.completion_tokens ?? tokens?.output_tokens;
  const known = tokens?.estimated !== true && validCount(prompt) && validCount(completion)
    && Number.isSafeInteger(prompt + completion);
  if (known) budget.usedTokens = addCount(budget.usedTokens, prompt + completion);
  else budget.unknownUsageCount = addCount(budget.unknownUsageCount, 1);
  writeBudget(db, connectionId, data, budget, nowMs);
  return connectionTokenBudgetStatus(budget, nowMs);
}
