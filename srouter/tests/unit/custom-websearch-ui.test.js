// T-0045 — Web Search page UI for custom providers (offline SSR, no writes).
// Review regressions (2026-10-04): linked pin serialization and the two-step
// create flow (node retained + key error reported instead of a duplicate
// create) are covered via the modal's exported helpers with a fake fetch.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import PropTypes from "prop-types";
import { renderToStaticMarkup } from "react-dom/server";
import { loadBindings, transform } from "next/dist/build/swc/index.js";
import { describe, expect, it } from "vitest";
import * as providerConstants from "@/shared/constants/providers";
import * as webProviderCards from "@/shared/utils/webProviderCards";
import * as webProviderIcons from "@/shared/utils/webProviderIcons";
import * as capabilityRoutes from "@/shared/utils/capabilityRoutes";
import * as connectionStatus from "@/shared/utils/connectionStatus";
import * as hostedSearchProviders from "@/shared/utils/hostedSearchProviders";
import * as hostedTools from "@/shared/constants/hostedTools";

const root = resolve(import.meta.dirname, "../..");
const clientPage = "src/shared/components/capability-pages/WebProvidersPage.js";
const modalFile = "src/shared/components/AddCustomSearchProviderModal.js";
const read = (file) => readFileSync(resolve(root, file), "utf8");
const NullComponent = () => null;
const Box = ({ children, ...props }) => React.createElement("div", { ...props, "data-box": props.label || props.title || props.variant || "" }, children);
const Link = ({ href, children, ...props }) => React.createElement("a", { ...props, href }, children);

async function compile(file, imports = {}) {
  await loadBindings();
  const { code } = await transform(read(file), {
    filename: file,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" },
  });
  const compiledModule = { exports: {} };
  const dependencies = {
    react: React, "react/jsx-runtime": jsxRuntime, "prop-types": PropTypes,
    ...imports,
  };
  new Function("module", "exports", "require", code)(compiledModule, compiledModule.exports, (id) => {
    if (!(id in dependencies)) throw new Error(`Unexpected import in ${file}: ${id}`);
    const dependency = dependencies[id];
    return dependency && "default" in dependency ? { ...dependency, __esModule: true } : dependency;
  });
  return compiledModule.exports;
}

function pageImports() {
  return {
    "next/link": { default: Link },
    "@/shared/components": {
      Card: Box, Badge: Box, AddCustomSearchProviderModal: Box,
    },
    "@/shared/components/ProviderIcon": { default: NullComponent },
    "@/shared/constants/providers": providerConstants,
    "@/shared/utils/webProviderCards": webProviderCards,
    "./ProviderIcon": { default: ({ providerId }) => React.createElement("img", { src: `/providers/${providerId}.png`, alt: "" }) },
    "@/shared/utils/hostedSearchProviders": hostedSearchProviders,
    "@/shared/utils/webProviderIcons": webProviderIcons,
    "@/app/(dashboard)/dashboard/providers/components/ProviderCardGroup": { default: Box },
    "@/shared/utils/capabilityRoutes": capabilityRoutes,
    "@/shared/utils/connectionStatus": connectionStatus,
  };
}

function modalImports() {
  return {
    "next/link": { default: Link },
    "@/shared/components": { Modal: Box, Input: Box, Button: Box, Badge: Box },
    "@/shared/constants/providers": providerConstants,
    "@/shared/utils/webProviderCards": webProviderCards,
    "./ProviderIcon": { default: ({ providerId }) => React.createElement("img", { src: `/providers/${providerId}.png`, alt: "" }) },
    "@/shared/utils/hostedSearchProviders": hostedSearchProviders,
    "@/shared/constants/hostedTools": hostedTools,
  };
}

describe("Web Search page: custom provider UI (offline SSR)", () => {
  it("renders the Add custom provider action under Search Workflow and above the provider grid", async () => {
    const page = await compile(clientPage, pageImports());
    const html = renderToStaticMarkup(React.createElement(page.default));
    const mcp = html.indexOf("SrouterSearch MCP");
    const workflow = html.indexOf("Search Workflow");
    const add = html.indexOf("Add custom provider");
    const grid = html.indexOf("providers</span>");
    expect(mcp).toBeGreaterThan(-1);
    expect(workflow).toBeGreaterThan(mcp);
    expect(add).toBeGreaterThan(workflow);
    expect(grid).toBeGreaterThan(add);
  });

  it("renders the three custom provider modes in the add/edit modal", async () => {
    const modal = await compile(modalFile, modalImports());
    const html = renderToStaticMarkup(React.createElement(modal.default, { isOpen: true, onClose: () => {} }));
    expect(html).toContain("SearXNG-compatible endpoint");
    expect(html).toContain("Custom JSON search API");
    expect(html).toContain("Connected provider (hosted search tool)");
    expect(html).toContain("Base URL");
  });

  it("renders endpoint-mode custom cards with connection status and a detail link", async () => {
    const page = await compile(clientPage, pageImports());
    const node = { id: "custom-websearch-abc", type: "custom-websearch", name: "My SearXNG", mode: "searxng" };
    const html = renderToStaticMarkup(React.createElement(page.CustomProviderCard, {
      node,
      connections: [{ provider: "custom-websearch-abc", testStatus: "success", isActive: true, id: "c1" }],
    }));
    expect(html).toContain("My SearXNG");
    expect(html).toContain("Custom");
    expect(html).toContain("SearXNG");
    expect(html).toContain("/dashboard/search/webSearch/custom-websearch-abc");
  });

  it("renders linked custom cards with the source provider and account scope", async () => {
    const page = await compile(clientPage, pageImports());
    const node = {
      id: "custom-websearch-xyz", type: "custom-websearch", name: "Hosted search",
      mode: "linked", sourceProviderId: "exa", sourceConnectionId: "conn-9",
    };
    const html = renderToStaticMarkup(React.createElement(page.CustomProviderCard, {
      node,
      connections: [{ id: "conn-9", provider: "exa", name: "work account" }],
    }));
    expect(html).toContain("Linked");
    expect(html).toContain("Pinned: work account");
    expect(html).toContain("Hosted search");
  });

  it("keeps the reduced spacing between the MCP and Search Workflow cards", () => {
    const source = read(clientPage);
    expect(source).toContain('className="flex flex-col gap-2"');
    expect(source).toContain('className="flex flex-col gap-4"');
  });
});

describe("custom provider modal helpers (offline, fake fetch)", () => {
  const baseForm = {
    name: "My node",
    mode: "searxng",
    baseUrl: "https://searx.example.org",
    authHeader: "none",
    sourceProviderId: "",
    sourceConnectionId: "",
  };

  it("serializes an empty linked account as an explicit null so a previous pin is cleared", async () => {
    const modal = await compile(modalFile, modalImports());
    expect(modal.buildNodePayload({ ...baseForm, mode: "linked", baseUrl: "", sourceProviderId: "exa", sourceConnectionId: "" }))
      .toEqual({ name: "My node", mode: "linked", sourceProviderId: "exa", sourceConnectionId: null });
    expect(modal.buildNodePayload({ ...baseForm, mode: "linked", baseUrl: "", sourceProviderId: "exa", sourceConnectionId: "conn-9" }).sourceConnectionId)
      .toBe("conn-9");
  });
  it("serializes plugin mode without endpoint/model fields or a node-owned key", async () => {
    const modal = await compile(modalFile, modalImports());
    const form = { ...baseForm, mode: "plugin", sourceProviderId: "codex", sourceAdapterId: "plugin:direct", sourceModel: "ignored" };
    expect(modal.buildNodePayload(form)).toEqual({
      name: "My node", mode: "plugin", sourceProviderId: "codex", sourceConnectionId: null,
      sourceAdapterId: "plugin:direct", sourceModel: null,
    });
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ node: { id: "custom-websearch-1" } }) }));
    await modal.submitCustomSearchNode({ form, apiKey: "not-used", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends an explicit null pin on the PUT when editing a linked node without a pinned account", async () => {
    const modal = await compile(modalFile, modalImports());
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init.method, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ node: { id: "custom-websearch-1", name: "My node" } }) };
    };
    const result = await modal.submitCustomSearchNode({
      form: { ...baseForm, mode: "linked", baseUrl: "", sourceProviderId: "exa", sourceConnectionId: "" },
      apiKey: "", editNode: { id: "custom-websearch-1" }, fetchImpl,
    });
    expect(result).toEqual({ node: { id: "custom-websearch-1", name: "My node" }, keyError: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/provider-nodes/custom-websearch-1");
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].body.sourceConnectionId).toBeNull();
    expect(calls[0].body.type).toBeUndefined();
  });

  it("creates the node and its key connection on the success path", async () => {
    const modal = await compile(modalFile, modalImports());
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init.method, body: JSON.parse(init.body) });
      if (url === "/api/provider-nodes") return { ok: true, json: async () => ({ node: { id: "custom-websearch-1", name: "My node" } }) };
      return { ok: true, json: async () => ({ connection: { id: "conn-1" } }) };
    };
    const result = await modal.submitCustomSearchNode({ form: baseForm, apiKey: "secret", editNode: null, fetchImpl });
    expect(result.keyError).toBeNull();
    expect(result.node.id).toBe("custom-websearch-1");
    expect(calls.map((call) => call.url)).toEqual(["/api/provider-nodes", "/api/providers"]);
    expect(calls[0].body.type).toBe("custom-websearch");
    expect(calls[1].body).toMatchObject({ provider: "custom-websearch-1", apiKey: "secret" });
  });

  it("keeps the created node and reports a key failure instead of retrying the create", async () => {
    const modal = await compile(modalFile, modalImports());
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url === "/api/provider-nodes") return { ok: true, json: async () => ({ node: { id: "custom-websearch-1", name: "My node" } }) };
      return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
    };
    const result = await modal.submitCustomSearchNode({ form: baseForm, apiKey: "secret", editNode: null, fetchImpl });
    expect(result.node.id).toBe("custom-websearch-1");
    expect(result.keyError).toBe("boom");
    expect(calls).toEqual(["/api/provider-nodes", "/api/providers"]);
  });

  it("surfaces a thrown key request as a key error with the node retained", async () => {
    const modal = await compile(modalFile, modalImports());
    const fetchImpl = async (url) => {
      if (url === "/api/provider-nodes") return { ok: true, json: async () => ({ node: { id: "custom-websearch-1", name: "n" } }) };
      throw new Error("socket closed");
    };
    const result = await modal.submitCustomSearchNode({ form: baseForm, apiKey: "secret", editNode: null, fetchImpl });
    expect(result.node.id).toBe("custom-websearch-1");
    expect(result.keyError).toBe("socket closed");
  });

  it("throws without creating a key connection when the node request itself fails", async () => {
    const modal = await compile(modalFile, modalImports());
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return { ok: false, status: 400, json: async () => ({ error: "bad node" }) };
    };
    await expect(modal.submitCustomSearchNode({ form: baseForm, apiKey: "secret", editNode: null, fetchImpl }))
      .rejects.toThrow("bad node");
    expect(calls).toEqual(["/api/provider-nodes"]);
  });
});

describe("ordinary hosted provider picker", () => {
  it("includes Codex, API and free LLM providers, not dedicated search services", () => {
    const catalog = hostedSearchProviders.getHostedProviderCatalog();
    expect(catalog.map((provider) => provider.id)).toContain("openai");
    expect(catalog.find((provider) => provider.id === "openai").connectionLabel).toContain("Codex OAuth");
    expect(hostedSearchProviders.getHostedProviderFamilyIds("openai")).toContain("codex");
    expect(catalog.map((provider) => provider.id)).toContain("opencode");
    expect(catalog.map((provider) => provider.id)).not.toContain("exa");
    expect(catalog.map((provider) => provider.id)).not.toContain("searxng");
  });

  it("keeps Codex OAuth accounts separate from OpenAI API accounts and accepts aliases", () => {
    const accounts = [
      { id: "c1", provider: "codex" }, { id: "c2", provider: "cx" },
      { id: "api1", provider: "openai" },
    ];
    expect(hostedSearchProviders.getHostedProviderAccounts(accounts, "codex").map((account) => account.id)).toEqual(["c1", "c2"]);
  });

  it("renders provider icons and real account counts in the full picker", async () => {
    const modal = await compile(modalFile, modalImports());
    const html = renderToStaticMarkup(React.createElement(modal.HostedProviderPicker, {
      providers: [{ id: "codex", name: "OpenAI Codex" }, { id: "claude", name: "Claude Code" }],
      connections: [{ id: "c1", provider: "codex", hasCredential: true }, { id: "c2", provider: "codex", isActive: false }],
      adapters: [{ id: "builtin:codex", providerIds: ["codex"] }],
      onSelect: () => {}, onBack: () => {},
    }));
    expect(html).toContain("/providers/codex.png");
    expect(html).toContain("1 active / 2 accounts");
    expect(html).toContain("Local plugin required");
    expect(html).toContain("Search providers");
    expect(html).not.toContain("<select");
    expect(html.indexOf("Back")).toBeLessThan(html.indexOf('aria-label="Search providers"'));
  });

  it("loads connections independently from the Web Search catalog", async () => {
    const urls = [];
    const catalog = await hostedSearchProviders.loadHostedSearchCatalog(async (url) => {
      urls.push(url);
      return { ok: true, json: async () => ({
        connections: [{ id: "c1", provider: "codex" }], nodes: [], adapters: [],
      }) };
    });
    expect(urls).toEqual(["/api/providers", "/api/provider-nodes", "/api/hosted-search-adapters"]);
    expect(catalog.connections[0].provider).toBe("codex");
  });

  it("does not silently turn failed account loading into an empty successful catalog", async () => {
    await expect(hostedSearchProviders.loadHostedSearchCatalog(async () => ({ ok: false }))).rejects.toThrow("Could not load");
  });

  it("shows Codex OAuth accounts in the OpenAI family without changing credential ownership", () => {
    const connections = [{ id: "oauth1", provider: "codex", authType: "oauth", hasCredential: true }];
    const adapters = [
      { id: "builtin:openai", providerIds: ["openai"] },
      { id: "builtin:codex", providerIds: ["codex"] },
    ];
    expect(hostedSearchProviders.getHostedFamilyAccounts(connections, "openai")).toEqual(connections);
    expect(hostedSearchProviders.selectHostedSource("openai", connections, adapters)).toMatchObject({
      sourceProviderId: "codex", sourceAdapterId: "builtin:codex", sourceConnectionId: "",
    });
    expect(hostedSearchProviders.selectHostedSource("openai", connections, adapters, "oauth1")).toMatchObject({
      sourceProviderId: "codex", sourceAdapterId: "builtin:codex", sourceConnectionId: "oauth1",
    });
  });

  it("selecting an API key from the same family switches back to the API adapter", () => {
    const connections = [{ id: "oauth1", provider: "codex" }, { id: "api1", provider: "openai" }];
    const adapters = [
      { id: "builtin:openai", providerIds: ["openai"] },
      { id: "builtin:codex", providerIds: ["codex"] },
    ];
    expect(hostedSearchProviders.selectHostedSource("codex", connections, adapters, "api1")).toMatchObject({
      sourceProviderId: "openai", sourceAdapterId: "builtin:openai", sourceConnectionId: "api1",
    });
  });

  it("puts active connected providers first, then disabled accounts, then unconnected providers", () => {
    const providers = [
      { id: "a", name: "A" }, { id: "openai", name: "OpenAI" },
      { id: "b", name: "B" }, { id: "c", name: "C" },
    ];
    const connections = [{ id: "o", provider: "codex" }, { id: "b1", provider: "b", isActive: false }];
    expect(hostedSearchProviders.sortHostedProviders(providers, connections).map((provider) => provider.id))
      .toEqual(["openai", "b", "a", "c"]);
  });

  it("rejects selecting an unrelated account from the OpenAI family", () => {
    expect(() => hostedSearchProviders.selectHostedSource("openai", [{ id: "other", provider: "burngate" }], [], "other"))
      .toThrow("does not belong");
  });

  it("marks the linked form WIP and prevents configuration while preserving endpoint modes", async () => {
    const modal = await compile(modalFile, modalImports());
    const html = renderToStaticMarkup(React.createElement(modal.default, {
      isOpen: true, onClose: () => {}, node: {
        id: "custom-websearch-1", mode: "linked", sourceProviderId: "codex", sourceAdapterId: "builtin:codex",
      },
    }));
    expect(html).not.toContain("Source model");
    expect(html).toContain("Hosted tools · WIP");
    expect(html).toContain("without invoking a model");
    expect(html).toMatch(/<option[^>]*value="linked"[^>]*disabled/);
    expect(html).not.toContain("Hosted search adapter");
    expect(html).not.toContain("Select a provider…");
    expect(html).toContain("SearXNG-compatible endpoint");
    expect(html).toContain("Custom JSON search API");
    expect(html).toMatch(/<option value="plugin">Local JS plugin/);
  });
  it("renders the separate plugin configuration without a model or endpoint", async () => {
    const modal = await compile(modalFile, modalImports());
    const html = renderToStaticMarkup(React.createElement(modal.default, {
      isOpen: true, onClose: () => {}, node: { mode: "plugin", name: "Direct",
        sourceProviderId: "codex", sourceAdapterId: "plugin:direct" },
    }));
    expect(html).toContain("Local search plugin");
    expect(html).toContain("without a model");
    expect(html).not.toContain("Source model");
    expect(html).not.toContain("Base URL");
  });
});
