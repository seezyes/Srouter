// Pass9 catalog repairs — positive regressions for the three confirmed Pass8 gaps
// plus the source-backed static declarations ported alongside them.
//
//   1. Muse Web short alias ("muse") must reach the web transport, not the newer
//      Muse Model API that happened to be registered later.
//   2. Provider-qualified registry ids ("poolside/laguna-s-2.1",
//      "nvidia/nemotron-…") are the upstream vendor namespace: the public catalog
//      replay must not discard them and the resolver must resolve them.
//   3. Explicit zero cached/reasoning/cache-creation rates are tariffs, not
//      missing values (asserted in pass9-billing-explicit-zero-rate.test.js).
//
// Self-contained: no shared helper is written or imported from Pass8 evidence.
import { describe, expect, it, vi } from "vitest";

// ---- buildModelsList fixtures (catalog/DB boundaries only) ----------------
const state = vi.hoisted(() => ({ connections: [] }));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: async () => state.connections,
  getCombos: async () => [],
  getCustomModels: async () => [],
  getModelAliases: async () => ({}),
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/sse/services/allowedModels.js", () => ({ fetchModelsFetcherIds: async () => [] }));
vi.mock("@/sse/services/tokenRefresh", () => ({
  updateProviderCredentials: async () => { throw new Error("credential write forbidden"); },
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({}) }));
vi.mock("@/sse/services/requestAccess.js", () => ({ authenticateRequest: async () => null }));
vi.mock("open-sse/services/kiroModels.js", () => ({ resolveKiroModels: async () => null }));
vi.mock("open-sse/services/kimchiModels.js", () => ({ resolveKimchiModels: async () => null }));
vi.mock("open-sse/services/copilotModels.js", () => ({ resolveCopilotModels: async () => null }));
vi.mock("open-sse/services/grokCliModels.js", () => ({ resolveGrokCliModels: async () => null }));
vi.mock("open-sse/services/cursorModels.js", () => ({ resolveCursorModels: async () => null }));
vi.mock("open-sse/shared/zedAuth.js", () => ({ resolveZedModels: async () => null }));
vi.mock("open-sse/services/qoderModels.js", () => ({
  resolveQoderModels: async () => null,
  routableQoderModels: () => [],
}));
vi.mock("open-sse/services/clinepassModels.js", () => ({
  resolveClinepassModels: async () => null,
  resolveClineModels: async () => null,
}));

const { getCapabilitiesForModel } = await import("open-sse/providers/capabilities.js");
const { getModelInfoCore, parseModel, resolveProviderAlias } = await import("open-sse/services/model.js");
const { getModelUpstreamId, getModelsByProviderId } = await import("open-sse/config/providerModels.js");
const { buildModelsList } = await import("@/app/api/v1/models/route.js");

async function published(providerId, prefix) {
  state.connections = [{
    id: "pass9-fixture",
    provider: providerId,
    isActive: true,
    providerSpecificData: prefix ? { prefix } : {},
  }];
  return buildModelsList(["llm"], {
    skipDynamicFetch: true,
    apiKeyInfo: { allowedProviders: [providerId] },
  });
}

describe("pass9 muse alias conflict", () => {
  it("routes the short muse alias to the Muse Spark Web transport", async () => {
    const target = await getModelInfoCore("muse/muse-spark", {});
    expect(target).toEqual({ provider: "muse-spark-web", model: "muse-spark" });
    expect(await getModelInfoCore("muse/muse-spark-thinking", {}))
      .toEqual({ provider: "muse-spark-web", model: "muse-spark-thinking" });
    // Explicit provider ids keep working in both directions.
    expect(await getModelInfoCore("muse-spark-web/muse-spark", {}))
      .toEqual({ provider: "muse-spark-web", model: "muse-spark" });
  });

  it("keeps the Muse Model API reachable through its own aliases", async () => {
    for (const alias of ["muse-ai", "meta-model-api", "muse-code", "muse-subscription"]) {
      expect(parseModel(`${alias}/muse-spark-1.3`))
        .toEqual({ provider: "muse", model: "muse-spark-1.3", isAlias: false, providerAlias: alias });
    }
    // The Model API id itself is still registered for direct routing tables.
    expect(resolveProviderAlias("muse")).toBe("muse");
  });

  it("does not disturb the mmf alias or untouched aliases", () => {
    expect(parseModel("mmf/mimo-auto").provider).toBe("mmf");
    expect(parseModel("openai/gpt-4o").provider).toBe("openai");
    expect(resolveProviderAlias("mmf")).toBe("mmf");
  });
});

describe("pass9 provider-qualified catalog ids", () => {
  it("resolves a bare poolside model id back to the vendor-namespaced wire id", () => {
    expect(getModelUpstreamId("poolside", "laguna-s-2.1")).toBe("poolside/laguna-s-2.1");
    expect(getModelUpstreamId("poolside", "poolside/laguna-s-2.1")).toBe("poolside/laguna-s-2.1");
    // nvidia stores the same shape (two vendor segments).
    expect(getModelUpstreamId("nvidia", "nemotron-3-super-120b-a12b"))
      .toBe("nvidia/nemotron-3-super-120b-a12b");
  });

  it("publishes the qualified id and survives the catalog replay round-trip", async () => {
    const listed = await published("poolside");
    for (const model of getModelsByProviderId("poolside")) {
      const entry = listed.find((item) => item.id.endsWith(model.id));
      expect(entry, `published ${model.id}`).toBeDefined();
      const target = await getModelInfoCore(entry.id, {});
      expect(target.provider).toBe("poolside");
      expect(getModelUpstreamId(target.provider, target.model)).toBe(model.id);
    }
  });

  it("keeps the vendor namespace when the connection adds an addressing prefix", async () => {
    const listed = await published("nvidia", "nv");
    const id = "nv/nvidia/nemotron-3-super-120b-a12b";
    expect(listed.map((m) => m.id)).toContain(id);
    // The address prefix is stripped by the resolver, but the vendor namespace survives.
    const target = await getModelInfoCore(id, {});
    expect(target.model).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(getModelUpstreamId("nvidia", target.model)).toBe("nvidia/nemotron-3-super-120b-a12b");
  });
});

describe("pass9 ported pinned static declarations", () => {
  it("declares the pinned poolside / nvidia / xiaomi catalog entries", () => {
    const poolside = getModelsByProviderId("poolside").map((m) => m.id);
    expect(poolside).toContain("poolside/laguna-m.1");
    const nvidia = getModelsByProviderId("nvidia").map((m) => m.id);
    for (const id of ["openai/gpt-oss-120b", "openai/gpt-oss-20b",
      "meta/llama-4-maverick-17b-128e-instruct", "stepfun-ai/step-3.7-flash",
      "nvidia/nemotron-3-super-120b-a12b"]) {
      expect(nvidia, id).toContain(id);
    }
    const xiaomi = getModelsByProviderId("xiaomi-mimo").map((m) => m.id);
    expect(xiaomi).toContain("mimo-x-pro-preview");
    expect(xiaomi).toContain("mimo-x-flash-preview");
    expect(getModelUpstreamId("xiaomi-mimo", "mimo-x-pro-preview")).toBe("xiaomi/mimo-x-pro-preview");
    expect(getModelUpstreamId("xiaomi-mimo", "mimo-x-flash-preview")).toBe("xiaomi/mimo-x-flash-preview");
  });

  it("marks image-only generators as imageOutput for every provider that exposes them", () => {
    for (const [provider, model] of [["codex", "gpt-image-2"], ["venice", "venice-sd35"],
      ["venice", "flux-2-pro"], ["venice", "gpt-image-2"], ["a6api", "gpt-image-2"]]) {
      expect(getCapabilitiesForModel(provider, model).imageOutput, `${provider}/${model}`).toBe(true);
    }
    // Unrelated text models keep the safe floor.
    expect(getCapabilitiesForModel("venice", "llama-3.3-70b").imageOutput).toBe(false);
  });
});
