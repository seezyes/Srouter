import { readFileSync } from "node:fs";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { loadBindings, transform } from "next/dist/build/swc/index.js";
import { describe, it, expect, vi } from "vitest";
import * as configUtils from "@/shared/utils/srouterSearchConfig";
import * as connectionUtils from "@/shared/utils/srouterSearchConnection";

const Stub = ({ children }) => React.createElement("div", null, children);
async function compile(file, imports) {
  await loadBindings();
  const source = readFileSync(new URL(`../../src/shared/components/${file}`, import.meta.url), "utf8");
  const { code } = await transform(source, {
    filename: file,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" },
  });
  const compiledModule = { exports: {} };
  const dependencies = {
    react: React, "react/jsx-runtime": jsxRuntime,
    "next/link": { default: ({ href, children }) => React.createElement("a", { href }, children) },
    "next/dynamic": { default: () => Stub },
    "@/shared/components": { Badge: Stub, Button: Stub, Card: Stub, Toggle: Stub },
    "@/shared/utils/webProviderCards": { getWebProviders: () => [] },
    "@/shared/utils/srouterSearchConfig": configUtils,
    "@/shared/utils/srouterSearchConnection": connectionUtils,
    "./Modal": { default: Stub }, "./Button": { default: Stub },
    ...imports,
  };
  new Function("module", "exports", "require", code)(compiledModule, compiledModule.exports, (id) => {
    if (!(id in dependencies)) throw new Error(`Unexpected import ${id}`);
    const value = dependencies[id];
    return value && "default" in value ? { ...value, __esModule: true } : value;
  });
  return compiledModule.exports.default;
}
function find(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) { const result = find(child, predicate); if (result) return result; }
  } else if (node && typeof node === "object") {
    if (predicate(node.props || {})) return node;
    return find(node.props?.children, predicate);
  }
  return null;
}

describe("SrouterSearch save/connect UI behavior (offline hook fixture)", () => {
  it("shows a draft until Save succeeds, then reloads the enabled saved value", async () => {
    const state = [], effects = [];
    let index = 0;
    let persisted = { ...configUtils.DEFAULT_SROUTER_SEARCH };
    const fetch = vi.fn(async (url, init = {}) => {
      if (init.method === "PATCH") {
        persisted = JSON.parse(init.body).srouterSearch;
        return Response.json({ srouterSearch: persisted });
      }
      if (url === "/api/settings") return Response.json({ srouterSearch: persisted });
      if (url === "/api/combos") return Response.json({ combos: [] });
      return Response.json({ nodes: [] });
    });
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("window", { location: { origin: "http://localhost:20129" } });
    const hooks = {
      ...React,
      useState(initial) {
        const slot = index++;
        if (!(slot in state)) state[slot] = initial;
        return [state[slot], (value) => { state[slot] = typeof value === "function" ? value(state[slot]) : value; }];
      },
      useEffect(effect) { if (!effects.length) effects.push(effect); },
    };
    try {
      const Page = await compile("capability-pages/SrouterSearchPage.js", { react: hooks });
      const render = () => { index = 0; return Page(); };
      render();
      effects[0]();
      await vi.waitFor(() => expect(state[6]).toBe(false)); // loading after GETs
      let tree = render();
      expect(find(tree, (p) => p.label === "Enable SrouterSearch MCP").props.checked).toBe(false);
      find(tree, (p) => p.label === "Enable SrouterSearch MCP").props.onChange(true);
      tree = render();
      expect(find(tree, (p) => typeof p.children === "string" && p.children.startsWith("Unsaved changes."))).toBeTruthy();
      expect(persisted.enabled).toBe(false);
      await find(tree, (p) => p.children === "Save settings").props.onClick();
      tree = render();
      expect(persisted.enabled).toBe(true);
      expect(find(tree, (p) => typeof p.children === "string" && p.children.startsWith("Unsaved changes."))).toBeNull();
      expect(find(tree, (p) => p.children === "Save settings").props.disabled).toBe(true);
      state.length = 0;
      effects.length = 0;
      render();
      effects[0]();
      await vi.waitFor(() => expect(state[6]).toBe(false));
      expect(find(render(), (p) => p.label === "Enable SrouterSearch MCP").props.checked).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  it("renders clear HTTP/auth/unsupported transport instructions without real keys", async () => {
    const Modal = await compile("SrouterSearchConnectModal.js");
    const html = renderToStaticMarkup(React.createElement(Modal, {
      origin: "http://localhost:20129", enabled: false, dirty: true, onClose: () => {},
    }));
    expect(html).toContain("Save your pending settings before connecting");
    expect(html).toContain("HTTP (streamable)");
    expect(html).toContain("http://localhost:20129/v1/mcp/search");
    expect(html).toContain("Authorization: Bearer");
    expect(html).toContain("A URL alone is not enough");
    expect(html).toContain("not supported directly");
    expect(html).toContain("Prompt for your agent");
    expect(html).toContain("only when the harness runs on this machine");
  });
});
