// Per-API-key spending limits — UI payloads against the live routes.
//
// The limits sheet builds its request bodies with buildLimitsPayload() /
// buildResetUsagePayload() / buildCreateKeyPayload(); this file feeds those exact
// bodies to PATCH/POST /api/keys so a drift between the two is caught here and
// not in the browser.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildLimitsPayload, buildResetUsagePayload, buildCreateKeyPayload } from "@/shared/utils/keyLimits.js";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let repo;
let adapter;
let keyRoute;
let keysRoute;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-ui-contract-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  repo = await import("@/lib/db/repos/apiKeysRepo.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  keyRoute = await import("../../src/app/api/keys/[id]/route.js");
  keysRoute = await import("../../src/app/api/keys/route.js");
});

afterAll(() => {
  adapter?.close?.();
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const patch = (id, body) => keyRoute.PATCH(
  new Request(`http://localhost/api/keys/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ id }) }
);

describe("UI payloads against the live routes", () => {
  it("creates with the optional-limits body", async () => {
    const res = await keysRoute.POST(new Request("http://localhost/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildCreateKeyPayload("created", { tokenLimit: "1000", costLimit: "2.5", resetMode: "monthly", resetDay: "5" })),
    }));
    expect(res.status).toBe(201);
    expect((await res.json())).toMatchObject({ tokenLimit: 1000, costLimit: 2.5, resetMode: "monthly", resetDay: 5 });
  });

  it("clears every limit with the blank-form body (0 / never)", async () => {
    const key = await repo.createApiKey("clear-me", "m1", { tokenLimit: 10, costLimit: 1, resetMode: "weekly", resetDay: 2 });
    const body = buildLimitsPayload({ tokenLimit: "", costLimit: "", resetMode: "none" });
    expect(body).toEqual({ tokenLimit: 0, costLimit: 0, resetMode: "none", resetDay: null });
    const res = await patch(key.id, body);
    expect(res.status).toBe(200);
    expect((await res.json()).key).toMatchObject({ tokenLimit: 0, costLimit: 0, resetMode: "none", resetDay: null });
  });

  it("saves limits with the form body", async () => {
    const key = await repo.createApiKey("save-me", "m1");
    const body = buildLimitsPayload({ tokenLimit: "250000", costLimit: "12.345", resetMode: "weekly", resetDay: "0" });
    expect(body).toEqual({ tokenLimit: 250000, costLimit: 12.35, resetMode: "weekly", resetDay: 0 });
    const res = await patch(key.id, body);
    expect(res.status).toBe(200);
    expect((await res.json()).key).toMatchObject({ tokenLimit: 250000, costLimit: 12.35, resetMode: "weekly", resetDay: 0 });
  });

  it("resets usage with the reset body", async () => {
    const key = await repo.createApiKey("reset-me", "m1", { tokenLimit: 100 });
    await repo.addApiKeyUsage(key.key, { tokens: 50, cost: 0.2 });
    const res = await patch(key.id, buildResetUsagePayload());
    expect(res.status).toBe(200);
    expect((await res.json()).key).toMatchObject({ usedTokens: 0, usedCost: 0 });
  });

  it("surfaces its 400 message for a rejected body", async () => {
    const key = await repo.createApiKey("bad-me", "m1");
    const res = await patch(key.id, buildLimitsPayload({ tokenLimit: "abc" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("tokenLimit");
  });
});
