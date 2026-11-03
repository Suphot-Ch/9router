// Scheduler behaviour: write only on a real change, never fight a parked
// schedule, survive failures, and never overlap ticks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

import {
  applyConnectionSchedules,
  runConnectionScheduleTick,
  startConnectionSchedules,
  stopConnectionSchedules,
} from "@/shared/services/connectionSchedules.js";

const BKK = "Asia/Bangkok";

const schedule = (overrides = {}) => ({
  enabled: true,
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "18:00",
  timezone: BKK,
  ...overrides,
});

const connection = (overrides = {}) => ({
  id: "conn-1",
  provider: "claude",
  authType: "oauth",
  isActive: true,
  schedule: schedule(),
  ...overrides,
});

let deps;
let state;
let warn;

const mondayNoonBkk = new Date("2026-06-01T05:00:00.000Z").getTime(); // active
const saturdayNoonBkk = new Date("2026-06-06T05:00:00.000Z").getTime(); // closed

beforeEach(() => {
  deps = {
    getProviderConnections: vi.fn().mockResolvedValue([]),
    updateProviderConnection: vi.fn().mockResolvedValue({}),
  };
  state = { interval: null, running: false, failures: new Map() };
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("connection schedule service", () => {
  it("does nothing when no connection has an enabled schedule", async () => {
    deps.getProviderConnections.mockResolvedValue([
      connection({ schedule: null }),
      connection({ id: "conn-2", schedule: { ...schedule(), enabled: false } }),
      connection({ id: "conn-3", schedule: undefined }),
    ]);

    const report = await applyConnectionSchedules(deps, mondayNoonBkk, state);

    expect(report).toEqual({ checked: 3, targets: 0, applied: 0 });
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("enables an account when its window is open", async () => {
    deps.getProviderConnections.mockResolvedValue([connection({ isActive: false })]);

    const report = await applyConnectionSchedules(deps, mondayNoonBkk, state);

    expect(report.applied).toBe(1);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("conn-1", {
      isActive: true,
      schedule: expect.objectContaining({
        enabled: true,
        start: "09:00",
        end: "18:00",
        lastAppliedState: "active",
        lastAppliedAt: "2026-06-01T05:00:00.000Z",
      }),
    });
  });

  it("disables an account when its window is closed", async () => {
    deps.getProviderConnections.mockResolvedValue([connection({ isActive: true })]);

    await applyConnectionSchedules(deps, saturdayNoonBkk, state);

    expect(deps.updateProviderConnection).toHaveBeenCalledWith("conn-1", expect.objectContaining({
      isActive: false,
      schedule: expect.objectContaining({ lastAppliedState: "disabled" }),
    }));
  });

  it("does not write when the stored state already matches the window", async () => {
    deps.getProviderConnections.mockResolvedValue([connection({ isActive: true })]);

    const report = await applyConnectionSchedules(deps, mondayNoonBkk, state);

    expect(report.applied).toBe(0);
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("never touches an account whose schedule is switched off", async () => {
    deps.getProviderConnections.mockResolvedValue([
      connection({ isActive: false, schedule: { ...schedule(), enabled: false } }),
      connection({ id: "conn-2", isActive: true, schedule: { ...schedule(), enabled: false } }),
    ]);

    const report = await applyConnectionSchedules(deps, mondayNoonBkk, state);

    expect(report.targets).toBe(0);
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("keeps an overnight window open after midnight", async () => {
    // Friday 23:30 in Bangkok, window Fri 22:00 → Sat 06:00.
    deps.getProviderConnections.mockResolvedValue([
      connection({ isActive: false, schedule: schedule({ days: [5], start: "22:00", end: "06:00" }) }),
    ]);

    await applyConnectionSchedules(deps, new Date("2026-06-05T16:30:00.000Z").getTime(), state);

    expect(deps.updateProviderConnection).toHaveBeenCalledWith("conn-1", expect.objectContaining({ isActive: true }));
  });

  it("keeps applying other accounts when one write fails, logging once", async () => {
    deps.getProviderConnections.mockResolvedValue([
      connection({ id: "broken", isActive: false }),
      connection({ id: "healthy", isActive: false }),
    ]);
    deps.updateProviderConnection.mockImplementation(async (id) => {
      if (id === "broken") throw new Error("db is locked");
      return {};
    });

    await applyConnectionSchedules(deps, mondayNoonBkk, state);
    await applyConnectionSchedules(deps, mondayNoonBkk, state);

    expect(deps.updateProviderConnection).toHaveBeenCalledWith("healthy", expect.objectContaining({ isActive: true }));
    expect(warn.mock.calls.filter(([line]) => String(line).includes("db is locked"))).toHaveLength(1);
  });

  it("skips a tick while the previous one is still running", async () => {
    state.running = true;

    const report = await runConnectionScheduleTick(deps, mondayNoonBkk, state);

    expect(report).toEqual({ skipped: true, reason: "running" });
    expect(deps.getProviderConnections).not.toHaveBeenCalled();
    expect(state.running).toBe(true);
  });

  it("never throws out of a tick when the read fails", async () => {
    deps.getProviderConnections.mockRejectedValue(new Error("database is gone"));

    const report = await runConnectionScheduleTick(deps, mondayNoonBkk, state);

    expect(report).toEqual({ skipped: true, reason: "error" });
    expect(state.running).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);

    // Same failure again → still only one warning.
    await runConnectionScheduleTick(deps, mondayNoonBkk, state);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("stops polling once the last schedule is gone", async () => {
    vi.useFakeTimers();
    state.interval = setInterval(() => {}, 60000);
    expect(vi.getTimerCount()).toBe(1);

    deps.getProviderConnections.mockResolvedValue([connection({ isActive: true, schedule: null })]);
    await runConnectionScheduleTick(deps, mondayNoonBkk, state);

    expect(state.interval).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts at most one interval and stops idempotently", async () => {
    vi.useFakeTimers();
    deps.getProviderConnections.mockResolvedValue([connection({ isActive: true })]);

    startConnectionSchedules({ deps, state });
    startConnectionSchedules({ deps, state });
    await Promise.resolve();

    expect(vi.getTimerCount()).toBe(1);

    stopConnectionSchedules(state);
    stopConnectionSchedules(state);

    expect(state.interval).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
