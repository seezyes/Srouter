import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import PropTypes from "prop-types";
import { renderToStaticMarkup } from "react-dom/server";
import { loadBindings, transform } from "next/dist/build/swc/index.js";
import { describe, expect, it, vi } from "vitest";
import * as providerConstants from "@/shared/constants/providers";
import * as routes from "@/shared/utils/capabilityRoutes";
import * as webProviderCards from "@/shared/utils/webProviderCards";
import * as providerIcon from "@/shared/utils/providerIcon";
import * as srouterSearchConfig from "@/shared/utils/srouterSearchConfig";
import * as connectionStatus from "@/shared/utils/connectionStatus";
import { cn } from "@/shared/utils/cn";
import { createNavigationShortcuts } from "@/shared/utils/navigationShortcuts";

const root = resolve(import.meta.dirname, "../..");
const { MEDIA_PROVIDER_KINDS } = providerConstants;
const dashboard = "src/app/(dashboard)/dashboard";
const clientRoot = "src/shared/components/capability-pages";
const kindIds = MEDIA_PROVIDER_KINDS.map((kind) => kind.id);
const read = (file) => readFileSync(resolve(root, file), "utf8");
const NullComponent = () => null;
const Link = ({ href, children, ...props }) => React.createElement("a", { ...props, href }, children);
const notFound = () => { throw new Error("NOT_FOUND"); };
const redirect = (href) => { throw new Error(`REDIRECT:${href}`); };

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
    "next/navigation": { notFound, redirect }, "next/link": { default: Link },
    "@/shared/utils/capabilityRoutes": routes,
    "@/shared/utils/webProviderCards": webProviderCards,
    "@/shared/utils/webProviderIcons": {
      getWebProviderIconSrc: (id) => `/providers/${id}.png`,
      getWebGroupIconSrc: (name) => name === "Ollama" ? "/providers/web/ollama-cloud.png" : undefined,
    },
    "@/shared/utils/srouterSearchConfig": srouterSearchConfig,
    ...imports,
  };
  new Function("module", "exports", "require", code)(compiledModule, compiledModule.exports, (id) => {
    if (!(id in dependencies)) throw new Error(`Unexpected import in ${file}: ${id}`);
    const dependency = dependencies[id];
    return dependency && "default" in dependency ? { ...dependency, __esModule: true } : dependency;
  });
  return compiledModule.exports.default;
}

describe("canonical capability navigation", () => {
  it.each(kindIds)("gives %s its own listing/provider/combo routes", (kind) => {
    const base = routes.isWebCapability(kind) ? `/dashboard/search/${kind}` : `/dashboard/${kind}`;
    expect(routes.getCapabilityListingHref(kind)).toBe(routes.isWebCapability(kind) ? "/dashboard/search" : base);
    expect(routes.getCapabilityProviderHref(kind, "openrouter")).toBe(`${base}/openrouter`);
    expect(routes.getCapabilityComboHref(kind, "combo-id")).toBe(`${base}/combo/combo-id`);
  });

  it("encodes IDs and rejects unknown kinds without creating arbitrary paths", () => {
    expect(routes.getCapabilityProviderHref("embedding", "custom/id")).toBe("/dashboard/embedding/custom%2Fid");
    expect(routes.getCapabilityComboHref("webSearch", "a?b")).toBe("/dashboard/search/webSearch/combo/a%3Fb");
    expect(routes.getCapabilityListingHref("unknown")).toBeNull();
    expect(routes.getCapabilityProviderHref("__proto__", "x")).toBeNull();
  });

  it.each(kindIds)("removes Media Providers from %s breadcrumbs, even on legacy URLs", (kind) => {
    const canonical = routes.getCapabilityProviderHref(kind, "openrouter");
    const info = routes.getCapabilityPageInfo(canonical);
    expect(info.breadcrumbs).toHaveLength(2);
    expect(info.breadcrumbs[0].href).toBe(routes.getCapabilityListingHref(kind));
    expect(info.breadcrumbs[1].label).toBe("OpenRouter");
    expect(JSON.stringify(info.breadcrumbs)).not.toContain("Media Providers");
    expect(routes.getCapabilityPageInfo(`/dashboard/media-providers/${kind}/openrouter`)).toEqual(info);
  });

  it("uses kind > Combo, not a fake provider or media ancestor", () => {
    const info = routes.getCapabilityPageInfo("/dashboard/search/webSearch/combo/example");
    expect(info.breadcrumbs).toEqual([
      { label: "Search Workflow", href: "/dashboard/search/workflows" }, { label: "Combo" },
    ]);
    expect(routes.getCapabilityPageInfo("/dashboard/search/image/openai")).toBeNull();
    expect(routes.getCapabilityPageInfo("/dashboard/providers/openai")).toBeNull();
  });

  it("does not activate media siblings or media for Search", () => {
    expect(routes.isCapabilityPathActive("/dashboard/embedding/openrouter", "embedding")).toBe(true);
    expect(routes.isCapabilityPathActive("/dashboard/tts/combo/id", "tts")).toBe(true);
    expect(routes.isCapabilityPathActive("/dashboard/imageToText/openai", "image")).toBe(false);
    expect(routes.isCapabilityPathActive("/dashboard/search/webSearch/openai", "image")).toBe(false);
  });
});

describe("canonical route wrappers and legacy redirects (DB mocked)", () => {
  const listing = async () => compile(`${dashboard}/[kind]/page.js`, {
    "@/shared/components/capability-pages/KindPage": { default: NullComponent },
  });

  it.each(kindIds.filter((kind) => !routes.isWebCapability(kind)))("renders a validated %s listing", async (kind) => {
    const Page = await listing();
    expect((await Page({ params: Promise.resolve({ kind }) })).props.kind).toBe(kind);
  });

  it.each(["unknown", "webSearch", "webFetch"])("rejects %s on the non-web root wrapper", async (kind) => {
    const Page = await listing();
    await expect(Page({ params: Promise.resolve({ kind }) })).rejects.toThrow("NOT_FOUND");
  });

  it.each([
    ["[kind]/[id]", "embedding", "provider/ProviderDetailPage"],
    ["[kind]/combo/[id]", "tts", "ComboDetailPage"],
    ["search/[kind]/[id]", "webSearch", "provider/ProviderDetailPage"],
    ["search/[kind]/combo/[id]", "webFetch", "ComboDetailPage"],
  ])("passes the correct kind through %s", async (path, kind, component) => {
    const Page = await compile(`${dashboard}/${path}/page.js`, {
      [`@/shared/components/capability-pages/${component}`]: { default: NullComponent },
    });
    expect((await Page({ params: Promise.resolve({ kind, id: "fixture" }) })).props.kind).toBe(kind);
    await expect(Page({ params: Promise.resolve({ kind: "unknown", id: "fixture" }) })).rejects.toThrow("NOT_FOUND");
  });

  it.each(kindIds)("redirects legacy %s listing and detail to canonical routes", async (kind) => {
    const Listing = await compile(`${dashboard}/media-providers/[kind]/page.js`);
    const Detail = await compile(`${dashboard}/media-providers/[kind]/[id]/page.js`);
    await expect(Listing({ params: Promise.resolve({ kind }) })).rejects.toThrow(`REDIRECT:${routes.getCapabilityListingHref(kind)}`);
    await expect(Detail({ params: Promise.resolve({ kind, id: "fixture" }) })).rejects.toThrow(`REDIRECT:${routes.getCapabilityProviderHref(kind, "fixture")}`);
  });

  it.each([
    ["media-providers", "/dashboard/embedding"],
    ["media-providers/web", "/dashboard/search"],
  ])("redirects %s instead of dead landing links", async (path, href) => {
    const Page = await compile(`${dashboard}/${path}/page.js`);
    expect(() => Page()).toThrow(`REDIRECT:${href}`);
  });

  it.each(["webSearch", "webFetch", "image", "tts"])("redirects legacy combo by its actual %s kind", async (kind) => {
    const getComboById = vi.fn(async () => ({ kind }));
    const Page = await compile(`${dashboard}/media-providers/combo/[id]/page.js`, {
      "@/lib/db/index.js": { getComboById },
    });
    await expect(Page({ params: Promise.resolve({ id: "fixture" }) })).rejects.toThrow(`REDIRECT:${routes.getCapabilityComboHref(kind, "fixture")}`);
    expect(getComboById).toHaveBeenCalledExactlyOnceWith("fixture");
  });

  it.each([null, { kind: "unknown" }, { kind: "llm" }])("does not misroute a missing/unsupported legacy combo: %j", async (combo) => {
    const Page = await compile(`${dashboard}/media-providers/combo/[id]/page.js`, {
      "@/lib/db/index.js": { getComboById: async () => combo },
    });
    await expect(Page({ params: Promise.resolve({ id: "fixture" }) })).rejects.toThrow("NOT_FOUND");
  });

  it("keeps merged web-kind listing aliases canonical", async () => {
    const Page = await compile(`${dashboard}/search/[kind]/page.js`);
    await expect(Page({ params: Promise.resolve({ kind: "webSearch" }) })).rejects.toThrow("REDIRECT:/dashboard/search");
    await expect(Page({ params: Promise.resolve({ kind: "image" }) })).rejects.toThrow("NOT_FOUND");
  });
});

describe("actual Header and Sidebar SSR", () => {
  async function header(pathname) {
    return compile("src/shared/components/Header.js", {
      "next/navigation": { usePathname: () => pathname },
      "@/shared/components/ProviderIcon": { default: NullComponent },
      "@/shared/components/HeaderMenu": { default: NullComponent },
      "@/shared/components/HeaderLanguage": { default: NullComponent },
      "@/shared/components/ThemeToggle": { default: NullComponent },
      "@/shared/components/StreamerMode": { default: NullComponent },
      "./onDemandModals": { DonateModal: NullComponent },
      "@/store/headerSearchStore": { useHeaderSearchStore: () => false },
      "@/shared/constants/config": { OAUTH_PROVIDERS: {}, APIKEY_PROVIDERS: {} },
      "@/shared/utils/providerIcon": { getProviderIconSrc: () => "" },
      "@/i18n/runtime": { translate: (text) => text },
      "./Header.module.css": { default: {} },
    });
  }

  async function sidebar(pathname, developerMode = false) {
    const imports = {
      "next/navigation": { usePathname: () => pathname, useRouter: () => ({}) },
      "@/shared/utils/navigationShortcuts": { createNavigationShortcuts },
      "@/shared/utils/cn": { cn },
      "@/shared/constants/config": { APP_CONFIG: { name: "Srouter", version: "test" }, UPDATER_CONFIG: {} },
      "@/shared/constants/providers": { MEDIA_PROVIDER_KINDS },
      "@/shared/hooks/useCopyToClipboard": { useCopyToClipboard: () => ({ copied: false, copy: () => {} }) },
      "@/store/settingsStore": { default: (selector) => selector({ settings: { developerSettingsAvailable: developerMode } }) },
      "@/store/uiStore": { default: (selector) => selector({ developerMode }) },
      "./Modal": { ConfirmModal: NullComponent },
      "./onDemandModals": { NineRemotePromoModal: NullComponent },
      "./Sidebar.module.css": { default: {} },
    };
    for (const name of ["Button", "SrouterMark", "UpstreamLines"]) {
      imports[`./${name}`] = { default: NullComponent };
    }
    return compile("src/shared/components/Sidebar.js", imports);
  }

  it.each(["/dashboard/embedding/openrouter", "/dashboard/search/webSearch/antigravity"])("renders only kind > provider for %s", async (path) => {
    const html = renderToStaticMarkup(React.createElement(await header(path), {}));
    expect(html).not.toContain("Media Providers");
    expect(html.match(/chevron_right/g)).toHaveLength(1);
    expect(html).not.toContain('href="/dashboard/media-providers');
  });

  it("opens Media accordion on a media detail and links independent pages", async () => {
    const html = renderToStaticMarkup(React.createElement(await sidebar("/dashboard/embedding/openrouter"), {}));
    expect(html).toContain('href="/dashboard/embedding"');
    expect(html).toContain('href="/dashboard/image"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain('href="/dashboard/media-providers');
  });

  it("keeps Search separate from the closed media group", async () => {
    const html = renderToStaticMarkup(React.createElement(await sidebar("/dashboard/search/webSearch/antigravity"), {}));
    expect(html).toContain('href="/dashboard/search"');
    expect(html).not.toContain('href="/dashboard/embedding"');
    expect(html).not.toContain('href="/dashboard/media-providers');
  });
  it("does not show the removed UI editor even with developer settings enabled", async () => {
    const html = renderToStaticMarkup(React.createElement(await sidebar("/dashboard/profile", true), {}));
    expect(html).not.toContain('href="/dashboard/ui"');
    expect(html).toContain('href="/dashboard/profile"');
  });
});

describe("relocated client closure", () => {
  const Box = ({ children }) => React.createElement("div", null, children);
  const uiImports = {
    "@/shared/constants/providers": providerConstants,
    "@/shared/utils/connectionStatus": connectionStatus,
    "@/shared/components/ProviderIcon": { default: NullComponent },
    "@/shared/components": {
      Card: Box, Badge: Box, Button: Box, Toggle: NullComponent,
      AddCustomEmbeddingModal: NullComponent, AddCustomSearchProviderModal: NullComponent, NoAuthProxyCard: NullComponent,
      ProviderInfoCard: NullComponent,
    },
    "next/navigation": { notFound, useRouter: () => ({}) },
  };

  it("renders actual capability cards with independent provider links", async () => {
    const Page = await compile(`${clientRoot}/KindPage.js`, uiImports);
    const html = renderToStaticMarkup(React.createElement(Page, { kind: "embedding" }));
    expect(html).toContain('href="/dashboard/embedding/openrouter"');
    expect(html).not.toContain("/dashboard/media-providers");
  });

  it("renders actual web cards under Search, not Media Providers", async () => {
    const Group = await compile(`${dashboard}/providers/components/ProviderCardGroup.js`, {
      ...uiImports,
      "@/shared/utils/providerIcon": providerIcon,
      "./ProviderCardGroup.module.css": { default: { reveal: "reveal" } },
    });
    const Page = await compile(`${clientRoot}/WebProvidersPage.js`, {
      ...uiImports,
      "@/app/(dashboard)/dashboard/providers/components/ProviderCardGroup": { default: Group },
    });
    const html = renderToStaticMarkup(React.createElement(Page));
    expect(html).toContain("Expand Google providers:");
    expect(html).toContain('href="/dashboard/search/srouter-search"');
    expect(html).toContain('href="/dashboard/search/workflows"');
    expect(html).toContain("SrouterSearch MCP");
    expect(html).not.toContain("SRouterSearch");
    expect(html.indexOf("SrouterSearch MCP")).toBeLessThan(html.indexOf("Search Workflow"));
    expect(html).not.toContain(">Search Combo<");
    expect(html).not.toContain(">Fetch Combo<");
    expect(html).toContain("Dashed / future");
    expect(read("src/app/(dashboard)/dashboard/providers/components/ProviderCardGroup.js")).toContain("iconSrc || getProviderIconSrc(provider.id)");
    expect(routes.getCapabilityPageInfo("/dashboard/search/workflows").title).toBe("Search Workflow");
    expect(html).toContain("Expand Ollama providers:");
    expect(html).toContain("Expand Perplexity providers:");
    expect(html).not.toContain('href="/dashboard/search/webSearch/antigravity"');
    expect(html).toContain('href="/dashboard/search/webFetch/exa"');
    expect(html).toContain('aria-label="Open Exa settings"');
    expect(html).toContain("absolute inset-0");
    expect(html).toContain("pointer-events-auto relative rounded-full");
    expect(html).not.toContain("/dashboard/media-providers");
    expect(html).toContain(">Tools</span>");
    expect(html).toContain(">Connect</span>");
    expect(html).toContain("Chat adapter");
    expect(html).not.toContain("<h2");
  });
  it("renders SrouterSearch settings and direct API guidance", async () => {
    const Page = await compile(`${clientRoot}/SrouterSearchPage.js`, {
      ...uiImports,
      "next/dynamic": { default: () => NullComponent },
      "@/shared/components": { ...uiImports["@/shared/components"], Toggle: ({ label }) => React.createElement("span", null, label) },
    });
    const html = renderToStaticMarkup(React.createElement(Page));
    expect(html).toContain("Enable SrouterSearch MCP");
    expect(html).toContain("SrouterSearch");
    expect(html).not.toContain("SRouterSearch");
    expect(html).toContain(">Connect</");
    expect(html).not.toContain("Harness connection");
    expect(html).toContain("POST /v1/search");
    expect(html).toContain("POST /v1/web/fetch");
    expect(html).toContain("Default search provider / combo");
    expect(html).toContain("Default fetch provider / combo");
    for (const tool of ["srouter_fetch", "srouter_web_fetch", "srouter_smart_search", "srouter_deep_search"]) expect(html).toContain(tool);
    expect(html).toContain("Deep Search alone is allowed");
    expect(html).toContain("Get raw page text / HTML");
    expect(routes.getCapabilityPageInfo("/dashboard/search/srouter-search").title).toBe("SrouterSearch");
    expect(routes.getCapabilityPageInfo("/dashboard/search/srouter-search").breadcrumbs.at(-1).label).toBe("SrouterSearch");
    expect(routes.getCapabilityPageInfo("/dashboard/search").title).toBe("Web Search");
    expect(read("src/shared/components/Sidebar.js")).toContain('label: "Web Search"');
  });

  it.each([["embedding", "openrouter", "/dashboard/embedding"], ["webSearch", "antigravity", "/dashboard/search"]])(
    "renders the actual %s provider's back link independently",
    async (kind, id, href) => {
      const imports = {
        ...uiImports,
        "next/navigation": { notFound, useRouter: () => ({}), useParams: () => ({ id }) },
        "@/app/(dashboard)/dashboard/providers/components/ConnectionsCard": { default: NullComponent },
        "@/app/(dashboard)/dashboard/providers/components/ModelsCard": { default: NullComponent },
        "./components/exampleShared": { KIND_EXAMPLE_CONFIG: {} },
      };
      for (const name of ["EmbeddingExampleCard", "TtsExampleCard", "GenericExampleCard", "ExaSearchExampleCard", "SttExampleCard"]) {
        imports[`./components/${name}`] = { [name]: NullComponent };
      }
      const Page = await compile(`${clientRoot}/provider/ProviderDetailPage.js`, imports);
      const html = renderToStaticMarkup(React.createElement(Page, { kind }));
      expect(html).toContain(`href="${href}"`);
      expect(html).not.toContain("/dashboard/media-providers");
    },
  );

  it("has no legacy dashboard links or route-component imports", () => {
    const clients = ["KindPage.js", "WebProvidersPage.js", "ComboDetailPage.js", "provider/ProviderDetailPage.js"];
    for (const file of clients) {
      expect(read(`${clientRoot}/${file}`)).not.toContain("/dashboard/media-providers");
    }
    expect(read(`${dashboard}/search/page.js`)).not.toContain("media-providers");
  });

  it("keeps all local imports for the relocated examples resolvable and JSX valid", async () => {
    const folder = resolve(root, clientRoot, "provider/components");
    await loadBindings();
    for (const name of readdirSync(folder)) {
      if (!name.endsWith(".js")) continue;
      const file = resolve(folder, name);
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
        expect(existsSync(resolve(folder, `${match[1]}.js`)) || existsSync(resolve(folder, match[1]))).toBe(true);
      }
      const result = await transform(source, { filename: file, jsc: { parser: { syntax: "ecmascript", jsx: true } } });
      expect(result.code).toBeTruthy();
    }
  });
});
