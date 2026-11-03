// Storage contract: the schedule lives in the connection's data JSON (no side
// table) and the scheduler's write round-trips through the real repo layer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
let originalDataDir;
let repo;
let service;

const schedule = {
  enabled: true,
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "18:00",
  timezone: "Asia/Bangkok",
};

// Monday 2026-06-01 12:00 in Bangkok — inside the window.
const insideWindow = new Date("2026-06-01T05:00:00.000Z").getTime();
// Saturday 2026-06-06 12:00 in Bangkok — outside it.
const outsideWindow = new Date("2026-06-06T05:00:00.000Z").getTime();

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-conn-schedule-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  repo = await import("@/lib/db/index.js");
  await repo.initDb();
  service = await import("@/shared/services/connectionSchedules.js");
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch { /* already closed */ }
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function createConnection(overrides = {}) {
  return repo.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "Work",
    email: "work@example.com",
    isActive: false,
    ...overrides,
  });
}

describe("connection schedule storage", () => {
  it("stores the schedule inside the connection data JSON", async () => {
    const conn = await createConnection();

    await repo.updateProviderConnection(conn.id, { schedule });

    const stored = await repo.getProviderConnectionById(conn.id);
    expect(stored.schedule).toEqual(schedule);
    expect(stored.name).toBe("Work");
  });

  it("round-trips an applied-state annotation without losing window fields", async () => {
    const conn = await createConnection();

    await repo.updateProviderConnection(conn.id, {
      schedule: { ...schedule, lastAppliedState: "active", lastAppliedAt: "2026-06-01T05:00:00.000Z" },
    });

    const stored = await repo.getProviderConnectionById(conn.id);
    expect(stored.schedule).toMatchObject(schedule);
    expect(stored.schedule.lastAppliedState).toBe("active");
    expect(stored.schedule.lastAppliedAt).toBe("2026-06-01T05:00:00.000Z");
  });

  it("applies the window through the service and records what it did", async () => {
    const conn = await createConnection();
    await repo.updateProviderConnection(conn.id, { schedule });

    const deps = {
      getProviderConnections: repo.getProviderConnections,
      updateProviderConnection: repo.updateProviderConnection,
    };
    const state = { interval: null, running: false, failures: new Map() };

    const report = await service.applyConnectionSchedules(deps, insideWindow, state);
    expect(report.applied).toBe(1);

    const activated = await repo.getProviderConnectionById(conn.id);
    expect(activated.isActive).toBe(true);
    expect(activated.schedule).toMatchObject({
      ...schedule,
      lastAppliedState: "active",
      lastAppliedAt: "2026-06-01T05:00:00.000Z",
    });

    // Second pass on the same instant is a no-op: the timestamp must survive.
    const again = await service.applyConnectionSchedules(deps, insideWindow, state);
    expect(again.applied).toBe(0);
    const untouched = await repo.getProviderConnectionById(conn.id);
    expect(untouched.schedule.lastAppliedAt).toBe("2026-06-01T05:00:00.000Z");

    await service.applyConnectionSchedules(deps, outsideWindow, state);
    const disabled = await repo.getProviderConnectionById(conn.id);
    expect(disabled.isActive).toBe(false);
    expect(disabled.schedule.lastAppliedState).toBe("disabled");
  });

  it("leaves isActive alone after the schedule is removed", async () => {
    const conn = await createConnection({ isActive: true });
    await repo.updateProviderConnection(conn.id, { schedule });

    await repo.updateProviderConnection(conn.id, { schedule: null });

    const stored = await repo.getProviderConnectionById(conn.id);
    expect(stored.schedule).toBeNull();
    expect(stored.isActive).toBe(true);
  });
});
