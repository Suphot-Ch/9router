// Per-API-key spending limits: wired into every /v1 handler.
// An exhausted key must be rejected with the documented 429 JSON before any
// provider/credential work (there are no provider connections in this DB, so a
// handler that got past the gate could not answer 429).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let repo;
let adapter;
let key;
let handlers;

const jsonRequest = (urlPath, body) => new Request(`http://localhost${urlPath}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
  body: JSON.stringify(body),
});

async function expectQuotaDenied(response) {
  expect(response.status).toBe(429);
  const body = await response.json();
  expect(body).toEqual({
    error: {
      message: expect.stringMatching(/token limit exceeded/i),
      type: "rate_limit_error",
      code: "key_token_limit",
    },
  });
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-limits-handlers-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  repo = await import("@/lib/db/repos/apiKeysRepo.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  handlers = {
    chat: (await import("@/sse/handlers/chat.js")).handleChat,
    embeddings: (await import("@/sse/handlers/embeddings.js")).handleEmbeddings,
    image: (await import("@/sse/handlers/imageGeneration.js")).handleImageGeneration,
    stt: (await import("@/sse/handlers/stt.js")).handleStt,
    tts: (await import("@/sse/handlers/tts.js")).handleTts,
  };
});

beforeEach(async () => {
  adapter.run("DELETE FROM apiKeys");
  key = await repo.createApiKey("exhausted", "machine-1", { tokenLimit: 10 });
  await repo.addApiKeyUsage(key.key, { tokens: 10 });
});

afterAll(() => {
  adapter?.close?.();
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("all five handlers enforce the key quota", () => {
  it("chat", async () => {
    const res = await handlers.chat(jsonRequest("/v1/chat/completions", {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    }));
    await expectQuotaDenied(res);
  });

  it("embeddings", async () => {
    const res = await handlers.embeddings(jsonRequest("/v1/embeddings", {
      model: "openai/text-embedding-3-small",
      input: "hi",
    }));
    await expectQuotaDenied(res);
  });

  it("image generation", async () => {
    const res = await handlers.image(jsonRequest("/v1/images/generations", {
      model: "openai/dall-e-3",
      prompt: "a cat",
    }));
    await expectQuotaDenied(res);
  });

  it("tts", async () => {
    const res = await handlers.tts(jsonRequest("/v1/audio/speech", {
      model: "openai/tts-1",
      input: "hi",
    }));
    await expectQuotaDenied(res);
  });

  it("stt", async () => {
    const formData = new FormData();
    formData.append("model", "openai/whisper-1");
    formData.append("file", new Blob(["audio"], { type: "audio/wav" }), "a.wav");
    const res = await handlers.stt(new Request("http://localhost/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key.key}` },
      body: formData,
    }));
    await expectQuotaDenied(res);
  });
});

describe("a key under its limit is not blocked by the gate", () => {
  it("chat proceeds past the quota check", async () => {
    const open = await repo.createApiKey("open", "machine-1", { tokenLimit: 10 });
    const res = await handlers.chat(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${open.key}` },
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    }));
    // No provider connections exist in this DB, so it fails later — but never
    // with the key quota 429.
    expect(res.status).not.toBe(429);
    const body = await res.json().catch(() => ({}));
    expect(body?.error?.code).not.toBe("key_token_limit");
  });
});
