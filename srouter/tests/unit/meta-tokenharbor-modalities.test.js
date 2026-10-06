import { afterEach, describe, expect, it, vi } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDER_MEDIA, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { resolveTransport } from "../../open-sse/services/provider.js";
import { resolveProviderAlias } from "../../open-sse/services/model.js";
import { getImageAdapter } from "../../open-sse/handlers/imageProviders/index.js";
import { handleSttCore } from "../../open-sse/handlers/sttCore.js";
import { getProviderIconSrc } from "@/shared/utils/providerIcon.js";

afterEach(() => vi.unstubAllGlobals());
describe("Meta and Token Harbor native transports and media", () => {
  it.each(["meta", "tokenharbor"])("%s exposes all three native transport formats", (provider) => {
    const executor = getExecutor(provider);
    for (const [format, suffix] of [["openai", "/chat/completions"], ["claude", "/messages"], ["openai-responses", "/responses"]]) {
      const transport = resolveTransport(provider, format);
      expect(transport?.format).toBe(format);
      const credentials = { apiKey: "fixture", runtimeTransport: transport };
      expect(executor.buildUrl("fixture", true, 0, credentials)).toBe(transport.baseUrl);
      expect(transport.baseUrl.endsWith(suffix)).toBe(true);
      const headers = executor.buildHeaders(credentials);
      const auth = provider === "tokenharbor" && format === "claude" ? "x-api-key" : "Authorization";
      expect(headers[auth]).toBe(auth === "x-api-key" ? "fixture" : "Bearer fixture");
    }
  });
  it.each(["meta", "tokenharbor"])("%s has a wired image adapter and configuration", (provider) => {
    const adapter = getImageAdapter(provider);
    expect(adapter).not.toBeNull();
    expect(adapter.buildUrl()).toBe(PROVIDER_MEDIA[provider].imageConfig.baseUrl);
    expect(adapter.buildHeaders({ apiKey: "fixture" }).Authorization).toBe("Bearer fixture");
    expect(adapter.buildBody("image-fixture", { prompt: "fixture" })).toMatchObject({
      model: "image-fixture", prompt: "fixture",
    });
  });
  it("Meta transcribes through the configured multipart transport", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"text":"fixture"}'));
    vi.stubGlobal("fetch", fetch);
    const formData = new FormData();
    formData.append("file", new File(["fixture"], "audio.wav", { type: "audio/wav" }));
    const result = await handleSttCore({
      provider: "meta", model: "muse-voice-transcribe-1.0", formData,
      credentials: { apiKey: "fixture" }, sttConfig: PROVIDER_MEDIA.meta.sttConfig,
    });
    expect(result.success).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe("https://api.meta.ai/v1/audio/transcriptions");
    expect(fetch.mock.calls[0][1].body.get("model")).toBe("muse-voice-transcribe-1.0");
  });
  it("keeps existing aliases and seed while adding the pinned seed models", () => {
    for (const alias of ["th", "thh", "tokenharbor"]) expect(resolveProviderAlias(alias)).toBe("tokenharbor");
    for (const alias of ["meta", "meta-ai"]) expect(resolveProviderAlias(alias)).toBe("meta");
    const ids = PROVIDER_MODELS.tokenharbor.map((entry) => entry.id);
    expect(ids).toEqual(expect.arrayContaining(["grok-4.7", "th-orchestra", "mimo-v2.6-pro", "minimax-m3"]));
    expect(new Set(ids).size).toBe(ids.length);
    expect(REGISTRY.some((entry) => entry.id === "burngate")).toBe(true);
    expect(new Set(REGISTRY.map((entry) => entry.id)).size).toBe(REGISTRY.length);
  });
  it("resolves Meta's pinned WebP icon without changing existing PNGs", () => {
    expect(getProviderIconSrc("meta")).toBe("/providers/meta.webp");
    expect(getProviderIconSrc("tokenharbor")).toBe("/providers/tokenharbor.png");
  });
});
