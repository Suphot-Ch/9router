import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fixtures from "../../src/shared/utils/routingPreview.js";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { transformSync } = require("next/dist/build/swc");
const componentUrl = new URL("../../src/app/(dashboard)/dashboard/usage/components/RoutingMapPreview.js", import.meta.url);

// Use the app's installed JSX compiler; no test-only runtime dependency required.
function loadJsxModule(url, overrides = {}) {
  const source = readFileSync(url, "utf8");
  const { code } = transformSync(source, {
    filename: fileURLToPath(url),
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" },
  });
  const compiledModule = { exports: {} };
  const localRequire = (name) => {
    if (Object.hasOwn(overrides, name)) return overrides[name];
    if (name.endsWith(".css")) return {};
    return require(name);
  };
  new Function("require", "module", "exports", code)(localRequire, compiledModule, compiledModule.exports);
  return compiledModule.exports;
}
const Wrapper = ({ children }) => React.createElement("div", null, children);
Wrapper.Section = Wrapper;
const preview = loadJsxModule(componentUrl, {
  "@/shared/utils/routingPreview": fixtures,
  "@/shared/components": { Card: Wrapper, Select: Wrapper, SegmentedControl: ({ options }) => React.createElement("div", null, options.map((option) => option.label).join(" · ")), Button: Wrapper, Modal: () => null },
  "./RoutingPreviewEdge": { __esModule: true, default: () => null },
  "@xyflow/react": { ReactFlow: Wrapper, Background: () => null, Controls: () => null, Handle: () => null, Position: { Left: "left", Right: "right" } },
});

afterEach(() => vi.useRealTimers());

describe("routing preview demo animation", () => {
  it("renders an explicitly labelled, default-off demo switch and a not-live-traffic disclaimer", () => {
    const html = renderToStaticMarkup(React.createElement(preview.default));
    expect(html).toContain("Demo animation");
    expect(html).toContain("Not live traffic");
    expect(html).toMatch(/role="switch"[^>]*aria-checked="false"/);
    expect(html).not.toContain("<animateMotion");
    expect(html).toContain("Key Explorer");
  });

  it("renders cyan particles only on active edges permitted to move, retaining metric labels", () => {
    const edgeUrl = new URL("../../src/app/(dashboard)/dashboard/usage/components/RoutingPreviewEdge.js", import.meta.url);
    const Edge = loadJsxModule(edgeUrl).default;
    const props = {
      id: 'edge:["provider-north","core"]', sourceX: 0, sourceY: 0, targetX: 200, targetY: 50,
      sourcePosition: "right", targetPosition: "left", label: "840", labelStyle: { fill: "var(--color-text-muted)" },
      labelBgStyle: { fill: "var(--color-surface)" }, style: { stroke: "var(--color-brand-500)" },
    };
    const draw = (data) => renderToStaticMarkup(React.createElement("svg", null, React.createElement(Edge, { ...props, data })));
    const moving = draw({ demoActive: true, demoMotion: true });
    expect(moving).toContain("<animateMotion");
    expect(moving).toContain("var(--color-cyan-400");
    expect(moving).toContain("840");
    expect(moving).toContain('pointer-events="none"');
    for (const data of [{ demoActive: false, demoMotion: true }, { demoActive: true, demoMotion: false }, {}]) {
      const html = draw(data);
      expect(html).not.toContain("<animateMotion");
      expect(html).toContain("840");
      expect(html).toContain("react-flow__edge-interaction");
      if (data.demoActive) expect(html).toContain('data-demo-edge="active"');
    }
  });

  it("cycles synthetic routes every three seconds and releases its timer and listeners", () => {
    expect(preview.startRoutingDemo).toBeTypeOf("function");
    vi.useFakeTimers();
    const document = new EventTarget();
    document.hidden = false;
    const media = new EventTarget();
    media.matches = false;
    const environment = { document, matchMedia: vi.fn(() => media), setInterval, clearInterval };
    const update = vi.fn();
    const stop = preview.startRoutingDemo(fixtures.ROUTING_PREVIEW_ROUTES, update, environment);
    expect(environment.matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    expect(update).toHaveBeenLastCalledWith({ routeId: "demo-1", motion: true });
    vi.advanceTimersByTime(2999);
    expect(update).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(update).toHaveBeenLastCalledWith({ routeId: "demo-2", motion: true });
    vi.advanceTimersByTime(15000);
    expect(update).toHaveBeenLastCalledWith({ routeId: "demo-1", motion: true });
    stop();
    const count = update.mock.calls.length;
    expect(vi.getTimerCount()).toBe(0);
    media.dispatchEvent(new Event("change"));
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(6000);
    expect(update).toHaveBeenCalledTimes(count);
  });

  it("pauses hidden tabs and reduced-motion preferences with a static complete highlight", () => {
    expect(preview.startRoutingDemo).toBeTypeOf("function");
    vi.useFakeTimers();
    const document = new EventTarget();
    document.hidden = false;
    const media = new EventTarget();
    media.matches = true;
    const update = vi.fn();
    const stop = preview.startRoutingDemo(fixtures.ROUTING_PREVIEW_ROUTES, update, { document, matchMedia: () => media, setInterval, clearInterval });
    expect(update).toHaveBeenLastCalledWith({ routeId: "demo-1", motion: false });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(12000);
    expect(update).toHaveBeenCalledTimes(1);
    media.matches = false;
    media.dispatchEvent(new Event("change"));
    vi.advanceTimersByTime(3000);
    expect(update).toHaveBeenLastCalledWith({ routeId: "demo-2", motion: true });
    document.hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(update).toHaveBeenLastCalledWith({ routeId: "demo-2", motion: false });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(12000);
    document.hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(update).toHaveBeenLastCalledWith({ routeId: "demo-2", motion: true });
    vi.advanceTimersByTime(3000);
    expect(update).toHaveBeenLastCalledWith({ routeId: "demo-3", motion: true });
    media.matches = true;
    media.dispatchEvent(new Event("change"));
    expect(update).toHaveBeenLastCalledWith({ routeId: "demo-3", motion: false });
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it("handles empty, single, filtered, and non-synthetic routes without stray highlights or timers", () => {
    expect(preview.startRoutingDemo).toBeTypeOf("function");
    vi.useFakeTimers();
    const document = new EventTarget();
    document.hidden = true;
    const media = new EventTarget();
    media.matches = false;
    const environment = { document, matchMedia: () => media, setInterval, clearInterval };
    const update = vi.fn();
    const synthetic = fixtures.ROUTING_PREVIEW_ROUTES[3];
    let stop = preview.startRoutingDemo([synthetic], update, environment);
    expect(update).toHaveBeenLastCalledWith({ routeId: synthetic.id, motion: false });
    stop();
    document.hidden = false;
    stop = preview.startRoutingDemo([synthetic], update, environment);
    expect(update).toHaveBeenLastCalledWith({ routeId: synthetic.id, motion: true });
    expect(vi.getTimerCount()).toBe(0);
    stop();
    for (const routes of [[], [{ ...synthetic, id: "real", synthetic: false }]]) {
      stop = preview.startRoutingDemo(routes, update, environment);
      expect(update).toHaveBeenLastCalledWith({ routeId: null, motion: false });
      expect(vi.getTimerCount()).toBe(0);
      stop();
    }
    const graph = preview.buildRoutingDemoGraph([synthetic], "demo-1");
    expect([...graph.nodes, ...graph.edges].some((item) => item.data.demoActive)).toBe(false);
    const live = { ...synthetic, id: "real", synthetic: false };
    expect(preview.buildRoutingDemoGraph([live], "real").nodes.some((node) => node.data.demoActive)).toBe(false);
    expect(preview.buildRoutingDemoGraph([], "demo-1")).toEqual({ nodes: [], edges: [] });
  });

  it("highlights exactly one complete four-stage synthetic path without changing provider-scoped identity or totals", () => {
    expect(preview.buildRoutingDemoGraph).toBeTypeOf("function");
    const routes = fixtures.ROUTING_PREVIEW_ROUTES;
    const before = JSON.stringify(routes);
    for (const route of routes) {
      const graph = preview.buildRoutingDemoGraph(routes, route.id);
      const nodes = graph.nodes.filter((node) => node.data.demoActive).sort((a, b) => a.position.x - b.position.x);
      const positions = new Map(nodes.map((node) => [node.id, node.position.x]));
      const edges = graph.edges.filter((edge) => edge.data.demoActive).sort((a, b) => positions.get(a.source) - positions.get(b.source));
      expect(nodes.map((node) => node.data.stage)).toEqual(["key", "route", "provider", "model"]);
      expect(nodes).toHaveLength(4);
      expect(edges).toHaveLength(3);
      expect(edges.map((edge) => [edge.source, edge.target])).toEqual(nodes.slice(1).map((node, index) => [nodes[index].id, node.id]));
      expect(nodes.at(-1).id).toBe(`model:${JSON.stringify([route.provider.id, route.model.id])}`);
      expect(graph.nodes.map(({ data, ...node }) => ({ ...node, data: { ...data, demoActive: undefined } }))).toEqual(
        fixtures.buildRoutingPreviewGraph(routes).nodes.map(({ data, ...node }) => ({ ...node, data: { ...data, demoActive: undefined } })),
      );
    }
    expect(JSON.stringify(routes)).toBe(before);
  });
});
