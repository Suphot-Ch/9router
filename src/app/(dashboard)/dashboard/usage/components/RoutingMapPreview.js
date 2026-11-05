"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { ReactFlow, Background, Controls, Handle, Position } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Card, Select, SegmentedControl, Button, Modal } from "@/shared/components";
import RoutingPreviewEdge from "./RoutingPreviewEdge";
import {
  ROUTING_PREVIEW_ROUTES,
  filterRoutingPreview,
  summarizeRoutingPreview,
  buildRoutingPreviewGraph,
  formatRoutingMetric,
} from "@/shared/utils/routingPreview";

const METRICS = [
  { value: "requests", label: "Requests" },
  { value: "tokens", label: "Tokens" },
  { value: "estimatedUsd", label: "Est USD" },
];
const OBSERVED_METRICS = [
  { value: "requests", label: "Requests" },
  { value: "attempts", label: "Tracked attempts" },
  { value: "tokens", label: "Tokens" },
  { value: "estimatedUsd", label: "Est USD" },
];
const VIEWS = [{ value: "flow", label: "Flow Map" }, { value: "keys", label: "Key Explorer" }];
const STAGES = { key: "Key", route: "Direct / Combo", provider: "Provider", model: "Model" };

// Membership comes from the same graph builder as inspection: shared links may
// glow, but only the selected route's four nodes and three edges are activated.
export function buildRoutingDemoGraph(routes, activeRouteId = null) {
  const graph = buildRoutingPreviewGraph(routes);
  const syntheticRoute = routes.find((route) => route.synthetic === true && route.id === activeRouteId);
  const mark = (item) => ({
    ...item,
    data: { ...item.data, demoActive: !!syntheticRoute && item.data.routeIds.includes(syntheticRoute.id) },
  });
  return { nodes: graph.nodes.map(mark), edges: graph.edges.map(mark) };
}

// One local-only effect controller owns every timer/listener. Recreating it on
// filter changes restarts from the first visible synthetic route.
export function startRoutingDemo(routes, onChange, environment = window) {
  const syntheticRoutes = routes.filter((route) => route.synthetic === true);
  if (!syntheticRoutes.length) {
    onChange({ routeId: null, motion: false });
    return () => {};
  }
  const media = environment.matchMedia("(prefers-reduced-motion: reduce)");
  let index = 0;
  let timer = null;
  const clearTimer = () => {
    if (timer !== null) environment.clearInterval(timer);
    timer = null;
  };
  const refresh = () => {
    clearTimer();
    const motion = !media.matches && !environment.document.hidden;
    onChange({ routeId: syntheticRoutes[index].id, motion });
    if (motion && syntheticRoutes.length > 1) {
      timer = environment.setInterval(() => {
        index = (index + 1) % syntheticRoutes.length;
        onChange({ routeId: syntheticRoutes[index].id, motion: true });
      }, 3000);
    }
  };
  media.addEventListener("change", refresh);
  environment.document.addEventListener("visibilitychange", refresh);
  refresh();
  return () => {
    clearTimer();
    media.removeEventListener("change", refresh);
    environment.document.removeEventListener("visibilitychange", refresh);
  };
}

function RoutingNode({ data }) {
  return (
    <div
      className="w-52 rounded-[10px] border border-border bg-surface p-3 text-text-main shadow-sm"
      data-demo-node={data.demoActive ? "active" : "idle"}
      style={data.demoActive ? {
        borderColor: "var(--color-brand-500)",
        boxShadow: "0 0 18px color-mix(in srgb, var(--color-brand-500) 35%, transparent)",
      } : undefined}
    >
      {data.stage !== "key" && <Handle type="target" position={Position.Left} className="!border-border !bg-brand-500" />}
      <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">{STAGES[data.stage]}{data.demoActive && <span className="ml-2 text-brand-500">Demo</span>}</p>
      <p className="truncate text-sm font-semibold">{data.label}</p>
      {data.providerLabel && <p className="text-xs text-text-muted">{data.providerLabel}</p>}
      <p className="mt-1 text-xs text-brand-500">{formatRoutingMetric(data.totals[data.metric], data.metric)} {data.metricLabel}</p>
      {data.stage !== "model" && <Handle type="source" position={Position.Right} className="!border-border !bg-brand-500" />}
    </div>
  );
}
const NODE_TYPES = { routingPreview: RoutingNode };
const EDGE_TYPES = { routingPreviewDemo: RoutingPreviewEdge };

function RouteList({ routes, metric, onInspect, realMode }) {
  return (
    <ul className="space-y-3">
      {routes.map((r) => (
        <li key={r.id} className="rounded-[10px] border border-border-subtle bg-bg p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 break-words text-sm font-semibold text-text-main">{r.key.label} <span className="text-text-muted">→ {r.route.label}</span></p>
            <span className="text-sm font-semibold text-brand-500">{formatRoutingMetric(r[metric], metric)}</span>
          </div>
          <p className="mt-1 break-words text-sm text-text-muted">{r.provider.label} → {r.model.label}</p>
          {realMode && <p className="mt-2 text-xs text-text-muted">{formatRoutingMetric(r.requests, "requests")} requests · {formatRoutingMetric(r.attempts, "attempts")} tracked attempts · {formatRoutingMetric(r.unknownCostEvents, "unknownCostEvents")} unknown-cost events</p>}
          <Button variant="ghost" size="sm" className="mt-2" onClick={() => onInspect([r])}>Route details</Button>
        </li>
      ))}
    </ul>
  );
}

export default function RoutingMapPreview({ dataRoutes, realMode = false } = {}) {
  const [view, setView] = useState(realMode ? "keys" : "flow");
  const [mobileDisplay, setMobileDisplay] = useState("list");
  const [metric, setMetric] = useState("requests");
  const [filters, setFilters] = useState({ key: "all", provider: "all", route: "all" });
  const [inspected, setInspected] = useState(null);
  const [demoEnabled, setDemoEnabled] = useState(false);
  const [demo, setDemo] = useState({ routeId: null, motion: false });
  const demoDescriptionId = useId();
  // Missing observed data never falls back to fictional fixtures.
  const sourceRoutes = useMemo(() => realMode ? (dataRoutes || []).filter((r) => r.synthetic === false) : (dataRoutes || ROUTING_PREVIEW_ROUTES), [dataRoutes, realMode]);
  const keyOptions = useMemo(() => [...new Map(sourceRoutes.map((r) => [r.key.id, { value: r.key.id, label: r.key.label }])).values()], [sourceRoutes]);
  const providerOptions = useMemo(() => [...new Map(sourceRoutes.map((r) => [r.provider.id, { value: r.provider.id, label: r.provider.label }])).values()], [sourceRoutes]);
  const routes = useMemo(() => filterRoutingPreview(sourceRoutes, filters), [sourceRoutes, filters]);
  const totals = useMemo(() => summarizeRoutingPreview(routes), [routes]);
  const metrics = realMode ? OBSERVED_METRICS : METRICS;
  const metricLabel = metrics.find((m) => m.value === metric).label;
  useEffect(() => {
    if (realMode || !demoEnabled || view !== "flow") return;
    return startRoutingDemo(routes, setDemo);
  }, [realMode, demoEnabled, routes, view]);
  const activeDemoRouteId = !realMode && demoEnabled && view === "flow" ? demo.routeId : null;
  const graph = useMemo(() => {
    const result = realMode ? buildRoutingPreviewGraph(routes, { contextScoped: true }) : buildRoutingDemoGraph(routes, activeDemoRouteId);
    return {
      nodes: result.nodes.map((n) => ({ ...n, data: { ...n.data, metric, metricLabel } })),
      edges: result.edges.map((e) => ({
        ...e,
        type: "routingPreviewDemo",
        data: { ...e.data, demoMotion: !realMode && demoEnabled && demo.motion },
        label: formatRoutingMetric(e.data.totals[metric], metric),
        // Use theme variables rather than React Flow's light-only defaults.
        style: { stroke: "var(--color-brand-500)", strokeWidth: 2 },
        labelStyle: { fill: "var(--color-text-muted)", fontSize: 11 },
        labelBgStyle: { fill: "var(--color-surface)" },
      })),
    };
  }, [routes, metric, metricLabel, activeDemoRouteId, realMode, demoEnabled, demo.motion]);
  const needsKeyFilter = realMode && filters.key === "all" && graph.nodes.length > 100;
  const graphMinZoom = realMode ? Math.min(0.2, 360 / graph.nodes.reduce((height, node) => Math.max(height, node.position.y + 130), 1)) : 0.2;
  const setFilter = (name) => (event) => setFilters((current) => ({ ...current, [name]: event.target.value }));
  const resetFilters = () => setFilters({ key: "all", provider: "all", route: "all" });
  const inspectGraphItem = (_, item) => setInspected(item.data.routeIds);
  const inspectRoutes = (selected) => setInspected(selected.map((r) => r.id));
  // Resolve details against current data so refresh cannot leave stale modal values.
  const inspectedRoutes = inspected === null ? [] : routes.filter((r) => inspected.includes(r.id));

  return (
    <section className="flex min-w-0 flex-col gap-4" aria-label={realMode ? "Observed usage routing map" : "Synthetic routing map preview"}>
      <Card padding="sm">
        {realMode ? <>
          <h2 className="text-lg font-semibold text-text-main">Observed usage</h2>
          <p className="mt-1 text-sm text-text-muted">Historical paths from retained usage history, not live ongoing requests. Unknown routes retain their legacy attribution.</p>
        </> : <>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-brand-500/10 px-2 py-1 text-xs font-bold text-brand-500">DEV PREVIEW</span>
          <span className="rounded-md bg-surface-2 px-2 py-1 text-xs font-bold text-text-muted">SYNTHETIC DATA</span>
        </div>
        <h2 className="mt-3 text-lg font-semibold text-text-main">Routing Map</h2>
        <p className="mt-1 text-sm text-text-muted">Explore fictional routing paths, not real usage. No API requests or production data. Est USD values are illustrative, not billing.</p>
        </>}
      </Card>

      <Card padding="sm" className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <SegmentedControl options={VIEWS} value={view} onChange={setView} />
          <SegmentedControl options={metrics} value={metric} onChange={setMetric} size="sm" />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Select label="Key" aria-label="Filter by key" value={filters.key} onChange={setFilter("key")} options={[{ value: "all", label: "All keys" }, ...keyOptions]} />
          <Select label="Provider" aria-label="Filter by provider" value={filters.provider} onChange={setFilter("provider")} options={[{ value: "all", label: "All providers" }, ...providerOptions]} />
          <Select label="Route" aria-label="Filter by route" value={filters.route} onChange={setFilter("route")} options={[{ value: "all", label: "All routes" }, { value: "direct", label: "Direct" }, { value: "combo", label: "Combo" }, { value: "unknown", label: "Unknown" }]} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-text-muted" aria-live="polite">{routes.length} {realMode ? "observed paths (loaded routes)" : "synthetic paths"} · <span className="font-semibold text-text-main">{formatRoutingMetric(totals[metric], metric)} {metricLabel}</span></p>
          <Button variant="ghost" size="sm" onClick={resetFilters}>Reset filters</Button>
        </div>
        {realMode ? <p className="text-xs text-text-muted">Path requests may overlap across retry/fallback paths; do not sum them as unique requests. Graph layers repeat the same usage, not additional consumption. Unknown-cost events: {formatRoutingMetric(totals.unknownCostEvents, "unknownCostEvents")}. Estimates exclude unknown prices, not free usage.</p> : <div className="rounded-[10px] border border-border-subtle bg-bg p-3">
          <label className="inline-flex cursor-pointer items-center gap-3 text-sm font-medium text-text-main">
            <input type="checkbox" role="switch" aria-checked={demoEnabled} aria-describedby={demoDescriptionId} checked={demoEnabled} onChange={(event) => setDemoEnabled(event.target.checked)} className="size-4 shrink-0 accent-brand-500" />
            Demo animation
          </label>
          <p id={demoDescriptionId} className="mt-1 text-xs text-text-muted">Not live traffic. Highlights one fictional Key → Direct / Combo → Provider → Model path at a time. Cycles every 3 seconds in Flow Map; reduced motion keeps a static highlight.</p>
          {demoEnabled && <p className="mt-2 text-xs font-medium text-brand-500">{view !== "flow" ? "Demo paused in Key Explorer." : !routes.length ? "Demo paused: no matching synthetic routes." : demo.motion ? "Demo on · Synthetic path animation" : "Demo on · Static highlight (reduced motion or hidden tab)"}</p>}
        </div>}
      </Card>

      {!routes.length ? (
        <Card title="No routes match" subtitle={realMode ? "Try another key, provider, or route combination. Filters apply to loaded observed paths." : "Try another key, provider, or route combination. These filters only affect synthetic data."}>
          <Button variant="secondary" onClick={resetFilters}>Clear filters</Button>
        </Card>
      ) : view === "keys" ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {keyOptions.filter((key) => routes.some((r) => r.key.id === key.value)).map((key) => {
            const keyRoutes = routes.filter((r) => r.key.id === key.value);
            const sum = summarizeRoutingPreview(keyRoutes);
            return (
              <Card key={key.value} title={key.label} subtitle={`${keyRoutes.length} ${realMode ? "observed" : "synthetic"} paths · ${formatRoutingMetric(sum[metric], metric)} ${metricLabel}`} padding="sm">
                <RouteList routes={keyRoutes} metric={metric} onInspect={inspectRoutes} realMode={realMode} />
              </Card>
            );
          })}
        </div>
      ) : (
        <Card padding="sm" title="Flow Map" subtitle="Key → Direct / Combo → Provider → Model">
          <p className="mb-3 text-xs text-text-muted">Select a node, connection, or route to inspect. Model nodes stay separate for each provider.{realMode && " Filter by Key for a readable graph; Key Explorer is the default for large histories. Pan/zoom or use the route list to inspect dense selected-key graphs."}</p>
          <div className="mb-3 sm:hidden">
            <SegmentedControl options={[{ value: "list", label: "Route list" }, { value: "graph", label: "Graph" }]} value={mobileDisplay} onChange={setMobileDisplay} size="sm" />
          </div>
          {needsKeyFilter ? <p role="status" className="rounded-[10px] border border-border-subtle bg-bg p-4 text-sm text-text-muted">Choose a key for a readable graph. This all-keys snapshot has {graph.nodes.length} nodes; use the Key filter above or Key Explorer.</p> : <div className={mobileDisplay === "list" ? "hidden sm:block" : "block"}>
            <div className="h-[460px] overflow-hidden rounded-[10px] border border-border-subtle bg-bg [&_.react-flow__controls-button]:!border-border [&_.react-flow__controls-button]:!bg-surface [&_.react-flow__controls-button]:!fill-text-main">
              <ReactFlow key={`${filters.key}-${filters.provider}-${filters.route}`} nodes={graph.nodes} edges={graph.edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES} fitView fitViewOptions={{ padding: 0.15, minZoom: graphMinZoom }} minZoom={graphMinZoom} maxZoom={1.8} nodesDraggable={false} nodesConnectable={false} onNodeClick={inspectGraphItem} onEdgeClick={inspectGraphItem}>
                <Background color="var(--color-border)" gap={20} />
                <Controls showInteractive={false} />
              </ReactFlow>
            </div>
          </div>}
          <div className={mobileDisplay === "list" ? "sm:hidden" : "hidden"}>
            <RouteList routes={routes} metric={metric} onInspect={inspectRoutes} realMode={realMode} />
          </div>
          <details className="mt-4 hidden sm:block">
            <summary className="cursor-pointer text-sm font-medium text-text-muted">Accessible route list</summary>
            <div className="mt-3"><RouteList routes={routes} metric={metric} onInspect={inspectRoutes} realMode={realMode} /></div>
          </details>
        </Card>
      )}

      <Modal isOpen={inspected !== null} onClose={() => setInspected(null)} title={realMode ? "Observed route details" : "Synthetic route details"} size="xl" footer={<Button variant="secondary" onClick={() => setInspected(null)}>Close</Button>}>
        <p className="mb-4 text-xs font-bold text-brand-500">{realMode ? "Observed usage · Retained history" : "DEV PREVIEW · SYNTHETIC DATA · Not real usage"}</p>
        <div className="space-y-4">
          {inspectedRoutes.map((r) => (
            <Card.Section key={r.id}>
              <ol className="space-y-1 text-sm text-text-main">
                <li><span className="text-text-muted">Key:</span> {r.key.label}</li>
                <li><span className="text-text-muted">Direct / Combo / Unknown:</span> {r.route.label}</li>
                <li><span className="text-text-muted">Provider:</span> {r.provider.label}</li>
                <li><span className="text-text-muted">Model:</span> {r.model.label}</li>
              </ol>
              <dl className="mt-3 grid grid-cols-1 gap-2 border-t border-border-subtle pt-3 text-sm sm:grid-cols-3">
                {metrics.map((m) => <div key={m.value}><dt className="text-text-muted">{m.label}</dt><dd className="font-semibold text-text-main">{formatRoutingMetric(r[m.value], m.value)}</dd></div>)}
                {realMode && <div><dt className="text-text-muted">Unknown-cost events</dt><dd className="font-semibold text-text-main">{formatRoutingMetric(r.unknownCostEvents, "unknownCostEvents")}</dd></div>}
              </dl>
            </Card.Section>
          ))}
        </div>
        {realMode && !inspectedRoutes.length && <p className="text-sm text-text-muted">This path is no longer in the filtered snapshot.</p>}
        <p className="mt-4 text-xs text-text-muted">{realMode ? "Tracked token events only; cost estimates are not provider charges. Legacy / route unknown is not inferred as Direct." : "Fictional counts and estimates for interface evaluation only. No credentials, prompts, or account information."}</p>
      </Modal>
    </section>
  );
}
