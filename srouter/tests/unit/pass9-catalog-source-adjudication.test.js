// Read-only source adjudication for the 35 unfinished Pass8 catalog IDs.
//
// These tests execute the real consumer functions (capabilities, pricing,
// catalog remap, registries) and pin the source facts the adjudication ledger
// relies on. No production writes, no DB, no network. Values that differ from a
// pinned upstream revision are documented as revision conflicts in
// evidence/pass9-catalog-repairs/catalog35-source-adjudication.json.
//
// NOTE: the thinking-wire block below records Pass9 CURRENT facts after the
// thinking-wire repairs (agentrouter/clinepass/codebuddy-cn/kimchi). It is a
// live guard, not immutable Pass8 evidence — the Pass8 pins are untouched.
import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getPricingForModel, isFreeModel, ZERO_PRICING } from "open-sse/providers/pricing.js";
import { getModelUpstreamId } from "open-sse/config/providerModels.js";
import codexRegistry from "open-sse/providers/registry/codex.js";
import antigravityRegistry from "open-sse/providers/registry/antigravity.js";
import agentrouterRegistry from "open-sse/providers/registry/agentrouter.js";
import clinepassRegistry from "open-sse/providers/registry/clinepass.js";
import codebuddyCnRegistry from "open-sse/providers/registry/codebuddy-cn.js";
import xiaomiRegistry from "open-sse/providers/registry/xiaomi-mimo.js";

describe("capacity source facts", () => {
  it("codex default is the documented Codex OAuth gateway window and the [1m] id is the extended variant", () => {
    // CODEX_GPT_56_DEFAULT_CAPS comment: "Codex OAuth (ChatGPT backend) —
    // per-model context window reported by upstream ... #2720"; the *gpt-6*
    // pattern comment records the same clipping contract.
    expect(getCapabilitiesForModel("codex", "gpt-6.1-sol").contextWindow).toBe(272000);
    expect(getCapabilitiesForModel("codex", "gpt-6-sol").contextWindow).toBe(272000);
    // Explicit extended-context catalog ids (872000), declared in the codex registry.
    expect(getCapabilitiesForModel("codex", "gpt-6-sol[1m]").contextWindow).toBe(872000);
    const declared = codexRegistry.models.filter((m) => m.id.endsWith("[1m]")).map((m) => m.id);
    expect(declared).toContain("gpt-6-sol[1m]");
    // The extended variant is a real catalog id whose upstream wire is the base model.
    expect(getModelUpstreamId("cx", "gpt-6-sol[1m]")).toBe("gpt-6-sol");
  });

  it("minimax-family and gpt-5.6-luna local capacities are the nine-revision literals", () => {
    for (const provider of ["minimax", "minimax-cn", "ollama", "zenmux", "tokenrouter", "codebuddy-intl", "bazaarlink"]) {
      const caps = getCapabilitiesForModel(provider, "MiniMax-M3");
      expect(caps.contextWindow, `${provider}/MiniMax-M3`).toBe(1000000);
      expect(caps.maxOutput).toBe(131072);
    }
    expect(getCapabilitiesForModel("freebuff", "minimax/minimax-m3").contextWindow).toBe(1000000);
    for (const provider of ["opencode-go", "a6api"]) {
      expect(getCapabilitiesForModel(provider, "gpt-5.6-luna").contextWindow, provider).toBe(1050000);
    }
  });

  it("tokenharbor free-model maxOutput is the nine-revision value", () => {
    expect(getCapabilitiesForModel("tokenharbor", "deepseek-v4.1-flash:free").maxOutput).toBe(128000);
  });

  it("antigravity 3.8 tiered remap is declared in the registry (parent port)", () => {
    const byId = (id) => antigravityRegistry.models.find((m) => m.id === id);
    expect(byId("gemini-3.8-flash-high").upstreamModelId).toBe("gemini-3.8-flash-tiered(high)");
    expect(byId("gemini-3.8-flash-medium").upstreamModelId).toBe("gemini-3.8-flash-tiered(medium)");
    expect(byId("gemini-3.8-flash-low").upstreamModelId).toBe("gemini-3.8-flash-tiered(low)");
  });
});

describe("thinking wire source facts", () => {
  it("agentrouter (Claude transport) now resolves the claude-budget wire from a provider override", () => {
    expect(agentrouterRegistry.transport.format).toBe("claude");
    const caps = getCapabilitiesForModel("agentrouter", "glm-5.2");
    expect(caps.thinkingFormat).toBe("claude-budget");
    expect(caps.thinkingCanDisable).toBe(true);
    // Numeric values stay as resolved before the repair (T-0039 owns the pinned 128000/128000).
    expect(caps.contextWindow).toBe(1000000);
    expect(caps.maxOutput).toBe(131072);
  });

  it("clinepass (OpenAI chat-completions transport) now resolves the openai wire", () => {
    expect(clinepassRegistry.transport.baseUrl).toContain("/chat/completions");
    const caps = getCapabilitiesForModel("clinepass", "deepseek-v4-pro");
    expect(caps.thinkingFormat).toBe("openai");
    expect(caps.thinkingCanDisable).toBe(false);
    expect(caps.contextWindow).toBe(1000000);
    expect(caps.maxOutput).toBe(384000);
  });

  it("codebuddy-cn glm-5.0-turbo now declares the gateway's openai wire", () => {
    expect(codebuddyCnRegistry.transport.thinkingFormat).toBe("openai");
    expect(getCapabilitiesForModel("codebuddy-cn", "glm-5.0").thinkingFormat).toBe("openai");
    const caps = getCapabilitiesForModel("codebuddy-cn", "glm-5.0-turbo");
    expect(caps.thinkingFormat).toBe("openai");
    expect(caps.thinkingCanDisable).toBe(false);
    expect(caps.contextWindow).toBe(200000);
    expect(caps.maxOutput).toBe(128000);
  });

  it("kimchi kimi-k2.7 cannot disable thinking in either pinned revision", () => {
    const caps = getCapabilitiesForModel("kimchi", "kimi-k2.7");
    expect(caps.thinkingCanDisable).toBe(false);
    expect(caps.videoInput).toBe(true);
    expect(caps.thinkingFormat).toBe("kimi");
  });

  it("Fable 5.1 is declared permanently adaptive in the local source", () => {
    for (const provider of ["claude", "opencode-zen"]) {
      const caps = getCapabilitiesForModel(provider, "claude-fable-5-1");
      expect(caps.thinkingFormat, provider).toBe("claude-adaptive");
      expect(caps.thinkingCanDisable, provider).toBe(false);
    }
  });
});

describe("tariff source facts", () => {
  it("local free-tier policy zeroes *-free/:free ids by an explicit documented rule", () => {
    // Local PATTERN_PRICING comment "--- Free Tier Models (*:free, *-free) ---".
    for (const [provider, model] of [["opencode-zen", "deepseek-v4-flash-free"],
      ["tokenrouter", "moonshotai/kimi-k3-free"], ["tokenharbor", "deepseek-v4.1-flash:free"]]) {
      expect(getPricingForModel(provider, model), `${provider}/${model}`).toEqual(ZERO_PRICING);
    }
    // The namespace rule is narrower than the suffix rule and stays unchanged.
    expect(isFreeModel("cline-free/deepseek-v4.1-flash")).toBe(true);
    expect(isFreeModel("deepseek-v4.1-flash:free")).toBe(false);
  });

  it("reseller tariffs are literal provider/model rows in PROVIDER_PRICING", () => {
    expect(getPricingForModel("tokenrouter", "anthropic/claude-haiku-4.5")).toEqual(
      { input: 1.0, output: 5.0, cached: 0.1, cache_creation: 1.25, reasoning: 5.0 });
    expect(getPricingForModel("claude", "claude-sonnet-5")).toEqual(
      { input: 2.00, output: 10.00, cached: 0.20, reasoning: 10.00, cache_creation: 2.50 });
  });
});

describe("xiaomi transport/catalog source facts", () => {
  it("v2.6 desktop dual-route models carry the xiaomi/ namespace; previews keep it too", () => {
    for (const id of ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.6-pro-ultraspeed", "mimo-x-pro-preview"]) {
      const model = xiaomiRegistry.models.find((m) => m.id === id);
      expect(model.upstreamModelId, id).toBe(`xiaomi/${id}`);
    }
  });
});
