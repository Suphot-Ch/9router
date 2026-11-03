// Per-API-key spending limits: schema + repo round-trip.
// Temp DATA_DIR only — never touches ~/.9router.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let repo;
let adapter;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-limits-repo-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  repo = await import("@/lib/db/repos/apiKeysRepo.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
});

beforeEach(() => {
  adapter.run("DELETE FROM apiKeys");
});

afterAll(() => {
  adapter?.close?.();
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const create = (options) => repo.createApiKey("k", "machine-1", options);

describe("apiKeys schema", () => {
  it("has the spending-limit columns", () => {
    const cols = adapter.all(`PRAGMA table_info(apiKeys)`).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      "tokenLimit", "costLimit", "usedTokens", "usedCost", "resetMode", "resetDay", "lastResetAt", "updatedAt",
    ]));
  });
});

describe("createApiKey / getApiKeyByKey round-trip", () => {
  it("persists limits, reset config and zeroed counters", async () => {
    const created = await create({ tokenLimit: 1000, costLimit: 2.5, resetMode: "monthly", resetDay: 5 });
    const fetched = await repo.getApiKeyByKey(created.key);

    expect(fetched).toMatchObject({
      id: created.id,
      tokenLimit: 1000,
      costLimit: 2.5,
      usedTokens: 0,
      usedCost: 0,
      resetMode: "monthly",
      resetDay: 5,
    });
    expect(typeof fetched.usedTokens).toBe("number");
    expect(typeof fetched.usedCost).toBe("number");
    expect(Date.parse(fetched.lastResetAt)).toBeGreaterThan(0);
    expect(Date.parse(fetched.updatedAt)).toBeGreaterThan(0);
  });

  it("still works with the 2-argument form and reads as unlimited", async () => {
    const created = await repo.createApiKey("plain", "machine-1");
    const fetched = await repo.getApiKeyById(created.id);
    expect(fetched).toMatchObject({
      tokenLimit: 0, costLimit: 0, usedTokens: 0, usedCost: 0, resetMode: "none", resetDay: null,
    });
  });

  it("treats explicit 0 limits as unlimited (not NULL, not blocked)", async () => {
    const created = await create({ tokenLimit: 0, costLimit: 0, resetMode: "none" });
    const fetched = await repo.getApiKeyByKey(created.key);
    expect(fetched.tokenLimit).toBe(0);
    expect(fetched.costLimit).toBe(0);
    expect(fetched.resetMode).toBe("none");
    expect(fetched.resetDay).toBeNull();
  });

  it("defaults resetDay per mode and clears it when the mode is none", async () => {
    const monthly = await create({ resetMode: "monthly" });
    expect((await repo.getApiKeyById(monthly.id)).resetDay).toBe(1);
    const weekly = await create({ resetMode: "weekly" });
    expect((await repo.getApiKeyById(weekly.id)).resetDay).toBe(1);

    const cleared = await repo.updateApiKey(monthly.id, { resetMode: "none" });
    expect(cleared.resetMode).toBe("none");
    expect(cleared.resetDay).toBeNull();
  });
});

describe("updateApiKey", () => {
  it("persists every spending-limit field and returns the updated record", async () => {
    const created = await create();
    const updated = await repo.updateApiKey(created.id, {
      tokenLimit: 500, costLimit: 1.25, resetMode: "weekly", resetDay: 0,
    });
    expect(updated).toMatchObject({ tokenLimit: 500, costLimit: 1.25, resetMode: "weekly", resetDay: 0 });
    expect((await repo.getApiKeyById(created.id)).resetDay).toBe(0);
    expect(updated.updatedAt >= created.updatedAt).toBe(true);
  });

  it("allows setting a limit back to 0 = unlimited", async () => {
    const created = await create({ tokenLimit: 900, costLimit: 3 });
    const updated = await repo.updateApiKey(created.id, { tokenLimit: 0, costLimit: 0 });
    expect(updated.tokenLimit).toBe(0);
    expect(updated.costLimit).toBe(0);
  });

  it("keeps an existing resetDay when only other fields change", async () => {
    const created = await create({ resetMode: "monthly", resetDay: 15 });
    const updated = await repo.updateApiKey(created.id, { tokenLimit: 42 });
    expect(updated.resetMode).toBe("monthly");
    expect(updated.resetDay).toBe(15);
  });

  it("returns null for an unknown id", async () => {
    expect(await repo.updateApiKey("nope", { tokenLimit: 1 })).toBeNull();
  });
});

describe("validation", () => {
  const bad = [
    ["negative tokenLimit", { tokenLimit: -1 }],
    ["NaN tokenLimit", { tokenLimit: "abc" }],
    ["infinite tokenLimit", { tokenLimit: Infinity }],
    ["negative costLimit", { costLimit: -0.5 }],
    ["NaN costLimit", { costLimit: NaN }],
    ["unknown resetMode", { resetMode: "daily" }],
    ["monthly day 0", { resetMode: "monthly", resetDay: 0 }],
    ["monthly day 32", { resetMode: "monthly", resetDay: 32 }],
    ["monthly fractional day", { resetMode: "monthly", resetDay: 1.5 }],
    ["weekly day 7", { resetMode: "weekly", resetDay: 7 }],
    ["weekly negative day", { resetMode: "weekly", resetDay: -1 }],
  ];

  for (const [label, data] of bad) {
    it(`rejects ${label}`, async () => {
      await expect(create(data)).rejects.toThrow(repo.ApiKeyValidationError);
      const created = await create();
      await expect(repo.updateApiKey(created.id, data)).rejects.toThrow(repo.ApiKeyValidationError);
      // Rejected input must not be written.
      expect(await repo.getApiKeyById(created.id)).toMatchObject({ tokenLimit: 0, costLimit: 0, resetMode: "none" });
    });
  }

  it("exposes a 400 status for route mapping", async () => {
    const error = await create({ tokenLimit: -5 }).catch((e) => e);
    expect(error.status).toBe(400);
    expect(error.message).toMatch(/tokenLimit/);
  });
});

describe("addApiKeyUsage", () => {
  it("accumulates tokens and cost in one atomic update", async () => {
    const created = await create();
    await repo.addApiKeyUsage(created.key, { tokens: 100, cost: 0.5 });
    expect(await repo.getApiKeyById(created.id)).toMatchObject({ usedTokens: 100, usedCost: 0.5 });

    await repo.addApiKeyUsage(created.key, { tokens: 50, cost: 0.25 });
    expect(await repo.getApiKeyById(created.id)).toMatchObject({ usedTokens: 150, usedCost: 0.75 });
  });

  it("supports token-only and cost-only increments", async () => {
    const created = await create();
    await repo.addApiKeyUsage(created.key, { tokens: 7 });
    await repo.addApiKeyUsage(created.key, { cost: 0.125 });
    expect(await repo.getApiKeyById(created.id)).toMatchObject({ usedTokens: 7, usedCost: 0.125 });
  });

  it("skips no-op and unknown-key increments", async () => {
    const created = await create();
    await repo.addApiKeyUsage(created.key, { tokens: 0, cost: 0 });
    await repo.addApiKeyUsage(created.key, { tokens: -5, cost: -1 });
    await repo.addApiKeyUsage(created.key);
    await repo.addApiKeyUsage("sk-not-a-real-key", { tokens: 10, cost: 1 });
    await repo.addApiKeyUsage(created.key, { tokens: NaN, cost: NaN });
    expect(await repo.getApiKeyById(created.id)).toMatchObject({ usedTokens: 0, usedCost: 0 });
  });
});

describe("resetApiKeyUsage", () => {
  it("zeroes both counters and stamps lastResetAt", async () => {
    const created = await create();
    await repo.addApiKeyUsage(created.key, { tokens: 900, cost: 1.5 });
    const reset = await repo.resetApiKeyUsage(created.id);
    expect(reset).toMatchObject({ usedTokens: 0, usedCost: 0 });
    expect(Date.parse(reset.lastResetAt)).toBeGreaterThanOrEqual(Date.parse(created.lastResetAt));
  });

  it("stamps an explicit boundary (lazy reset path)", async () => {
    const created = await create();
    const boundary = "2026-03-01T00:00:00.000Z";
    const reset = await repo.resetApiKeyUsage(created.id, { lastResetAt: boundary });
    expect(reset.lastResetAt).toBe(boundary);
  });

  it("returns null for an unknown id", async () => {
    expect(await repo.resetApiKeyUsage("nope")).toBeNull();
  });
});

describe("applyDueKeyReset", () => {
  it("zeroes counters only once the boundary has passed", async () => {
    const created = await create({ tokenLimit: 10, resetMode: "monthly", resetDay: 1 });
    await repo.addApiKeyUsage(created.key, { tokens: 50, cost: 0.25 });
    const row = await repo.getApiKeyById(created.id);

    // No boundary crossed yet (window starts now).
    const untouched = await repo.applyDueKeyReset(row);
    expect(untouched.usedTokens).toBe(50);

    // Pretend the window opened in January → a boundary has passed.
    adapter.run(`UPDATE apiKeys SET lastResetAt = ? WHERE id = ?`, ["2026-01-05T00:00:00.000Z", created.id]);
    const fresh = await repo.getApiKeyById(created.id);
    const afterReset = await repo.applyDueKeyReset(fresh, Date.parse("2026-03-15T00:00:00.000Z"));
    expect(afterReset.usedTokens).toBe(0);
    expect(afterReset.usedCost).toBe(0);
    expect(Date.parse(afterReset.lastResetAt)).toBeGreaterThan(Date.parse("2026-01-05T00:00:00.000Z"));
  });

  it("is a no-op for mode none", async () => {
    const created = await create();
    await repo.addApiKeyUsage(created.key, { tokens: 12 });
    const row = await repo.getApiKeyById(created.id);
    const unchanged = await repo.applyDueKeyReset(row, Date.parse("2030-01-01T00:00:00.000Z"));
    expect(unchanged.usedTokens).toBe(12);
  });
});

describe("usage accounting (saveRequestUsage)", () => {
  it("adds prompt+completion tokens and cost once per inserted row", async () => {
    const usageRepo = await import("@/lib/db/repos/usageRepo.js");
    const pricingRepo = await import("@/lib/db/repos/pricingRepo.js");
    await pricingRepo.updatePricing({ openai: { "gpt-test-limits": { input: 1, output: 2 } } });

    const created = await create();
    const entry = {
      provider: "openai",
      model: "gpt-test-limits",
      apiKey: created.key,
      endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 1000, completion_tokens: 1000 },
      status: "ok",
    };
    await usageRepo.saveRequestUsage(entry);

    const afterFirst = await repo.getApiKeyById(created.id);
    expect(afterFirst.usedTokens).toBe(2000);
    expect(afterFirst.usedCost).toBeCloseTo(0.003, 10);

    // Same entry again (same timestamp/tokens) is deduped by the history insert,
    // so the key counters must not move.
    await usageRepo.saveRequestUsage(entry);
    const afterSecond = await repo.getApiKeyById(created.id);
    expect(afterSecond.usedTokens).toBe(2000);
    expect(afterSecond.usedCost).toBeCloseTo(0.003, 10);
  });

  it("does not attribute usage to a missing apiKey", async () => {
    const usageRepo = await import("@/lib/db/repos/usageRepo.js");
    const created = await create();
    await usageRepo.saveRequestUsage({
      provider: "openai",
      model: "gpt-test-limits",
      tokens: { prompt_tokens: 10, completion_tokens: 10 },
      status: "ok",
    });
    expect(await repo.getApiKeyById(created.id)).toMatchObject({ usedTokens: 0, usedCost: 0 });
  });
});
