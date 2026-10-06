import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  key: vi.fn(), settings: vi.fn(), credentials: vi.fn(), searchCore: vi.fn(), fetchCore: vi.fn(), ssrf: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.settings, getCombos: vi.fn(async () => []), getCustomModels: vi.fn(async () => []),
  getProviderConnectionById: vi.fn(),
}));
vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: (request) => request.headers.get("authorization")?.slice(7),
  getApiKeyInfo: mocks.key, getProviderCredentials: mocks.credentials,
  markAccountUnavailable: vi.fn(), clearAccountError: vi.fn(),
}));
vi.mock("@/sse/services/internalTrust.js", () => ({ isTrustedInternalRequest: vi.fn(async () => false) }));
vi.mock("@/sse/services/allowedModels.js", () => ({ isModelAllowed: vi.fn(async () => true) }));
vi.mock("@/lib/db/index.js", () => ({ getProviderNodeById: vi.fn(async () => null) }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_, credentials) => credentials), updateProviderCredentials: vi.fn(),
}));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrlResolved: mocks.ssrf }));
vi.mock("open-sse/handlers/search/index.js", () => ({ handleSearchCore: mocks.searchCore }));
vi.mock("open-sse/handlers/fetch/index.js", () => ({ handleFetchCore: mocks.fetchCore }));
import { handleSrouterSearchMcp } from "@/lib/mcp/srouterSearch";
const call = async (name, args) => {
  const response = await handleSrouterSearchMcp(new Request("http://localhost:20129/api/v1/mcp/search", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer synthetic-key" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }));
  return (await response.json()).result;
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockResolvedValue({ requireApiKey: true, srouterSearch: { enabled: true } });
  mocks.key.mockResolvedValue({ id: "synthetic", isActive: true, allowedKinds: null, allowedProviders: null, allowedCombos: null });
  mocks.credentials.mockResolvedValue({ apiKey: "synthetic-provider", connectionId: "synthetic" });
  mocks.ssrf.mockResolvedValue(undefined);
  mocks.searchCore.mockImplementation(async () => ({ success: true, response: Response.json({ results: [] }) }));
  mocks.fetchCore.mockResolvedValue({ success: true, data: { content: "public page" } });
});
describe("MCP through actual Search/Fetch handlers (mocked upstream)", () => {
  it("calls no-auth search without credentials", async () => {
    expect((await call("srouter_web_search", { provider: "searxng", query: "test" })).isError).toBeUndefined();
    expect(mocks.searchCore).toHaveBeenCalled();
    expect(mocks.credentials).not.toHaveBeenCalled();
  });
  it("preserves provider ACL even with optional HTTP key mode", async () => {
    mocks.settings.mockResolvedValue({ requireApiKey: false, srouterSearch: { enabled: true } });
    mocks.key.mockResolvedValue({ id: "synthetic", isActive: true, allowedProviders: [] });
    const result = await call("srouter_web_search", { provider: "searxng", query: "test" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("HTTP 403");
    expect(mocks.searchCore).not.toHaveBeenCalled();
  });
  it("uses saved fetch credentials without exposing them", async () => {
    const result = await call("srouter_web_fetch", { provider: "exa", url: "https://example.com" });
    expect(result.isError).toBeUndefined();
    expect(mocks.ssrf).toHaveBeenCalledWith("https://example.com");
    expect(mocks.fetchCore).toHaveBeenCalledWith(expect.objectContaining({ credentials: expect.objectContaining({ apiKey: "synthetic-provider" }), maxCharacters: 20000 }));
    expect(JSON.stringify(result)).not.toContain("synthetic-provider");
  });
  it("honors SSRF guard failure before fetch credentials/upstream", async () => {
    mocks.ssrf.mockRejectedValue(new Error("Internal URL blocked"));
    const result = await call("srouter_web_fetch", { provider: "exa", url: "http://127.0.0.1" });
    expect(result.isError).toBe(true);
    expect(mocks.credentials).not.toHaveBeenCalled();
    expect(mocks.fetchCore).not.toHaveBeenCalled();
  });
});
