// HTTP contract for a connection's weekly window: 400 on anything ambiguous,
// 404 for an unknown id, and the same body shape from GET/PUT/DELETE.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/shared/services/connectionSchedules", () => ({
  startConnectionSchedules: vi.fn(),
}));

import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { startConnectionSchedules } from "@/shared/services/connectionSchedules";
import { GET, PUT, DELETE } from "@/app/api/providers/[id]/schedule/route.js";

const CONNECTION_ID = "conn-1";

const params = (id = CONNECTION_ID) => ({ params: Promise.resolve({ id }) });
const request = (body) => new Request(`http://localhost/api/providers/${CONNECTION_ID}/schedule`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const monday = {
  enabled: true,
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "18:00",
  timezone: "Asia/Bangkok",
};

const connection = (overrides = {}) => ({
  id: CONNECTION_ID,
  provider: "claude",
  authType: "oauth",
  name: "Work",
  isActive: true,
  schedule: monday,
  ...overrides,
});

describe("connection schedule API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Monday 2026-06-01 12:00 in Bangkok — inside the Mon-Fri 09:00-18:00 window.
    vi.setSystemTime(new Date("2026-06-01T05:00:00.000Z"));
    updateProviderConnection.mockImplementation(async (id, patch) => connection({ ...patch, id }));
  });

  it("GET returns the schedule with the live window state", async () => {
    getProviderConnectionById.mockResolvedValue(connection());

    const response = await GET(new Request("http://localhost"), params());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({
      schedule: monday,
      active: true,
      nextChangeAt: "2026-06-01T11:00:00.000Z",
    });
  });

  it("GET reports no automation for a connection without a schedule", async () => {
    getProviderConnectionById.mockResolvedValue(connection({ schedule: null }));

    const data = await (await GET(new Request("http://localhost"), params())).json();

    expect(data).toEqual({ schedule: null, active: null, nextChangeAt: null });
  });

  it("GET returns a parked schedule without evaluating it", async () => {
    getProviderConnectionById.mockResolvedValue(connection({ schedule: { ...monday, enabled: false } }));

    const data = await (await GET(new Request("http://localhost"), params())).json();

    expect(data).toEqual({
      schedule: { ...monday, enabled: false },
      active: null,
      nextChangeAt: null,
    });
  });

  it("GET drops a stored schedule that no longer validates", async () => {
    getProviderConnectionById.mockResolvedValue(connection({ schedule: { ...monday, days: [42] } }));

    const data = await (await GET(new Request("http://localhost"), params())).json();

    expect(data).toEqual({ schedule: null, active: null, nextChangeAt: null });
  });

  it("GET returns 404 for an unknown connection id", async () => {
    getProviderConnectionById.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost"), params("nope"));
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data).toEqual({ error: "Connection not found" });
  });

  it("PUT saves, applies immediately and returns the live state", async () => {
    getProviderConnectionById.mockResolvedValue(connection({ isActive: false }));

    const response = await PUT(request(monday), params());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(updateProviderConnection).toHaveBeenCalledWith(CONNECTION_ID, expect.objectContaining({
      isActive: true,
      schedule: expect.objectContaining({
        days: [1, 2, 3, 4, 5],
        start: "09:00",
        end: "18:00",
        timezone: "Asia/Bangkok",
        lastAppliedState: "active",
        lastAppliedAt: "2026-06-01T05:00:00.000Z",
      }),
    }));
    expect(data.active).toBe(true);
    expect(data.schedule.lastAppliedState).toBe("active");
    expect(startConnectionSchedules).toHaveBeenCalledTimes(1);
  });

  it("PUT disables the account when the saved window is closed", async () => {
    // 2026-06-06 is a Saturday — outside every selected day.
    vi.setSystemTime(new Date("2026-06-06T05:00:00.000Z"));
    getProviderConnectionById.mockResolvedValue(connection({ isActive: true }));

    const response = await PUT(request(monday), params());

    expect(response.status).toBe(200);
    expect(updateProviderConnection).toHaveBeenCalledWith(CONNECTION_ID, expect.objectContaining({
      isActive: false,
      schedule: expect.objectContaining({ lastAppliedState: "disabled" }),
    }));
  });

  it("PUT does not touch isActive when the stored state already matches", async () => {
    getProviderConnectionById.mockResolvedValue(connection({ isActive: true }));

    await PUT(request(monday), params());

    const patch = updateProviderConnection.mock.calls[0][1];
    expect(patch).not.toHaveProperty("isActive");
    expect(patch.schedule.lastAppliedState).toBeUndefined();
  });

  it("PUT accepts a { schedule } envelope", async () => {
    getProviderConnectionById.mockResolvedValue(connection({ isActive: true }));

    const response = await PUT(request({ schedule: monday }), params());

    expect(response.status).toBe(200);
    expect(updateProviderConnection).toHaveBeenCalled();
  });

  it("PUT does not start the scheduler for a parked schedule", async () => {
    getProviderConnectionById.mockResolvedValue(connection({ isActive: true }));

    const response = await PUT(request({ ...monday, enabled: false }), params());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ schedule: { ...monday, enabled: false }, active: null, nextChangeAt: null });
    expect(updateProviderConnection.mock.calls[0][1]).not.toHaveProperty("isActive");
    expect(startConnectionSchedules).not.toHaveBeenCalled();
  });

  it("PUT rejects an empty day list when enabled with a precise message", async () => {
    getProviderConnectionById.mockResolvedValue(connection());

    const response = await PUT(request({ ...monday, days: [] }), params());
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("days must not be empty when the schedule is enabled");
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("PUT rejects a bad weekday", async () => {
    getProviderConnectionById.mockResolvedValue(connection());

    const response = await PUT(request({ ...monday, days: [1, 9] }), params());
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toMatch(/invalid weekday 9/);
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("PUT rejects a bad time", async () => {
    getProviderConnectionById.mockResolvedValue(connection());

    const response = await PUT(request({ ...monday, start: "24:00" }), params());
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("start must be a 24h time in HH:MM form (00:00-23:59)");
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("PUT rejects an unknown timezone", async () => {
    getProviderConnectionById.mockResolvedValue(connection());

    const response = await PUT(request({ ...monday, timezone: "Mars/Olympus" }), params());
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toMatch(/timezone must be a valid IANA timezone/);
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("PUT rejects a non-object body", async () => {
    getProviderConnectionById.mockResolvedValue(connection());

    const response = await PUT(new Request("http://localhost/api/providers/conn-1/schedule", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    }), params());
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("schedule must be an object");
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("PUT returns 404 for an unknown connection id", async () => {
    getProviderConnectionById.mockResolvedValue(null);

    const response = await PUT(request(monday), params("nope"));

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("Connection not found");
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("DELETE drops the schedule without touching isActive", async () => {
    getProviderConnectionById.mockResolvedValue(connection({ isActive: false }));

    const response = await DELETE(new Request("http://localhost", { method: "DELETE" }), params());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ schedule: null, active: null, nextChangeAt: null });
    expect(updateProviderConnection).toHaveBeenCalledWith(CONNECTION_ID, { schedule: null });
    expect(updateProviderConnection.mock.calls[0][1]).not.toHaveProperty("isActive");
  });

  it("DELETE returns 404 for an unknown connection id", async () => {
    getProviderConnectionById.mockResolvedValue(null);

    const response = await DELETE(new Request("http://localhost", { method: "DELETE" }), params("nope"));

    expect(response.status).toBe(404);
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });
});
