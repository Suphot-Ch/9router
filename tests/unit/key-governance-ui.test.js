import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Exercise the real JSX and handlers without starting a Next server. The optional
// renderer can be installed outside the worktree; no app dependency is changed.
const require = createRequire(import.meta.url);
const rendererPath = process.env.GOVERNANCE_REACT_RENDERER || "react-test-renderer";
const rendererRequire = createRequire(require.resolve(rendererPath));
const React = rendererRequire("react");
const { create, act } = require(rendererPath);
const { transformSync } = require("next/dist/build/swc");
const root = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} }; cache.set(file, mod);
  const { code } = transformSync(readFileSync(file, "utf8"), {
    filename: file, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" },
  });
  const localRequire = (name) => {
    if (name === "react" || name.startsWith("react/")) return rendererRequire(name);
    if (name === "@/store/settingsStore") return { getState: () => ({ fetchSettings: async () => ({ requireLogin: true, hasPassword: true }) }) };
    if (name === "@/shared/components") return {
      ...Object.fromEntries(["Button", "Input", "Card", "Toggle", "Modal"].map((component) => [component, load(resolve(root, `src/shared/components/${component}.js`)).default])),
      ConfirmModal: load(resolve(root, "src/shared/components/Modal.js")).ConfirmModal,
      ModelSelectModal: function ModelSelectModal() { return null; },
    };
    if (name.startsWith("@/")) return load(resolve(root, "src", name.slice(2)) + (name.endsWith(".js") ? "" : ".js"));
    if (name.startsWith(".")) return load(resolve(dirname(file), name) + (name.endsWith(".js") ? "" : ".js"));
    return require(name);
  };
  new Function("require", "module", "exports", code)(localRequire, mod, mod.exports);
  return mod.exports;
}
let tree;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const key = { id: "key-one", name: "Test key", rpmLimit: 0, tpmLimit: 0, accessMode: "local", accessGroupId: null, access: { restricted: false, allow: [] }, alertsEnabled: true, alertThresholds: [80, 90, 100] };
const response = (data, ok = true) => ({ ok, json: async () => data });
const nodes = (type) => tree.root.findAllByType(type);
const button = (label) => nodes("button").find((n) => n.props["aria-label"] === label || n.children.join("") === label);
const field = (label) => nodes("input").find((n) => n.props["aria-label"] === label);
async function mountGroups() {
  const UI = load(resolve(root, "src/app/(dashboard)/dashboard/endpoint/components/AccessGroupSettings.js")).default;
  await act(async () => { tree = create(React.createElement(UI)); });
}
async function mount(props = {}) {
  const UI = load(resolve(root, "src/app/(dashboard)/dashboard/endpoint/components/KeyGovernance.js")).default;
  await act(async () => { tree = create(React.createElement(UI, { apiKey: key, onSaved: vi.fn(), ...props })); });
}
afterEach(async () => { if (tree) await act(async () => tree.unmount()); tree = null; vi.unstubAllGlobals(); });

describe("native key governance", () => {
  it("refreshes actual key choices and server effective access after leaving Group Settings", async () => {
    const listeners = new Map();
    vi.stubGlobal("window", { location: new URL("http://localhost/dashboard/endpoint?tab=groups&keep=1"), history: { pushState: vi.fn() }, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) });
    vi.stubGlobal("document", { body: { style: {} }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    let groups = [{ id: "team", name: "Team", memberCount: 0, access: { restricted: true, allow: ["old-model"] } }];
    let snapshot = { ...key, accessMode: "group", accessGroupId: "team", effectiveAccess: { restricted: true, allow: ["old-model"] } };
    const fetch = vi.fn(async (url) => {
      if (url === "/api/access-groups") return response({ groups });
      if (url === "/api/keys") return response({ keys: [snapshot] });
      if (url.includes("alerts?")) return response({ alerts: [] });
      if (url === "/api/tunnel/status") return response({});
      throw new Error(`Unexpected call ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    const UI = load(resolve(root, "src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js")).default;
    await act(async () => { tree = create(React.createElement(UI, { machineId: "test-machine" })); });
    expect(fetch.mock.calls.some(([url]) => url === "/api/keys")).toBe(false);
    const selectTab = async (label) => act(async () => nodes("button").find((n) => n.props.role === "tab" && n.children.join("") === label).props.onClick());
    await selectTab("Keys");
    expect(JSON.stringify(tree.toJSON())).toContain("old-model");
    await selectTab("Group Settings");
    groups = [{ ...groups[0], name: "Renamed team", access: { restricted: true, allow: ["new-model"] } }];
    snapshot = { ...snapshot, effectiveAccess: { restricted: true, allow: ["new-model"] } };
    await selectTab("Keys");
    expect(JSON.stringify(tree.toJSON())).toContain("new-model");
    expect(JSON.stringify(tree.toJSON())).not.toContain("old-model");
    expect(nodes("option").some((n) => n.children.join("") === "Renamed team")).toBe(true);
    expect(button("New access group")).toBeUndefined();
    expect(fetch.mock.calls.filter(([url]) => url === "/api/keys")).toHaveLength(2);
    expect(fetch.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it("keeps group action labels compact when group names are long", async () => {
    const name = "group-with-a-long-unbroken-name-".repeat(6);
    vi.stubGlobal("fetch", vi.fn(async () => response({ groups: [{ id: "long", name, memberCount: 0, access: { restricted: true, allow: [] } }] })));
    await mountGroups();
    const edit = nodes("button").find((n) => n.props["aria-label"] === `Edit ${name}`);
    expect(edit.children.join("")).toBe("Edit");
    expect(edit.props.className.includes("min-h-11")).toBe(true);
  });
  it("finishes the Keys refresh under React StrictMode effect replay", async () => {
    let finish;
    const refresh = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    vi.stubGlobal("window", { location: new URL("http://localhost/dashboard/endpoint?tab=keys"), addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const UI = load(resolve(root, "src/app/(dashboard)/dashboard/endpoint/components/EndpointTabs.js")).default;
    await act(async () => { tree = create(React.createElement(React.StrictMode, null, React.createElement(UI, { onKeysSelected: refresh }, "Keys ready"))); });
    await act(async () => finish());
    expect(JSON.stringify(tree.toJSON()).includes("Keys ready")).toBe(true);
  });
  it("deep links Group Settings without keys and supports tab keyboard/history navigation", async () => {
    const file = resolve(root, "src/app/(dashboard)/dashboard/endpoint/components/EndpointTabs.js");
    expect(existsSync(file)).toBe(true);
    let location = new URL("http://localhost/dashboard/endpoint?keep=1&tab=groups#section");
    const listeners = new Map();
    const focus = vi.fn();
    const win = { get location() { return location; }, history: { pushState: vi.fn((_state, _unused, url) => { location = new URL(url, location); }) }, addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: (name) => listeners.delete(name) };
    vi.stubGlobal("window", win);
    vi.stubGlobal("fetch", vi.fn(async () => response({ groups: [] })));
    const refresh = vi.fn(async () => {});
    await act(async () => { tree = create(React.createElement(load(file).default, { onKeysSelected: refresh }, React.createElement("p", null, "Key content")), { createNodeMock: () => ({ focus }) }); });
    const tabs = () => nodes("button").filter((n) => n.props.role === "tab");
    expect(tabs().map((n) => n.props["aria-selected"])).toEqual([false, true]);
    expect(JSON.stringify(tree.toJSON())).not.toContain("Key content");
    expect(button("New access group")).toBeDefined();
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => tabs()[1].props.onKeyDown({ key: "ArrowRight", preventDefault: vi.fn() }));
    expect(focus).toHaveBeenCalled();
    expect(location.searchParams.get("tab")).toBe("keys");
    expect(location.searchParams.get("keep")).toBe("1");
    expect(location.hash).toBe("#section");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(tree.toJSON())).toContain("Key content");
    location = new URL("http://localhost/dashboard/endpoint?keep=1&tab=groups");
    await act(async () => listeners.get("popstate")());
    expect(tabs().map((n) => n.props["aria-selected"])).toEqual([false, true]);
    expect(nodes("section").some((n) => n.props.role === "tabpanel" && n.props["aria-labelledby"] === tabs()[1].props.id)).toBe(true);
    await act(async () => tabs()[1].props.onKeyDown({ key: "Home", preventDefault: vi.fn() }));
    expect(refresh).toHaveBeenCalledTimes(2);
  });
  it("provides shared group management without requiring a key", async () => {
    const file = resolve(root, "src/app/(dashboard)/dashboard/endpoint/components/AccessGroupSettings.js");
    expect(existsSync(file)).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => response({ groups: [{ id: "team", name: "Team", memberCount: 3, access: { restricted: true, allow: [] } }] })));
    await act(async () => { tree = create(React.createElement(load(file).default)); });
    expect(JSON.stringify(tree.toJSON())).toContain("3 keys");
    expect(button("New access group")).toBeDefined();
    expect(button("Edit Team")).toBeDefined();
    expect(button("Delete Team")).toBeDefined();
  });
  it("keeps shared group management out of each key policy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ groups: [], alerts: [] })));
    await mount();
    expect(button("New access group")).toBeUndefined();
    expect(nodes("select").some((n) => n.props["aria-label"] === "Access group")).toBe(true);
  });
  it("extends the existing Endpoint key card without replacing native budget or local-access controls", () => {
    const page = readFileSync(resolve(root, "src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js"), "utf8");
    expect(page).toContain("<EndpointTabs onKeysSelected={fetchData}>");
    expect(page).not.toContain("    fetchData();\n    loadSettings();");
    expect(page).toContain("<KeyGovernance");
    expect(page.includes("group flex flex-col sm:flex-row")).toBe(true);
    expect(page.includes('className="w-full flex-1 min-w-0"')).toBe(true);
    expect(page).toContain("<KeyAccessControls");
    expect(page).toContain("<KeyLimitsSummary");
    expect(page).toContain("<KeyLimitsModal");
    expect(page).toContain("onSaved={(updatedKey) => handleLimitsSaved(key.id, updatedKey)}");
  });

  it("shows loading, empty and retriable inbox/group errors without inventing counts", async () => {
    const pending = [];
    const fetch = vi.fn(() => new Promise((r) => { pending.push(r); }));
    vi.stubGlobal("fetch", fetch);
    await mount();
    expect(JSON.stringify(tree.toJSON())).toContain("Loading budget alerts");
    expect(JSON.stringify(tree.toJSON())).toContain("Loading access groups");
    await act(async () => pending.forEach((finish) => finish(response({ error: "Inbox unavailable" }, false))));
    expect(JSON.stringify(tree.toJSON())).toContain("Inbox unavailable");
    fetch.mockImplementation(async () => response({ alerts: [], groups: [] }));
    await act(async () => button("Refresh inbox").props.onClick());
    expect(JSON.stringify(tree.toJSON())).toContain("No budget alerts for this key");
  });

  it("retains a referenced group when deletion is rejected and preserves unacknowledged alerts on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, o) => {
      if (o?.method === "DELETE") return response({ error: "Group is referenced by a key" }, false);
      if (o?.method === "PATCH") return response({ error: "Acknowledgement failed" }, false);
      if (url === "/api/access-groups") return response({ groups: [{ id: "team", name: "Team", access: { restricted: true, allow: [] } }] });
      return response({ alerts: [{ id: "a", keyId: key.id, metric: "tokens", threshold: 90, used: 90, limit: 100, period: "p", createdAt: "2026-11-09T00:00:00Z" }] });
    }));
    await mountGroups();
    await act(async () => button("Delete Team").props.onClick());
    await act(async () => button("Confirm delete group").props.onClick());
    expect(JSON.stringify(tree.toJSON())).toContain("Group is referenced by a key");
    expect(button("Delete Team")).toBeDefined();
    await act(async () => tree.unmount());
    await mount();
    await act(async () => button("Acknowledge alert").props.onClick());
    expect(JSON.stringify(tree.toJSON())).toContain("Acknowledgement failed");
    expect(button("Acknowledge alert")).toBeDefined();
  });

  it("does not mutate alerts while a save is in flight", async () => {
    let finish;
    vi.stubGlobal("fetch", vi.fn(async (url, o) => {
      if (o?.method === "PATCH") return new Promise((r) => { finish = r; });
      if (url === "/api/access-groups") return response({ groups: [] });
      return response({ alerts: [] });
    }));
    await mount();
    let save;
    await act(async () => { save = button("Save alert settings").props.onClick(); });
    expect(button("Save alert settings").props.disabled).toBe(true);
    await act(async () => { finish(response({ error: "Try again" }, false)); await save; });
    expect(button("Save alert settings").props.disabled).toBe(false);
    expect(JSON.stringify(tree.toJSON())).toContain("Try again");
  });

  it("keeps local policy intact while saving group intersection and handles group CRUD through APIs", async () => {
    let groups = [{ id: "team", name: "Team", access: { restricted: true, allow: ["combo-a"] } }];
    let persisted = { ...key };
    const saved = vi.fn();
    const fetch = vi.fn(async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : {};
      if (url === "/api/access-groups" && options?.method === "POST") { groups = [...groups, { id: "new-team", ...body }]; return response({ group: groups.at(-1) }); }
      if (url === "/api/access-groups/new-team" && options?.method === "PUT") { groups = groups.map((g) => g.id === "new-team" ? { ...g, ...body } : g); return response({ group: groups.at(-1) }); }
      if (url === "/api/access-groups/new-team" && options?.method === "DELETE") { groups = groups.filter((g) => g.id !== "new-team"); return response({ success: true }); }
      if (url === "/api/access-groups") return response({ groups });
      if (options?.method === "PATCH") { persisted = { ...persisted, ...body }; return response({ key: persisted }); }
      if (url === "/api/keys/key-one") return response({ key: persisted });
      return response({ alerts: [] });
    });
    vi.stubGlobal("fetch", fetch);
    await mount({ onSaved: saved });
    const mode = nodes("select").find((n) => n.props["aria-label"] === "Access policy mode");
    await act(async () => mode.props.onChange({ target: { value: "intersection" } }));
    await act(async () => nodes("select").find((n) => n.props["aria-label"] === "Access group").props.onChange({ target: { value: "team" } }));
    await act(async () => button("Save access policy").props.onClick());
    expect(JSON.parse(fetch.mock.calls.find(([, o]) => o?.method === "PATCH")[1].body)).toEqual({ accessMode: "intersection", accessGroupId: "team" });
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ access: key.access, accessMode: "intersection" }));
    await act(async () => tree.unmount());
    await mountGroups();
    await act(async () => button("New access group").props.onClick());
    await act(async () => field("Group name").props.onChange({ target: { value: "New team" } }));
    await act(async () => button("Create group").props.onClick());
    expect(fetch.mock.calls.some(([, o]) => o?.method === "POST")).toBe(false);
    await act(async () => button("Confirm save group").props.onClick());
    expect(fetch.mock.calls.some(([, o]) => o?.method === "POST" && JSON.parse(o.body).access.restricted === true)).toBe(true);
    expect(JSON.stringify(tree.toJSON())).toContain("New team");
    await act(async () => button("Edit New team").props.onClick());
    await act(async () => field("Group name").props.onChange({ target: { value: "Renamed" } }));
    await act(async () => button("Save group").props.onClick());
    await act(async () => button("Confirm save group").props.onClick());
    expect(JSON.stringify(tree.toJSON())).toContain("Renamed");
    await act(async () => button("Delete Renamed").props.onClick());
    await act(async () => button("Confirm delete group").props.onClick());
    expect(JSON.stringify(tree.toJSON())).not.toContain("Delete Renamed");
    expect(fetch.mock.calls.filter(([url, o]) => url === "/api/access-groups" && !o?.method).length).toBeGreaterThanOrEqual(4);
  });

  it("saves budget alert settings separately and acknowledges only after a fresh inbox read", async () => {
    let alerts = [{ id: "alert-one", keyId: key.id, metric: "cost", threshold: 80, used: 8, limit: 10, period: "2026-11", createdAt: "2026-11-09T00:00:00Z", acknowledgedAt: null }];
    let persisted = key;
    const fetch = vi.fn(async (url, o) => {
      if (url === "/api/access-groups") return response({ groups: [] });
      if (url.startsWith("/api/keys/alerts?")) return response({ alerts });
      if (url === "/api/keys/alerts/alert-one" && o?.method === "PATCH") { alerts = alerts.map((a) => ({ ...a, acknowledgedAt: "2026-11-09T01:00:00Z" })); return response({ alert: alerts[0] }); }
      if (o?.method === "PATCH") { persisted = { ...persisted, ...JSON.parse(o.body) }; return response({ key: persisted }); }
      return response({ key: persisted });
    });
    vi.stubGlobal("fetch", fetch);
    await mount();
    await act(async () => field("Budget alert thresholds (%)").props.onChange({ target: { value: "100, 75, 75" } }));
    await act(async () => button("Save alert settings").props.onClick());
    expect(JSON.parse(fetch.mock.calls.find(([u, o]) => u === "/api/keys/key-one" && o?.method === "PATCH")[1].body)).toEqual({ alertsEnabled: true, alertThresholds: [75, 100] });
    expect(JSON.stringify(tree.toJSON())).toContain("80% cost budget");
    await act(async () => button("Acknowledge alert").props.onClick());
    expect(fetch).toHaveBeenCalledWith("/api/keys/alerts/alert-one", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ acknowledged: true }) }));
    expect(JSON.stringify(tree.toJSON())).toContain("Acknowledged");
    expect(button("Acknowledge alert")).toBeUndefined();
    expect(fetch.mock.calls.filter(([url]) => url.startsWith("/api/keys/alerts?")).length).toBe(2);
  });

  it("shows unknown rate coverage honestly and displays server-observed counters only", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ groups: [], alerts: [] })));
    await mount({ apiKey: { ...key, rateStatus: { warmingUp: true, rpm: { used: 3 }, tpm: { used: null, coverage: "incomplete", unknownEvents: 2 }, inFlight: 4, deploymentConfigured: false } } });
    const output = JSON.stringify(tree.toJSON());
    expect(output).toContain("3 requests observed");
    expect(output).toContain("TPM usage unknown");
    expect(output).toContain("incomplete");
    expect(output).toContain("4 in-flight");
    expect(output).toContain("Warming up");
    expect(output).toContain("not confirmed");
  });

  it("shows server effective allowlist rather than inferring permissions from the selected draft", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ groups: [], alerts: [] })));
    await mount({ apiKey: { ...key, effectiveAccess: { restricted: true, allow: ["combo-effective"] } } });
    expect(JSON.stringify(tree.toJSON()).includes("combo-effective")).toBe(true);
    await act(async () => nodes("select").find((n) => n.props["aria-label"] === "Access policy mode").props.onChange({ target: { value: "group" } }));
    expect(JSON.stringify(tree.toJSON()).includes("combo-effective")).toBe(true);
    expect(JSON.stringify(tree.toJSON())).toContain("Server effective access");
  });

  it("renders composite intersection policies without falsely claiming an empty effective allowlist", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ groups: [], alerts: [] })));
    await mount({ apiKey: { ...key, accessMode: "intersection", effectiveAccess: { mode: "intersection", restricted: true, allow: null, policies: [{ restricted: true, allow: ["combo-effective"] }, { restricted: true, allow: ["provider/*"] }] } } });
    const output = JSON.stringify(tree.toJSON());
    expect(output.includes("combo-effective")).toBe(true);
    expect(output.includes("provider/*")).toBe(true);
    expect(output.includes("No combos or models allowed — access denied.")).toBe(false);
    expect(output.includes("All policies below must allow")).toBe(true);
  });

  it("rejects invalid alert thresholds without a write and reports failed readback without claiming saved", async () => {
    const saved = vi.fn();
    const fetch = vi.fn(async (url, o) => {
      if (url === "/api/access-groups") return response({ groups: [] });
      if (url.includes("alerts?")) return response({ alerts: [] });
      return o?.method === "PATCH" ? response({ key }) : response({ error: "Readback unavailable" }, false);
    });
    vi.stubGlobal("fetch", fetch);
    await mount({ onSaved: saved });
    for (const value of ["", "0", "101", "80.5", "80,"]) {
      await act(async () => field("Budget alert thresholds (%)").props.onChange({ target: { value } }));
      await act(async () => button("Save alert settings").props.onClick());
      expect(JSON.stringify(tree.toJSON())).toContain("whole percentages");
    }
    expect(fetch.mock.calls.some(([, o]) => o?.method)).toBe(false);
    await act(async () => button("Save minute limits").props.onClick());
    expect(saved).not.toHaveBeenCalled();
    expect(JSON.stringify(tree.toJSON())).toContain("Readback unavailable");
    expect(JSON.stringify(tree.toJSON())).not.toContain("Saved minute limits");
  });

  it("uses the existing native access editor to restrict a new group without granting permissions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ groups: [], alerts: [] })));
    await mount();
    await act(async () => tree.unmount());
    await mountGroups();
    await act(async () => button("New access group").props.onClick());
    const toggle = nodes("button").find((n) => n.props.role === "switch");
    expect(toggle.props["aria-checked"]).toBe(true);
    expect(nodes("label").some((n) => n.props["aria-label"] === "Restrict access")).toBe(true);
    expect(JSON.stringify(tree.toJSON())).toContain("No combos or models allowed");
    expect(JSON.stringify(tree.toJSON())).toContain("this group allows nothing");
  });

  it("does not claim acknowledgement when readback still shows an unacknowledged alert", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, o) => {
      if (url === "/api/access-groups") return response({ groups: [] });
      if (o?.method) return response({ alert: { id: "a", acknowledgedAt: "2026-11-09T01:00:00Z" } });
      return response({ alerts: [{ id: "a", keyId: key.id, metric: "cost", threshold: 80, period: "p", createdAt: "2026-11-09T00:00:00Z", acknowledgedAt: null }] });
    }));
    await mount();
    await act(async () => button("Acknowledge alert").props.onClick());
    expect(JSON.stringify(tree.toJSON()).includes("Acknowledged alert")).toBe(false);
    expect(JSON.stringify(tree.toJSON()).includes("not confirmed")).toBe(true);
  });

  it("rejects fractional and unsafe minute values rather than silently coercing them", async () => {
    const fetch = vi.fn(async () => response({ groups: [] })); vi.stubGlobal("fetch", fetch);
    await mount();
    for (const value of ["1.5", "-1", "9007199254740992"]) {
      await act(async () => field("Requests per minute (RPM)").props.onChange({ target: { value } }));
      await act(async () => button("Save minute limits").props.onClick());
      expect(nodes("p").some((p) => p.props.role === "alert")).toBe(true);
    }
    expect(fetch.mock.calls.some(([, o]) => o?.method === "PATCH")).toBe(false);
  });

  it("does not present a rejected save as persisted", async () => {
    const saved = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (_url, o) => o?.method ? response({ error: "Permission denied" }, false) : response({ groups: [] })));
    await mount({ onSaved: saved });
    await act(async () => button("Save minute limits").props.onClick());
    expect(JSON.stringify(tree.toJSON())).toContain("Permission denied");
    expect(saved).not.toHaveBeenCalled();
    expect(button("Save minute limits").props.disabled).toBe(false);
  });
  
  it("saves integer minute limits without resetting period budgets and reads the persisted key back", async () => {
    const saved = vi.fn();
    const fetch = vi.fn(async (url, options) => {
      if (options?.method === "PATCH") return response({ key: { ...key, rpmLimit: 12, tpmLimit: 600 } });
      if (url === "/api/keys/key-one") return response({ key: { ...key, rpmLimit: 12, tpmLimit: 600 } });
      if (url.startsWith("/api/access-groups")) return response({ groups: [] });
      return response({ alerts: [] });
    });
    vi.stubGlobal("fetch", fetch);
    await mount({ onSaved: saved });
    await act(async () => { field("Requests per minute (RPM)").props.onChange({ target: { value: "12" } }); });
    await act(async () => { field("Tokens per minute (TPM)").props.onChange({ target: { value: "600" } }); });
    await act(async () => { await button("Save minute limits").props.onClick(); });
    const write = fetch.mock.calls.find(([, options]) => options?.method === "PATCH");
    expect(JSON.parse(write[1].body)).toEqual({ rpmLimit: 12, tpmLimit: 600 });
    expect(fetch).toHaveBeenCalledWith("/api/keys/key-one", expect.objectContaining({ cache: "no-store" }));
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ rpmLimit: 12, tpmLimit: 600 }));
    expect(JSON.stringify(tree.toJSON())).toContain("Saved minute limits");
  });
});
