import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => globalThis.fetch(...args),
}));
import { testApiKeyConnection, testOAuthConnection } from "@/app/api/providers/[id]/test/testUtils.js";
import { POST as validate } from "@/app/api/providers/validate/route.js";
afterEach(() => vi.unstubAllGlobals());

describe("Registry-backed validation and ZCode diagnostics", () => {
  it.each(["meta", "tokenharbor", "burngate"])("validates %s using its models endpoint", async (provider) => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"data":[]}'));
    vi.stubGlobal("fetch", fetch);
    expect(await testApiKeyConnection({ provider, apiKey: "fixture" })).toMatchObject({ valid: true });
    expect(String(fetch.mock.calls[0][0])).toMatch(/\/models$/);
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer fixture");
  });
  it.each([401, 403, 500])("does not accept status %s as a validated key", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("fixture", { status })));
    expect(await testApiKeyConnection({ provider: "meta", apiKey: "fixture" })).toMatchObject({ valid: false });
  });
  it("ZCode API-key testing sends native auth without starting a browser", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    expect(await testApiKeyConnection({ provider: "zcode", apiKey: "fixture" })).toMatchObject({ valid: true });
    expect(fetch.mock.calls[0][0]).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect(fetch.mock.calls[0][1].headers["x-api-key"]).toBe("fixture");
  });
  it("ZCode onboarding validation also applies the registry auth descriptor", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const response = await validate(new Request("http://localhost/api/providers/validate", {
      method: "POST", body: JSON.stringify({ provider: "zcode", apiKey: "fixture" }),
    }));
    expect((await response.json()).valid).toBe(true);
    expect(fetch.mock.calls[0][1].headers["x-api-key"]).toBe("fixture");
  });
  it("ZCode OAuth diagnostics distinguish absent and expired plan credentials", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await testOAuthConnection({ provider: "zcode", accessToken: "fixture" })).toMatchObject({ valid: false });
    const jwt = `fixture.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.fixture`;
    expect(await testOAuthConnection({ provider: "zcode", accessToken: "fixture", providerSpecificData: { zcodeJwtToken: jwt } }))
      .toMatchObject({ valid: false, error: expect.stringContaining("expired") });
    expect(await testOAuthConnection({ provider: "zcode", accessToken: "fixture", providerSpecificData: { zcodeJwtToken: "opaque" } }))
      .toMatchObject({ valid: true, warning: expect.stringContaining("not tested") });
    expect(fetch).not.toHaveBeenCalled();
  });
});
