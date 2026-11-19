import { describe, expect, it } from "vitest";
import { normalizeConnectionTokenBudget, resolveConnectionTokenBudget, connectionTokenBudgetStatus } from "@/shared/utils/connectionTokenBudget.js";

const now = Date.parse("2026-11-19T05:00:00.000Z");
describe("connection token budget normalization", () => {
  it("resolves due Bangkok month-end resets without mutating the stored policy", () => {
    const stored = { tokenLimit: 100, usedTokens: 110, unknownUsageCount: 2, resetMode: "monthly", resetDay: 31, lastResetAt: "2026-01-30T17:00:00.000Z" };
    const at = Date.parse("2026-02-27T17:00:00.000Z");
    expect(connectionTokenBudgetStatus(stored, at - 1)).toMatchObject({ atLimit: true, remainingTokens: 0, nextResetAt: "2026-02-27T17:00:00.000Z" });
    expect(resolveConnectionTokenBudget(stored, at)).toMatchObject({ usedTokens: 0, unknownUsageCount: 0, lastResetAt: "2026-02-27T17:00:00.000Z" });
    expect(connectionTokenBudgetStatus(resolveConnectionTokenBudget(stored, at), at)).toMatchObject({ atLimit: false, remainingTokens: 100, nextResetAt: "2026-03-30T17:00:00.000Z" });
    expect(stored.usedTokens).toBe(110);
    expect(connectionTokenBudgetStatus(undefined, at)).toMatchObject({ atLimit: false, remainingTokens: null, nextResetAt: null });
  });
  it("resolves Sunday weekly reset at local midnight exactly once", () => {
    const raw = { usedTokens: 5, resetMode: "weekly", resetDay: 0, lastResetAt: "2026-11-03T05:00:00.000Z" };
    const at = Date.parse("2026-11-07T17:00:00.000Z");
    const resolved = resolveConnectionTokenBudget(raw, at);
    expect(resolved).toMatchObject({ usedTokens: 0, resetDay: 0, lastResetAt: new Date(at).toISOString() });
    expect(resolveConnectionTokenBudget({ ...resolved, usedTokens: 3 }, at).usedTokens).toBe(3);
  });
  it("starts an unlimited epoch without importing historical usage or secrets", () => {
    expect(normalizeConnectionTokenBudget(undefined, now)).toEqual({
      tokenLimit: 0, usedTokens: 0, unknownUsageCount: 0,
      resetMode: "none", resetDay: null, lastResetAt: new Date(now).toISOString(),
    });
    expect(normalizeConnectionTokenBudget({ tokenLimit: -1, usedTokens: -3, unknownUsageCount: "2", resetMode: "daily", resetDay: 2, lastResetAt: "bad", apiKey: "secret" }, now))
      .toEqual(normalizeConnectionTokenBudget(undefined, now));
  });
});
