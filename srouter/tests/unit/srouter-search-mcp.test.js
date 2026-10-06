import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_SROUTER_SEARCH, normalizeSrouterSearch, validateSrouterSearch } from "@/shared/utils/srouterSearchConfig";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(), key: vi.fn(), kind: vi.fn(), search: vi.fn(), fetch: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.settings }));
vi.mock("@/sse/services/auth", () => ({
  extractApiKey: (request) => request.headers.get("authorization")?.replace(/^Bearer /, ""),
  getApiKeyInfo: mocks.key,
}));
vi.mock("@/sse/services/requestAccess", () => ({ checkKindAccess: mocks.kind }));
vi.mock("@/sse/handlers/search", () => ({ handleSearch: mocks.search }));
vi.mock("@/sse/handlers/fetch", () => ({ handleFetch: mocks.fetch }));

import { handleSrouterSearchMcp } from "@/lib/mcp/srouterSearch";
import { GET, DELETE } from "@/app/api/v1/mcp/search/route";

const config = () => ({ ...DEFAULT_SROUTER_SEARCH, enabled: true, searchProvider: "exa", fetchProvider: "jina" });
const request = (method, params, overrides = {}) => new Request("http://localhost:20129/api/v1/mcp/search", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer test-key", ...overrides.headers },
  body: overrides.raw ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
});
const invoke = async (method, params, overrides) => {
  const response = await handleSrouterSearchMcp(request(method, params, overrides));
  return { status: response.status, data: await response.json() };
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.key.mockResolvedValue({ isActive: true });
  mocks.settings.mockResolvedValue({ requireApiKey: false, srouterSearch: config() });
  mocks.kind.mockReturnValue(null);
  mocks.search.mockImplementation(async () => Response.json({ results: [{ url: "https://example.com" }] }));
  mocks.fetch.mockImplementation(async () => Response.json({ content: "page" }));
});

describe("SRouterSearch settings", () => {
  it("is opt-in with valid bounded defaults", () => {
    expect(normalizeSrouterSearch(undefined)).toEqual(DEFAULT_SROUTER_SEARCH);
    expect(DEFAULT_SROUTER_SEARCH.enabled).toBe(false);
    expect(validateSrouterSearch(config())).toBeNull();
  });
  it.each([
    null, [], { enabled: "true" }, { token: "not-allowed" }, { maxResults: 101 },
    { maxCharacters: 999 }, { searchProvider: 3 }, { fetchProvider: "bad\nname" },
  ])("rejects invalid configuration %j", (value) => {
    expect(validateSrouterSearch(value)).toBeTruthy();
    expect(normalizeSrouterSearch(value).enabled).toBe(false);
  });
});

describe("SRouterSearch stateless MCP", () => {
  it.each(["2025-06-18", "2025-03-26", "2024-11-05"])("initializes %s", async (protocolVersion) => {
    const { data } = await invoke("initialize", { protocolVersion });
    expect(data.result.protocolVersion).toBe(protocolVersion);
    expect(data.result.serverInfo.name).toBe("SRouterSearch");
    expect(data.result.capabilities.tools).toEqual({ listChanged: false });
  });
  it("requires a real key even when HTTP API key mode is optional", async () => {
    mocks.key.mockResolvedValue(null);
    expect((await invoke("tools/list")).status).toBe(401);
    expect(mocks.search).not.toHaveBeenCalled();
  });
  it("is disabled by default", async () => {
    mocks.settings.mockResolvedValue({});
    expect((await invoke("tools/list")).status).toBe(503);
  });
  it("blocks cross-origin requests and non-JSON content", async () => {
    expect((await invoke("ping", {}, { headers: { origin: "https://foreign.example" } })).status).toBe(403);
    expect((await invoke("ping", {}, { headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect(mocks.key).not.toHaveBeenCalled();
  });
  it("advertises only enabled and allowed tools", async () => {
    expect((await invoke("tools/list")).data.result.tools.map((t) => t.name)).toEqual(["srouter_web_search", "srouter_web_fetch"]);
    mocks.kind.mockImplementation((_, kind) => kind === "webFetch" ? new Response(null, { status: 403 }) : null);
    expect((await invoke("tools/list")).data.result.tools.map((t) => t.name)).toEqual(["srouter_web_search"]);
    mocks.settings.mockResolvedValue({ srouterSearch: { ...config(), searchEnabled: false } });
    expect((await invoke("tools/list")).data.result.tools).toEqual([]);
  });
  it("forwards a default or explicit provider/combo to the actual search handler boundary", async () => {
    const result = await invoke("tools/call", { name: "srouter_web_search", arguments: { query: "hello" } }, {
      headers: { cookie: "dashboard-secret", "x-cli-token": "internal-secret" },
    });
    expect(result.data.result.isError).toBeUndefined();
    const forwarded = mocks.search.mock.calls[0][0];
    expect(await forwarded.json()).toEqual({ provider: "exa", query: "hello", max_results: 10 });
    expect(forwarded.headers.get("authorization")).toBe("Bearer test-key");
    expect(forwarded.headers.get("cookie")).toBeNull();
    expect(forwarded.headers.get("x-cli-token")).toBeNull();
    await invoke("tools/call", { name: "srouter_web_search", arguments: { query: "hello", provider: "my-combo", max_results: 3 } });
    expect(await mocks.search.mock.calls[1][0].json()).toEqual({ provider: "my-combo", query: "hello", max_results: 3 });
  });
  it("forwards fetch to the existing SSRF/ACL-guarded handler boundary", async () => {
    await invoke("tools/call", { name: "srouter_web_fetch", arguments: { url: "https://example.com" } });
    expect(await mocks.fetch.mock.calls[0][0].json()).toEqual({ provider: "jina", url: "https://example.com", format: "markdown", max_characters: 20000 });
    const source = readFileSync(new URL("../../src/sse/handlers/fetch.js", import.meta.url), "utf8");
    expect(source).toContain("await assertPublicUrlResolved(targetUrl)");
    expect(source).toContain('checkTargetAccess(apiKeyInfo, providerId, "fetch", "webFetch")');
  });
  it("fails closed for tool permission and disabled tool", async () => {
    mocks.kind.mockReturnValue(new Response(null, { status: 403 }));
    expect((await invoke("tools/call", { name: "srouter_web_search", arguments: { query: "x" } })).data.result.isError).toBe(true);
    mocks.kind.mockReturnValue(null);
    mocks.settings.mockResolvedValue({ srouterSearch: { ...config(), fetchEnabled: false } });
    expect((await invoke("tools/call", { name: "srouter_web_fetch", arguments: { url: "https://example.com" } })).data.result.isError).toBe(true);
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each([
    { name: "unknown", arguments: {} },
    { name: "srouter_web_search", arguments: { query: "" } },
    { name: "srouter_web_search", arguments: { query: "x", max_results: 11 } },
    { name: "srouter_web_search", arguments: { query: "x", provider_options: {} } },
    { name: "srouter_web_fetch", arguments: { url: "https://example.com", max_characters: 20001 } },
    { name: "srouter_web_fetch", arguments: { url: "https://example.com", format: "html" } },
  ])("rejects invalid tool call %j", async (params) => {
    expect((await invoke("tools/call", params)).data.result.isError).toBe(true);
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("requires a target when no default is set", async () => {
    mocks.settings.mockResolvedValue({ srouterSearch: { ...config(), searchProvider: "" } });
    expect((await invoke("tools/call", { name: "srouter_web_search", arguments: { query: "x" } })).data.result.isError).toBe(true);
  });
  it("does not disclose upstream errors", async () => {
    mocks.fetch.mockResolvedValue(new Response("sensitive upstream payload", { status: 403 }));
    const result = await invoke("tools/call", { name: "srouter_web_fetch", arguments: { url: "http://127.0.0.1" } });
    expect(JSON.stringify(result)).not.toContain("sensitive");
    expect(result.data.result.content[0].text).toContain("HTTP 403");
  });
  it("bounds output and rejects streaming/non-JSON results", async () => {
    mocks.search.mockResolvedValue(Response.json({ content: "x".repeat(1024 * 1024) }));
    expect((await invoke("tools/call", { name: "srouter_web_search", arguments: { query: "x" } })).data.result.isError).toBe(true);
    mocks.search.mockResolvedValue(new Response("data: secret", { headers: { "Content-Type": "text/event-stream" } }));
    expect((await invoke("tools/call", { name: "srouter_web_search", arguments: { query: "x" } })).data.result.isError).toBe(true);
  });
  it("supports notifications, ping and method errors without sessions", async () => {
    const response = await handleSrouterSearchMcp(request("notifications/initialized", {}, { raw: '{"jsonrpc":"2.0","method":"notifications/initialized"}' }));
    expect(response.status).toBe(202);
    expect((await invoke("ping")).data.result).toEqual({});
    expect((await invoke("unknown")).data.error.code).toBe(-32601);
    expect(GET().status).toBe(405);
    expect(DELETE().status).toBe(405);
  });
  it("rejects malformed, oversized, batch and unsupported-version requests", async () => {
    expect((await invoke("ping", {}, { raw: "{" })).data.error.code).toBe(-32700);
    expect((await invoke("ping", {}, { raw: "[]" })).status).toBe(400);
    expect((await invoke("ping", {}, { raw: "x".repeat(65537) })).status).toBe(413);
    expect((await invoke("ping", {}, { headers: { "mcp-protocol-version": "invalid" } })).status).toBe(400);
  });
});
