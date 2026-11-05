import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ROUTING_PREVIEW_ROUTES, filterRoutingPreview, summarizeRoutingPreview, formatRoutingMetric, buildRoutingPreviewGraph } from "../../src/shared/utils/routingPreview.js";

describe("synthetic routing preview", () => {
  it("keeps synthetic rendering behind the explicit dev flag and demo query while the real tab is native", () => {
    const page = readFileSync(new URL("../../src/app/(dashboard)/dashboard/usage/page.js", import.meta.url), "utf8");
    expect(page).toContain('process.env.NEXT_PUBLIC_ROUTING_MAP_PREVIEW === "1"');
    expect(page).toContain('process.env.NODE_ENV !== "production"');
    expect(page).toContain('routingPreviewEnabled && searchParams.get("demo") === "1"');
    expect(page).toContain('showRoutingDemo ? <RoutingMapPreview /> : <RoutingMap period={period} />');
    expect(page).toContain('{ value: "routing-map", label: "Routing Map" }');
    expect(page.indexOf('label: "Routing Map"')).toBeLessThan(page.indexOf('label: "Details"'));
  });
  it("uses native components and local-only fixtures with a mobile list fallback", () => {
    const ui = readFileSync(new URL("../../src/app/(dashboard)/dashboard/usage/components/RoutingMapPreview.js", import.meta.url), "utf8");
    for (const component of ["Card", "Select", "SegmentedControl", "Button", "Modal"]) expect(ui).toContain(`<${component}`);
    for (const label of ["DEV PREVIEW", "SYNTHETIC DATA", "Flow Map", "Key Explorer", "No routes match"]) expect(ui).toContain(label);
    expect(ui).toContain('useState("list")');
    expect(ui).toContain("hidden sm:block");
    expect(ui).not.toMatch(/fetch\(|axios|localStorage|sessionStorage/);
    expect(ui).not.toContain("hideAttribution");
  });
  it("builds conserved four-stage paths with stable provider-scoped model IDs", () => {
    const graph = buildRoutingPreviewGraph(ROUTING_PREVIEW_ROUTES);
    expect(buildRoutingPreviewGraph([])).toEqual({ nodes: [], edges: [] });
    expect(graph).toEqual(buildRoutingPreviewGraph(ROUTING_PREVIEW_ROUTES));
    expect(new Set(graph.nodes.map((n) => n.id)).size).toBe(graph.nodes.length);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const coreModels = graph.nodes.filter((n) => n.data.stage === "model" && n.data.label === "Core Model");
    expect(coreModels).toHaveLength(2);
    expect(new Set(coreModels.map((n) => n.data.providerId)).size).toBe(2);
    const filtered = buildRoutingPreviewGraph(filterRoutingPreview(ROUTING_PREVIEW_ROUTES, { key: "agent-a" }));
    expect(filtered.nodes.filter((n) => n.data.stage === "model").map((n) => n.id).sort()).toEqual(coreModels.map((n) => n.id).sort());
    for (const edge of graph.edges) {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      expect(target.position.x).toBeGreaterThan(source.position.x);
      expect(["key:route", "route:provider", "provider:model"]).toContain(`${source.data.stage}:${target.data.stage}`);
      const matching = ROUTING_PREVIEW_ROUTES.filter((r) => edge.data.routeIds.includes(r.id));
      expect(edge.data.totals).toEqual(summarizeRoutingPreview(matching));
    }
    for (const stage of ["key", "route", "provider", "model"]) {
      expect(graph.nodes.filter((n) => n.data.stage === stage).reduce((sum, n) => sum + n.data.totals.requests, 0)).toBe(summarizeRoutingPreview(ROUTING_PREVIEW_ROUTES).requests);
    }
  });
  it("combines key/provider/route filters without changing fixtures", () => {
    const before = JSON.stringify(ROUTING_PREVIEW_ROUTES);
    expect(filterRoutingPreview(ROUTING_PREVIEW_ROUTES, { key: "agent-a", provider: "provider-south", route: "combo" }).map((r) => r.id)).toEqual(["demo-2"]);
    expect(filterRoutingPreview(ROUTING_PREVIEW_ROUTES, { key: "agent-a", route: "direct" })).toEqual([]);
    expect(filterRoutingPreview(ROUTING_PREVIEW_ROUTES)).toEqual(ROUTING_PREVIEW_ROUTES);
    expect(filterRoutingPreview(ROUTING_PREVIEW_ROUTES, { provider: "missing" })).toEqual([]);
    expect(JSON.stringify(ROUTING_PREVIEW_ROUTES)).toBe(before);
    expect(summarizeRoutingPreview(filterRoutingPreview(ROUTING_PREVIEW_ROUTES, { key: "agent-a" }))).toEqual({ requests: 1200, attempts: 0, tokens: 600000, estimatedUsd: 2.22, unknownCostEvents: 0 });
    expect(summarizeRoutingPreview([])).toEqual({ requests: 0, attempts: 0, tokens: 0, estimatedUsd: 0, unknownCostEvents: 0 });
    expect(formatRoutingMetric(1234, "requests")).toBe("1,234");
    expect(formatRoutingMetric(0.5, "estimatedUsd")).toBe("$0.50");
  });
  it("contains only explicitly synthetic, deterministic route records", () => {
    expect(ROUTING_PREVIEW_ROUTES.length).toBeGreaterThan(0);
    expect(new Set(ROUTING_PREVIEW_ROUTES.map((r) => r.id)).size).toBe(ROUTING_PREVIEW_ROUTES.length);
    expect(new Set(ROUTING_PREVIEW_ROUTES.map((r) => r.route.kind))).toEqual(new Set(["direct", "combo"]));
    for (const route of ROUTING_PREVIEW_ROUTES) {
      expect(route.synthetic).toBe(true);
      expect(route.requests).toBeGreaterThan(0);
      expect(route.tokens).toBeGreaterThan(0);
      expect(route.estimatedUsd).toBeGreaterThanOrEqual(0);
      expect(Object.isFrozen(route)).toBe(true);
    }
  });
});
