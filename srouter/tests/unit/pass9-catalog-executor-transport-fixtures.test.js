// Pass9 executor/transport fixtures for two Pass8 catalog IDs whose pinned
// delta is a wire remap rather than a catalog/price declaration:
//
//   P8-CAT-vans-antigravity   gemini-3.8-flash-high(high) vs tiered(high)
//   P8-CAT-vans-xiaomi-mimo   preview models + xiaomi/ namespace transport
//
// Registry repairs use the existing specialized executor without modifying it.
import { describe, expect, it } from "vitest";
import antigravityRegistry from "open-sse/providers/registry/antigravity.js";
import xiaomiRegistry from "open-sse/providers/registry/xiaomi-mimo.js";
import { AntigravityExecutor } from "open-sse/executors/antigravity.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getModelUpstreamId, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { XiaomiMimoExecutor, __test__ as xiaomiInternals } from "open-sse/executors/xiaomi-mimo.js";

const byId = (registry, id) => registry.models.find((m) => m.id === id);

describe("antigravity wire remap acceptance", () => {
  it("resolves each public 3.8 tier to its pinned wire id through the specialized executor", () => {
    const executor = new AntigravityExecutor();
    const alias = PROVIDER_ID_TO_ALIAS.antigravity;
    for (const tier of ["high", "medium", "low"]) {
      const publicId = `gemini-3.8-flash-${tier}`;
      const expectedWire = `gemini-3.8-flash-tiered(${tier})`;
      expect(byId(antigravityRegistry, publicId).upstreamModelId).toBe(expectedWire);
      const wire = getModelUpstreamId(alias, publicId);
      expect(wire).toBe(expectedWire);
      expect(executor.transformRequest(wire, { contents: [] }, true, {
        accessToken: "fixture-token",
      }).model).toBe(expectedWire);
    }
    expect(getModelUpstreamId(alias, "gemini-3.8-flash"))
      .toBe("gemini-3.8-flash-tiered(medium)");
    expect(byId(antigravityRegistry, "gemini-3.7-flash-high").upstreamModelId)
      .toBe("gemini-3.7-flash-tiered(high)");
  });

  it("the specialized executor passes the upstream model id through unchanged", () => {
    const executor = new AntigravityExecutor();
    const credentials = { accessToken: "fixture-token" };
    for (const model of ["gemini-3.8-flash-high(high)", "gemini-3.7-flash-tiered(high)"]) {
      const out = executor.transformRequest(model, { contents: [] }, true, credentials);
      // No tier/namespace rewriting happens in the executor: whatever the registry
      // declares as upstreamModelId is what reaches the upstream `model` field.
      expect(out.model).toBe(model);
    }
  });

  it("the specialized executor targets the Antigravity v1internal endpoint", () => {
    const executor = new AntigravityExecutor();
    expect(executor.buildUrl("gemini-3.8-flash-high(high)", true)).toContain("v1internal:");
    expect(executor.buildUrl("gemini-3.8-flash-high(high)", false)).toContain(":generateContent");
  });
});

describe("Kimi K2.7 native media declaration", () => {
  it("keeps existing text/thinking limits while exposing its pinned video input", () => {
    expect(getCapabilitiesForModel("kimchi", "kimi-k2.7")).toMatchObject({
      vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi",
      contextWindow: 262144, maxOutput: 262144,
    });
    expect(getCapabilitiesForModel("kimchi", "kimi-k2.5").videoInput).toBe(false);
  });
});

describe("xiaomi-mimo transport fixture", () => {
  it("preview models are declared with the xiaomi/ upstream namespace", () => {
    expect(byId(xiaomiRegistry, "mimo-x-pro-preview").upstreamModelId).toBe("xiaomi/mimo-x-pro-preview");
    expect(byId(xiaomiRegistry, "mimo-x-flash-preview").upstreamModelId).toBe("xiaomi/mimo-x-flash-preview");
    expect(byId(xiaomiRegistry, "mimo-x-pro-preview").supportedFormats).toEqual(["openai"]);
  });

  it("declares the openai and claude transports the executor selects between", () => {
    const formats = xiaomiRegistry.transports.map((t) => t.format).sort();
    expect(formats).toEqual(["claude", "openai"]);
    expect(xiaomiRegistry.transports.find((t) => t.format === "claude").baseUrl)
      .toContain("/anthropic/v1/messages");
  });

  it("only the v2.6 trio takes the desktop account route; preview models fall back to the cloud API", () => {
    // Owner contract: the v2.6 desktop dual-route models consume the weekly
    // account quota when a desktop session is present; the smaller preview
    // models intentionally stay on the cloud API transport.
    expect([...xiaomiInternals.ACCOUNT_MODELS].sort()).toEqual([
      "mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed",
    ]);
    const executor = new XiaomiMimoExecutor();
    const withSession = { providerSpecificData: { mimoPassToken: "fixture" } };
    expect(executor.isAccountRoute("xiaomi/mimo-v2.6-pro", withSession)).toBe(true);
    expect(executor.isAccountRoute("xiaomi/mimo-x-pro-preview", withSession)).toBe(false);
    expect(executor.buildUrl("xiaomi/mimo-x-pro-preview", true, 0, withSession))
      .toBe("https://api.xiaomimimo.com/v1/chat/completions");
  });
});
