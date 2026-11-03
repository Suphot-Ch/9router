// Per-API-key spending limits: /api/keys routes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let repo;
let adapter;
let keysRoute;
let keyRoute;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-limits-api-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  repo = await import("@/lib/db/repos/apiKeysRepo.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  keysRoute = await import("../../src/app/api/keys/route.js");
  keyRoute = await import("../../src/app/api/keys/[id]/route.js");
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

const post = (body) => keysRoute.POST(new Request("http://localhost/api/keys", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}));

const patch = (id, body) => keyRoute.PATCH(
  new Request(`http://localhost/api/keys/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ id }) }
);

describe("GET /api/keys", () => {
  it("returns the spending-limit fields for every key", async () => {
    await repo.createApiKey("limited", "machine-1", { tokenLimit: 100, costLimit: 1.5, resetMode: "monthly", resetDay: 3 });
    const res = await keysRoute.GET();
    expect(res.status).toBe(200);
    const { keys } = await res.json();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      name: "limited",
      tokenLimit: 100,
      costLimit: 1.5,
      usedTokens: 0,
      usedCost: 0,
      resetMode: "monthly",
      resetDay: 3,
    });
    expect(typeof keys[0].lastResetAt).toBe("string");
    expect(typeof keys[0].updatedAt).toBe("string");
  });
});

describe("POST /api/keys", () => {
  it("creates a key with limits and returns them", async () => {
    const res = await post({ name: "new", tokenLimit: 1000, costLimit: 2.5, resetMode: "monthly", resetDay: 5 });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      name: "new",
      tokenLimit: 1000,
      costLimit: 2.5,
      usedTokens: 0,
      usedCost: 0,
      resetMode: "monthly",
      resetDay: 5,
    });

    const stored = await repo.getApiKeyByKey(body.key);
    expect(stored).toMatchObject({ tokenLimit: 1000, costLimit: 2.5, resetMode: "monthly", resetDay: 5 });
  });

  it("creates an unlimited key when limits are omitted", async () => {
    const res = await post({ name: "plain" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ tokenLimit: 0, costLimit: 0, resetMode: "none", resetDay: null });
  });

  it("returns 400 for invalid limits instead of 500", async () => {
    const cases = [
      { name: "n", tokenLimit: -1 },
      { name: "n", costLimit: "abc" },
      { name: "n", resetMode: "daily" },
      { name: "n", resetMode: "monthly", resetDay: 0 },
      { name: "n", resetMode: "weekly", resetDay: 9 },
    ];
    for (const body of cases) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
    expect(await repo.getApiKeys()).toHaveLength(0);
  });

  it("still requires a name", async () => {
    expect((await post({ tokenLimit: 5 })).status).toBe(400);
  });
});

describe("PATCH /api/keys/[id]", () => {
  it("updates limits and returns the updated record", async () => {
    const key = await repo.createApiKey("patch-me", "machine-1");
    const res = await patch(key.id, { tokenLimit: 500, costLimit: 0.75, resetMode: "weekly", resetDay: 0 });
    expect(res.status).toBe(200);
    const { key: updated } = await res.json();
    expect(updated).toMatchObject({ id: key.id, tokenLimit: 500, costLimit: 0.75, resetMode: "weekly", resetDay: 0 });
    expect((await repo.getApiKeyById(key.id)).resetDay).toBe(0);
  });

  it("resets usage with {resetUsage:true}", async () => {
    const key = await repo.createApiKey("reset-me", "machine-1", { tokenLimit: 100 });
    await repo.addApiKeyUsage(key.key, { tokens: 90, cost: 0.4 });
    const before = await repo.getApiKeyById(key.id);

    const res = await patch(key.id, { resetUsage: true });
    expect(res.status).toBe(200);
    const { key: updated } = await res.json();
    expect(updated).toMatchObject({ usedTokens: 0, usedCost: 0 });
    expect(Date.parse(updated.lastResetAt)).toBeGreaterThanOrEqual(Date.parse(before.lastResetAt));
  });

  it("rejects invalid limits with 400", async () => {
    const key = await repo.createApiKey("bad-patch", "machine-1");
    expect((await patch(key.id, { tokenLimit: -5 })).status).toBe(400);
    expect((await patch(key.id, { resetMode: "yearly" })).status).toBe(400);
    expect((await patch(key.id, { resetMode: "monthly", resetDay: 40 })).status).toBe(400);
    expect(await repo.getApiKeyById(key.id)).toMatchObject({ tokenLimit: 0, resetMode: "none", resetDay: null });
  });

  it("returns 404 for an unknown id", async () => {
    expect((await patch("nope", { tokenLimit: 1 })).status).toBe(404);
  });
});
