import { describe, expect, it } from "vitest";
import { aggregateRoutingMap } from "../../src/lib/db/routingMapAggregation.js";

const meta = (overrides = {}) => JSON.stringify({ routing: {
  version: 1, requestId: "req-one", attemptId: "attempt-one", keyId: "key-one",
  requestedModel: "balanced", routeKind: "combo", comboPath: ["balanced", "fast"], ...overrides,
} });
const row = (overrides = {}) => ({
  id: 1, timestamp: "2026-11-05T01:00:00.000Z", provider: "north", model: "core",
  apiKey: "SECRET_RAW_MARKER", promptTokens: 10, completionTokens: 5, cost: 0.25,
  meta: meta(), ...overrides,
});

describe("retained joint routing events", () => {
  it("deduplicates logical requests globally, not by summing fallback paths", () => {
    const result = aggregateRoutingMap([
      row(),
      row({ id: 2, meta: meta({ attemptId: "attempt-two" }) }),
      row({ id: 3, provider: "south", meta: meta({ attemptId: "attempt-three" }) }),
      row({ id: 4, meta: "{}" }),
    ], [{ id: "key-one", key: "SECRET_RAW_MARKER", name: "Renamed key" }], { period: "all" });
    expect(result.totals).toEqual({ requests: 2, attempts: 4, tokens: 60, estimatedUsd: 1, unknownCostEvents: 0 });
    expect(result.routes).toHaveLength(3);
    const north = result.routes.find((r) => r.route.kind === "combo" && r.provider.id === "north");
    expect(north).toMatchObject({ key: { id: "key-one", label: "Renamed key" }, requests: 1, attempts: 2, tokens: 30, estimatedUsd: 0.5, synthetic: false });
    expect(north.route.comboPath).toEqual(["balanced", "fast"]);
    expect(result.routes.find((r) => r.route.kind === "unknown").route.label).toBe("Legacy / route unknown");
    expect(result.coverage).toMatchObject({ source: "retained-usage-history", events: 4, attributedEvents: 3, legacyEvents: 1, totalRoutes: 3, returnedRoutes: 3, omittedRoutes: 0, truncated: false });
    expect(JSON.stringify(result)).not.toContain("SECRET_RAW_MARKER");
    expect(new Set(result.routes.filter((r) => r.route.kind === "combo").map((r) => r.model.id)).size).toBe(2);
  });

  it("keeps renamed, deleted, current exact-match and local identities separate without masked collisions", () => {
    const keys = [
      { id: "key-a", name: "Renamed A", key: "sk-shared-AAA-tail" },
      { id: "key-b", name: "Renamed B", key: "sk-shared-BBB-tail" },
    ];
    const result = aggregateRoutingMap([
      row({ id: 1, apiKey: keys[0].key, meta: "{}" }),
      row({ id: 2, apiKey: keys[1].key, meta: "{}" }),
      row({ id: 3, apiKey: keys[1].key, meta: meta({ keyId: "key-a" }) }),
      row({ id: 4, apiKey: "DELETED_RAW_SECRET", meta: meta({ keyId: "deleted-id", requestId: "deleted" }) }),
      row({ id: 5, apiKey: "DELETED_UNKNOWN_A", meta: "{}" }),
      row({ id: 6, apiKey: "DELETED_UNKNOWN_B", meta: "{}" }),
      row({ id: 7, apiKey: null, meta: meta({ keyId: null, requestId: "local" }) }),
      row({ id: 8, apiKey: keys[1].key, meta: meta({ keyId: "bad id", requestId: "bad-id" }) }),
    ], keys, { period: "all" });
    expect(new Set(result.routes.map((r) => r.key.id))).toEqual(new Set(["key-a", "key-b", "deleted-id", "unresolved", "local"]));
    expect(result.routes.find((r) => r.key.id === "unresolved")).toMatchObject({ requests: 2, attempts: 2, key: { label: "Deleted / unresolved keys (combined)" } });
    expect(result.routes.find((r) => r.key.id === "local").key.label).toBe("Local / No Key");
    expect(result.routes.find((r) => r.key.id === "deleted-id").key.label).toBe("Deleted / unresolved key");
    expect(result.routes.find((r) => r.route.kind === "combo" && r.key.id === "key-a").key.label).toBe("Renamed A");
    for (const value of [keys[0].key, keys[1].key, "sk-share", "DELETED_RAW_SECRET", "DELETED_UNKNOWN_A", "DELETED_UNKNOWN_B"]) expect(JSON.stringify(result)).not.toContain(value);
    expect(result.coverage.note).toContain("combined");
  });

  it("keeps ambiguous historical zero unknown while recognizing explicit tracked free events", () => {
    const result = aggregateRoutingMap([
      row({ id: 1, cost: 0, meta: "{}" }),
      row({ id: 2, cost: 0, meta: meta({ costKnown: false }) }),
      row({ id: 3, cost: 0, meta: meta() }),
      row({ id: 4, cost: 0, meta: meta({ costKnown: true }) }),
      row({ id: 5, cost: 0.75, meta: "{}" }),
    ], [], { period: "all" });
    expect(result.totals.estimatedUsd).toBe(0.75);
    expect(result.totals.unknownCostEvents).toBe(3);
    expect(result.routes.find((r) => r.route.kind === "unknown").unknownCostEvents).toBe(1);
  });

  it("keeps positive partial costs unknown when the writer explicitly marks incomplete rates", () => {
    const result = aggregateRoutingMap([
      row({ id: 1, cost: 0.001, meta: meta({ costKnown: false }) }),
      row({ id: 2, cost: 0.75, meta: meta({ costKnown: true, attemptId: "known" }) }),
      row({ id: 3, cost: 0.25, meta: "{}" }),
    ], [], { period: "all" });
    expect(result.totals.estimatedUsd).toBe(1);
    expect(result.totals.unknownCostEvents).toBe(1);
    expect(result.routes.find((route) => route.route.kind === "combo").unknownCostEvents).toBe(1);
  });

  it("uses canonical stored cost, preserving free zero and counting every invalid cost as unknown", () => {
    const costs = [0, 1.25, null, undefined, NaN, Infinity, -1, "0.1", ""];
    const result = aggregateRoutingMap(costs.map((cost, id) => row({ id, cost, meta: meta({ attemptId: `attempt-${id}`, costKnown: true }) })), [], { period: "all" });
    expect(result.totals).toEqual({ requests: 1, attempts: 9, tokens: 135, estimatedUsd: 1.25, unknownCostEvents: 7 });
    expect(result.routes[0].unknownCostEvents).toBe(7);
  });

  it("counts duplicate tracked attempts once but consumes stored event costs/tokens without repricing", () => {
    const result = aggregateRoutingMap([row(), row({ id: 2 })], [], { period: "all" });
    expect(result.totals).toEqual({ requests: 1, attempts: 1, tokens: 30, estimatedUsd: 0.5, unknownCostEvents: 0 });
    expect(result.coverage.events).toBe(2);
  });

  it("never infers direct or combo from legacy or malformed metadata", () => {
    const metadata = ["{}", null, "not json", "[]", JSON.stringify({ routing: { version: 2, requestedModel: "combo" } }), meta({ requestId: null }), meta({ attemptId: "" }), meta({ comboPath: null }), meta({ routeKind: "bad" })];
    const result = aggregateRoutingMap(metadata.map((value, id) => row({ id, meta: value })), [{ id: "key-one", key: "SECRET_RAW_MARKER", name: "Current key" }], { period: "all" });
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].route).toEqual({ id: "unknown", label: "Legacy / route unknown", kind: "unknown" });
    expect(result.totals.requests).toBe(metadata.length);
    expect(result.totals.attempts).toBe(metadata.length);
    expect(result.coverage).toMatchObject({ attributedEvents: 0, legacyEvents: metadata.length });
  });

  it("groups joint requested routes, not just resolved models, with stable nested combo IDs", () => {
    const rows = [
      row({ id: 1, meta: meta({ routeKind: "direct", requestedModel: "alias/core", comboPath: [] }) }),
      row({ id: 2, meta: meta({ routeKind: "direct", requestedModel: "other/core", comboPath: [], attemptId: "two" }) }),
      row({ id: 3, meta: meta({ comboPath: ["balanced", "fast"], attemptId: "three" }) }),
      row({ id: 4, meta: meta({ comboPath: ["balanced", "cheap"], attemptId: "four" }) }),
    ];
    const result = aggregateRoutingMap(rows, [], { period: "all" });
    expect(result.routes).toHaveLength(4);
    expect(new Set(result.routes.map((r) => r.route.id)).size).toBe(4);
    expect(result.totals.requests).toBe(1);
    expect(aggregateRoutingMap([...rows].reverse(), [], { period: "all" })).toEqual(result);
    expect(aggregateRoutingMap(rows, [], { period: "all", provider: "missing" })).toMatchObject({ routes: [], totals: { requests: 0, attempts: 0, tokens: 0, estimatedUsd: 0, unknownCostEvents: 0 }, coverage: { events: 0, earliestTimestamp: null, latestTimestamp: null, omittedRoutes: 0, truncated: false } });
  });

  it("rejects credential/email display fields rather than reflecting them from allowlisted columns", () => {
    const result = aggregateRoutingMap([
      row({ provider: "account@example.invalid", model: "SECRET_RAW_MARKER", meta: meta({ requestedModel: "SECRET_RAW_MARKER", comboPath: ["PRIVATE_EMAIL@example.invalid"] }) }),
    ], [{ id: "key-one", key: "SECRET_RAW_MARKER", name: "SECRET_RAW_MARKER" }], { period: "all" });
    const serialized = JSON.stringify(result);
    for (const value of ["SECRET_RAW_MARKER", "account@example.invalid", "PRIVATE_EMAIL@example.invalid"]) expect(serialized).not.toContain(value);
    expect(result.routes[0]).toMatchObject({ key: { label: "Key key-one" }, route: { kind: "unknown" }, provider: { id: "unknown" }, model: { label: "unknown" } });
  });
});
