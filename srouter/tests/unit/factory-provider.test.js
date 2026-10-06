import { describe, it, expect } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import factoryEntry, {
  FACTORY_CLIENT_VERSION,
  FACTORY_MODEL_META,
  FACTORY_WIRE_URLS,
} from "../../open-sse/providers/registry/factory.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";
import {
  getDefaultModel,
  getModelSupportedFormats,
  getModelTargetFormat,
  isValidModel,
} from "../../open-sse/config/providerModels.js";
import { getTargetFormat, resolveTransport } from "../../open-sse/services/provider.js";
import { resolveProviderAlias } from "../../open-sse/services/model.js";
import { APIKEY_PROVIDERS } from "../../src/shared/constants/providers.js";

const COMPLETIONS = "https://api.factory.ai/api/llm/o/v1/chat/completions";
const RESPONSES = "https://api.factory.ai/api/llm/o/v1/responses";
const ANTHROPIC = "https://api.factory.ai/api/llm/a/v1/messages";

describe("factory registry entry", () => {
  it("is registered once in the static import list", () => {
    const matches = REGISTRY.filter((entry) => entry.id === "factory");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(factoryEntry);
  });

  it("appears as an apikey provider with quota features", () => {
    expect(APIKEY_PROVIDERS.factory).toBeDefined();
    expect(APIKEY_PROVIDERS.factory.alias).toBe("factory");
    expect(factoryEntry.category).toBe("apikey");
    expect(factoryEntry.features).toEqual({ usage: true, usageApikey: true });
  });

  it("declares the three verified wire transports", () => {
    const byFormat = Object.fromEntries(factoryEntry.transports.map((t) => [t.format, t.baseUrl]));
    expect(byFormat).toEqual({
      openai: COMPLETIONS,
      "openai-responses": RESPONSES,
      claude: ANTHROPIC,
    });
    expect(FACTORY_WIRE_URLS).toMatchObject({
      openai: COMPLETIONS,
      "openai-responses": RESPONSES,
      claude: ANTHROPIC,
    });
    expect(factoryEntry.transport.baseUrl).toBe(COMPLETIONS);
    expect(factoryEntry.transport.usage.url).toBe("https://api.factory.ai/api/billing/limits");
  });

  it("exposes billing + auth fields through the runtime PROVIDERS map", () => {
    expect(PROVIDERS.factory.baseUrl).toBe(COMPLETIONS);
    expect(PROVIDERS.factory.transports).toHaveLength(3);
    expect(PROVIDERS.factory.usage.url).toBe("https://api.factory.ai/api/billing/limits");
    expect(PROVIDERS.factory.auth).toMatchObject({ header: "Authorization", scheme: "bearer" });
  });

  it("keeps the catalog free of guessed price/entitlement fields", () => {
    for (const model of factoryEntry.models) {
      expect(model).not.toHaveProperty("pricing");
      expect(model).not.toHaveProperty("entitlements");
      expect(model.upstream).toBeTruthy();
      expect(FACTORY_MODEL_META[model.id]).toBe(model);
    }
  });

  it("mirrors the verified CLI snapshot model ids with single-wire support", () => {
    const ids = factoryEntry.models.map((m) => m.id);
    expect(ids).toEqual([
      // Anthropic Messages wire
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-4-8-fast",
      "claude-opus-5",
      "claude-opus-5-fast",
      "claude-opus-5-5",
      "claude-opus-5-5-fast",
      "claude-sonnet-5",
      "claude-sonnet-5-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-opus-4-5-20251101",
      "claude-haiku-4-5-20251001",
      "claude-fable-5",
      "claude-fable-5.1",
      "atlas-07-21",
      "aster-07-15",
      "minimax-m2.7",
      // OpenAI Responses wire
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-sol-fast",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.5-fast",
      "gpt-5.5-pro",
      "gpt-5.4",
      "gpt-5.4-fast",
      "gpt-5.4-mini",
      "gpt-5.4-mini-fast",
      "gpt-5.3-codex",
      "gpt-5.3-codex-fast",
      "gpt-5.2",
      "grok-4.7",
      "grok-4.6",
      "grok-4.5",
      // Chat Completions wire
      "kimi-k3",
      "glm-5.3",
      "glm-5.3-flash",
      "glm-5.2",
      "glm-5.2-fast",
      "deepseek-v4-pro",
      "deepseek-v4.1-flash",
      "deepseek-v4-flash-0731",
      "minimax-m3",
      "qwen3.8-max",
      "nemotron-3-ultra",
      "mistral-medium-3.5",
      "inkling",
    ]);
    expect(Object.keys(FACTORY_MODEL_META)).toHaveLength(ids.length);
    for (const model of factoryEntry.models) {
      expect(model.supportedFormats).toHaveLength(1);
      expect(model.contextLength).toBeGreaterThan(0);
      expect(model.maxOutputTokens).toBeGreaterThan(0);
    }
    expect(FACTORY_CLIENT_VERSION).toBe("0.228.0");
  });
});

describe("factory routing metadata", () => {
  it("resolves transports per client source format", () => {
    expect(resolveTransport("factory", "openai").baseUrl).toBe(COMPLETIONS);
    expect(resolveTransport("factory", "openai-responses").baseUrl).toBe(RESPONSES);
    expect(resolveTransport("factory", "claude").baseUrl).toBe(ANTHROPIC);
    expect(resolveTransport("factory", "gemini")).toBeNull();
  });

  it("defaults to the completions wire", () => {
    expect(getTargetFormat("factory")).toBe("openai");
    expect(getDefaultModel("factory")).toBe("claude-opus-4-6");
  });

  it("guards per-model wire support", () => {
    expect(getModelSupportedFormats("factory", "claude-opus-4-6")).toEqual(["claude"]);
    expect(getModelTargetFormat("factory", "claude-opus-4-6")).toBe("claude");
    expect(getModelSupportedFormats("factory", "gpt-6-sol")).toEqual(["openai-responses"]);
    expect(getModelTargetFormat("factory", "gpt-6-sol")).toBe("openai-responses");
    expect(getModelSupportedFormats("factory", "kimi-k3")).toEqual(["openai"]);
    expect(getModelTargetFormat("factory", "kimi-k3")).toBeNull();
    expect(getModelTargetFormat("factory", "grok-4.6")).toBe("openai-responses");
    expect(getModelTargetFormat("factory", "gpt-5.4-mini-fast")).toBe("openai-responses");
    expect(getModelSupportedFormats("factory", "glm-5.2-fast")).toEqual(["openai"]);
    expect(getModelTargetFormat("factory", "glm-5.2-fast")).toBeNull();
    expect(getModelTargetFormat("factory", "claude-opus-4-5-20251101")).toBe("claude");
  });

  it("resolves the provider id and aliases", () => {
    expect(resolveProviderAlias("factory")).toBe("factory");
    expect(resolveProviderAlias("factory-droid")).toBe("factory");
    expect(isValidModel("factory", "gpt-6-luna")).toBe(true);
    expect(isValidModel("factory", "gpt-9-imaginary")).toBe(false);
  });
});
