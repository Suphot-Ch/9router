import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const rendererPath = process.env.GOVERNANCE_REACT_RENDERER || "react-test-renderer";
const rendererRequire = createRequire(require.resolve(rendererPath));
const React = rendererRequire("react");
const { create, act } = require(rendererPath);
const { transformSync } = require("next/dist/build/swc");
const root = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const directory = resolve(root, "src/app/(dashboard)/dashboard/providers/[id]");
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} }; cache.set(file, mod);
  const { code } = transformSync(readFileSync(file, "utf8"), {
    filename: file, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" },
  });
  const localRequire = (name) => {
    if (name === "react" || name.startsWith("react/")) return rendererRequire(name);
    if (name === "@/shared/components") return Object.fromEntries(["Button", "Input", "Modal", "Badge", "Toggle", "Tooltip"].map((component) => [component, load(resolve(root, `src/shared/components/${component}.js`)).default]));
    if (name.startsWith("@/")) return load(resolve(root, "src", name.slice(2)) + (name.endsWith(".js") ? "" : ".js"));
    if (name.startsWith(".")) return load(resolve(dirname(file), name) + (name.endsWith(".js") ? "" : ".js"));
    return require(name);
  };
  new Function("require", "module", "exports", code)(localRequire, mod, mod.exports);
  return mod.exports;
}
let tree;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const budget = { tokenLimit: 1000, usedTokens: 1001, unknownUsageCount: 2, resetMode: "weekly", resetDay: 1, lastResetAt: null, nextResetAt: "2026-11-23T00:00:00Z", atLimit: true, remainingTokens: 0 };
const response = (data, ok = true) => ({ ok, json: async () => data });
const nodes = (type) => tree.root.findAllByType(type);
const button = (label) => nodes("button").find((n) => n.props["aria-label"] === label || n.children.join("") === label);
const field = (label) => [...nodes("input"), ...nodes("select")].find((n) => n.props["aria-label"] === label);
const text = () => JSON.stringify(tree.toJSON());
function dom() {
  vi.stubGlobal("document", { body: { style: {} }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
}
async function mount(props = {}) {
  dom();
  await act(async () => { tree = create(React.createElement(load(resolve(directory, "ConnectionTokenBudgetModal.js")).default, { isOpen: true, onClose: vi.fn(), connection: { id: "account-one", name: "Account" }, ...props })); });
}
afterEach(async () => { if (tree) await act(async () => tree.unmount()); tree = null; vi.unstubAllGlobals(); });

describe("native per-account token limits", () => {
  it("opens from the row beside Schedule and preserves the manual toggle when the limit is reached", async () => {
    dom();
    const toggle = vi.fn();
    const fetch = vi.fn(async () => response({ budget })); vi.stubGlobal("fetch", fetch);
    const Row = load(resolve(directory, "ConnectionRow.js")).default;
    const props = { connection: { id: "account-one", name: "Account", isActive: true, tokenBudget: budget }, proxyPools: [], isOAuth: true, isFirst: true, isLast: true, onMoveUp: vi.fn(), onMoveDown: vi.fn(), onToggleActive: toggle, onEdit: vi.fn(), onDelete: vi.fn(), schedule: { badge: "Schedule off", onConfigure: vi.fn() } };
    await act(async () => { tree = create(React.createElement(Row, props)); });
    expect(button("Token Limits")).toBeDefined();
    expect(text()).toContain("Token limit reached");
    expect(text()).toContain("Schedule off");
    expect(nodes("button").some((node) => node.props.role === "switch" && node.props["aria-checked"] === true)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => button("Token Limits").props.onClick());
    expect(nodes("input").some((node) => node.props["aria-label"] === "Token limit")).toBe(true);
    expect(toggle).not.toHaveBeenCalled();
    await act(async () => button("Cancel").props.onClick());
    expect(nodes("input")).toHaveLength(0);
    expect(text()).toContain("Token limit reached");
  });
  it("saves only policy fields without resetting counters and reads the persisted budget back", async () => {
    let persisted = { ...budget };
    const updated = vi.fn(); const close = vi.fn();
    const fetch = vi.fn(async (_url, options) => {
      if (options.method === "PUT") persisted = { ...persisted, ...JSON.parse(options.body) };
      return response({ budget: persisted });
    });
    vi.stubGlobal("fetch", fetch);
    await mount({ onUpdated: updated, onClose: close });
    await act(async () => field("Token limit").props.onChange({ target: { value: "2500" } }));
    await act(async () => field("Reset usage").props.onChange({ target: { value: "monthly" } }));
    await act(async () => field("Reset day").props.onChange({ target: { value: "31" } }));
    await act(async () => button("Save").props.onClick());
    expect(JSON.parse(fetch.mock.calls.find(([, o]) => o.method === "PUT")[1].body)).toEqual({ tokenLimit: 2500, resetMode: "monthly", resetDay: 31 });
    expect(fetch.mock.calls.map(([, o]) => o.method)).toEqual(["GET", "PUT", "GET"]);
    expect(updated).toHaveBeenLastCalledWith(expect.objectContaining({ usedTokens: 1001, tokenLimit: 2500 }));
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("requires confirmation before resetting counters and does not apply unsaved policy edits", async () => {
    let persisted = { ...budget };
    const fetch = vi.fn(async (_url, options) => {
      if (options.method === "PUT") persisted = { ...persisted, usedTokens: 0, unknownUsageCount: 0 };
      return response({ budget: persisted });
    }); vi.stubGlobal("fetch", fetch);
    await mount();
    await act(async () => field("Token limit").props.onChange({ target: { value: "9999" } }));
    await act(async () => button("Reset usage now").props.onClick());
    expect(fetch.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
    await act(async () => button("Confirm reset usage").props.onClick());
    expect(JSON.parse(fetch.mock.calls.find(([, options]) => options.method === "PUT")[1].body)).toEqual({ resetUsage: true });
    expect(field("Token limit").props.value).toBe("1000");
    expect(text()).not.toContain("unknown usage —");
    expect(text()).not.toContain("Token limit reached");
  });
  it("removes limits only after confirmation then reads back the account", async () => {
    let persisted = budget;
    const updated = vi.fn(); const close = vi.fn();
    const fetch = vi.fn(async (_url, options) => {
      if (options.method === "DELETE") persisted = null;
      return response({ budget: persisted });
    }); vi.stubGlobal("fetch", fetch);
    await mount({ onUpdated: updated, onClose: close });
    await act(async () => button("Remove limit").props.onClick());
    expect(fetch.mock.calls).toHaveLength(1);
    await act(async () => button("Confirm remove limit").props.onClick());
    expect(fetch.mock.calls.map(([, options]) => options.method)).toEqual(["GET", "DELETE", "GET"]);
    expect(updated).toHaveBeenLastCalledWith(null);
    expect(close).toHaveBeenCalledOnce();
  });
  it("rejects invalid integers without coercion and supports zero as unlimited", async () => {
    const fetch = vi.fn(async () => response({ budget })); vi.stubGlobal("fetch", fetch);
    await mount();
    for (const value of ["-1", "1.5", "9007199254740992", "1e3", "oops"]) {
      await act(async () => field("Token limit").props.onChange({ target: { value } }));
      await act(async () => button("Save").props.onClick());
      expect(text()).toContain("nonnegative safe whole number");
    }
    expect(fetch.mock.calls).toHaveLength(1);
    await act(async () => field("Token limit").props.onChange({ target: { value: "0" } }));
    await act(async () => field("Reset usage").props.onChange({ target: { value: "none" } }));
    await act(async () => button("Save").props.onClick());
    expect(JSON.parse(fetch.mock.calls.find(([, options]) => options.method === "PUT")[1].body)).toEqual({ tokenLimit: 0, resetMode: "none", resetDay: null });
  });
  it("retries failed loads and never reports a failed readback as saved", async () => {
    const updated = vi.fn(); const close = vi.fn();
    const fetch = vi.fn(async () => response({ error: "Read denied" }, false)); vi.stubGlobal("fetch", fetch);
    await mount({ onUpdated: updated, onClose: close });
    expect(button("Save").props.disabled).toBe(true);
    expect(text()).toContain("Read denied");
    fetch.mockImplementation(async (_url, options) => response({ budget }));
    await act(async () => button("Retry loading token limits").props.onClick());
    updated.mockClear();
    let wrote = false;
    fetch.mockImplementation(async (_url, options) => {
      if (options.method === "PUT") { wrote = true; return response({ budget }); }
      return response({ error: "Readback unavailable" }, false);
    });
    await act(async () => button("Save").props.onClick());
    expect(wrote).toBe(true);
    expect(text()).toContain("Readback unavailable");
    expect(updated).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(button("Save").props.disabled).toBe(false);
  });
  it("keeps a new account's empty policy editable after a rejected save", async () => {
    const fetch = vi.fn(async (_url, options) => options.method === "PUT" ? response({ error: "Try again" }, false) : response({ budget: null })); vi.stubGlobal("fetch", fetch);
    await mount();
    await act(async () => button("Save").props.onClick());
    expect(text()).toContain("Try again");
    expect(field("Token limit")).toBeDefined();
    expect(button("Save").props.disabled).toBe(false);
  });
  it("shows loading and blocks concurrent mutations", async () => {
    let finish;
    const fetch = vi.fn(() => new Promise((resolve) => { finish = resolve; })); vi.stubGlobal("fetch", fetch);
    await mount();
    expect(text()).toContain("Loading token limits");
    expect(button("Save").props.disabled).toBe(true);
    await act(async () => finish(response({ budget })));
    let save;
    await act(async () => { save = button("Save").props.onClick(); });
    expect(button("Save").props.disabled).toBe(true);
    expect(button("Reset usage now").props.disabled).toBe(true);
    fetch.mockImplementation(async () => response({ budget }));
    await act(async () => { finish(response({ budget })); await save; });
  });
  it("loads the sanitized account budget and displays tracked usage and unknown coverage", async () => {
    const fetch = vi.fn(async () => response({ budget })); vi.stubGlobal("fetch", fetch);
    await mount();
    expect(fetch).toHaveBeenCalledWith("/api/providers/account-one/token-budget", expect.objectContaining({ method: "GET", cache: "no-store" }));
    expect(field("Token limit").props.value).toBe("1000");
    expect(text()).toContain("1,001");
    expect(text()).toContain("2");
    expect(text()).toContain("unknown usage");
    expect(text()).toContain("not upstream billed tokens");
    expect(text()).toContain("Soft cap");
    expect(text()).toContain("can exceed");
  });
});
