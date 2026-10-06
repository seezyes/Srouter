// Codex catalog: the GPT-6 family must be available to clients under the
// provider alias `cx` (PROVIDER_MODELS is keyed by registry alias).
import { describe, expect, it } from "vitest";
import { PROVIDER_MODELS, getProviderModels } from "../../open-sse/config/providerModels.js";

describe("codex GPT-6 catalog", () => {
  it("exposes the GPT-6 ids under the cx alias", () => {
    const ids = getProviderModels("cx").map((model) => model.id);
    for (const id of ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol"]) {
      expect(ids).toContain(id);
    }
  });

  it("keeps the pre-existing GPT-5.6 entries intact", () => {
    const ids = (PROVIDER_MODELS.cx || []).map((model) => model.id);
    for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(ids).toContain(id);
    }
  });
});
