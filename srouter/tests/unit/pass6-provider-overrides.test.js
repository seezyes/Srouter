import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
vi.mock("@/lib/db", () => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { BaseExecutor } from "../../open-sse/executors/base.js";
import { normalizeProviderOverride, applyProviderOverride } from "../../open-sse/utils/providerOverrides.js";
import { getSettings, updateSettings } from "@/lib/db";
import { GET, PUT } from "@/app/api/providers/[id]/overrides/route.js";
const params = (id) => ({ params: Promise.resolve({ id }) });
const put = (body) => new Request("http://localhost/api/providers/cc/overrides", {
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue({ providerOverrides: {} });
  updateSettings.mockResolvedValue({});
});
afterEach(() => vi.restoreAllMocks());

describe("header override trust boundaries", () => {
  it.each(["Authorization", "Cookie", "x-api-key", "X-Goog-Api-Key", "proxy-authorization", "ChatGPT-Account-ID",
    "x-access-token", "x-relay-target", "x-forwarded-for", "Host", "connection"])("rejects credential/routing header %s", (name) => {
    expect(() => normalizeProviderOverride({ headers: { [name]: "foreign" } })).toThrow();
  });
  it("rejects malformed, control, duplicate-case and oversized values", () => {
    for (const body of [[], null, { headers: [] }, { headers: { X: "a\r\nb" } },
      { headers: { X: "x", x: "y" } }, { headers: { X: "x".repeat(8193) } }]) {
      expect(() => normalizeProviderOverride(body)).toThrow();
    }
  });
  it("replaces names case-insensitively and keeps registry objects intact", () => {
    const original = { "User-Agent": "builtin", Authorization: "Bearer selected" };
    expect(applyProviderOverride(original, { headers: { "user-agent": "custom" } })).toEqual({
      "user-agent": "custom", Authorization: "Bearer selected",
    });
    expect(original["User-Agent"]).toBe("builtin");
    expect(applyProviderOverride(original, { headers: { Authorization: "foreign" } })).toBe(original);
  });
  it("applies overrides to the real dispatch without crossing credentials", async () => {
    proxyAwareFetch.mockImplementation(async (_url, init) => new Response(JSON.stringify(init.headers)));
    const config = { baseUrl: "https://provider.invalid/chat", headers: { "User-Agent": "builtin" }, retry: {} };
    const executor = new BaseExecutor("test", config);
    const results = await Promise.all(["one", "two"].map((token) => executor.execute({
      model: "model", body: {}, stream: false, credentials: { apiKey: token },
      providerOverrides: { headers: { "USER-AGENT": token } },
    })));
    for (let i = 0; i < results.length; i++) {
      expect(await results[i].response.json()).toMatchObject({
        Authorization: `Bearer ${["one", "two"][i]}`, "user-agent": ["one", "two"][i],
      });
    }
    expect(config.headers).toEqual({ "User-Agent": "builtin" });
  });
});
describe("override API", () => {
  it("canonicalizes aliases and returns no-store", async () => {
    const response = await PUT(put({ headers: { "User-Agent": "custom" } }), params("cc"));
    expect(response.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({ providerOverrides: { claude: { headers: { "user-agent": "custom" } } } });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("does not clear on malformed JSON or unknown provider", async () => {
    expect((await PUT(new Request("http://localhost", { method: "PUT", body: "{" }), params("cc"))).status).toBe(400);
    expect((await PUT(put({}), params("unknown"))).status).toBe(404);
    expect(updateSettings).not.toHaveBeenCalled();
  });
  it("filters malformed imported overrides and built-in auth before returning", async () => {
    getSettings.mockResolvedValue({ providerOverrides: { claude: { headers: { Authorization: "secret" } } } });
    const response = await GET(null, params("cc"));
    expect((await response.json()).headers).toEqual({});
  });
  it("serializes concurrent provider read/modify/write", async () => {
    let settings = { providerOverrides: {} };
    getSettings.mockImplementation(async () => structuredClone(settings));
    updateSettings.mockImplementation(async (value) => { await Promise.resolve(); settings = { ...settings, ...value }; });
    await Promise.all([PUT(put({ headers: { X: "one" } }), params("cc")), PUT(put({ headers: { X: "two" } }), params("cx"))]);
    expect(Object.keys(settings.providerOverrides).sort()).toEqual(["claude", "codex"]);
  });
});
