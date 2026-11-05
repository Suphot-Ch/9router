// In-memory fictional fixtures for the explicitly gated demo only. The pure graph
// helpers below also accept observed routes; they never fetch or persist usage.
const agent = Object.freeze({ id: "agent-a", label: "Agent A" });
const web = Object.freeze({ id: "web-app", label: "Web App" });
const batch = Object.freeze({ id: "batch-job", label: "Batch Job" });
const north = Object.freeze({ id: "provider-north", label: "Provider North" });
const south = Object.freeze({ id: "provider-south", label: "Provider South" });
const direct = Object.freeze({ id: "direct", label: "Direct", kind: "direct" });
const combo = Object.freeze({ id: "balanced", label: "Balanced combo", kind: "combo" });
const fast = Object.freeze({ id: "fast", label: "Fast combo", kind: "combo" });
const core = Object.freeze({ id: "core", label: "Core Model" });
const mini = Object.freeze({ id: "mini", label: "Mini Model" });

export const ROUTING_PREVIEW_ROUTES = Object.freeze([
  { id: "demo-1", key: agent, route: combo, provider: north, model: core, requests: 840, tokens: 420000, estimatedUsd: 1.68 },
  { id: "demo-2", key: agent, route: combo, provider: south, model: core, requests: 360, tokens: 180000, estimatedUsd: 0.54 },
  { id: "demo-3", key: web, route: direct, provider: north, model: mini, requests: 620, tokens: 155000, estimatedUsd: 0.31 },
  { id: "demo-4", key: web, route: fast, provider: south, model: mini, requests: 280, tokens: 70000, estimatedUsd: 0.14 },
  { id: "demo-5", key: batch, route: direct, provider: south, model: core, requests: 120, tokens: 240000, estimatedUsd: 0.72 },
  { id: "demo-6", key: batch, route: combo, provider: north, model: core, requests: 80, tokens: 160000, estimatedUsd: 0.64 },
].map((route) => Object.freeze({ ...route, synthetic: true })));

export function filterRoutingPreview(routes, filters = {}) {
  return routes.filter((r) =>
    (!filters.key || filters.key === "all" || r.key.id === filters.key) &&
    (!filters.provider || filters.provider === "all" || r.provider.id === filters.provider) &&
    (!filters.route || filters.route === "all" || r.route.kind === filters.route)
  );
}

export function summarizeRoutingPreview(routes) {
  const totals = routes.reduce((sum, r) => ({
    requests: sum.requests + r.requests,
    attempts: sum.attempts + (r.attempts ?? 0),
    tokens: sum.tokens + r.tokens,
    estimatedUsd: sum.estimatedUsd + r.estimatedUsd,
    unknownCostEvents: sum.unknownCostEvents + (r.unknownCostEvents ?? 0),
  }), { requests: 0, attempts: 0, tokens: 0, estimatedUsd: 0, unknownCostEvents: 0 });
  return { ...totals, estimatedUsd: Number(totals.estimatedUsd.toFixed(6)) };
}

// IDs encode entity identity, never array position or display labels.
export function buildRoutingPreviewGraph(routes, { contextScoped = false } = {}) {
  const nodes = new Map();
  const edges = new Map();
  for (const r of routes) {
    const stages = [
      ["key", `key:${r.key.id}`, r.key.label],
      // Real graphs must not create phantom paths by joining different keys or
      // routes through a globally merged Combo/provider node. Models are sinks.
      ["route", `route:${contextScoped ? JSON.stringify([r.key.id, r.route.id]) : r.route.id}`, r.route.label],
      ["provider", `provider:${contextScoped ? JSON.stringify([r.key.id, r.route.id, r.provider.id]) : r.provider.id}`, r.provider.label],
      ["model", `model:${JSON.stringify([r.provider.id, r.model.id])}`, r.model.label],
    ];
    stages.forEach(([stage, id, label], column) => {
      if (!nodes.has(id)) nodes.set(id, {
        id, type: "routingPreview", position: { x: column * 260, y: 0 },
        data: { stage, label, providerId: stage === "model" ? r.provider.id : null, providerLabel: stage === "model" ? r.provider.label : null, routeIds: [] },
      });
      nodes.get(id).data.routeIds.push(r.id);
      if (column > 0) {
        const source = stages[column - 1][1];
        const edgeId = JSON.stringify([source, id]);
        if (!edges.has(edgeId)) edges.set(edgeId, { id: edgeId, source, target: id, data: { routeIds: [] } });
        edges.get(edgeId).data.routeIds.push(r.id);
      }
    });
  }
  const rows = {};
  for (const node of nodes.values()) {
    const stage = node.data.stage;
    node.position.y = (rows[stage] || 0) * 130;
    rows[stage] = (rows[stage] || 0) + 1;
  }
  const byId = new Map(routes.map((r) => [r.id, r]));
  for (const item of [...nodes.values(), ...edges.values()]) {
    item.data.totals = summarizeRoutingPreview(item.data.routeIds.map((id) => byId.get(id)));
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

export function formatRoutingMetric(value, metric) {
  return metric === "estimatedUsd"
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
    : new Intl.NumberFormat("en-US").format(value);
}
