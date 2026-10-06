import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import PropTypes from "prop-types";
import { renderToStaticMarkup } from "react-dom/server";
import { loadBindings, transform } from "next/dist/build/swc/index.js";
import { describe, expect, it, vi } from "vitest";
import * as providerConstants from "@/shared/constants/providers";
import * as capabilityRoutes from "@/shared/utils/capabilityRoutes";
import * as searchWorkflows from "@/shared/utils/searchWorkflows";
import {
  SEARCH_WORKFLOW_KINDS,
  SEARCH_WORKFLOW_NAME,
  generateSearchWorkflowName,
  getSearchWorkflowComboHref,
  getSearchWorkflowKind,
  isSearchWorkflowKind,
  isValidSearchWorkflowName,
  listSearchWorkflows,
  summarizeSearchWorkflows,
} from "@/shared/utils/searchWorkflows";

const root = resolve(import.meta.dirname, "../..");
const clientPage = "src/shared/components/capability-pages/SearchWorkflowPage.js";
const routePage = "src/app/(dashboard)/dashboard/search/workflows/page.js";
const read = (file) => readFileSync(resolve(root, file), "utf8");
const NullComponent = () => null;
const Box = ({ children }) => React.createElement("div", null, children);
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
    "next/navigation": { useRouter: () => ({ push: vi.fn() }) },
    "@/shared/components": { Badge: Box, Button: Box, Card: Box },
    "@/shared/components/ProviderIcon": { default: NullComponent },
    "@/shared/constants/providers": providerConstants,
    "@/shared/utils/capabilityRoutes": capabilityRoutes,
    "@/shared/utils/searchWorkflows": searchWorkflows,
  };
}

describe("search workflow helpers", () => {
  it("keeps the two existing web combo kinds and their labels", () => {
    expect(SEARCH_WORKFLOW_NAME).toBe("search-workflow");
    expect(SEARCH_WORKFLOW_KINDS.map((kind) => kind.id)).toEqual(["webSearch", "webFetch"]);
    expect(SEARCH_WORKFLOW_KINDS.map((kind) => kind.label)).toEqual(["Web Search", "Web Fetch"]);
    expect(getSearchWorkflowKind("webSearch")).toMatchObject({ icon: "search" });
    expect(getSearchWorkflowKind("webFetch")).toMatchObject({ icon: "article" });
    expect(getSearchWorkflowKind("chat")).toBeNull();
  });

  it("classifies only web search/fetch combo kinds", () => {
    expect(isSearchWorkflowKind("webSearch")).toBe(true);
    expect(isSearchWorkflowKind("webFetch")).toBe(true);
    for (const kind of ["chat", "image", "tts", "", null, undefined, "__proto__", "web"]) {
      expect(isSearchWorkflowKind(kind)).toBe(false);
    }
  });

  it("lists both kinds in input order and ignores unrelated or malformed combos", () => {
    const combos = [
      { id: "s1", name: "search-a", kind: "webSearch", models: ["exa/neural"] },
      { id: "c1", name: "chat-combo", kind: "chat", models: [] },
      null,
      { id: "f1", name: "fetch-b", kind: "webFetch", models: [] },
      { id: "broken-1", kind: "webSearch", models: [] },
      { name: "broken-2", kind: "webFetch", models: [] },
      { id: 7, name: "broken-3", kind: "webSearch", models: [] },
      { id: "", name: "broken-4", kind: "webSearch", models: [] },
    ];
    const listed = listSearchWorkflows(combos);
    expect(listed.map((combo) => combo.name)).toEqual(["search-a", "fetch-b"]);
    expect(combos).toHaveLength(8);
    expect(listSearchWorkflows(null)).toEqual([]);
    expect(listSearchWorkflows("not-an-array")).toEqual([]);
  });

  it("summarizes both kinds for the page header", () => {
    const combos = [
      { id: "s1", name: "a", kind: "webSearch" },
      { id: "s2", name: "b", kind: "webSearch" },
      { id: "f1", name: "c", kind: "webFetch" },
      { id: "c1", name: "d", kind: "chat" },
    ];
    expect(summarizeSearchWorkflows(combos)).toEqual({ total: 3, webSearch: 2, webFetch: 1 });
    expect(summarizeSearchWorkflows(undefined)).toEqual({ total: 0, webSearch: 0, webFetch: 0 });
  });

  it("generates the shared search-workflow name with a collision-free suffix", () => {
    expect(generateSearchWorkflowName([])).toBe("search-workflow");
    expect(generateSearchWorkflowName(["chat-combo", "image-combo"])).toBe("search-workflow");
    expect(generateSearchWorkflowName(["search-workflow"])).toBe("search-workflow-1");
    expect(generateSearchWorkflowName(new Set(["search-workflow", "search-workflow-1", "search-workflow-3"]))).toBe("search-workflow-2");
    expect(generateSearchWorkflowName(["fetch-flow"], "fetch-flow")).toBe("fetch-flow-1");
    expect(generateSearchWorkflowName(null)).toBe("search-workflow");
  });

  it("checks uniqueness across names of every combo kind, not only web ones", () => {
    const combos = [
      { id: "c1", name: "search-workflow", kind: "chat" },
      { id: "i1", name: "search-workflow-1", kind: "image" },
      { id: "s1", name: "my-search", kind: "webSearch" },
    ];
    const names = combos.map((combo) => combo.name);
    expect(generateSearchWorkflowName(names)).toBe("search-workflow-2");
  });

  it("validates names with the same contract as POST /api/combos", () => {
    for (const name of ["search-workflow", "Search_Flow.2", "a-b_c.1"]) {
      expect(isValidSearchWorkflowName(name)).toBe(true);
    }
    for (const name of ["", "has space", "a/b", "a?b", "имя", null, undefined, 42]) {
      expect(isValidSearchWorkflowName(name)).toBe(false);
    }
  });

  it("builds kind-scoped detail links and rejects unrelated kinds", () => {
    expect(getSearchWorkflowComboHref({ id: "a?b", kind: "webSearch" })).toBe("/dashboard/search/webSearch/combo/a%3Fb");
    expect(getSearchWorkflowComboHref({ id: "f1", kind: "webFetch" })).toBe("/dashboard/search/webFetch/combo/f1");
    expect(getSearchWorkflowComboHref({ id: "c1", kind: "chat" })).toBeNull();
    expect(getSearchWorkflowComboHref({ kind: "webSearch" })).toBeNull();
    expect(getSearchWorkflowComboHref(null)).toBeNull();
  });
});

describe("Search Workflow page SSR (offline, no writes)", () => {
  it("renders the create action, honest engine note and loading state", async () => {
    const { default: Page } = await compile(clientPage, pageImports());
    const html = renderToStaticMarkup(React.createElement(Page));
    expect(html).toContain("Back to Web Search");
    expect(html).toContain('href="/dashboard/search"');
    expect(html).toContain("Create Workflow");
    expect(html).toContain("Loading workflows");
    expect(html).toContain("multi-step research");
    expect(html).toContain("stays planned in T-0042");
  });

  it("does not touch the network while rendering (effects do not run in SSR)", async () => {
    const { default: Page } = await compile(clientPage, pageImports());
    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy;
    try {
      const html = renderToStaticMarkup(React.createElement(Page));
      expect(html).toContain("Create Workflow");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("renders one unified list with per-kind detail links for both kinds", async () => {
    const { SearchWorkflowList } = await compile(clientPage, pageImports());
    const html = renderToStaticMarkup(React.createElement(SearchWorkflowList, {
      workflows: [
        { id: "s/1", name: "my-search", kind: "webSearch", models: ["exa/neural"] },
        { id: "f1", name: "my-fetch", kind: "webFetch", models: ["exa/neural", "custom-x/deep"] },
      ],
    }));
    expect(html).toContain('href="/dashboard/search/webSearch/combo/s%2F1"');
    expect(html).toContain('href="/dashboard/search/webFetch/combo/f1"');
    expect(html).toContain("my-search");
    expect(html).toContain("my-fetch");
    expect(html).toContain("Web Search");
    expect(html).toContain("Web Fetch");
  });

  it("renders an actionable empty state instead of a fake workflow", async () => {
    const { SearchWorkflowList } = await compile(clientPage, pageImports());
    const html = renderToStaticMarkup(React.createElement(SearchWorkflowList, { workflows: [] }));
    expect(html).toContain("No Search or Fetch workflows yet");
    expect(html).toContain("/v1/search");
    expect(html).toContain("/v1/web/fetch");
  });

  it("mounts the client page at the canonical /dashboard/search/workflows route", async () => {
    const marker = () => null;
    const { default: Page } = await compile(routePage, {
      "@/shared/components/capability-pages/SearchWorkflowPage": { default: marker },
    });
    expect(Page().type).toBe(marker);
  });
});
