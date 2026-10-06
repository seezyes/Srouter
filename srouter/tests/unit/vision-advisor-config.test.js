import { describe, expect, it } from "vitest";
import { normalizeAdvisorModels, normalizeVisionAdvisor, validateVisionAdvisor, visionAdvisorModelKey } from "../../src/shared/utils/visionAdvisorConfig.js";
import { mergeWithDefaults } from "../../src/lib/db/repos/settingsRepo.js";

describe("Vision Advisor configuration", () => {
  it("reads legacy single-model settings without rewriting the input", () => {
    const legacy = { enabled: true, model: "cmc/moonshotai/Kimi-K3" };
    expect(normalizeVisionAdvisor(legacy)).toEqual({ enabled: true, models: [legacy.model], overrides: {} });
    expect(mergeWithDefaults({ visionAdvisor: legacy }).visionAdvisor.models).toEqual([legacy.model]);
    expect(legacy).not.toHaveProperty("models");
  });

  it("does not revive a removed chain from a stale legacy model field", () => {
    expect(normalizeVisionAdvisor({ enabled: true, model: "cmc/old", models: [] }).models).toEqual([]);
  });

  it("deduplicates aliases and trims models without changing their order", () => {
    expect(normalizeAdvisorModels([" cmc/model ", "commandcode/model", "", null, "openai/second"])).toEqual(["cmc/model", "openai/second"]);
    expect(visionAdvisorModelKey("cmc/deepseek/model")).toBe("commandcode/deepseek/model");
  });

  it("keeps empty overrides and canonicalizes their target model", () => {
    expect(normalizeVisionAdvisor({ enabled: true, overrides: { "cmc/main": [], "openai/other": ["cmc/vision"] } }))
      .toEqual({ enabled: true, models: [], overrides: { "commandcode/main": [], "openai/other": ["cmc/vision"] } });
  });

  it("safely handles missing or malformed persisted fields", () => {
    expect(normalizeVisionAdvisor(null)).toEqual({ enabled: false, models: [], overrides: {} });
    expect(mergeWithDefaults({}).visionAdvisor).toEqual({ enabled: false, models: [], overrides: {} });
    expect(normalizeVisionAdvisor({ enabled: "yes", models: [null, 3], overrides: { broken: [], "x/y": null } }))
      .toEqual({ enabled: false, models: [], overrides: {} });
  });

  it.each([null, [], { enabled: "true" }, { models: "x/y" }, { models: [null] }, { models: ["no-provider"] }, { overrides: [] }, { overrides: { "x/y": "bad" } }])("rejects malformed API settings: %j", (config) => {
    expect(validateVisionAdvisor(config)).toBeTypeOf("string");
  });

  it("accepts both legacy and new API shapes", () => {
    expect(validateVisionAdvisor({ enabled: true, model: "cmc/vision" })).toBeNull();
    expect(validateVisionAdvisor({ enabled: false, models: [], overrides: { "x/y": [] } })).toBeNull();
  });
});
