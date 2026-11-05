import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as helpers from "../../src/shared/utils/routingPreview.js";

const require = createRequire(import.meta.url);
const { ROUTING_PREVIEW_ROUTES, summarizeRoutingPreview, buildRoutingPreviewGraph, filterRoutingPreview } = helpers;
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { transformSync } = require("next/dist/build/swc");
const component = (file) => new URL(`../../src/app/(dashboard)/dashboard/usage/${file}`, import.meta.url);
function load(url, overrides = {}) {
  const { code } = transformSync(readFileSync(url, "utf8"), {
    filename: fileURLToPath(url),
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" },
  });
  const mod = { exports: {} };
  new Function("require", "module", "exports", code)((name) => Object.hasOwn(overrides, name) ? overrides[name] : name.endsWith(".css") ? {} : require(name), mod, mod.exports);
  return mod.exports;
}
const Box = ({ children, title, subtitle }) => React.createElement("div", null, title, subtitle, children);
Box.Section = Box;
const native = {
  Card: Box, CardSkeleton: () => React.createElement("p", null, "Loading"),
  Button: ({ children, ...props }) => React.createElement("button", props, children),
  Select: ({ options, label, ...props }) => React.createElement("select", { ...props, "aria-label": label }, options.map((o) => React.createElement("option", { key: o.value, value: o.value }, o.label))),
  SegmentedControl: ({ options }) => React.createElement("div", null, options.map((o) => o.label).join(" | ")),
  Modal: ({ isOpen, children, title }) => isOpen ? React.createElement(Box, { title }, children) : null,
  RequestLogger: () => null,
};
const realRoute = { id: "observed-1", key: { id: "safe-key-id", label: "Actual client" }, route: { id: "legacy", label: "Legacy / route unknown", kind: "unknown" }, provider: { id: "observed-provider", label: "Actual provider" }, model: { id: "observed-model", label: "Actual model" }, requests: 2, attempts: 3, tokens: 150, estimatedUsd: 0.125, unknownCostEvents: 1, synthetic: false };
const previewOverrides = {
  "@/shared/utils/routingPreview": helpers,
  "@/shared/components": native,
  "./RoutingPreviewEdge": { __esModule: true, default: () => null },
  "@xyflow/react": { ReactFlow: ({ nodes, edges, ...props }) => React.createElement("div", { "data-graph": JSON.stringify({ nodes, edges }), "data-attribution": props.proOptions?.hideAttribution ? "hidden" : "visible" }), Background: () => null, Controls: () => null, Handle: () => null, Position: { Left: "left", Right: "right" } },
};
function clientPreview(props) {
  const states = [];
  let cursor = 0;
  const hooks = { ...React, useId: () => "routing-test", useMemo: (fn) => fn(), useEffect: () => {}, useState: (initial) => {
    const i = cursor++;
    if (!(i in states)) states[i] = initial;
    return [states[i], (value) => { states[i] = typeof value === "function" ? value(states[i]) : value; }];
  } };
  const Preview = load(component("components/RoutingMapPreview.js"), { ...previewOverrides, react: hooks }).default;
  return { render: (next = props) => { props = next; cursor = 0; return Preview(props); } };
}
function findElement(tree, predicate) {
  if (!tree || typeof tree !== "object") return null;
  if (predicate(tree)) return tree;
  for (const child of React.Children.toArray(tree.props?.children)) {
    const result = findElement(child, predicate);
    if (result) return result;
  }
  return null;
}
afterEach(() => vi.unstubAllEnvs());

describe("native observed Routing Map", () => {
  it("always offers Overview | Routing Map | Details, serving real data unless both demo gates opt in", () => {
    const renderPage = (flag, demo, nodeEnv = "development") => {
      vi.stubEnv("NEXT_PUBLIC_ROUTING_MAP_PREVIEW", flag);
      vi.stubEnv("NODE_ENV", nodeEnv);
      const { default: Page } = load(component("page.js"), {
        "next/navigation": { useSearchParams: () => new URLSearchParams(`tab=routing-map&demo=${demo}`), useRouter: () => ({ push: vi.fn() }) },
        "next/dynamic": { __esModule: true, default: (loader, options) => () => React.createElement("p", { "data-ssr": String(options.ssr) }, String(loader).includes("RoutingMapPreview") ? "SYNTHETIC COMPONENT" : "OBSERVED COMPONENT") },
        "@/shared/components": native,
        "@/shared/components/UsageStats": { __esModule: true, default: () => null },
        "./components/RequestDetailsTab": { __esModule: true, default: () => null },
      });
      return renderToStaticMarkup(React.createElement(Page));
    };
    for (const [flag, demo, env] of [["0", "0", "development"], ["0", "1", "development"], ["1", "0", "development"], ["1", "1", "production"]]) {
      const html = renderPage(flag, demo, env);
      expect(html).toContain("Overview | Routing Map | Details");
      expect(html).toContain("OBSERVED COMPONENT");
      expect(html).not.toContain("SYNTHETIC COMPONENT");
      expect(html).toContain('data-ssr="false"');
    }
    expect(renderPage("1", "1")).toContain("SYNTHETIC COMPONENT");
  });

  it("summarizes tracked attempts and unknown costs without treating missing prices as known free usage", () => {
    const routes = [
      { ...ROUTING_PREVIEW_ROUTES[0], synthetic: false, attempts: 4, unknownCostEvents: 2, estimatedUsd: 0 },
      { ...ROUTING_PREVIEW_ROUTES[1], synthetic: false, attempts: 3, unknownCostEvents: 1, estimatedUsd: 0.125 },
    ];
    expect(summarizeRoutingPreview(routes)).toEqual({ requests: 1200, attempts: 7, tokens: 600000, estimatedUsd: 0.125, unknownCostEvents: 3 });
    const graph = buildRoutingPreviewGraph(routes);
    const key = graph.nodes.find((node) => node.data.stage === "key");
    expect(key.data.totals.attempts).toBe(7);
    expect(key.data.totals.unknownCostEvents).toBe(3);
    expect(filterRoutingPreview([{ ...routes[0], route: { id: "legacy", label: "Legacy / route unknown", kind: "unknown" } }], { route: "unknown" })).toHaveLength(1);
  });

  it("scopes observed route/provider nodes to key context so every complete graph walk is observed", () => {
    const identity = (id) => ({ id, label: id });
    const base = { ...realRoute, route: { id: "shared-combo", label: "Shared Combo", kind: "combo" } };
    const routes = [
      { ...base, id: "a", key: identity("key-a"), provider: identity("p-a"), model: identity("model-a") },
      { ...base, id: "b", key: identity("key-b"), provider: identity("p-b"), model: identity("model-b") },
      { ...base, id: "c", key: identity("key-a"), route: { id: "other-route", label: "Direct", kind: "direct" }, provider: identity("p-a"), model: identity("other-model") },
    ];
    const graph = buildRoutingPreviewGraph(routes, { contextScoped: true });
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(graph.nodes.filter((n) => n.data.stage === "route")).toHaveLength(3);
    expect(graph.nodes.filter((n) => n.data.stage === "provider")).toHaveLength(3);
    const paths = [];
    const walk = (node, path) => {
      const current = [...path, node];
      if (node.data.stage === "model") paths.push(current);
      else for (const edge of graph.edges.filter((e) => e.source === node.id)) walk(byId.get(edge.target), current);
    };
    graph.nodes.filter((n) => n.data.stage === "key").forEach((node) => walk(node, []));
    expect(paths).toHaveLength(routes.length);
    for (const path of paths) {
      expect(path.map((n) => n.data.stage)).toEqual(["key", "route", "provider", "model"]);
      const members = routes.filter((r) => path.every((n) => n.data.routeIds.includes(r.id)));
      expect(members).toHaveLength(1);
      const r = members[0];
      expect(path[1].id).toBe(`route:${JSON.stringify([r.key.id, r.route.id])}`);
      expect(path[2].id).toBe(`provider:${JSON.stringify([r.key.id, r.route.id, r.provider.id])}`);
      expect(path[3].id).toBe(`model:${JSON.stringify([r.provider.id, r.model.id])}`);
    }
  });

  it("starts real all-keys usage in readable Key Explorer rather than a crowded graph", () => {
    const { default: Preview } = load(component("components/RoutingMapPreview.js"), previewOverrides);
    const html = renderToStaticMarkup(React.createElement(Preview, { realMode: true, dataRoutes: [realRoute] }));
    expect(html).toContain("Route details");
    expect(html).toContain("Actual client");
    expect(html).not.toContain("data-graph=");
  });

  it("requires a key filter for more than 100 all-key graph nodes", () => {
    const { default: Preview } = load(component("components/RoutingMapPreview.js"), { ...previewOverrides, react: { ...React, useState: (initial) => React.useState(initial === "keys" ? "flow" : initial) } });
    const routes = Array.from({ length: 110 }, (_, i) => ({ ...realRoute, id: `route-${i}`, key: { id: `key-${i}`, label: `Client ${i}` } }));
    const html = renderToStaticMarkup(React.createElement(Preview, { realMode: true, dataRoutes: routes }));
    expect(html).toContain("Choose a key for a readable graph");
    expect(html).toContain("Key Explorer");
    expect(html).not.toContain("data-graph=");
  });

  it("allows fitting a large selected-key graph without the old 0.2 zoom floor", () => {
    let flowProps;
    const { default: Preview } = load(component("components/RoutingMapPreview.js"), {
      ...previewOverrides,
      react: { ...React, useState: (initial) => React.useState(initial === "keys" ? "flow" : initial?.key === "all" ? { ...initial, key: realRoute.key.id } : initial) },
      "@xyflow/react": { ...previewOverrides["@xyflow/react"], ReactFlow: (props) => { flowProps = props; return null; } },
    });
    const routes = Array.from({ length: 120 }, (_, i) => ({ ...realRoute, id: `path-${i}`, route: { id: `request-${i}`, label: `Model ${i}`, kind: "direct" } }));
    renderToStaticMarkup(React.createElement(Preview, { realMode: true, dataRoutes: routes }));
    expect(flowProps).toBeDefined();
    expect(flowProps.minZoom).toBeLessThan(0.2);
    expect(flowProps.fitView).toBe(true);
  });

  it("uses only observed route props in real mode, derives actual filters and keeps history static", () => {
    const { default: Preview } = load(component("components/RoutingMapPreview.js"), { ...previewOverrides, react: { ...React, useState: (initial) => React.useState(initial === "keys" ? "flow" : initial) } });
    const html = renderToStaticMarkup(React.createElement(Preview, { realMode: true, dataRoutes: [realRoute] }));
    expect(html).toContain("Observed usage");
    expect(html).toContain("Actual client");
    expect(html).toContain("Actual provider");
    expect(html).toContain("Actual model");
    expect(html).toContain('value="unknown"');
    expect(html).toContain("Tracked attempts");
    expect(html).toContain("Unknown-cost events");
    expect(html).toContain("Historical paths");
    expect(html).toContain('data-attribution="visible"');
    expect(html).not.toMatch(/Demo animation|SYNTHETIC DATA|DEV PREVIEW|Agent A|Provider North|Core Model/);
    expect(html).not.toContain('&quot;demoActive&quot;:true');
    expect(html).not.toContain('&quot;demoMotion&quot;:true');
  });

  it("filters actual key/provider/kind IDs, switches metrics/views, and inspects current graph/list data", () => {
    const direct = { ...realRoute, id: "direct", key: { id: "db-key-2", label: "Other key" }, route: { id: "direct-request", label: "Requested direct model", kind: "direct" }, provider: { id: "provider-2", label: "Other provider" } };
    const combo = { ...direct, id: "combo", route: { id: "combo-request", label: "Requested Combo", kind: "combo" } };
    const app = clientPreview({ realMode: true, dataRoutes: [realRoute, direct, combo] });
    let tree = app.render();
    const select = (label, value) => { findElement(tree, (node) => node.type === native.Select && node.props.label === label).props.onChange({ target: { value } }); tree = app.render(); };
    select("Key", "db-key-2");
    let list = findElement(tree, (node) => typeof node.props?.onInspect === "function");
    expect(list.props.routes.map((r) => r.id)).toEqual(["direct", "combo"]);
    select("Route", "direct");
    list = findElement(tree, (node) => typeof node.props?.onInspect === "function");
    expect(list.props.routes.map((r) => r.id)).toEqual(["direct"]);
    select("Route", "combo");
    expect(findElement(tree, (node) => typeof node.props?.onInspect === "function").props.routes.map((r) => r.id)).toEqual(["combo"]);
    select("Provider", realRoute.provider.id);
    expect(renderToStaticMarkup(tree)).toContain("No routes match");
    findElement(tree, (node) => node.props?.children === "Reset filters").props.onClick();
    tree = app.render();
    select("Route", "unknown");
    list = findElement(tree, (node) => typeof node.props?.onInspect === "function");
    expect(list.props.routes.map((r) => r.id)).toEqual([realRoute.id]);
    findElement(tree, (node) => node.props?.options?.some((o) => o.value === "attempts")).props.onChange("attempts");
    tree = app.render();
    expect(renderToStaticMarkup(tree)).toContain("3 Tracked attempts");
    const listTree = list.type(list.props);
    findElement(listTree, (node) => node.props?.children === "Route details").props.onClick();
    tree = app.render();
    let modal = findElement(tree, (node) => node.type === native.Modal);
    expect(modal.props.isOpen).toBe(true);
    const details = renderToStaticMarkup(modal);
    expect(details.indexOf("Key:")).toBeLessThan(details.indexOf("Direct / Combo / Unknown:"));
    expect(details.indexOf("Direct / Combo / Unknown:")).toBeLessThan(details.indexOf("Provider:"));
    expect(details.indexOf("Provider:")).toBeLessThan(details.indexOf("Model:"));
    expect(details).toContain("Unknown-cost events");
    modal.props.onClose();
    findElement(tree, (node) => node.props?.options?.some((o) => o.value === "flow")).props.onChange("flow");
    tree = app.render();
    const flow = findElement(tree, (node) => node.type === previewOverrides["@xyflow/react"].ReactFlow);
    expect(flow.props.nodes.find((node) => node.data.stage === "key").id).toBe(`key:${realRoute.key.id}`);
    expect(flow.props.nodes.find((node) => node.data.stage === "route").id).toBe(`route:${JSON.stringify([realRoute.key.id, realRoute.route.id])}`);
    flow.props.onEdgeClick(null, flow.props.edges[0]);
    tree = app.render();
    expect(findElement(tree, (node) => node.type === native.Modal).props.isOpen).toBe(true);
    tree = app.render({ realMode: true, dataRoutes: [direct] });
    modal = findElement(tree, (node) => node.type === native.Modal);
    expect(renderToStaticMarkup(modal)).toContain("This path is no longer in the filtered snapshot");
    expect(renderToStaticMarkup(modal)).not.toContain("Actual client");
  });

  it("never falls back to demo routes for empty real data and rejects synthetic rows in real mode", () => {
    const { default: Preview } = load(component("components/RoutingMapPreview.js"), previewOverrides);
    for (const props of [{ realMode: true }, { realMode: true, dataRoutes: [] }, { realMode: true, dataRoutes: helpers.ROUTING_PREVIEW_ROUTES }]) {
      const html = renderToStaticMarkup(React.createElement(Preview, props));
      expect(html).toContain("No routes match");
      expect(html).not.toMatch(/Agent A|Provider North|Demo animation|SYNTHETIC DATA/);
    }
    const demo = renderToStaticMarkup(React.createElement(Preview));
    expect(demo).toContain("SYNTHETIC DATA");
    expect(demo).toContain("Demo animation");
  });
});
