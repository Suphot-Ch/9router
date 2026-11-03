// Per-API-key spending limits: the 429 gate (checkApiKeyQuota).
// Temp DATA_DIR only — never touches ~/.9router.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let repo;
let adapter;
let checkApiKeyQuota;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-limits-gate-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  repo = await import("@/lib/db/repos/apiKeysRepo.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  ({ checkApiKeyQuota } = await import("@/sse/services/auth.js"));
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
const fresh = async (id) => repo.getApiKeyById(id);

describe("key token limit", () => {
  it("returns 429 key_token_limit once usedTokens reaches tokenLimit", async () => {
    const key = await create({ tokenLimit: 100 });
    await repo.addApiKeyUsage(key.key, { tokens: 100 });

    const denied = await checkApiKeyQuota(key.key, false);
    expect(denied).toMatchObject({ status: 429, code: "key_token_limit" });
    expect(denied.error).toMatch(/token limit exceeded/i);
  });

  it("allows a key under its token limit", async () => {
    const key = await create({ tokenLimit: 100 });
    await repo.addApiKeyUsage(key.key, { tokens: 99 });
    expect(await checkApiKeyQuota(key.key, false)).toBeNull();
  });

  it("treats tokenLimit 0 as unlimited", async () => {
    const key = await create({ tokenLimit: 0 });
    await repo.addApiKeyUsage(key.key, { tokens: 10_000_000 });
    expect(await checkApiKeyQuota(key.key, false)).toBeNull();
  });
});

describe("key cost limit", () => {
  it("returns 429 key_cost_limit once usedCost reaches costLimit", async () => {
    const key = await create({ costLimit: 0.5 });
    await repo.addApiKeyUsage(key.key, { tokens: 1, cost: 0.5 });

    const denied = await checkApiKeyQuota(key.key, false);
    expect(denied).toMatchObject({ status: 429, code: "key_cost_limit" });
    expect(denied.error).toMatch(/cost limit exceeded/i);
  });

  it("allows a key under its cost limit and treats costLimit 0 as unlimited", async () => {
    const limited = await create({ costLimit: 0.5 });
    await repo.addApiKeyUsage(limited.key, { cost: 0.49 });
    expect(await checkApiKeyQuota(limited.key, false)).toBeNull();

    const unlimited = await create({ costLimit: 0 });
    await repo.addApiKeyUsage(unlimited.key, { cost: 100 });
    expect(await checkApiKeyQuota(unlimited.key, false)).toBeNull();
  });
});

describe("unknown keys keep existing behavior", () => {
  it("passes an unknown key in local mode", async () => {
    expect(await checkApiKeyQuota("sk-unknown", false)).toBeNull();
  });

  it("rejects an unknown key when keys are required", async () => {
    expect(await checkApiKeyQuota("sk-unknown", true)).toMatchObject({ status: 401, code: "invalid_api_key" });
  });

  it("rejects a missing key only when keys are required", async () => {
    expect(await checkApiKeyQuota(null, false)).toBeNull();
    expect(await checkApiKeyQuota(null, true)).toMatchObject({ status: 401, code: "missing_api_key" });
  });

  it("rejects a paused key when keys are required, ignores it in local mode", async () => {
    const key = await create();
    await repo.updateApiKey(key.id, { isActive: false });
    expect(await checkApiKeyQuota(key.key, false)).toBeNull();
    expect(await checkApiKeyQuota(key.key, true)).toMatchObject({ status: 401 });
  });
});

describe("lazy reset before comparing", () => {
  it("resets an exhausted monthly key whose boundary has passed, then allows it", async () => {
    const key = await create({ tokenLimit: 10, resetMode: "monthly", resetDay: 1 });
    const longAgo = new Date(Date.now() - 40 * 86400000).toISOString();
    adapter.run(
      `UPDATE apiKeys SET usedTokens = 5000, usedCost = 2, lastResetAt = ?, updatedAt = ? WHERE id = ?`,
      [longAgo, longAgo, key.id]
    );

    expect(await checkApiKeyQuota(key.key, false)).toBeNull();

    const after = await fresh(key.id);
    expect(after.usedTokens).toBe(0);
    expect(after.usedCost).toBe(0);
    expect(Date.parse(after.lastResetAt)).toBeGreaterThan(Date.parse(longAgo));
  });

  it("does not reset (and still blocks) before the boundary", async () => {
    const key = await create({ tokenLimit: 10, resetMode: "monthly", resetDay: 1 });
    await repo.addApiKeyUsage(key.key, { tokens: 10 });

    const denied = await checkApiKeyQuota(key.key, false);
    expect(denied).toMatchObject({ status: 429, code: "key_token_limit" });
    expect((await fresh(key.id)).usedTokens).toBe(10);
  });

  it("never resets a key with resetMode none", async () => {
    const key = await create({ tokenLimit: 10 });
    const longAgo = new Date(Date.now() - 400 * 86400000).toISOString();
    adapter.run(`UPDATE apiKeys SET usedTokens = 10, lastResetAt = ? WHERE id = ?`, [longAgo, key.id]);

    expect(await checkApiKeyQuota(key.key, false)).toMatchObject({ status: 429, code: "key_token_limit" });
    expect((await fresh(key.id)).usedTokens).toBe(10);
  });

  it("applies a weekly window too", async () => {
    const key = await create({ tokenLimit: 10, resetMode: "weekly", resetDay: 1 });
    const longAgo = new Date(Date.now() - 8 * 86400000).toISOString();
    adapter.run(`UPDATE apiKeys SET usedTokens = 10, lastResetAt = ? WHERE id = ?`, [longAgo, key.id]);

    expect(await checkApiKeyQuota(key.key, false)).toBeNull();
    expect((await fresh(key.id)).usedTokens).toBe(0);
  });
});
