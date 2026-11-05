import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoutingAttribution, withRoutingAttribution, withRoutingAttempt, withComboRouting } from "../../open-sse/utils/routingAttribution.js";

const fx = vi.hoisted(() => ({ execute: vi.fn(), save: vi.fn(async () => {}) }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({ noAuth: true, execute: fx.execute }) }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: fx.save,
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({ createRequestLogger: async () => ({
  logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
  logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
}) }));
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { buildOnStreamComplete } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
const { saveUsageStats } = await import("../../open-sse/handlers/chatCore/requestDetail.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");
const usage = { prompt_tokens: 12, completion_tokens: 4 };
const json = { id: "fixture", model: "upstream-reported-model", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage };
const chatSSE = `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`;
const responsesSSE = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: {
  id: "fixture", object: "response", model: "upstream-reported-model", status: "completed",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
  usage: { input_tokens: 12, output_tokens: 4 },
} })}\n\n`;
const raw = name => withRoutingAttempt(withComboRouting(withRoutingAttribution({
  endpoint: "/v1/chat/completions", headers: { authorization: "Bearer fixture-secret" }, body: { metadata: { routing: { requestedModel: "spoof" } } },
}, createRoutingAttribution(name, "key-id")), name));
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network is prohibited in attribution tests"); })); });
afterAll(() => vi.unstubAllGlobals());

describe("all four chat usage completion save paths", () => {
  it("does not invent usage attribution when a client disconnects before completion", async () => {
    const encoder = new TextEncoder();
    const cancelled = vi.fn();
    const upstream = new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n')); },
      cancel: cancelled,
    });
    fx.execute.mockResolvedValueOnce({ response: new Response(upstream, { headers: { "content-type": "text/event-stream" } }), url: "https://fixture.invalid", headers: {} });
    const result = await handleChatCore({ body: { model: "openai/routing-fixture", stream: true, messages: [] }, modelInfo: { provider: "openai", model: "routing-fixture" }, credentials: {}, clientRawRequest: raw("Disconnect"), log });
    const reader = result.response.body.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel("fixture disconnect");
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalled());
    expect(fx.save).not.toHaveBeenCalled();
  });
  it("keeps legacy/nonchat usage working without creating inferred routing metadata", () => {
    saveUsageStats({ provider: "openai", model: "routing-fixture", tokens: usage, silent: true });
    expect(fx.save.mock.calls[0][0]).not.toHaveProperty("routingAttribution");
  });
  it("keeps deferred stream callbacks scoped when parallel requests complete in reverse order", () => {
    const a = raw("A"), b = raw("B");
    const callback = clientRawRequest => buildOnStreamComplete({
      provider: "openai", model: "routing-fixture", connectionId: "account", requestStartTime: Date.now(),
      body: { messages: [] }, stream: true, clientRawRequest,
    }).onStreamComplete;
    const completeA = callback(a), completeB = callback(b);
    completeB({ content: "B" }, usage); completeA({ content: "A" }, usage);
    expect(fx.save.mock.calls.map(([saved]) => saved.routingAttribution)).toEqual([b.routingAttribution, a.routingAttribution]);
  });
  it("omits zero-token, missing-usage, and preflight/error completions rather than inventing failed-attempt telemetry", async () => {
    const clientRawRequest = raw("Combo");
    const complete = buildOnStreamComplete({ provider: "openai", model: "routing-fixture", requestStartTime: Date.now(), body: {}, stream: true, clientRawRequest }).onStreamComplete;
    complete({}, { prompt_tokens: 0, completion_tokens: 0 }); complete({}, null);
    fx.execute.mockResolvedValueOnce({ response: Response.json({ error: { message: "fixture error" } }, { status: 400 }), url: "https://fixture.invalid", headers: {} });
    const result = await handleChatCore({ body: { model: "openai/routing-fixture", stream: false, messages: [] }, modelInfo: { provider: "openai", model: "routing-fixture" }, credentials: {}, clientRawRequest, log });
    expect(result.success).toBe(false);
    expect(fx.save).not.toHaveBeenCalled();
  });
  it("canonicalizes cache tokens without copying untrusted extra attribution fields", () => {
    const attribution = raw("Cache").routingAttribution;
    saveUsageStats({ provider: "openai", model: "routing-fixture", tokens: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 },
      routingAttribution: { ...attribution, costKnown: true, headers: { authorization: "fixture-secret" }, body: { prompt: "private" } }, silent: true });
    expect(fx.save.mock.calls[0][0]).toMatchObject({ tokens: { prompt_tokens: 33, completion_tokens: 4, cached_tokens: 20, cache_creation_input_tokens: 3 }, routingAttribution: attribution });
    expect(Object.keys(fx.save.mock.calls[0][0].routingAttribution).sort()).toEqual(Object.keys(attribution).sort());
  });
  it.each([
    ["JSON", "openai-compatible-attribution-test", false, JSON.stringify(json), "application/json"],
    ["stream completion", "openai", true, chatSSE, "text/event-stream"],
    ["forced Chat SSE", "zed", false, chatSSE, "text/event-stream"],
    ["forced Responses SSE", "codex", false, responsesSSE, "text/event-stream"],
    ["unexpected SSE on nonstream path", "openai-compatible-attribution-test", false, chatSSE, "text/event-stream"],
  ])("%s retains explicit scope through real chatCore, never through payload metadata", async (_label, provider, stream, responseText, contentType) => {
    const clientRawRequest = raw("Original Combo");
    fx.execute.mockResolvedValueOnce({ response: new Response(responseText, { headers: { "content-type": contentType } }), url: "https://fixture.invalid", headers: {}, transformedBody: null });
    const result = await handleChatCore({
      body: { model: `${provider}/routing-fixture`, stream, max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
      modelInfo: { provider, model: "routing-fixture" }, credentials: {}, log,
      connectionId: "account", apiKey: "fixture-secret", sourceFormatOverride: FORMATS.OPENAI, clientRawRequest,
    });
    expect(result.success).toBe(true);
    await result.response.text(); // drains streaming completion callbacks
    await vi.waitFor(() => expect(fx.save).toHaveBeenCalledTimes(1));
    const saved = fx.save.mock.calls[0][0];
    expect(saved.routingAttribution).toEqual(clientRawRequest.routingAttribution);
    expect(saved).toMatchObject({ provider, model: "routing-fixture", tokens: usage, endpoint: "/v1/chat/completions" });
    expect(JSON.stringify(saved.routingAttribution)).not.toContain("fixture-secret");
    const sent = fx.execute.mock.calls[0][0];
    expect(JSON.stringify(sent.body)).not.toContain(clientRawRequest.routingAttribution.requestId);
    expect(JSON.stringify(sent.headers || {})).not.toContain(clientRawRequest.routingAttribution.requestId);
    expect(fetch).not.toHaveBeenCalled();
  });
});
