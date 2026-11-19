// Real SQLite in an isolated DATA_DIR; no existing application state is opened.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const previous = process.env.DATA_DIR;
let dir, db, repo;
const now = Date.parse("2026-11-19T05:00:00.000Z");
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-connection-budget-"));
  process.env.DATA_DIR = dir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await (await import("@/lib/db/driver.js")).getAdapter();
  repo = await import("@/lib/db/repos/connectionTokenBudgetsRepo.js");
});
beforeEach(() => { db.run("DELETE FROM providerConnections"); });
afterAll(() => {
  db?.close?.(); delete global._dbAdapter;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
  vi.useRealTimers();
});
function create(id = "account-a", budget) {
  const data = { apiKey: "private-key", refreshToken: "private-refresh", schedule: { enabled: false }, providerSpecificData: { workspace: "one" } };
  if (budget) data.tokenBudget = budget;
  db.run("INSERT INTO providerConnections(id,provider,authType,data,createdAt,updatedAt) VALUES(?,?,?,?,?,?)", [id, "provider", "apikey", JSON.stringify(data), "2020-01-01T00:00:00.000Z", new Date(now).toISOString()]);
  return id;
}
const stored = (id = "account-a") => JSON.parse(db.get("SELECT data FROM providerConnections WHERE id=?", [id]).data);

describe("connection token budget repository", () => {
  it("canonical usage writer counts parallel distinct attempts once and ignores duplicate callbacks", async () => {
    create(); create("account-b");
    const { randomUUID } = await import("node:crypto");
    const { saveRequestUsage } = await import("@/lib/db/repos/usageRepo.js");
    const entry = { timestamp: new Date(now).toISOString(), provider: "fixture-unknown", model: "no-price", connectionId: "account-a", tokens: { prompt_tokens: 10, completion_tokens: 5, cached_tokens: 9, reasoning_tokens: 2 }, routingAttribution: { version: 1, requestId: randomUUID(), attemptId: randomUUID(), requestedModel: "no-price", keyId: null, routeKind: "direct", comboPath: [] } };
    await Promise.all([saveRequestUsage({ ...entry }), saveRequestUsage({ ...entry })]);
    expect(stored().tokenBudget).toMatchObject({ usedTokens: 15, unknownUsageCount: 0 });
    await Promise.all(Array.from({ length: 10 }, () => saveRequestUsage({ ...entry, routingAttribution: { ...entry.routingAttribution, attemptId: randomUUID() } })));
    expect(stored().tokenBudget.usedTokens).toBe(165);
    const unknown = { ...entry, connectionId: "account-b", tokens: {}, routingAttribution: { ...entry.routingAttribution, attemptId: randomUUID() } };
    await saveRequestUsage(unknown); await saveRequestUsage(unknown);
    expect(stored("account-b").tokenBudget).toMatchObject({ usedTokens: 0, unknownUsageCount: 1 });
  });
  it("legacy duplicate detection avoids a second charge and canonical write failures roll back accounting and history", async () => {
    create();
    const { saveRequestUsage } = await import("@/lib/db/repos/usageRepo.js");
    const entry = { timestamp: new Date(now).toISOString(), provider: "fixture-unknown", model: "legacy", connectionId: "account-a", tokens: { prompt_tokens: 2, completion_tokens: 3 } };
    await saveRequestUsage({ ...entry }); await saveRequestUsage({ ...entry, endpoint: "/v1/chat/completions" });
    expect(stored().tokenBudget.usedTokens).toBe(5);
    expect(db.get("SELECT endpoint FROM usageHistory WHERE model='legacy'").endpoint).toBe("/v1/chat/completions");
    const countBefore = db.get("SELECT COUNT(*) AS n FROM usageHistory").n;
    db.exec("CREATE TEMP TRIGGER fail_budget BEFORE UPDATE OF data ON providerConnections BEGIN SELECT RAISE(ABORT, 'budget write rejected'); END");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await saveRequestUsage({ ...entry, timestamp: new Date(now + 1000).toISOString() });
      expect(error).toHaveBeenCalled();
      expect(db.get("SELECT COUNT(*) AS n FROM usageHistory").n).toBe(countBefore);
      expect(stored().tokenBudget.usedTokens).toBe(5);
    } finally { db.exec("DROP TRIGGER fail_budget"); error.mockRestore(); }
  });
  it("policy edits preserve counters, cadence edits start a new baseline, DELETE disables only policy", async () => {
    create("account-a", { tokenLimit: 100, usedTokens: 75, unknownUsageCount: 2, resetMode: "none", resetDay: null, lastResetAt: "2026-01-01T00:00:00.000Z" });
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(await repo.updateConnectionTokenBudget("account-a", { tokenLimit: 50 })).toMatchObject({ usedTokens: 75, unknownUsageCount: 2, atLimit: true, lastResetAt: "2026-01-01T00:00:00.000Z" });
    expect(await repo.updateConnectionTokenBudget("account-a", { resetMode: "weekly", resetDay: 0 })).toMatchObject({ usedTokens: 75, unknownUsageCount: 2, resetDay: 0, lastResetAt: new Date(now).toISOString() });
    expect(await repo.deleteConnectionTokenBudget("account-a")).toMatchObject({ tokenLimit: 0, usedTokens: 75, unknownUsageCount: 2, resetMode: "none", resetDay: null, atLimit: false });
    expect(stored()).toMatchObject({ apiKey: "private-key", schedule: { enabled: false } });
    expect(await repo.updateConnectionTokenBudget("account-a", { resetUsage: true })).toMatchObject({ usedTokens: 0, unknownUsageCount: 0, lastResetAt: new Date(now).toISOString() });
    expect(await repo.updateConnectionTokenBudget("account-a", { resetMode: "monthly" })).toMatchObject({ resetDay: 1 });
    expect(await repo.updateConnectionTokenBudget("missing", {})).toBeNull();
    expect(await repo.deleteConnectionTokenBudget("missing")).toBeNull();
    vi.restoreAllMocks();
  });
  it.each([null, [], "bad", { tokenLimit: -1 }, { tokenLimit: "4" }, { tokenLimit: 1.1 }, { tokenLimit: Number.MAX_SAFE_INTEGER + 1 }, { tokenLimit: null }, { resetMode: "daily" }, { resetMode: "weekly", resetDay: 7 }, { resetMode: "monthly", resetDay: 0 }, { resetMode: "none", resetDay: 2 }, { resetUsage: "true" }, { usedTokens: 0 }, { unknownUsageCount: 0 }, { lastResetAt: "2026-01-01" }].map((input) => [input]))("rejects invalid or server-owned input without modifying JSON: %j", async (input) => {
    create();
    const before = stored();
    await expect(repo.updateConnectionTokenBudget("account-a", input)).rejects.toMatchObject({ status: 400 });
    expect(stored()).toEqual(before);
  });
  it("applies a due reset to the latest persisted JSON without losing schedule/credential changes", async () => {
    create("account-a", { usedTokens: 8, unknownUsageCount: 1, tokenLimit: 7, resetMode: "monthly", resetDay: 1, lastResetAt: "2026-09-03T00:00:00.000Z" });
    vi.spyOn(Date, "now").mockReturnValue(now);
    const data = stored();
    data.schedule = { enabled: true, lastAppliedState: "active" }; data.refreshToken = "rotated";
    db.run("UPDATE providerConnections SET data=? WHERE id=?", [JSON.stringify(data), "account-a"]);
    const first = await repo.applyConnectionTokenBudget("account-a");
    expect(first).toMatchObject({ usedTokens: 0, unknownUsageCount: 0, lastResetAt: "2026-10-31T17:00:00.000Z", nextResetAt: "2026-11-30T17:00:00.000Z" });
    db.transaction(() => repo.accountConnectionTokenUsage(db, "account-a", { prompt_tokens: 1, completion_tokens: 2 }, now));
    expect(await repo.applyConnectionTokenBudget("account-a")).toMatchObject({ usedTokens: 3 });
    expect(stored()).toMatchObject({ refreshToken: "rotated", schedule: { enabled: true, lastAppliedState: "active" } });
    vi.restoreAllMocks();
  });
  it("tracks prompt plus completion once even while unlimited, marking missing and estimated usage unknown", async () => {
    create(); create("account-b");
    db.transaction(() => {
      repo.accountConnectionTokenUsage(db, "account-a", { prompt_tokens: 10, input_tokens: 100, completion_tokens: 5, output_tokens: 50, cached_tokens: 7, reasoning_tokens: 4 }, now);
      repo.accountConnectionTokenUsage(db, "account-a", { input_tokens: 2, output_tokens: 0 }, now);
      repo.accountConnectionTokenUsage(db, "account-a", { prompt_tokens: 999, completion_tokens: 999, estimated: true }, now);
      repo.accountConnectionTokenUsage(db, "account-a", {}, now);
      repo.accountConnectionTokenUsage(db, "account-a", { prompt_tokens: 0, completion_tokens: 0 }, now);
      repo.accountConnectionTokenUsage(db, "missing", null, now);
    });
    expect(stored().tokenBudget).toMatchObject({ usedTokens: 17, unknownUsageCount: 2, tokenLimit: 0 });
    expect(stored("account-b")).not.toHaveProperty("tokenBudget");
  });
  it("resets due counters before counting the completing request and rolls back with its caller", async () => {
    const id = create("account-a", { usedTokens: 99, unknownUsageCount: 3, tokenLimit: 80, resetMode: "weekly", resetDay: 0, lastResetAt: "2026-11-03T05:00:00.000Z" });
    db.transaction(() => repo.accountConnectionTokenUsage(db, id, { prompt_tokens: 3, completion_tokens: 2 }, now));
    expect(stored().tokenBudget).toMatchObject({ usedTokens: 5, unknownUsageCount: 0, lastResetAt: "2026-11-14T17:00:00.000Z" });
    expect(() => db.transaction(() => { repo.accountConnectionTokenUsage(db, id, { prompt_tokens: 9, completion_tokens: 1 }, now); throw new Error("rollback"); })).toThrow("rollback");
    expect(stored().tokenBudget.usedTokens).toBe(5);
  });
  it.each([null, { total_tokens: 8 }, { prompt_tokens: 4 }, { prompt_tokens: -1, completion_tokens: 3 }, { prompt_tokens: "4", completion_tokens: 3 }, { prompt_tokens: 1.5, completion_tokens: 3 }, { prompt_tokens: Infinity, completion_tokens: 3 }])("marks incomplete or invalid usage unknown: %j", (tokens) => {
    create();
    db.transaction(() => repo.accountConnectionTokenUsage(db, "account-a", tokens, now));
    expect(stored().tokenBudget).toMatchObject({ usedTokens: 0, unknownUsageCount: 1 });
  });
  it("starts at zero with no historic import, preserves unrelated JSON and returns null for missing accounts", async () => {
    create();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const budget = await repo.getConnectionTokenBudget("account-a");
    expect(budget).toEqual({ tokenLimit: 0, usedTokens: 0, unknownUsageCount: 0, resetMode: "none", resetDay: null, lastResetAt: new Date(now).toISOString(), nextResetAt: null, atLimit: false, remainingTokens: null });
    expect(stored()).toMatchObject({ apiKey: "private-key", refreshToken: "private-refresh", schedule: { enabled: false }, tokenBudget: { usedTokens: 0 } });
    expect(await repo.getConnectionTokenBudget("missing")).toBeNull();
    expect(await repo.applyConnectionTokenBudget("missing")).toBeNull();
    vi.restoreAllMocks();
  });
});
