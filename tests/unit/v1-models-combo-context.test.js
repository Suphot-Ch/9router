import { describe, expect, it, vi } from "vitest";
import { setCatalogSource } from "../../open-sse/providers/capabilities.js";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));

vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

const syncedLimits = { contextWindow: 180000, maxOutput: 16000 };

async function modelsWithCombo(providerId, modelId, combos) {
  db.getProviderConnections.mockResolvedValue([{
    id: 1,
    provider: providerId,
    isActive: true,
    providerSpecificData: { enabledModels: [modelId] },
  }]);
  db.getCombos.mockResolvedValue(combos);
  setCatalogSource({
    getModalities: () => null,
    getLimits: (provider, model) =>
      provider === providerId && model === modelId ? syncedLimits : null,
  });
  try {
    return await buildModelsList(["llm"]);
  } finally {
    setCatalogSource(null);
  }
}

describe("/v1/models combo limits", () => {
  it.each([64000, 1000000])("advertises explicit ctx %i in both fields without changing output limits", async (contextLength) => {
    const models = await modelsWithCombo('opencode-go', 'mimo-v2.5', [
      { name: 'override', models: ['ocg/mimo-v2.5'], contextLength },
    ]);
    expect(models.find(m => m.id === 'override')).toMatchObject({
      context_length: contextLength, max_completion_tokens: 16000,
      capabilities: { contextWindow: contextLength, maxOutput: 16000 },
    });
  });

  it.each([8000, 1000000])('advertises explicit max output %i consistently without changing ctx', async (maxOutputTokens) => {
    const models = await modelsWithCombo('opencode-go', 'mimo-v2.5', [
      { name: 'output-override', models: ['ocg/mimo-v2.5'], maxOutputTokens },
      { name: 'nested-output', models: ['output-override'] },
      { name: 'output-minimum', models: ['output-override', 'ocg/mimo-v2.5'] },
      { name: 'cycle-output', models: ['cycle-output'], contextLength: 500000, maxOutputTokens },
      { name: 'cycle-auto-output', models: ['cycle-auto-output'] },
    ]);
    for (const id of ['output-override', 'nested-output']) expect(models.find(m => m.id === id)).toMatchObject({
      context_length: 180000, max_completion_tokens: maxOutputTokens,
      capabilities: { contextWindow: 180000, maxOutput: maxOutputTokens },
    });
    const minimum = Math.min(maxOutputTokens, 16000);
    expect(models.find(m => m.id === 'output-minimum')).toMatchObject({ max_completion_tokens: minimum, capabilities: { maxOutput: minimum } });
    expect(models.find(m => m.id === 'cycle-output')).toMatchObject({ context_length: 500000, max_completion_tokens: maxOutputTokens, capabilities: { contextWindow: 500000, maxOutput: maxOutputTokens } });
    expect(models.find(m => m.id === 'cycle-auto-output').max_completion_tokens).toBeUndefined();
    expect(models.find(m => m.id === 'cycle-auto-output').capabilities?.maxOutput).toBeUndefined();
  });

  it.each([
    ["ocg", "opencode-go", "mimo-v2.5"],
    ["xmtp", "xiaomi-tokenplan", "mimo-v2.5"],
    ["ps", "poolside", "custom-model"],
    ["ds", "deepseek", "deepseek-chat"],
  ])("uses the real provider for a %s UI-alias seat", async (uiAlias, providerId, modelId) => {
    const combo = { name: "ui-alias-combo", models: [`${uiAlias}/${modelId}`] };
    const models = await modelsWithCombo(providerId, modelId, [combo]);
    const published = models.find((model) => model.id === combo.name);

    expect(published).toMatchObject({
      context_length: 180000,
      max_completion_tokens: 16000,
      capabilities: { contextWindow: 180000, maxOutput: 16000 },
    });
  });

  it('inherits nested overrides, applies Auto minimum, and keeps cycles bounded', async () => {
    const models = await modelsWithCombo('opencode-go', 'mimo-v2.5', [
      { name: 'inner', models: ['ocg/mimo-v2.5'], contextLength: 900000 },
      { name: 'outer', models: ['inner'] },
      { name: 'minimum', models: ['inner', 'ocg/mimo-v2.5'], contextLength: null },
      { name: 'cycle-a', models: ['cycle-b'] },
      { name: 'cycle-b', models: ['cycle-a', 'ocg/mimo-v2.5'], contextLength: 64000 },
      { name: 'cycle-only', models: ['cycle-only'], contextLength: 50000 },
      { name: 'cycle-auto', models: ['cycle-auto'] },
    ]);
    for (const [id, context] of [['inner',900000], ['outer',900000], ['minimum',180000], ['cycle-a',64000], ['cycle-b',64000], ['cycle-only',50000]]) {
      expect(models.find(m => m.id === id)).toMatchObject({ context_length: context, capabilities: { contextWindow: context } });
    }
    for (const id of ['inner','outer','minimum','cycle-a','cycle-b']) {
      expect(models.find(m => m.id === id).max_completion_tokens).toBe(16000);
    }
    expect(models.find(m => m.id === 'cycle-auto').context_length).toBeUndefined();
  });

  it.each([undefined, null, 0])('keeps Auto recursive minimum for %s', async (contextLength) => {
    const models = await modelsWithCombo('opencode-go', 'mimo-v2.5', [
      { name: 'auto', models: ['ocg/mimo-v2.5', 'cx/gpt-5'], contextLength },
    ]);
    expect(models.find(m => m.id === 'auto')).toMatchObject({ context_length: 180000, capabilities: { contextWindow: 180000 }, max_completion_tokens: 16000 });
  });

  it("carries provider-scoped limits through a nested combo", async () => {
    const models = await modelsWithCombo("opencode-go", "mimo-v2.5", [
      { name: "inner-combo", models: ["ocg/mimo-v2.5"] },
      { name: "outer-combo", models: ["inner-combo"] },
    ]);
    const outer = models.find((model) => model.id === "outer-combo");

    expect(outer).toMatchObject({
      context_length: 180000,
      max_completion_tokens: 16000,
      capabilities: { contextWindow: 180000, maxOutput: 16000 },
    });
  });

  it("publishes Devin CLI's 200k limit for a dv combo seat", async () => {
    const models = await modelsWithCombo("devin-cli", "gpt-5.5-high", [
      { name: "devin-combo", models: ["dv/gpt-5.5-high"] },
    ]);
    const combo = models.find((model) => model.id === "devin-combo");

    expect(combo).toMatchObject({
      context_length: 200000,
      capabilities: { contextWindow: 200000 },
    });
  });
});
