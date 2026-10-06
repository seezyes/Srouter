import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { getDefaultModel, getModelTargetFormat, getModelSupportedFormats, getModelUpstreamId, getProviderModels, isValidModel } from "../../open-sse/config/providerModels.js";
import { parseModel } from "../../open-sse/services/model.js";
import { resolveTransport } from "../../open-sse/services/provider.js";

const additions = [
  ["xai", "xai", "grok-4.7"],
  ["claude", "cc", "claude-sonnet-5-5"],
  ["anthropic", "anthropic", "claude-sonnet-5-5"],
  ["anthropic", "anthropic", "claude-opus-5-5"],
  ["deepseek", "deepseek", "deepseek-flash"],
  ["mistral", "mistral", "mistral-medium-3-5"],
  ["mistral", "mistral", "mistral-large-2512"],
  ["perplexity", "perplexity", "sonar-reasoning-pro"],
  ["perplexity", "perplexity", "sonar-deep-research"],
  ["minimax", "minimax", "MiniMax-M3.1-Flash-Preview"],
];

describe("source-backed provider catalog additions", () => {
  it.each(additions)("routes %s via %s/%s without rewriting its official ID", (id, alias, model) => {
    const entry = REGISTRY.find((p) => p.id === id);
    expect(entry.models.filter((m) => m.id === model)).toHaveLength(1);
    expect(isValidModel(alias, model)).toBe(true);
    expect(getModelUpstreamId(alias, model)).toBe(model);
    expect(parseModel(`${alias}/${model}`)).toMatchObject({ provider: id, model });
  });

  it("keeps older model IDs available", () => {
    for (const [alias, model] of [
      ["cc", "claude-sonnet-5"], ["xai", "grok-4.6"], ["deepseek", "deepseek-v4.1-flash"],
      ["mistral", "mistral-large-latest"], ["perplexity", "sonar"], ["minimax", "MiniMax-M3"],
    ]) expect(isValidModel(alias, model)).toBe(true);
  });

  it("does not pretend xAI API availability establishes Grok CLI subscription access", () => {
    expect(getProviderModels("gcli").some((m) => m.id === "grok-4.7")).toBe(false);
  });

  it("does not invent Gemini 4 Argon or unsupported China preview IDs", () => {
    for (const alias of ["gemini", "gc", "vertex"]) {
      expect(getProviderModels(alias).some((m) => /argon/i.test(m.id))).toBe(false);
    }
    expect(getProviderModels("minimax-cn").some((m) => m.id === "MiniMax-M3.1-Flash-Preview")).toBe(false);
    expect(REGISTRY.find((p) => p.id === "minimax").models.find((m) => m.id === "MiniMax-M3.1-Flash-Preview").name).toContain("Token Plan");
    expect(getModelTargetFormat("minimax", "MiniMax-M3.1-Flash-Preview")).toBe("openai");
    expect(getModelSupportedFormats("minimax", "MiniMax-M3.1-Flash-Preview")).toEqual(["openai"]);
    expect(resolveTransport("minimax", getModelTargetFormat("minimax", "MiniMax-M3.1-Flash-Preview")).baseUrl)
      .toBe("https://api.minimax.io/v1/chat/completions");
    expect(getDefaultModel("minimax")).toBe("MiniMax-M3");
  });
});
