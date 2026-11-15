import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Run the actual client JSX/handlers with deterministic catalog and network fixtures.
const require = createRequire(import.meta.url);
const rendererPath = process.env.GOVERNANCE_REACT_RENDERER || "react-test-renderer";
const rendererRequire = createRequire(require.resolve(rendererPath));
const React = rendererRequire("react");
const { create, act } = require(rendererPath);
const { transformSync } = require("next/dist/build/swc");
const root = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const cache = new Map();
const getCaps = () => ({ contextWindow: 128000, maxOutput: 16000 });
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} }; cache.set(file, mod);
  const { code } = transformSync(readFileSync(file, "utf8"), {
    filename: file, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" },
  });
  const localRequire = (name) => {
    if (name === "react" || name.startsWith("react/")) return rendererRequire(name);
    if (name === "@/shared/hooks/useModelCaps") return { useModelCaps: () => ({ getCaps }) };
    if (name.includes("ModelSelectModal")) return { default: () => null };
    if (name.startsWith("@dnd-kit/")) return {
      DndContext: ({ children }) => children, SortableContext: ({ children }) => children,
      useSensors: () => [], useSensor: () => ({}), useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {} }),
      CSS: { Transform: { toString: () => undefined } }, arrayMove: (a, from, to) => { const b = [...a]; b.splice(to, 0, b.splice(from, 1)[0]); return b; },
    };
    if (name === "@/shared/components") return {
      ...Object.fromEntries(["Button", "Input", "Card", "Toggle", "Modal", "Select", "Badge"].map((component) => [component, load(resolve(root, `src/shared/components/${component}.js`)).default])),
      ConfirmModal: load(resolve(root, "src/shared/components/Modal.js")).ConfirmModal,
      ModelSelectModal: () => null, CapacityBadges: () => null, SmartPolicyModal: () => null, CardSkeleton: () => null,
    };
    if (name.startsWith("@/")) return load(resolve(root, "src", name.slice(2)) + (name.endsWith(".js") ? "" : ".js"));
    if (name.startsWith(".")) return load(resolve(dirname(file), name) + (name.endsWith(".js") ? "" : ".js"));
    if (name.startsWith("open-sse/")) return load(resolve(root, name));
    return require(name);
  };
  new Function("require", "module", "exports", code)(localRequire, mod, mod.exports);
  return mod.exports;
}
let tree;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const response = (data, ok = true) => ({ ok, json: async () => data });
const nodes = (type) => tree.root.findAllByType(type);
const button = (label) => nodes("button").find((n) => n.props.title === label || n.props["aria-label"] === label || n.children.join("") === label);
const contextField = () => nodes("input").find((n) => n.props["aria-label"] === "Context window (tokens)");
const changeContext = async (value) => act(async () => contextField().props.onChange({ target: { value } }));
const outputField = () => nodes("input").find((n) => n.props["aria-label"] === "Max output (tokens)");
const changeOutput = async (value) => act(async () => outputField().props.onChange({ target: { value } }));
async function mountShared(props = {}) {
  const UI = load(resolve(root, "src/shared/components/ComboFormModal.js")).default;
  await act(async () => { tree = create(React.createElement(UI, { isOpen: true, onClose: vi.fn(), activeProviders: [], ...props })); });
}
beforeEach(() => {
  vi.stubGlobal("document", { body: { style: {} }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("fetch", vi.fn(async () => response({ aliases: {} })));
});
afterEach(async () => { if (tree) await act(async () => tree.unmount()); tree = null; vi.unstubAllGlobals(); });

describe("combo context configuration", () => {
  it("edits max output independently with safe validation, Auto reset, and visible save failures", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error("maxOutputTokens rejected")).mockResolvedValue(undefined);
    await mountShared({ combo: { name: "limits", models: [], contextLength: 256000, maxOutputTokens: 32000 }, onSave });
    const outputField = () => nodes("input").find((n) => n.props["aria-label"] === "Max output (tokens)");
    expect(outputField()).toBeDefined();
    expect(outputField().props.value).toBe("32000");
    expect(nodes("label").some((n) => n.props.htmlFor === outputField().props.id)).toBe(true);
    for (const value of ["0", "-1", "1.5", "1e6", "abc", "9007199254740992"]) {
      await act(async () => outputField().props.onChange({ target: { value } }));
      expect(outputField().props["aria-invalid"]).toBe(true);
      expect(button("Save").props.disabled).toBe(true);
      await act(async () => button("Save").props.onClick());
      expect(onSave).not.toHaveBeenCalled();
      expect(JSON.stringify(tree.toJSON())).toContain("positive safe integer");
    }
    await act(async () => outputField().props.onChange({ target: { value: "64000" } }));
    await act(async () => button("Save").props.onClick());
    expect(onSave).toHaveBeenLastCalledWith({ name: "limits", models: [], contextLength: 256000, maxOutputTokens: 64000 });
    expect(nodes("p").some((n) => n.props.role === "alert" && n.children.join("").includes("maxOutputTokens rejected"))).toBe(true);
    expect(outputField().props.value).toBe("64000");
    await changeContext("");
    await act(async () => button("Save").props.onClick());
    expect(onSave).toHaveBeenLastCalledWith({ name: "limits", models: [], contextLength: null, maxOutputTokens: 64000 });
    await act(async () => outputField().props.onChange({ target: { value: "" } }));
    await act(async () => button("Save").props.onClick());
    expect(onSave).toHaveBeenLastCalledWith({ name: "limits", models: [], contextLength: null, maxOutputTokens: null });
    expect(JSON.stringify(tree.toJSON())).toContain("max_tokens");
    expect(JSON.stringify(tree.toJSON())).toContain("truncate");
  });
  it("wires native cards, copy, create and edit to independent nullable context/output metadata and displays API errors", async () => {
    let combos = [
      { id: "auto", name: "auto", models: ["test/model"], contextLength: null, maxOutputTokens: null },
      { id: "manual", name: "manual", models: ["test/model"], contextLength: 256000, maxOutputTokens: 32000 },
    ];
    const writes = [];
    let reject = false;
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => {}) } });
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      if (options?.method) {
        const body = JSON.parse(options.body); writes.push({ url, method: options.method, body });
        if (reject) return response({ error: "contextLength not accepted" }, false);
        if (options.method === "POST") combos = [...combos, { id: "created", ...body }];
        else combos = combos.map((c) => url.endsWith(c.id) ? { ...c, ...body } : c);
        return response({});
      }
      if (url === "/api/combos") return response({ combos });
      if (url === "/api/providers") return response({ connections: [] });
      return response({ aliases: {} });
    }));
    const UI = load(resolve(root, "src/app/(dashboard)/dashboard/combos/page.js")).default;
    await act(async () => { tree = create(React.createElement(UI)); });
    const texts = () => nodes("span").map((n) => n.children.join(""));
    expect(texts()).toContain("ctx Auto · 128k");
    expect(texts()).toContain("ctx Manual · 256k");
    expect(texts()).toContain("max Auto · 16k");
    expect(texts()).toContain("max Manual · 32k");
    await act(async () => button("Copy combo name").props.onClick({ stopPropagation: vi.fn() }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("auto");
    await act(async () => nodes("button").find((n) => n.children.some((c) => c === "Create Combo")).props.onClick());
    await act(async () => nodes("input").find((n) => n.props.placeholder === "my-combo").props.onChange({ target: { value: "created" } }));
    await changeContext("512000");
    await changeOutput("64000");
    await act(async () => button("Create").props.onClick());
    expect(writes.at(-1)).toEqual({ url: "/api/combos", method: "POST", body: { name: "created", models: [], contextLength: 512000, maxOutputTokens: 64000 } });
    await act(async () => nodes("button").filter((n) => n.props.title === "Edit")[1].props.onClick());
    expect(contextField().props.value).toBe("256000");
    expect(outputField().props.value).toBe("32000");
    const writesBeforeInvalid = writes.length;
    await changeContext("1.5");
    expect(button("Save").props.disabled).toBe(true);
    await act(async () => button("Save").props.onClick());
    expect(writes).toHaveLength(writesBeforeInvalid);
    await changeContext("");
    await changeOutput("9007199254740992");
    expect(button("Save").props.disabled).toBe(true);
    await act(async () => button("Save").props.onClick());
    expect(writes).toHaveLength(writesBeforeInvalid);
    expect(outputField().props["aria-invalid"]).toBe(true);
    await changeOutput("64000");
    reject = true;
    await act(async () => button("Save").props.onClick());
    expect(writes.at(-1).body.contextLength).toBeNull();
    expect(writes.at(-1).body.maxOutputTokens).toBe(64000);
    expect(nodes("p").some((n) => n.props.role === "alert" && n.children.join("").includes("contextLength not accepted"))).toBe(true);
    expect(button("Save").props.disabled).toBe(false);
    reject = false;
    await act(async () => button("Save").props.onClick());
    expect(contextField()).toBeUndefined();
    expect(texts().filter((s) => s === "ctx Auto · 128k")).toHaveLength(2);
    expect(texts().filter((s) => s === "max Manual · 64k")).toHaveLength(2);
    await act(async () => nodes("button").filter((n) => n.props.title === "Edit")[1].props.onClick());
    expect(outputField().props.value).toBe("64000");
    await changeOutput("");
    await act(async () => button("Save").props.onClick());
    expect(writes.at(-1).body).toMatchObject({ contextLength: null, maxOutputTokens: null });
    expect(texts().filter((s) => s === "max Auto · 16k")).toHaveLength(2);
  });
  it("shows small manual token values without rounding them down to zero", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => response(url === "/api/combos" ? { combos: [{ id: "tiny", name: "tiny", models: [], contextLength: 1, maxOutputTokens: 1 }] } : {})));
    const UI = load(resolve(root, "src/app/(dashboard)/dashboard/combos/page.js")).default;
    await act(async () => { tree = create(React.createElement(UI)); });
    expect(nodes("span").some((n) => n.children.join("") === "ctx Manual · 1")).toBe(true);
    expect(nodes("span").some((n) => n.children.join("") === "max Manual · 1")).toBe(true);
  });
  it("preserves manual edits, permits above-seat metadata, resets Auto, and rejects unsafe token counts", async () => {
    const onSave = vi.fn();
    await mountShared({ combo: { name: "manual", models: ["test/model"], contextLength: 256000 }, onSave });
    expect(contextField().props.value).toBe("256000");
    await act(async () => button("Save").props.onClick());
    expect(onSave).toHaveBeenLastCalledWith({ name: "manual", models: ["test/model"], contextLength: 256000, maxOutputTokens: null });
    onSave.mockClear();
    expect(JSON.stringify(tree.toJSON())).toContain("does not expand upstream");
    for (const value of ["0", "-1", "1.5", "1e6", "abc", "9007199254740992"]) {
      await changeContext(value);
      await act(async () => button("Save").props.onClick());
      expect(onSave).not.toHaveBeenCalled();
      expect(JSON.stringify(tree.toJSON())).toContain("positive safe integer");
    }
    await changeContext("512000");
    await act(async () => button("Save").props.onClick());
    expect(onSave).toHaveBeenLastCalledWith({ name: "manual", models: ["test/model"], contextLength: 512000, maxOutputTokens: null });
    await changeContext("");
    await act(async () => button("Save").props.onClick());
    expect(onSave).toHaveBeenLastCalledWith({ name: "manual", models: ["test/model"], contextLength: null, maxOutputTokens: null });
  });
  it("keeps the draft and exposes rejected saves while allowing retry", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error("contextLength rejected by server")).mockResolvedValueOnce(undefined);
    await mountShared({ combo: { name: "manual", models: [], contextLength: 128000 }, onSave });
    await changeContext("256000");
    await act(async () => button("Save").props.onClick());
    expect(nodes("p").some((n) => n.props.role === "alert" && n.children.join("").includes("contextLength rejected by server"))).toBe(true);
    expect(contextField().props.value).toBe("256000");
    expect(button("Save").props.disabled).toBe(false);
    await act(async () => button("Save").props.onClick());
    expect(onSave).toHaveBeenCalledTimes(2);
  });
  it("creates with labelled blank Auto context/output and sends explicit nulls", async () => {
    const onSave = vi.fn();
    await mountShared({ onSave });
    expect(contextField()).toBeDefined();
    expect(contextField().props.value).toBe("");
    expect(outputField().props.value).toBe("");
    expect(nodes("label").some((n) => n.props.htmlFor === contextField().props.id)).toBe(true);
    await act(async () => nodes("input").find((n) => n.props.placeholder === "my-combo").props.onChange({ target: { value: "test-auto" } }));
    await act(async () => button("Create").props.onClick());
    expect(onSave).toHaveBeenCalledWith({ name: "test-auto", models: [], contextLength: null, maxOutputTokens: null });
  });
});
