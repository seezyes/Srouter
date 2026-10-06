import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), captcha: vi.fn() }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
vi.mock("open-sse/utils/zcodeCaptcha.js", () => ({ solveZCodeCaptcha: mocks.captcha }));
import { ZcodeExecutor } from "open-sse/executors/zcode.js";
import { BaseExecutor } from "open-sse/executors/base.js";
import REGISTRY from "open-sse/providers/registry/index.js";
import zcode from "@/lib/oauth/providers/zcode.js";
// Browser option tests import the actual module rather than the executor mock.
const browser = await vi.importActual("open-sse/utils/zcodeCaptcha.js");
const executor = new ZcodeExecutor();
beforeEach(() => {
  vi.clearAllMocks();
  mocks.captcha.mockResolvedValue("synthetic-verification");
  mocks.fetch.mockImplementation(async () => new Response("ok", { headers: { "content-type": "text/event-stream" } }));
});

describe("ZCode integration", () => {
  it("registers unique dual-auth provider with four pinned models", () => {
    const entries = REGISTRY.filter((entry) => entry.id === "zcode");
    expect(entries).toHaveLength(1);
    expect(entries[0].authModes).toEqual(["apikey", "oauth"]);
    expect(entries[0].models).toHaveLength(4);
  });

  it("uses native Windows Edge or explicit browser executable, not an author's Linux path", () => {
    expect(browser.getZCodeBrowserOptions(null, {}, "win32")).toMatchObject({ channel: "msedge" });
    expect(browser.getZCodeBrowserOptions(null, { ZCODE_BROWSER_EXECUTABLE: "C:\\Browser\\chrome.exe" }, "win32"))
      .toMatchObject({ executablePath: "C:\\Browser\\chrome.exe" });
    expect(() => browser.getZCodeBrowserOptions(null, { ZCODE_BROWSER_EXECUTABLE: "relative.exe" }, "win32")).toThrow();
    expect(browser.getZCodeBrowserOptions({ connectionProxyEnabled: true, connectionProxyUrl: "http://user:pass@127.0.0.1:1234" }, {}, "win32"))
      .toMatchObject({ proxy: { server: "http://127.0.0.1:1234", username: "user", password: "pass" } });
    expect(() => browser.getZCodeBrowserOptions({ strictProxy: true }, {}, "win32")).toThrow();
  });

  it("API keys use official endpoint and never launch browser verification", async () => {
    await executor.execute({ model: "GLM-5.2", body: { messages: [] }, stream: true, credentials: { apiKey: "synthetic-api-key" } });
    expect(mocks.captcha).not.toHaveBeenCalled();
    expect(mocks.fetch.mock.calls[0][0]).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect(mocks.fetch.mock.calls[0][1].headers["x-api-key"]).toBe("synthetic-api-key");
    expect(mocks.fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("keeps the account-count retry cap on the API-key BaseExecutor path", async () => {
    const execute = vi.spyOn(BaseExecutor.prototype, "execute").mockResolvedValue({ response: new Response("ok") });
    try {
      await executor.execute({
        model: "GLM-5.2", body: {}, credentials: { apiKey: "fixture-key" }, accountCount: 5,
      });
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ accountCount: 5 }));
      expect(mocks.captcha).not.toHaveBeenCalled();
    } finally {
      execute.mockRestore();
    }
  });

  it("OAuth requests use plan JWT, platform identity, captcha and reasoning variant", async () => {
    const result = await executor.execute({
      model: "GLM-5.2-Max", body: { messages: [], max_tokens: 100 }, stream: true,
      credentials: { providerSpecificData: { zcodeJwtToken: "synthetic-plan-jwt" } },
    });
    expect(result.url).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
    const sent = mocks.fetch.mock.calls[0][1];
    expect(sent.headers).toMatchObject({ Authorization: "Bearer synthetic-plan-jwt", "X-Aliyun-Captcha-Verify-Param": "synthetic-verification" });
    const payload = JSON.parse(sent.body);
    expect(payload).toMatchObject({ model: "GLM-5.2", max_tokens: 100, thinking: { type: "enabled" }, output_config: { effort: "max" } });
    expect(payload.thinking.budget_tokens).toBeUndefined();
  });

  it("missing plan JWT fails before network or browser activity", async () => {
    const result = await executor.execute({ model: "GLM-5.2", body: {}, credentials: { accessToken: "synthetic-oauth" } });
    expect(result.response.status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.captcha).not.toHaveBeenCalled();
  });

  it.each(["apikey", "oauth"])("sends explicit off/budget without Max forcing them on (%s)", async (mode) => {
    const credentials = mode === "apikey"
      ? { apiKey: "synthetic-api-key" }
      : { providerSpecificData: { zcodeJwtToken: "synthetic-plan-jwt" } };
    for (const thinking of [
      { type: "disabled" },
      { type: "enabled", budget_tokens: 12000 },
    ]) {
      const body = { messages: [], max_tokens: 15000, thinking };
      await executor.execute({ model: "GLM-5.2-Max", body, stream: true, credentials });
      const sent = JSON.parse(mocks.fetch.mock.calls.at(-1)[1].body);
      expect(sent.thinking).toEqual(thinking);
      expect(sent.max_tokens).toBe(15000);
      expect(sent.model).toBe("GLM-5.2");
      expect(body.thinking).toEqual(thinking);
    }
  });

  it("refreshes only the business token through the selected proxy, preserving the plan JWT", async () => {
    const proxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:1234" };
    const credentials = {
      accessToken: "fixture-oauth", providerSpecificData: {
        zcodeJwtToken: "fixture-plan", businessToken: "fixture-old-business", enabledModels: ["GLM-5.2"],
      },
    };
    mocks.fetch.mockResolvedValueOnce(Response.json({ data: { access_token: "fixture-new-business" } }));
    const refreshed = await executor.refreshCredentials(credentials, null, proxy);
    expect(refreshed).toEqual({
      accessToken: "fixture-oauth", providerSpecificData: {
        ...credentials.providerSpecificData, businessToken: "fixture-new-business",
      },
    });
    expect(mocks.fetch.mock.calls[0][2]).toBe(proxy);
    expect(mocks.fetch.mock.calls[0][0]).toBe("https://api.z.ai/api/auth/z/login");
    expect(credentials.providerSpecificData.businessToken).toBe("fixture-old-business");
    expect(mocks.captcha).not.toHaveBeenCalled();
  });

  it("does not fabricate a successful refresh for a failed or empty business-token response", async () => {
    for (const response of [
      new Response("", { status: 401 }), Response.json({ data: {} }),
    ]) {
      mocks.fetch.mockResolvedValueOnce(response);
      expect(await executor.refreshCredentials({ accessToken: "fixture-oauth" }, null)).toBeNull();
    }
    expect(await executor.refreshCredentials({}, null)).toBeNull();
  });

  it("aborted request does not start verification or inference", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(executor.execute({ model: "GLM-5.2", body: {}, signal: controller.signal, credentials: {} })).rejects.toThrow();
    expect(mocks.captcha).not.toHaveBeenCalled();
  });

  it("OAuth URL and exchange pin the custom scheme and preserve state", async () => {
    const url = new URL(zcode.buildAuthUrl(zcode.config, "http://foreign/callback", "synthetic-state"));
    expect(url.searchParams.get("redirect_uri")).toBe("zcode://zai-auth/callback");
    expect(url.searchParams.get("state")).toBe("synthetic-state");
    const fetch = vi.fn(async () => Response.json({ code: 0, data: { token: "synthetic-jwt", zai: { access_token: "synthetic-oauth" } } }));
    vi.stubGlobal("fetch", fetch);
    try {
      const tokens = await zcode.exchangeToken(zcode.config, "synthetic-code", "http://foreign/callback", "", "synthetic-state");
      expect(tokens).toMatchObject({ accessToken: "synthetic-oauth", zcodeJwtToken: "synthetic-jwt" });
      expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ redirect_uri: "zcode://zai-auth/callback", state: "synthetic-state" });
      expect(zcode.mapTokens(tokens).providerSpecificData.enabledModels).toHaveLength(4);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
