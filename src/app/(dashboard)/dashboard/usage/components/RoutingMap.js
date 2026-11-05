"use client";

import { useEffect, useState } from "react";
import { Card, Button } from "@/shared/components";
import { formatRoutingMetric } from "@/shared/utils/routingPreview";
import RoutingMapPreview from "./RoutingMapPreview";

const SUMMARY = [
  { value: "requests", label: "Requests" },
  { value: "attempts", label: "Tracked attempts" },
  { value: "tokens", label: "Tokens" },
  { value: "estimatedUsd", label: "Cost estimate (known USD subtotal)" },
  { value: "unknownCostEvents", label: "Unknown-cost events" },
];

const PAGE_SIZE = 1000;
const isCount = (value) => Number.isFinite(value) && value >= 0;

function validateSnapshot(data, period) {
  const entity = (value) => value && typeof value.id === "string" && typeof value.label === "string";
  const metrics = (value) => value && SUMMARY.every(({ value: name }) => isCount(value[name]));
  if (data?.period !== period || !Array.isArray(data.routes) || !metrics(data.totals) ||
      data.coverage?.source !== "retained-usage-history" ||
      !["events", "attributedEvents", "legacyEvents", "totalRoutes", "returnedRoutes", "omittedRoutes"].every((name) => isCount(data.coverage[name])) ||
      !data.routes.every((r) => r && typeof r.id === "string" && r.synthetic === false && metrics(r) &&
        [r.key, r.route, r.provider, r.model].every(entity) && ["direct", "combo", "unknown"].includes(r.route.kind))) {
    throw new Error("The routing API returned invalid observed usage. Retry to fetch a fresh snapshot.");
  }
  return data;
}

async function readRoutingSnapshot(period, pages, signal) {
  let first;
  const routes = new Map();
  for (let page = 0; page < pages; page++) {
    if (first && page * PAGE_SIZE >= first.coverage.totalRoutes) break;
    const params = new URLSearchParams({ period, limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
    const response = await fetch(`/api/usage/routing-map?${params}`, { signal, cache: "no-store" });
    if (!response.ok) throw new Error(`Unable to load observed usage (HTTP ${response.status}).`);
    const data = validateSnapshot(await response.json(), period);
    if (signal.aborted) return null;
    if (first && data.coverage.totalRoutes !== first.coverage.totalRoutes) {
      throw new Error("Routing history changed while loading more routes. Retry for a fresh snapshot.");
    }
    first ||= data;
    data.routes.forEach((route) => routes.set(route.id, route));
  }
  const omittedRoutes = Math.max(0, first.coverage.totalRoutes - routes.size);
  // Period totals are authoritative distinct counts, never sums of path/page totals.
  return { ...first, routes: [...routes.values()], coverage: { ...first.coverage, returnedRoutes: routes.size, omittedRoutes, truncated: omittedRoutes > 0 } };
}

export default function RoutingMap({ period = "today" }) {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState(null);
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState({ period, pages: 1 });
  const pages = expanded.period === period ? expanded.pages : 1;

  useEffect(() => {
    let disposed = false;
    let busy = false;
    let controller;
    const refresh = async () => {
      // Do not repeatedly abort a slow read on each polling tick.
      if (busy) return;
      busy = true;
      controller = new AbortController();
      const { signal } = controller;
      setLoading(true);
      setFailure(null);
      try {
        const data = await readRoutingSnapshot(period, pages, signal);
        if (!disposed && !signal.aborted) setSnapshot(data);
      } catch (err) {
        if (!disposed && !signal.aborted) setFailure({ period, message: err.message || "Unable to read retained usage history." });
      } finally {
        busy = false;
        if (!disposed && !signal.aborted) setLoading(false);
      }
    };
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => { disposed = true; controller?.abort(); clearInterval(timer); };
  }, [period, pages, retry]);

  // A new selection must never display the previous period's graph or totals.
  const data = snapshot?.period === period ? snapshot : null;
  const error = failure?.period === period ? failure.message : null;
  const coverage = data?.coverage;
  return (
    <section className="flex min-w-0 flex-col gap-4" aria-label="Observed routing usage" aria-busy={loading}>
      <Card padding="sm" title="Routing Map" subtitle={`Observed usage · ${period}`}>
        <p className="text-sm text-text-muted">Retained usage history, not live ongoing requests. Refreshes every 15 seconds by reading recorded usage only.</p>
        <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">Tracked token events only. Failures or attempts without tracked token events may be absent; this is not a complete request/error log.</p>
        <p className="mt-2 text-xs text-text-muted">Requests count recorded logical requests; tracked attempts count provider attempts. Retry/fallback paths may overlap. Cost estimates are not provider charges; unknown prices are not zero or free.</p>
      </Card>
      {error && <Card title="Unable to load routing usage" padding="sm">
        <p role="alert" className="text-sm text-text-muted">{error}{data ? " Showing the last observed snapshot; refresh failed." : " No observed graph is available."}</p>
        <Button variant="secondary" className="mt-3" onClick={() => setRetry((value) => value + 1)}>Retry</Button>
      </Card>}
      {!data && !error && <p role="status" className="text-sm text-text-muted">Loading observed usage…</p>}
      {data && <>
        {loading && <p role="status" className="text-xs text-text-muted">Refreshing observed usage…</p>}
        <Card padding="sm">
          <h3 className="text-sm font-semibold text-text-main">Selected period totals · All observed routes</h3>
          <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
            {SUMMARY.map(({ value, label }) => <div key={value}><dt className="text-xs text-text-muted">{label}</dt><dd className="mt-1 break-words text-lg font-semibold text-text-main">{formatRoutingMetric(data.totals[value], value)}</dd></div>)}
          </dl>
          <p className="mt-3 text-xs text-text-muted">Totals come from the API, not a sum of overlapping route requests. Estimates include known costs only; see unknown-cost events above.</p>
        </Card>
        <Card padding="sm" title="Retained usage history">
          <p className="text-sm text-text-muted">{formatRoutingMetric(coverage.events, "events")} tracked events · {formatRoutingMetric(coverage.attributedEvents, "events")} attributed · {formatRoutingMetric(coverage.legacyEvents, "events")} Legacy / route unknown. Missing historical attribution is never inferred as Direct.</p>
          <p className="mt-2 break-words text-xs text-text-muted">Retained timestamps: {coverage.earliestTimestamp || "Unavailable"} → {coverage.latestTimestamp || "Unavailable"}</p>
          {coverage.note && <p className="mt-2 text-xs text-text-muted">{coverage.note}</p>}
          <p className="mt-2 text-sm text-text-muted">Loaded {formatRoutingMetric(coverage.returnedRoutes, "routes")} of {formatRoutingMetric(coverage.totalRoutes, "routes")} observed routes · {formatRoutingMetric(coverage.omittedRoutes, "routes")} omitted{coverage.truncated ? " · Truncated graph/list and filters apply only to loaded routes." : "."}</p>
          {coverage.truncated && <Button variant="secondary" className="mt-3" disabled={loading} onClick={() => setExpanded({ period, pages: pages + 1 })}>Load more routes</Button>}
        </Card>
        {data.routes.length ? <RoutingMapPreview realMode dataRoutes={data.routes} /> : <Card title="No observed usage" subtitle="No retained tracked-token events were found for this period. Choose another period; no demo data is substituted." />}
      </>}
    </section>
  );
}
