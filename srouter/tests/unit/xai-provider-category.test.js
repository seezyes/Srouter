import { describe, expect, it } from "vitest";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { APIKEY_PROVIDERS, OAUTH_PROVIDERS } from "../../src/shared/constants/providers.js";

// xai moved from the OAuth grid to the API-key grid: Grok Build sign-in belongs
// to provider `grok-cli`, while xai keeps its API-key transport and models.
describe("xai provider category", () => {
  it("is listed in the API-key grid, not the OAuth grid", () => {
    expect(APIKEY_PROVIDERS.xai).toBeTruthy();
    expect(OAUTH_PROVIDERS.xai).toBeUndefined();
    expect(APIKEY_PROVIDERS.xai.authModes).toEqual(["apikey"]);
    expect(APIKEY_PROVIDERS.xai.hasOAuth).toBeUndefined();
  });

  it("keeps grok-cli as the Grok Build OAuth provider", () => {
    expect(OAUTH_PROVIDERS["grok-cli"]).toBeTruthy();
    expect(OAUTH_PROVIDERS["grok-cli"].hasOAuth).toBe(true);
    expect(OAUTH_PROVIDERS["grok-cli"].name).toMatch(/Grok CLI/i);
  });

  it("keeps the xAI API-key transport, models and media routes", () => {
    expect(PROVIDERS.xai.baseUrl).toBe("https://api.x.ai/v1/chat/completions");
    expect(PROVIDERS.xai.validateUrl).toBe("https://api.x.ai/v1/models");
    expect(PROVIDERS.xai.responsesUrl).toBe("https://api.x.ai/v1/responses");
    expect(PROVIDER_MODELS.xai.some((model) => model.id === "grok-4.6")).toBe(true);
    expect(APIKEY_PROVIDERS.xai.serviceKinds).toContain("image");
    expect(APIKEY_PROVIDERS.xai.serviceKinds).toContain("video");
  });
});
