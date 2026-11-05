import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as helpers from "../../src/shared/utils/routingPreview.js";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { transformSync } = require("next/dist/build/swc");
const url = new URL("../../src/app/(dashboard)/dashboard/usage/components/RoutingMap.js", import.meta.url);
const Box = ({ children, title, subtitle }) => React.createElement("div", null, title, subtitle, children);
const Graph = (props) => React.createElement("p", { "data-real": String(props.realMode) }, "OBSERVED GRAPH");
const native = { Card: Box, Button: ({ children, ...props }) => React.createElement("button", props, children) };
function load(overrides = {}) {
  const { code } = transformSync(readFileSync(url, "utf8"), {
    filename: fileURLToPath(url), jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } }, module: { type: "commonjs" },
  });
  const mod = { exports: {} };
  const modules = { "@/shared/utils/routingPreview": helpers, "@/shared/components": native, "./RoutingMapPreview": { __esModule: true, default: Graph }, ...overrides };
  new Function("require", "module", "exports", code)((name) => Object.hasOwn(modules, name) ? modules[name] : require(name), mod, mod.exports);
  return mod.exports;
}
const route = (id = "observed") => ({ id, key: { id: "key", label: "Observed key" }, route: { id: "unknown", label: "Legacy / route unknown", kind: "unknown" }, provider: { id: "provider", label: "Observed provider" }, model: { id: "model", label: "Observed model" }, requests: 2, attempts: 4, tokens: 10, estimatedUsd: 0, unknownCostEvents: 2, synthetic: false });
const payload = (period = "today", extra = {}) => ({ period, routes: [route()], totals: { requests: 2, attempts: 4, tokens: 10, estimatedUsd: 0, unknownCostEvents: 2 }, coverage: { source: "retained-usage-history", events: 4, attributedEvents: 1, legacyEvents: 3, earliestTimestamp: "2026-11-01T00:00:00.000Z", latestTimestamp: "2026-11-05T00:00:00.000Z", truncated: false, totalRoutes: 1, returnedRoutes: 1, omittedRoutes: 0, note: "Only retained events are available." }, ...extra });
const response = (value) => ({ ok: true, json: async () => value });

// Minimal deterministic hook runner: executes the real client effect and cleanup
// without adding a DOM dependency. UI assertions use React's own JSX/SSR runtime.
function mount() {
  const slots = [];
  let cursor = 0;
  let effects = [];
  let component;
  let props = {};
  const hooks = {
    ...React,
    useState(initial) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[i].value, (value) => { slots[i].value = typeof value === "function" ? value(slots[i].value) : value; }];
    },
    useEffect(effect, deps) {
      const i = cursor++;
      if (!slots[i] || deps.some((value, index) => !Object.is(value, slots[i].deps[index]))) {
        slots[i]?.cleanup?.();
        slots[i] = { deps };
        effects.push(() => { slots[i].cleanup = effect(); });
      }
    },
    useRef(initial) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { current: initial };
      return slots[i];
    },
    useMemo(fn) { cursor++; return fn(); },
    useCallback(fn) { cursor++; return fn; },
  };
  component = load({ react: hooks }).default;
  const render = (next = props) => { props = next; cursor = 0; const tree = component(props); const queued = effects; effects = []; queued.forEach((fn) => fn()); return tree; };
  return { render, html: (next) => renderToStaticMarkup(render(next)), unmount: () => slots.forEach((slot) => slot?.cleanup?.()) };
}
function find(tree, predicate) {
  if (!tree || typeof tree !== "object") return null;
  if (predicate(tree)) return tree;
  for (const child of React.Children.toArray(tree.props?.children)) { const found = find(child, predicate); if (found) return found; }
  return null;
}
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("observed Routing Map data lifecycle", () => {
  it("polls every 15 seconds in the selected period and cancels requests and timers on period change/unmount", async () => {
    vi.useFakeTimers();
    const pending = [];
    vi.stubGlobal("fetch", vi.fn((endpoint, options) => new Promise((resolve) => pending.push({ endpoint, options, resolve }))));
    const app = mount();
    app.render({ period: "30d" });
    expect(pending).toHaveLength(1);
    pending[0].resolve(response(payload("30d")));
    await flush();
    vi.advanceTimersByTime(14999);
    expect(pending).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(pending).toHaveLength(2);
    expect(pending[1].endpoint).toContain("period=30d");
    const next = app.html({ period: "60d" });
    expect(pending[1].options.signal.aborted).toBe(true);
    expect(next).not.toContain("OBSERVED GRAPH");
    pending[1].resolve(response(payload("30d")));
    await flush();
    expect(app.html()).not.toContain("OBSERVED GRAPH");
    pending[2].resolve(response(payload("60d")));
    await flush();
    expect(app.html()).toContain("OBSERVED GRAPH");
    vi.advanceTimersByTime(15000);
    expect(pending[3].endpoint).toContain("period=60d");
    app.unmount();
    expect(pending[3].options.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not discard a slow in-flight request on a polling tick", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const app = mount();
    app.render();
    vi.advanceTimersByTime(45000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(false);
    app.unmount();
  });

  it("discloses top-route truncation, expands with offset pages, and never sums paged server totals", async () => {
    const first = payload("7d", { routes: Array.from({ length: 1000 }, (_, i) => route(`path-${i}`)) });
    first.coverage = { ...first.coverage, truncated: true, totalRoutes: 1001, returnedRoutes: 1000, omittedRoutes: 1 };
    const second = payload("7d", { routes: [route("last-path")], coverage: { ...first.coverage, returnedRoutes: 1, omittedRoutes: 1000 } });
    vi.stubGlobal("fetch", vi.fn(async (endpoint) => response(endpoint.includes("offset=1000") ? second : first)));
    const app = mount();
    app.render({ period: "7d" });
    await flush();
    let tree = app.render();
    let html = renderToStaticMarkup(tree);
    expect(html).toContain("1,000 of 1,001");
    expect(html).toContain("1 omitted");
    const more = find(tree, (node) => node.props?.children === "Load more routes");
    expect(more).not.toBeNull();
    more.props.onClick();
    app.render();
    await flush();
    expect(fetch.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      "/api/usage/routing-map?period=7d&limit=1000&offset=0",
      "/api/usage/routing-map?period=7d&limit=1000&offset=0",
      "/api/usage/routing-map?period=7d&limit=1000&offset=1000",
    ]);
    tree = app.render();
    const graph = find(tree, (node) => node.type === Graph);
    expect(graph.props.dataRoutes).toHaveLength(1001);
    expect(new Set(graph.props.dataRoutes.map((r) => r.id)).size).toBe(1001);
    expect(find(tree, (node) => node.props?.children === "Load more routes")).toBeNull();
    html = renderToStaticMarkup(tree);
    expect(html).toContain("1,001 of 1,001");
    expect(html).toContain('>2</dd>');
    app.render({ period: "today" });
    expect(fetch.mock.calls.at(-1)[0]).toContain("period=today&limit=1000&offset=0");
    app.unmount();
  });

  it("shows errors with retry, empty state without synthetic data, and preserves a failed-refresh snapshot", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce(response(payload("today", { routes: [] })))
      .mockRejectedValueOnce(new Error("Network unavailable")));
    const app = mount();
    app.render();
    await flush();
    let tree = app.render();
    let html = renderToStaticMarkup(tree);
    expect(html).toContain("HTTP 503");
    expect(html).not.toContain("OBSERVED GRAPH");
    find(tree, (node) => node.props?.children === "Retry").props.onClick();
    app.render();
    await flush();
    expect(app.html()).toContain("No observed usage");
    expect(app.html()).not.toContain("SYNTHETIC DATA");
    vi.advanceTimersByTime(15000);
    await flush();
    html = app.html();
    expect(html).toContain("Showing the last observed snapshot");
    expect(html).toContain("Network unavailable");
    expect(html).toContain("No observed usage");
    app.unmount();
  });

  it("fails closed on synthetic, mismatched-period, or malformed API payloads", async () => {
    for (const invalid of [payload("24h"), payload("today", { routes: [{ ...route(), synthetic: true }] }), payload("today", { totals: null }), payload("today", { coverage: null }), payload("today", { routes: [{ ...route(), route: null }] })]) {
      vi.stubGlobal("fetch", vi.fn(async () => response(invalid)));
      const app = mount();
      app.render();
      await flush();
      const html = app.html();
      expect(html).toContain("Unable to load routing usage");
      expect(html).not.toContain("OBSERVED GRAPH");
      app.unmount();
    }
  });
  it("starts empty, fetches the selected period with page limit 1000, then presents real coverage and server totals", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(payload("7d"))));
    const app = mount();
    const initial = app.html({ period: "7d" });
    expect(initial).toContain("Loading observed usage");
    expect(initial).not.toMatch(/OBSERVED GRAPH|synthetic|Agent A|0 requests/);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [endpoint, options] = fetch.mock.calls[0];
    expect(endpoint).toBe("/api/usage/routing-map?period=7d&limit=1000&offset=0");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.cache).toBe("no-store");
    const html = app.html();
    for (const text of ["OBSERVED GRAPH", "Retained usage history", "Legacy / route unknown", "Tracked token events only", "Tracked attempts", "Unknown-cost events", "Cost estimate", "known USD subtotal", "not provider charges", "Only retained events are available.", "2026-11-01", "2026-11-05"]) expect(html).toContain(text);
    expect(html).toContain('data-real="true"');
    expect(html).toContain("Requests");
    app.unmount();
  });
});
