import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({ execute: vi.fn(), saves: [], combos: [], aliases: {} }));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ comboStrategy: "fallback" }), getModelAliases: async () => fx.aliases,
  getComboByName: async name => fx.combos.find(c => c.name === name) || null,
  getCombos: async () => fx.combos, getProviderNodes: async () => [], getProviderConnections: async () => [],
  getProviderConnectionById: async () => null, getCustomModels: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: async entry => {
    // Exercise the real writer, not a fabricated persistence response.
    const saving = import("@/lib/db/repos/usageRepo.js").then(repo => repo.saveRequestUsage(entry));
    fx.saves.push(saving); await saving;
  },
}));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: async (_p, excluded) => excluded.size >= 2 ? null : ({ connectionId: `account-${excluded.size + 1}`, connectionName: "fixture" }),
  markAccountUnavailable: async () => ({ shouldFallback: true }), clearAccountError: vi.fn(),
  extractApiKey: request => request.headers.get("Authorization")?.slice(7) || null,
  isValidApiKey: async () => true, checkApiKeyQuota: async () => null,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: async (_p, c) => c, updateProviderCredentials: vi.fn(async () => {}) }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({ noAuth: true, execute: fx.execute }) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({ createRequestLogger: async () => ({
  logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
  logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
}) }));

const originalDataDir = process.env.DATA_DIR;
let tempDir, adapter, handleChat, key;
const usage = { prompt_tokens: 12, completion_tokens: 4 };
const response = content => Response.json({ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: content ? "stop" : "incomplete" }], usage });
const sse = content => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
const request = (model, stream = false) => new Request("http://localhost/v1/chat/completions", {
  method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${key.key}` },
  body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "hi" }], metadata: { routing: { requestId: "spoof", costKnown: true } } }),
});
const rows = () => adapter.all("SELECT provider, model, connectionId, promptTokens, completionTokens, meta FROM usageHistory ORDER BY id");

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-routing-joint-"));
  process.env.DATA_DIR = tempDir; delete global._dbAdapter; vi.resetModules();
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  key = await (await import("@/lib/db/repos/apiKeysRepo.js")).createApiKey("joint-fixture", "machine");
  ({ handleChat } = await import("../../src/sse/handlers/chat.js"));
});
beforeEach(() => {
  vi.clearAllMocks(); fx.saves = []; fx.combos = []; fx.aliases = {};
  adapter.run("DELETE FROM usageHistory"); adapter.run("DELETE FROM usageDaily");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network inference permitted"); }));
});
afterAll(() => {
  adapter?.close?.(); delete global._dbAdapter; vi.unstubAllGlobals();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = originalDataDir;
});

describe("joint ingress → real chatCore → usage writer (fixture executors only)", () => {
  it("persists token-bearing nested fallback attempts, but omits an account's preflight failure", async () => {
    const provider = "openai-compatible-joint-fixture";
    fx.combos = [{ name: "Outer", models: ["Inner", `${provider}/winner`] }, { name: "Inner", models: [`${provider}/empty`] }];
    fx.execute.mockImplementation(async ({ model, credentials }) => ({
      response: model === "empty" && credentials.connectionId === "account-1"
        ? Response.json({ error: { message: "fixture preflight" } }, { status: 400 })
        : response(model === "empty" ? "" : "ok"),
      url: "https://fixture.invalid", headers: {}, transformedBody: null,
    }));
    const res = await handleChat(request("Outer"));
    expect(res.status).toBe(200); await res.text(); await Promise.all(fx.saves);
    expect(fx.execute).toHaveBeenCalledTimes(3);
    expect(rows()).toHaveLength(2);
    expect(rows().map(row => [row.provider, row.model, row.connectionId])).toEqual([
      [provider, "empty", "account-2"], [provider, "winner", "account-1"],
    ]);
    const routes = rows().map(row => JSON.parse(row.meta).routing);
    expect(new Set(routes.map(r => r.requestId)).size).toBe(1);
    expect(new Set(routes.map(r => r.attemptId)).size).toBe(2);
    expect(routes.map(r => r.comboPath)).toEqual([["Outer", "Inner"], ["Outer"]]);
    for (const r of routes) expect(r).toMatchObject({ requestedModel: "Outer", keyId: key.id, routeKind: "combo", costKnown: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("persists independent parallel streaming alias requests after draining real callbacks", async () => {
    fx.aliases = { friendly: "openai/routing-joint-fixture" };
    fx.execute.mockImplementation(async () => ({ response: sse("ok"), url: "https://fixture.invalid", headers: {}, transformedBody: null }));
    const responses = await Promise.all([handleChat(request("friendly", true)), handleChat(request("friendly", true))]);
    await Promise.all(responses.map(res => res.text())); await Promise.all(fx.saves);
    expect(rows()).toHaveLength(2);
    const routes = rows().map(row => JSON.parse(row.meta).routing);
    expect(new Set(routes.map(r => r.requestId)).size).toBe(2);
    expect(new Set(routes.map(r => r.attemptId)).size).toBe(2);
    for (const r of routes) expect(r).toMatchObject({ requestedModel: "friendly", keyId: key.id, routeKind: "direct", comboPath: [] });
    expect(fetch).not.toHaveBeenCalled();
  });
});
