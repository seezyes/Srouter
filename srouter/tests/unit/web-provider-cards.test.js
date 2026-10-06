import { describe, expect, it } from "vitest";
import { getProvidersByKind } from "@/shared/constants/providers";
import { getWebProviders, getWebConnectionLabels, groupWebProviders, getWebProviderToolOptions, getWebProviderConnectionOptions } from "@/shared/utils/webProviderCards";
import { WEB_PROVIDER_CAPABILITIES, WEB_TOOL_LABELS, WEB_CONNECTION_LABELS } from "@/shared/constants/webProviderCapabilities";
import { getCapabilityProviderHref } from "@/shared/utils/capabilityRoutes";

describe("unified web provider cards", () => {
  it("documents every current web service without adding runtime providers", () => {
    expect(Object.keys(WEB_PROVIDER_CAPABILITIES).sort()).toEqual(getWebProviders().map((p) => p.id).sort());
    for (const entry of Object.values(WEB_PROVIDER_CAPABILITIES)) {
      for (const [key, labels] of [["serviceTools", WEB_TOOL_LABELS], ["possibleConnections", WEB_CONNECTION_LABELS]]) {
        expect(new Set(entry[key].map((item) => item.type)).size).toBe(entry[key].length);
        for (const item of entry[key]) {
          expect(labels[item.type]).toBeTruthy();
          expect(["documented", "conditional"]).toContain(item.status);
          expect(item.note.length).toBeGreaterThan(5);
          expect(item.sources.length).toBeGreaterThan(0);
          for (const source of item.sources) expect(new URL(source).protocol).toBe("https:");
        }
      }
    }
  });
  it("keeps implemented operations and authentication distinct from future surfaces", () => {
    for (const provider of getWebProviders()) {
      const tools = getWebProviderToolOptions(provider);
      const warnings = WEB_PROVIDER_CAPABILITIES[provider.id].adapterWarnings || {};
      expect(tools.filter((tool) => tool.implemented).map((tool) => tool.type)).toEqual(provider.kinds.filter((kind) => !warnings[kind]));
      expect(new Set(tools.map((tool) => tool.type)).size).toBe(tools.length);
      for (const tool of tools.filter((tool) => !tool.implemented)) {
        expect(tool.kind).toBeUndefined();
        expect(tool.sources.length).toBeGreaterThan(0);
      }
      const access = getWebProviderConnectionOptions(provider);
      expect(access.filter((option) => option.implemented).map((option) => option.label)).toEqual(getWebConnectionLabels(provider));
    }
    expect(WEB_CONNECTION_LABELS.hostedTool).toBe("Hosted tool");
    expect(WEB_TOOL_LABELS.webFetch).toBe("Web Fetch");
    expect(WEB_TOOL_LABELS.fetch).toBe("Fetch");
    expect(getWebProviderToolOptions(getWebProviders().find((p) => p.id === "openai")).find((t) => t.type === "webSearch").implemented).toBe(false);
    expect(getWebProviderToolOptions(getWebProviders().find((p) => p.id === "vercel-ai-gateway")).find((t) => t.type === "webSearch").implemented).toBe(false);
  });
  it("collapses Google, Ollama and Perplexity without losing providers or tools", () => {
    const providers = getWebProviders();
    const groups = groupWebProviders(providers);
    expect(groups.filter((item) => item.entries).map((item) => item.name)).toEqual(["Google", "Perplexity", "Ollama"]);
    expect(groups.find((item) => item.name === "Google").entries.map((p) => p.id)).toEqual(["antigravity", "gemini", "google-pse"]);
    expect(groups.find((item) => item.name === "Ollama").entries.map((p) => p.id)).toEqual(["ollama-search", "ollama"]);
    expect(groups.find((item) => item.name === "Perplexity").entries.map((p) => p.id)).toEqual(["perplexity", "perplexity-agent"]);
    const flattened = groups.flatMap((item) => item.entries || [item.provider]);
    expect(flattened).toHaveLength(providers.length);
    expect(new Set(flattened.map((p) => p.id)).size).toBe(providers.length);
    for (const provider of providers) expect(flattened.find((p) => p.id === provider.id)).toEqual(provider);
  });
  it("shows every provider once and retains every supported operation", () => {
    const cards = getWebProviders();
    expect(new Set(cards.map((p) => p.id)).size).toBe(cards.length);
    for (const kind of ["webSearch", "webFetch"]) {
      for (const provider of getProvidersByKind(kind)) {
        const card = cards.find((p) => p.id === provider.id);
        expect(card.kinds).toContain(kind);
        expect(getCapabilityProviderHref(kind, card.id)).toBe(`/dashboard/search/${kind}/${card.id}`);
      }
    }
    expect(cards.find((p) => p.id === "exa").kinds).toEqual(["webSearch", "webFetch"]);
  });

  it("includes chat adapter among connection methods", () => {
    expect(getWebConnectionLabels({ id: "openai", searchViaChat: true })).toEqual(["Chat adapter", "API"]);
    expect(getWebConnectionLabels({ id: "antigravity" })).toEqual(["OAuth"]);
    expect(getWebConnectionLabels({ id: "dual", authModes: ["oauth", "apikey"] })).toEqual(["OAuth", "API"]);
    expect(getWebConnectionLabels({ id: "searxng", noAuth: true })).toEqual(["Free"]);
  });
});
