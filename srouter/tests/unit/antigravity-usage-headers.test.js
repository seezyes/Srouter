import { describe, it, expect, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.fn(async (url) => ({
  ok: true,
  status: 200,
  json: async () => url.includes(":loadCodeAssist")
    ? { cloudaicompanionProject: "project-1", currentTier: { name: "Pro" }, paidTier: { id: "g1-pro-tier", name: "Google AI Pro" } }
    : url.includes(":retrieveUserQuotaSummary")
      ? { groups: [] }
      : { models: {} },
  text: async () => "{}",
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

describe("Antigravity usage headers", () => {
  beforeEach(() => proxyAwareFetch.mockClear());

  it("uses the official IDE user agent and omits router-only source headers", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    await getAntigravityUsage("access-token", {});

    // loadCodeAssist + fetchAvailableModels + retrieveUserQuotaSummary
    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
    for (const [, options] of proxyAwareFetch.mock.calls) {
      expect(options.headers["User-Agent"]).toBe("antigravity/ide/2.11.0 darwin/arm64");
      expect(options.headers).not.toHaveProperty("x-request-source");
    }
  });

  it.each([["VALIDATION_REQUIRED", true], ["access denied", false]])("distinguishes quota refusal %s", async (detail, ineligible) => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    proxyAwareFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    proxyAwareFetch.mockResolvedValueOnce({ ok: false, status: 403, text: async () => detail });
    const usage = await getAntigravityUsage("test-token", {});
    expect(usage).toMatchObject({ ineligible, quotas: {} });
    expect(usage.message).toContain(ineligible ? "Chat will fail with 403" : "Chat may still work");
  });
});
