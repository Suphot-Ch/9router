// Real auth, access, controller, SQLite and handlers; only the upstream core
// and provider credentials are replaced so these tests cannot send traffic.
import fs from "node:fs";
import path from "node:path";
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
const upstream = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: upstream.chat }));
vi.mock("open-sse/handlers/embeddingsCore.js", () => ({ handleEmbeddingsCore: () => { throw new Error("Unexpected upstream"); } }));
vi.mock("open-sse/handlers/imageGenerationCore.js", () => ({ handleImageGenerationCore: () => { throw new Error("Unexpected upstream"); } }));
vi.mock("open-sse/handlers/sttCore.js", () => ({ handleSttCore: () => { throw new Error("Unexpected upstream"); } }));
vi.mock("open-sse/handlers/ttsCore.js", () => ({ handleTtsCore: () => { throw new Error("Unexpected upstream"); } }));
vi.mock("@/sse/services/auth.js", async importOriginal => ({
  ...await importOriginal(),
  getProviderCredentials: async () => ({ connectionId: "test-only", connectionName: "isolated" }),
  clearAccountError: async () => {},
  markAccountUnavailable: async () => ({ shouldFallback: false }),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: async (_p, c) => c, updateProviderCredentials: async () => {} }));
let dir, repo, adapter, handlers, rates, auth, key;
const original = process.env.DATA_DIR;
const originalMode = process.env.KEY_RATE_LIMIT_MODE;
const req = (body, headers = {}, query = "") => new Request(`http://localhost/v1/chat/completions${query}`, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
});
const body = { model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] };
beforeAll(async () => {
  const base = "/home/user/.hermes/cache/scratch/9router-governance-dev-data";
  fs.mkdirSync(base, { recursive: true });
  dir = fs.mkdtempSync(path.join(base, "rate-handlers-")); process.env.DATA_DIR = dir;
  process.env.KEY_RATE_LIMIT_MODE = "single-process";
  delete global._dbAdapter;
  repo = await import("@/lib/db/repos/apiKeysRepo.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  await (await import("@/lib/db/repos/settingsRepo.js")).updateSettings({ requireApiKey: false });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network allowed in admission tests"); }));
  rates = await import("@/sse/services/keyRateLimits.js");
  auth = await import("@/sse/services/auth.js");
  handlers = {
    chat: (await import("@/sse/handlers/chat.js")).handleChat,
    embeddings: (await import("@/sse/handlers/embeddings.js")).handleEmbeddings,
    image: (await import("@/sse/handlers/imageGeneration.js")).handleImageGeneration,
    stt: (await import("@/sse/handlers/stt.js")).handleStt,
    tts: (await import("@/sse/handlers/tts.js")).handleTts,
    search: (await import("@/sse/handlers/search.js")).handleSearch,
    fetch: (await import("@/sse/handlers/fetch.js")).handleFetch,
    systemone: (await import("@/sse/handlers/systemone.js")).handleSystemone,
    video: request => import("@/sse/handlers/videoGeneration.js").then(m => m.handleVideoCreate(request, "generations")),
  };
});
beforeEach(async () => {
  key = await repo.createApiKey("rate-test", "test-machine", { rpmLimit: 1, tpmLimit: 10 });
  upstream.chat.mockReset();
  upstream.chat.mockResolvedValue({ success: true, response: new Response('data: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } }) });
});
afterAll(() => {
  vi.unstubAllGlobals();
  adapter?.close?.(); delete global._dbAdapter;
  fs.rmSync(dir, { recursive: true, force: true });
  if (original === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = original;
  if (originalMode === undefined) delete process.env.KEY_RATE_LIMIT_MODE; else process.env.KEY_RATE_LIMIT_MODE = originalMode;
});
describe("real inference admission", () => {
  it("blocks second logical request with Retry-After across alternate key transports", async () => {
    const first = await handlers.chat(req(body, { "x-goog-api-key": key.key }));
    expect(first.status).toBe(200); await first.text();
    const second = await handlers.chat(req(body, {}, `?key=${encodeURIComponent(key.key)}`));
    expect(second.status).toBe(429); expect(second.headers.get("retry-after")).toBeTruthy();
    expect((await second.json()).error.code).toBe("key_rpm_limit");
    expect(upstream.chat).toHaveBeenCalledTimes(1);
  });
  it("does not consume RPM for denied access or invalid body", async () => {
    await repo.updateApiKey(key.id, { access: { restricted: true, allow: [] } });
    expect((await handlers.chat(req(body, { Authorization: `Bearer ${key.key}` }))).status).toBe(403);
    expect((await handlers.chat(req({}, { Authorization: `Bearer ${key.key}` }))).status).toBe(400);
    expect(rates.getKeyRateStatus(key.id, key).rpm.used).toBe(0);
  });
  it("rejects an inactive known key in local mode but preserves unknown-key behavior", async () => {
    await repo.updateApiKey(key.id, { isActive: false });
    expect([401, 403]).toContain((await handlers.chat(req(body, { Authorization: `Bearer ${key.key}` }))).status);
    const unknown = await handlers.chat(req(body, { Authorization: "Bearer unregistered-local-key" }));
    expect(unknown.status).toBe(200); await unknown.text();
  });
  it("rejects finite-cap inference without an explicit single-process deployment assertion", async () => {
    delete process.env.KEY_RATE_LIMIT_MODE;
    try {
      const response = await handlers.chat(req(body, { Authorization: `Bearer ${key.key}` }));
      expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe("key_rate_configuration");
      expect(upstream.chat).not.toHaveBeenCalled();
    } finally { process.env.KEY_RATE_LIMIT_MODE = "single-process"; }
  });
  it("lets an admitted stream complete after actual TPM reaches the cap and blocks new work", async () => {
    await repo.updateApiKey(key.id, { rpmLimit: 0 });
    let stream;
    upstream.chat.mockImplementation(async () => ({ success: true, response: new Response(new ReadableStream({ start(c) { stream = c; } })) }));
    const first = await handlers.chat(req(body, { Authorization: `Bearer ${key.key}` }));
    expect(rates.getKeyRateStatus(key.id, key).inFlight).toBe(1);
    rates.recordKeyTokenUsage(key.id, { prompt_tokens: 6, completion_tokens: 4 }, "actual-stream");
    expect((await handlers.chat(req(body, { Authorization: `Bearer ${key.key}` }))).status).toBe(429);
    stream.enqueue(new TextEncoder().encode("still finishes")); stream.close();
    expect(await first.text()).toBe("still finishes");
    expect(rates.getKeyRateStatus(key.id, key).inFlight).toBe(0);
  });
  it("shares admission across all existing quota endpoints, exempting media only from TPM", async () => {
    rates.admitKeyRateLimit(key).finish();
    const headers = { Authorization: `Bearer ${key.key}` };
    const cases = [
      [handlers.embeddings, { model: "openai/text-embedding-3-small", input: "hi" }],
      [handlers.image, { model: "openai/dall-e-3", prompt: "cat" }],
      [handlers.tts, { model: "openai/tts-1", input: "hi" }],
    ];
    for (const [handler, payload] of cases) {
      const res = await handler(req(payload, headers));
      expect(res.status).toBe(429); expect((await res.json()).error.code).toBe("key_rpm_limit");
    }
    const form = new FormData(); form.append("model", "openai/whisper-1"); form.append("file", new Blob(["audio"]), "a.wav");
    const stt = await handlers.stt(new Request("http://localhost/v1/audio/transcriptions", { method: "POST", headers, body: form }));
    expect(stt.status).toBe(429); expect((await stt.json()).error.code).toBe("key_rpm_limit");
  });
  it("gates search, fetch, decision and video creation with the same minute window", async () => {
    rates.admitKeyRateLimit(key).finish();
    for (const [handler, payload] of [
      [handlers.search, { provider: "tavily", query: "hi" }],
      [handlers.fetch, { provider: "tavily", url: "https://8.8.8.8/" }],
      [handlers.systemone, { model: "openai/gpt-4o", state: {}, questions: {} }],
      [handlers.video, { model: "xai/grok-imagine-video", prompt: "cat" }],
    ]) {
      const res = await handler(req(payload, { Authorization: `Bearer ${key.key}` }));
      expect(res.status).toBe(429);
      expect((await res.json()).error.code).toBe("key_rpm_limit");
    }
  });
  it("counts real combo fallback once, not once per attempt", async () => {
    await (await import("@/lib/db/repos/combosRepo.js")).createCombo({ name: `Combo-${key.id}`, models: ["openai/a", "openai/b"] });
    upstream.chat.mockImplementation(async ({ modelInfo }) => modelInfo.model === "a"
      ? { success: false, status: 500, error: "failed", response: new Response("failed", { status: 500 }) }
      : { success: true, response: new Response("ok") });
    const res = await handlers.chat(req({ ...body, model: `Combo-${key.id}` }, { Authorization: `Bearer ${key.key}` }));
    expect(res.status).toBe(200); await res.text();
    expect(upstream.chat).toHaveBeenCalledTimes(2);
    expect(rates.getKeyRateStatus(key.id, key).rpm.used).toBe(1);
  });
  it("gates Gemini-native audio, not just translated text", async () => {
    rates.admitKeyRateLimit(key).finish();
    const route = await import("@/app/api/v1beta/models/[...path]/route.js");
    const res = await route.POST(new Request("http://localhost/v1beta/models/gemini-2.5-flash-preview-tts:generateContent", {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key.key },
      body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }], generationConfig: { responseModalities: ["AUDIO"] } }),
    }), { params: Promise.resolve({ path: ["gemini-2.5-flash-preview-tts:generateContent"] }) });
    expect(res.status).toBe(429); expect((await res.json()).error.code).toBe("key_rpm_limit");
  });
  it("counts only committed canonical usage once and exposes missing usage", async () => {
    const usage = await import("@/lib/db/repos/usageRepo.js");
    const event = { requestId: `usage-${key.id}`, provider: "openai", model: "gpt-4o", apiKey: key.key, tokens: { prompt_tokens: 7, completion_tokens: 3, cached_tokens: 90 }, status: "success" };
    await usage.saveRequestUsage(event);
    await usage.saveRequestUsage(event);
    expect(rates.getKeyRateStatus(key.id, key).tpm.trackedTokens).toBe(10);
    const response = await handlers.chat(req(body, { Authorization: `Bearer ${key.key}` }));
    expect(response.status).toBe(429); expect((await response.json()).error.code).toBe("key_tpm_limit");
  });
  it("releases cancelled streams and marks missing terminal usage incomplete", async () => {
    upstream.chat.mockImplementation(async () => ({ success: true, response: new Response(new ReadableStream({ start() {} })) }));
    const response = await handlers.chat(req(body, { Authorization: `Bearer ${key.key}` }));
    await response.body.cancel("disconnect");
    expect(rates.getKeyRateStatus(key.id, key).inFlight).toBe(0);
    expect(rates.getKeyRateStatus(key.id, key).tpm.coverage).toBe("incomplete");
  });
  it("serializes concurrent admission and applies policy edits without resetting the minute", async () => {
    await repo.updateApiKey(key.id, { rpmLimit: 3 });
    upstream.chat.mockImplementation(async () => ({ success: true, response: new Response("ok") }));
    const responses = await Promise.all(Array.from({ length: 20 }, () => handlers.chat(req(body, { Authorization: `Bearer ${key.key}` }))));
    expect(responses.filter(r => r.status === 200)).toHaveLength(3);
    expect(responses.filter(r => r.status === 429)).toHaveLength(17);
    await Promise.all(responses.map(r => r.text()));
    await repo.updateApiKey(key.id, { rpmLimit: 1 });
    expect((await handlers.chat(req(body, { Authorization: `Bearer ${key.key}` }))).status).toBe(429);
    expect(rates.getKeyRateStatus(key.id, key).rpm.used).toBe(3);
  });
  it("preserves extractor precedence including an explicitly invalid higher-priority key", () => {
    expect(auth.extractApiKey(req(body, { Authorization: "Bearer invalid", "x-api-key": key.key, "x-goog-api-key": key.key }, `?key=${key.key}`))).toBe("invalid");
    expect(auth.extractApiKey(req(body, { "x-api-key": "first", "x-goog-api-key": "second" }, "?key=third"))).toBe("first");
    expect(auth.extractApiKey(req(body, { "x-goog-api-key": "second" }, "?key=third"))).toBe("second");
  });
});
