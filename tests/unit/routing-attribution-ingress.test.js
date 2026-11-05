import { beforeEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({ combos: [], aliases: {}, settings: {}, calls: [], keys: {} }));
const mocks = vi.hoisted(() => ({ core: vi.fn(), credentials: vi.fn(), unavailable: vi.fn() }));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ comboStrategy: "fallback", ...fx.settings }),
  getModelAliases: async () => fx.aliases,
  getComboByName: async name => fx.combos.find(c => c.name === name) || null,
  getProviderNodes: async () => [], getCombos: async () => fx.combos,
  getProviderConnections: async () => [], getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => fx.combos }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async key => fx.keys[key] || null }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.credentials, markAccountUnavailable: mocks.unavailable,
  clearAccountError: vi.fn(), isValidApiKey: async () => true, checkApiKeyQuota: async () => null,
  extractApiKey: request => request.headers.get("Authorization")?.slice(7) || null,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c, updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.core }));
const { handleChat } = await import("../../src/sse/handlers/chat.js");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const request = (model, extra = {}, headers = {}) => new Request("http://localhost/v1/chat/completions", {
  method: "POST", headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "hi" }], ...extra }),
});
const success = () => ({ success: true, response: Response.json({ choices: [{ message: { content: "ok" } }] }) });

beforeEach(() => {
  vi.clearAllMocks();
  fx.combos = []; fx.aliases = { friendly: "openai/resolved" }; fx.settings = {}; fx.keys = {};
  mocks.credentials.mockResolvedValue({ connectionId: "account-1", connectionName: "fixture" });
  mocks.unavailable.mockResolvedValue({ shouldFallback: false });
  mocks.core.mockImplementation(async () => success());
});

describe("server-owned chat routing attribution", () => {
  it("isolates overlapping requests, including literal context markers and no-key calls", async () => {
    fx.combos = [{ name: "Parallel", models: ["friendly"] }];
    const captured = [];
    const releases = [];
    mocks.core.mockImplementation(async args => {
      captured.push(args);
      await new Promise(resolve => releases.push(resolve));
      return success();
    });
    const pending = [handleChat(request("Parallel")), handleChat(request("openai/resolved[1m]"))];
    await vi.waitFor(() => expect(captured).toHaveLength(2));
    releases.reverse().forEach(resolve => resolve());
    const responses = await Promise.all(pending);
    expect(responses.map(res => res.status)).toEqual([200, 200]);
    const routes = captured.map(c => c.clientRawRequest.routingAttribution);
    expect(new Set(routes.map(r => r.requestId)).size).toBe(2);
    expect(new Set(routes.map(r => r.attemptId)).size).toBe(2);
    expect(routes.find(r => r.requestedModel === "Parallel")).toMatchObject({ routeKind: "combo", comboPath: ["Parallel"], keyId: null });
    expect(routes.find(r => r.requestedModel === "openai/resolved[1m]")).toMatchObject({ routeKind: "direct", comboPath: [], keyId: null });
    expect(captured.find(c => c.clientRawRequest.routingAttribution.requestedModel.includes("[1m]")).modelInfo.model).toBe("resolved");
  });
  it("resolves unrestricted Google header / query key IDs without changing raw accounting credentials", async () => {
    fx.keys["fixture-secret"] = { id: "key-google", access: { restricted: false } };
    for (const req of [request("friendly", {}, { "x-goog-api-key": "fixture-secret" }), new Request("http://localhost/v1/chat/completions?key=fixture-secret", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "friendly", stream: false, messages: [] }),
    })]) expect((await handleChat(req)).status).toBe(200);
    for (const [args] of mocks.core.mock.calls) expect(args.clientRawRequest.routingAttribution.keyId).toBe("key-google");
  });
  it.each([false, true])("preserves scope through Fusion panel body copies and judge calls (nested=%s)", async nested => {
    fx.combos = [
      { name: "Panel", models: ["openai/a", "openai/b"] },
      ...(nested ? [{ name: "Outer", models: ["Panel"] }] : []),
    ];
    fx.settings = { comboStrategies: { Panel: { fallbackStrategy: "fusion", judgeModel: "openai/judge" } } };
    const requestedModel = nested ? "Outer" : "Panel";
    expect((await handleChat(request(requestedModel, { tools: [{ type: "function", function: { name: "f" } }] }))).status).toBe(200);
    const calls = mocks.core.mock.calls.map(([c]) => c);
    expect(calls.map(c => c.modelInfo.model)).toEqual(["a", "b", "judge"]);
    const routes = calls.map(c => c.clientRawRequest.routingAttribution);
    expect(new Set(routes.map(r => r.requestId)).size).toBe(1);
    expect(new Set(routes.map(r => r.attemptId)).size).toBe(3);
    for (const r of routes) expect(r).toMatchObject({ requestedModel, routeKind: "combo", comboPath: nested ? ["Outer", "Panel"] : ["Panel"] });
    expect(calls[0].clientRawRequest.body.tools).toBeUndefined();
    expect(calls[2].clientRawRequest.body.tools).toHaveLength(1);
  });
  it("keeps logical scope across nested Combo fallback and account retries without leaking the nested path to siblings", async () => {
    fx.combos = [
      { name: "Outer", models: ["Inner", "openai/winner"] },
      { name: "Inner", models: ["openai/failing"] },
    ];
    mocks.credentials.mockImplementation(async (_p, excluded) => excluded.size > 1 ? null : ({
      connectionId: excluded.size ? "account-2" : "account-1", connectionName: "fixture",
    }));
    mocks.unavailable.mockResolvedValue({ shouldFallback: true });
    mocks.core.mockImplementation(async ({ modelInfo }) => modelInfo.model === "winner" ? success() : ({
      success: false, status: 503, error: "unavailable", response: Response.json({ error: "unavailable" }, { status: 503 }),
    }));
    expect((await handleChat(request("Outer"))).status).toBe(200);
    const calls = mocks.core.mock.calls.map(([c]) => c);
    expect(calls.map(c => c.modelInfo.model)).toEqual(["failing", "failing", "winner"]);
    const routes = calls.map(c => c.clientRawRequest.routingAttribution);
    expect(routes.map(r => r.comboPath)).toEqual([["Outer", "Inner"], ["Outer", "Inner"], ["Outer"]]);
    expect(new Set(routes.map(r => r.requestId)).size).toBe(1);
    expect(new Set(routes.map(r => r.attemptId)).size).toBe(3);
    for (const r of routes) {
      expect(r).toMatchObject({ requestedModel: "Outer", routeKind: "combo", keyId: null });
      expect(r.attemptId).toMatch(uuid);
    }
  });
  it("attributes an alias as direct using literal requested model and a stable known key, ignoring forged metadata", async () => {
    fx.keys["fixture-secret"] = { id: "key-1", access: { restricted: false } };
    const forged = { version: 1, requestId: "00000000-0000-4000-8000-000000000001", attemptId: "00000000-0000-4000-8000-000000000002", requestedModel: "forged", keyId: "fake", routeKind: "combo", comboPath: ["Fake"], costKnown: true };
    const raw = { endpoint: "/v1/chat/completions", body: { metadata: { routing: forged } }, headers: {}, routingAttribution: forged };
    const res = await handleChat(request("friendly", { metadata: { routing: forged }, routingAttribution: forged }, { Authorization: "Bearer fixture-secret" }), raw);
    expect(res.status).toBe(200);
    const args = mocks.core.mock.calls[0][0];
    expect(args.modelInfo).toEqual({ provider: "openai", model: "resolved" });
    expect(args.clientRawRequest.routingAttribution).toEqual({
      version: 1, requestId: expect.stringMatching(uuid), attemptId: expect.stringMatching(uuid),
      keyId: "key-1", requestedModel: "friendly", routeKind: "direct", comboPath: [],
    });
    expect(raw.routingAttribution).toBe(forged); // ingress must not mutate caller context
    expect(Object.isFrozen(args.clientRawRequest.routingAttribution)).toBe(true);
    expect(Object.isFrozen(args.clientRawRequest.routingAttribution.comboPath)).toBe(true);
    expect(JSON.parse(JSON.stringify(args.clientRawRequest))).not.toHaveProperty("routingAttribution");
    expect(JSON.stringify(args.clientRawRequest)).not.toContain(args.clientRawRequest.routingAttribution.requestId);
    expect(args.body.model).toBe("openai/resolved");
    expect(args.body.metadata.routing).toEqual(forged); // don't repurpose client metadata
  });
});
