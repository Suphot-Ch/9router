import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoutingAttribution, withRoutingAttribution, withRoutingAttempt } from "../../open-sse/utils/routingAttribution.js";

const originalDataDir = process.env.DATA_DIR;
let tempDir, adapter, usage, keys, pricing;
const route = (requested = "friendly", keyId = null) => withRoutingAttempt(withRoutingAttribution({}, createRoutingAttribution(requested, keyId))).routingAttribution;
const entry = (routingAttribution, extra = {}) => ({
  provider: "openai", model: "routing-fixture", timestamp: "2026-01-02T03:04:05.000Z",
  tokens: { prompt_tokens: 1000, completion_tokens: 100 }, routingAttribution, ...extra,
});
const rows = () => adapter.all("SELECT * FROM usageHistory ORDER BY id");
const meta = row => JSON.parse(row.meta);

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-routing-attribution-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  usage = await import("@/lib/db/repos/usageRepo.js");
  keys = await import("@/lib/db/repos/apiKeysRepo.js");
  pricing = await import("@/lib/db/repos/pricingRepo.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  await pricing.updatePricing({ openai: { "routing-fixture": { input: 1, output: 2 } } });
});
beforeEach(() => {
  adapter.run("DELETE FROM usageHistory"); adapter.run("DELETE FROM usageDaily");
  adapter.run("DELETE FROM apiKeys"); adapter.run("DELETE FROM _meta WHERE key = 'totalRequestsLifetime'");
});
afterAll(() => {
  adapter?.close?.(); delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("routing attribution persisted beside unchanged canonical usage", () => {
  it.each([
    ["missing", undefined], ["legacy meta only", null], ["version", { version: 2 }],
    ["bad UUID", { attemptId: "client-chosen" }], ["bad key", { keyId: { secret: "private" } }],
    ["bad kind", { routeKind: "unknown" }], ["bad path", { routeKind: "combo", comboPath: ["Outer", {}] }],
    ["sparse path", { routeKind: "combo", comboPath: new Array(1) }],
  ])("keeps invalid/legacy %s attribution out of metadata without changing legacy dedup", async (_label, bad) => {
    const attribution = bad == null ? bad : { ...route(), ...bad };
    const item = entry(attribution, { meta: { routing: route(), authorization: "never-copy" } });
    await usage.saveRequestUsage(item); await usage.saveRequestUsage({ ...item });
    expect(rows()).toHaveLength(1);
    expect(meta(rows()[0])).toEqual({});
  });
  it("retains ingress key identity after rename/deletion, including masked-prefix collisions and no-key usage", async () => {
    const a = await keys.createApiKey("same", "machine"), b = await keys.createApiKey("same", "machine");
    adapter.run("UPDATE apiKeys SET name = ? WHERE id = ?", ["renamed", a.id]);
    adapter.run("DELETE FROM apiKeys WHERE id = ?", [b.id]);
    await usage.saveRequestUsage(entry(route("friendly", a.id)));
    await usage.saveRequestUsage(entry(route("friendly", b.id)));
    await usage.saveRequestUsage(entry(route()));
    expect(rows().map(row => meta(row).routing.keyId)).toEqual([a.id, b.id, null]);
  });
  it("dedupes the same attempt after a module reload and history retention without scanning history", async () => {
    const attribution = route();
    await usage.saveRequestUsage(entry(attribution));
    vi.resetModules();
    const reloaded = await import("@/lib/db/repos/usageRepo.js");
    await reloaded.saveRequestUsage(entry(attribution, { timestamp: "2026-01-03T03:04:05.000Z" }));
    expect(rows()).toHaveLength(1);
    adapter.run("DELETE FROM usageHistory");
    await reloaded.saveRequestUsage(entry(attribution));
    expect(rows()).toHaveLength(0);
    expect(adapter.get("SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'").value).toBe("1");
    const plan = adapter.all("EXPLAIN QUERY PLAN SELECT h.id, h.endpoint FROM _meta m LEFT JOIN usageHistory h ON h.id = CAST(m.value AS INTEGER) WHERE m.key = ?", [`usageAttempt:${attribution.attemptId}`]);
    expect(plan.map(row => row.detail).join(" ")).not.toMatch(/SCAN /);
  });
  it.each([
    ["paid", { input: 1, output: 2 }, true],
    ["free", { input: 0, output: 0 }, true],
    ["missing", null, false],
    ["sparse", { input: 1 }, false],
    ["invalid", { input: "bad", output: 2 }, false],
    ["negative", { input: -1, output: 2 }, false],
    ["invalid-cache", { input: 1, output: 2, cached: "bad" }, false],
  ])("writer owns costKnown for %s pricing without treating unknown as free", async (suffix, rates, known) => {
    const model = `routing-price-${suffix}`;
    // Simulate legacy invalid pricing in this isolated database; don't change validation.
    const current = JSON.parse(adapter.get("SELECT value FROM kv WHERE scope = 'pricing' AND key = 'openai'").value);
    if (rates) current[model] = rates;
    adapter.run("UPDATE kv SET value = ? WHERE scope = 'pricing' AND key = 'openai'", [JSON.stringify(current)]);
    await usage.saveRequestUsage(entry({ ...route(), costKnown: !known }, { model, cost: 123 }));
    expect(meta(rows()[0]).routing.costKnown).toBe(known);
    if (suffix === "free" || suffix === "missing") expect(rows()[0].cost).toBe(0);
    if (suffix === "paid") expect(rows()[0].cost).toBeCloseTo(0.0012, 12);
    if (suffix === "sparse") expect(rows()[0].cost).toBeCloseTo(0.001, 12);
  });
  it("dedupes by attempt ID across completion times but never collapses concurrent logical requests with identical usage", async () => {
    const key = await keys.createApiKey("fixture", "machine");
    const a = route("friendly", key.id), b = route("friendly", key.id);
    await Promise.all([usage.saveRequestUsage(entry(a, { apiKey: key.key })), usage.saveRequestUsage(entry(b, { apiKey: key.key }))]);
    expect(rows()).toHaveLength(2);
    await usage.saveRequestUsage(entry(a, { apiKey: key.key, timestamp: "2026-01-02T03:05:05.000Z", endpoint: "/v1/chat/completions" }));
    expect(rows()).toHaveLength(2);
    expect(rows()[0].endpoint).toBe("/v1/chat/completions");
    expect((await keys.getApiKeyById(key.id)).usedTokens).toBe(2200);
    expect((await keys.getApiKeyById(key.id)).usedCost).toBeCloseTo(0.0024, 12);
    const day = JSON.parse(adapter.get("SELECT data FROM usageDaily").data);
    expect(day).toMatchObject({ requests: 2, promptTokens: 2000, completionTokens: 200 });
    expect(day.cost).toBeCloseTo(0.0024, 12);
    expect(adapter.get("SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'").value).toBe("2");
  });
  it("persists only the allowlisted routing envelope and resolves a stable key ID without copying a credential", async () => {
    const key = await keys.createApiKey("fixture", "machine");
    const attribution = route();
    await usage.saveRequestUsage(entry({ ...attribution, apiKey: "injected-secret", headers: { authorization: "injected-secret" } }, {
      apiKey: key.key, meta: { routing: { requestId: "forged" }, prompt: "never store this" },
    }));
    expect(rows()).toHaveLength(1);
    expect(meta(rows()[0]).routing).toMatchObject({ ...attribution, keyId: key.id });
    expect(Object.keys(meta(rows()[0]))).toEqual(["routing"]);
    expect(rows()[0].meta).not.toContain(key.key);
    expect(rows()[0].meta).not.toContain("injected-secret");
    expect(rows()[0].meta).not.toContain("never store this");
    expect(rows()[0]).toMatchObject({ provider: "openai", model: "routing-fixture", promptTokens: 1000, completionTokens: 100 });
    expect(rows()[0].cost).toBeCloseTo(0.0012, 12);
    expect((await keys.getApiKeyById(key.id)).usedTokens).toBe(1100);
    expect((await keys.getApiKeyById(key.id)).usedCost).toBeCloseTo(0.0012, 12);
  });
});
