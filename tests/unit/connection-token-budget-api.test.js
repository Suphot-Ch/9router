import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let db, route, dir;
const previous = process.env.DATA_DIR;
const ctx = (id = "api-account") => ({ params: Promise.resolve({ id }) });
const req = (body) => new Request("http://localhost/api/providers/api-account/token-budget", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-connection-budget-api-"));
  process.env.DATA_DIR = dir; delete global._dbAdapter; vi.resetModules();
  db = await (await import("@/lib/db/driver.js")).getAdapter();
  route = await import("@/app/api/providers/[id]/token-budget/route.js");
});
beforeEach(() => {
  db.run("DELETE FROM providerConnections");
  db.run("INSERT INTO providerConnections(id,provider,authType,data,createdAt,updatedAt) VALUES(?,?,?,?,?,?)", ["api-account", "provider", "apikey", JSON.stringify({ apiKey: "private-value", refreshToken: "private-refresh", schedule: { enabled: true } }), "2026-11-19T05:00:00.000Z", "2026-11-19T05:00:00.000Z"]);
});
afterAll(() => {
  db?.close?.(); delete global._dbAdapter;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
});

describe("per-provider-account token budget API", () => {
  it("GET/PUT/DELETE return only a sanitized budget and DELETE keeps counters", async () => {
    const get = await route.GET(new Request("http://localhost"), ctx());
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ budget: { tokenLimit: 0, usedTokens: 0, unknownUsageCount: 0, resetMode: "none", resetDay: null, lastResetAt: expect.any(String), nextResetAt: null, atLimit: false, remainingTokens: null } });
    const repo = await import("@/lib/db/repos/connectionTokenBudgetsRepo.js");
    db.transaction(() => repo.accountConnectionTokenUsage(db, "api-account", { prompt_tokens: 4, completion_tokens: 2 }));
    const put = await route.PUT(req({ tokenLimit: 5, resetMode: "weekly", resetDay: 0 }), ctx());
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ budget: expect.objectContaining({ tokenLimit: 5, usedTokens: 6, atLimit: true, resetDay: 0, remainingTokens: 0 }) });
    const del = await route.DELETE(new Request("http://localhost"), ctx());
    expect(del.status).toBe(200);
    const body = await del.json();
    expect(body).toEqual({ budget: expect.objectContaining({ tokenLimit: 0, usedTokens: 6, resetMode: "none", resetDay: null, atLimit: false }) });
    expect(JSON.stringify(body)).not.toContain("private");
    const reset = await route.PUT(req({ budget: { resetUsage: true } }), ctx());
    expect(reset.status).toBe(200);
    expect((await reset.json()).budget.usedTokens).toBe(0);
    const data = JSON.parse(db.get("SELECT data FROM providerConnections WHERE id=?", ["api-account"]).data);
    expect(data).toMatchObject({ apiKey: "private-value", refreshToken: "private-refresh", schedule: { enabled: true } });
  });
  it.each(["GET", "PUT", "DELETE"])("%s returns 404 for an unknown id", async (method) => {
    const res = await route[method](req({ tokenLimit: 5 }), ctx("missing"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Connection not found" });
  });
  it.each([null, [], { tokenLimit: "10" }, { tokenLimit: -1 }, { resetMode: "daily" }, { resetMode: "monthly", resetDay: 32 }, { resetUsage: "yes" }, { usedTokens: 0 }, { budget: { tokenLimit: 5 }, apiKey: "forbidden" }].map((body) => [body]))("PUT rejects invalid input with 400: %j", async (body) => {
    const res = await route.PUT(req(body), ctx());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(JSON.parse(db.get("SELECT data FROM providerConnections WHERE id=?", ["api-account"]).data)).not.toHaveProperty("tokenBudget");
  });
  it("PUT rejects malformed JSON", async () => {
    const res = await route.PUT(new Request("http://localhost", { method: "PUT", body: "{" }), ctx());
    expect(res.status).toBe(400);
  });
});
