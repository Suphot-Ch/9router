// Per-API-key spending limits: a DB written before the new columns upgrades in
// place, and every existing key reads as unlimited (0/0, resetMode 'none').
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

function writeLegacyDb(dir) {
  fs.mkdirSync(path.join(dir, "db"), { recursive: true });
  const db = new DatabaseSync(path.join(dir, "db", "data.sqlite"));
  db.exec(`CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.exec(`INSERT INTO _meta(key, value) VALUES ('schemaVersion', '2'), ('backupSchemaVersion', '2')`);
  // apiKeys as it was before tokenLimit/costLimit/used*/reset*/updatedAt.
  db.exec(`CREATE TABLE apiKeys (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT, isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL, accessRestricted INTEGER DEFAULT 0, accessAllow TEXT)`);
  const ins = db.prepare(`INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, accessRestricted, accessAllow) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  ins.run("k1", "sk-legacy-one", "Legacy", "m", 1, "2026-09-01T00:00:00.000Z", 0, null);
  ins.run("k2", "sk-legacy-two", "Paused", "m", 0, "2026-09-02T00:00:00.000Z", 0, null);
  db.close();
}

async function boot() {
  delete global._dbAdapter;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  return { db, adapter: await getAdapter() };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-limits-migration-"));
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("apiKeys spending-limit columns: upgrade from the previous schema", () => {
  it("adds the columns and reads every existing key as unlimited", async () => {
    writeLegacyDb(tempDir);
    const { db, adapter } = await boot();

    const cols = adapter.all(`PRAGMA table_info(apiKeys)`).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      "tokenLimit", "costLimit", "usedTokens", "usedCost", "resetMode", "resetDay", "lastResetAt", "updatedAt",
    ]));

    const keys = await db.getApiKeys();
    expect(keys.map((k) => ({
      id: k.id,
      tokenLimit: k.tokenLimit,
      costLimit: k.costLimit,
      usedTokens: k.usedTokens,
      usedCost: k.usedCost,
      resetMode: k.resetMode,
      resetDay: k.resetDay,
      lastResetAt: k.lastResetAt,
    }))).toEqual([
      { id: "k1", tokenLimit: 0, costLimit: 0, usedTokens: 0, usedCost: 0, resetMode: "none", resetDay: null, lastResetAt: null },
      { id: "k2", tokenLimit: 0, costLimit: 0, usedTokens: 0, usedCost: 0, resetMode: "none", resetDay: null, lastResetAt: null },
    ]);
  });

  it("lets a legacy row gain limits through updateApiKey", async () => {
    writeLegacyDb(tempDir);
    const { db } = await boot();

    const updated = await db.updateApiKey("k1", { tokenLimit: 5000, costLimit: 1, resetMode: "monthly", resetDay: 10 });
    expect(updated).toMatchObject({ tokenLimit: 5000, costLimit: 1, resetMode: "monthly", resetDay: 10, usedTokens: 0, usedCost: 0 });
    expect((await db.getApiKeyById("k1")).resetDay).toBe(10);
  });
});
