import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createSqlJsAdapter } from "../../src/lib/db/adapters/sqljsAdapter.js";
import { buildCreateTableSql, TABLES } from "../../src/lib/db/schema.js";

const state = vi.hoisted(() => ({ db: null }));
vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: vi.fn(async () => state.db) }));
import { getRoutingMap, routingMapTimeBounds } from "../../src/lib/db/repos/routingMapRepo.js";
import { GET } from "../../src/app/api/usage/routing-map/route.js";

let directory;
const now = new Date(2026, 10, 5, 15, 30, 0, 0);
const routing = (overrides = {}) => JSON.stringify({ routing: {
  version: 1, requestId: "request-a", attemptId: "attempt-a", keyId: "key-a",
  requestedModel: "balanced", routeKind: "combo", comboPath: ["balanced"], ...overrides,
} });
function insert(overrides = {}) {
  const event = { timestamp: now.toISOString(), provider: "north", model: "core", apiKey: "SECRET_KEY_A_MARKER",
    promptTokens: 10, completionTokens: 5, cost: 0.25, meta: routing(), ...overrides };
  const columns = Object.keys(event);
  state.db.run(`INSERT INTO usageHistory (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`, Object.values(event));
}
const get = (query = "") => GET(new Request(`http://localhost/api/usage/routing-map${query ? `?${query}` : ""}`));

beforeAll(async () => {
  const scratch = process.env.TMPDIR || "/home/user/.hermes/cache/scratch";
  mkdirSync(scratch, { recursive: true });
  directory = mkdtempSync(join(scratch, "routing-map-sqlite-"));
  state.db = await createSqlJsAdapter(join(directory, "test.sqlite"));
  for (const name of ["apiKeys", "usageHistory"]) state.db.exec(buildCreateTableSql(name, TABLES[name]));
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  state.db.run("DELETE FROM usageHistory");
  state.db.run("DELETE FROM apiKeys");
  state.db.run("INSERT INTO apiKeys (id, key, name, createdAt) VALUES (?, ?, ?, ?)", ["key-a", "SECRET_KEY_A_MARKER", "Current renamed key", now.toISOString()]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
afterAll(() => { state.db?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });

describe("routing map API with the app SQLite adapter", () => {
  it("returns actual persisted rows, filtered totals before pagination, and safe projection", async () => {
    insert({ connectionId: "PRIVATE_ACCOUNT_EMAIL@example.invalid", tokens: JSON.stringify({ prompt: "PRIVATE_PROMPT_MARKER", headers: "PRIVATE_HEADER_MARKER" }) });
    insert({ provider: "south", meta: routing({ attemptId: "attempt-b" }) });
    insert({ apiKey: null, meta: "{}", cost: null });
    const response = await get("period=all&key=key-a&routeKind=combo&limit=1");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const result = await response.json();
    expect(result.totals).toEqual({ requests: 1, attempts: 2, tokens: 30, estimatedUsd: 0.5, unknownCostEvents: 0 });
    expect(result.routes).toHaveLength(1);
    expect(result.coverage).toMatchObject({ events: 2, attributedEvents: 2, legacyEvents: 0, totalRoutes: 2, returnedRoutes: 1, omittedRoutes: 1, truncated: true });
    expect(result.routes[0].key).toEqual({ id: "key-a", label: "Current renamed key" });
    const all = JSON.stringify(await (await get("period=all")).json());
    for (const secret of ["SECRET_KEY_A_MARKER", "SECRET_K***", "PRIVATE_ACCOUNT_EMAIL", "PRIVATE_PROMPT_MARKER", "PRIVATE_HEADER_MARKER", "connectionId", "apiKey", "headers"]) expect(all).not.toContain(secret);
    const second = await (await get("period=all&key=key-a&routeKind=combo&limit=1&offset=1")).json();
    expect(second.routes[0].id).not.toBe(result.routes[0].id);
    expect(second.totals).toEqual(result.totals);
  });

  it.each([
    "period=", "period=year", "period=all&period=today", "unknown=1",
    "key=", "key=sk-SECRET_MARKER", "key=key%20a", "key=x&key=y",
    "provider=", "provider=account%40example.invalid", "provider=x%27%20OR%201%3D1--",
    "routeKind=", "routeKind=auto", "routeKind=direct&routeKind=combo",
    "limit=0", "limit=1001", "limit=-1", "limit=1.5", "limit=1e2", "limit=NaN", "limit=",
    "offset=-1", "offset=1.5", "offset=9007199254740992", "offset=1e3", "offset=",
  ])("rejects invalid query %s before reading history", async (query) => {
    const read = vi.spyOn(state.db, "all");
    const response = await get(query);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/^Invalid /);
    expect(JSON.stringify(body)).not.toContain("SECRET_MARKER");
    expect(read).not.toHaveBeenCalled();
  });

  it("accepts filter intersections and returns explicit empty coverage", async () => {
    insert();
    insert({ provider: "south", meta: routing({ requestId: "direct-request", attemptId: "direct-attempt", requestedModel: "alias/core", routeKind: "direct", comboPath: [] }) });
    insert({ apiKey: null, cost: 0, meta: "{}" });
    const result = await (await get("period=all&key=key-a&provider=south&routeKind=direct&limit=1000&offset=0")).json();
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ route: { label: "alias/core", kind: "direct" }, provider: { id: "south" } });
    expect(result.totals.requests).toBe(1);
    const empty = await (await get("period=all&key=missing&offset=1000")).json();
    expect(empty).toMatchObject({ period: "all", routes: [], totals: { requests: 0, attempts: 0, tokens: 0, estimatedUsd: 0, unknownCostEvents: 0 }, coverage: { events: 0, earliestTimestamp: null, latestTimestamp: null, truncated: false, totalRoutes: 0, returnedRoutes: 0, omittedRoutes: 0 } });
    const local = await (await get("period=all&key=local&routeKind=unknown")).json();
    expect(local).toMatchObject({ totals: { requests: 1, unknownCostEvents: 1 }, coverage: { legacyEvents: 1, attributedEvents: 0 } });
  });

  it.each(["today", "24h", "7d", "30d", "60d"])("uses inclusive local/rolling start and excludes future events for %s", async (period) => {
    const expectedStart = new Date(now);
    if (period === "24h") expectedStart.setTime(now.getTime() - 86400000);
    else {
      expectedStart.setHours(0, 0, 0, 0);
      if (period !== "today") expectedStart.setDate(expectedStart.getDate() - (Number.parseInt(period, 10) - 1));
    }
    const bounds = routingMapTimeBounds(period);
    expect(bounds).toEqual({ start: expectedStart.toISOString(), end: now.toISOString() });
    for (const timestamp of [expectedStart.getTime() - 1, expectedStart.getTime(), now.getTime(), now.getTime() + 1]) insert({ timestamp: new Date(timestamp).toISOString(), meta: "{}" });
    const result = await getRoutingMap({ period });
    expect(result.coverage).toMatchObject({ events: 2, earliestTimestamp: bounds.start, latestTimestamp: bounds.end });
    expect(result.totals.requests).toBe(2);
    const all = await getRoutingMap({ period: "all" });
    expect(all.coverage.events).toBe(4);
  });

  it("keeps calendar midnight across spring daylight-saving changes", () => {
    const instant = new Date(2026, 2, 10, 15, 0);
    expect(routingMapTimeBounds("7d", instant.getTime()).start).toBe(new Date(2026, 2, 4, 0, 0).toISOString());
    expect(routingMapTimeBounds("all", instant.getTime())).toEqual({ start: null, end: null });
    expect(() => routingMapTimeBounds("bad")).toThrow("Invalid period");
  });

  it("binds timestamp bounds without applying a hidden history limit", async () => {
    insert();
    const read = vi.spyOn(state.db, "all");
    const response = await get();
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.period).toBe("7d");
    const [sql, params] = read.mock.calls.find(([statement]) => statement.includes("FROM usageHistory"));
    expect(sql).toContain("timestamp >= ? AND timestamp <= ?");
    expect(params).toEqual(Object.values(routingMapTimeBounds("7d")));
    expect(sql).not.toMatch(/LIMIT/i);
    expect(sql).not.toContain(now.toISOString());
  });

  it("paginates more than 1000 joint paths without losing events or filtered totals", async () => {
    state.db.transaction(() => {
      for (let i = 0; i < 1105; i += 1) insert({ model: `model-${i}`, meta: "{}" });
    });
    const first = await (await get("period=all")).json();
    expect(first.routes).toHaveLength(200);
    expect(first.coverage).toMatchObject({ events: 1105, totalRoutes: 1105, returnedRoutes: 200, omittedRoutes: 905, truncated: true });
    const page = await (await get("period=all&limit=1000&offset=1000")).json();
    expect(page.routes).toHaveLength(105);
    expect(page.coverage).toMatchObject({ returnedRoutes: 105, omittedRoutes: 1000, truncated: true });
    expect(page.totals).toEqual(first.totals);
    expect(page.totals).toEqual({ requests: 1105, attempts: 1105, tokens: 1105 * 15, estimatedUsd: 1105 * 0.25, unknownCostEvents: 0 });
    const beyond = await (await get("period=all&offset=1105")).json();
    expect(beyond.routes).toEqual([]);
    expect(beyond.coverage).toMatchObject({ returnedRoutes: 0, omittedRoutes: 1105, truncated: true });
    expect(beyond.totals).toEqual(first.totals);
  });

  it("exposes only a generic failure when the database error contains secret data", async () => {
    vi.spyOn(state.db, "all").mockImplementationOnce(() => { throw new Error("SECRET_DATABASE_ERROR_MARKER"); });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await get("period=all");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to fetch routing map" });
    expect(log).not.toHaveBeenCalled();
  });
});
