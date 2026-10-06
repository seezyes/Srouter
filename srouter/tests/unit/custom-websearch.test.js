// T-0045 — Custom web search provider nodes: builders, normalizer, /v1/search
// dispatch branches, ACL provider list and provider-nodes API validation.
// Review regressions (2026-10-04) are covered here: linked override stripping,
// no-auth/credentialFallback source policy, disabled-model check, keyed
// override guard order and makeResult-shaped custom JSON results.
// All offline; no DB, network or working data. Mirrors the mocking style of
// srouter-search-dispatch.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  key: vi.fn(),
  settings: vi.fn(),
  credentials: vi.fn(),
  searchCore: vi.fn(),
  node: vi.fn(),
  createNode: vi.fn(),
  getNodeById: vi.fn(),
  updateNode: vi.fn(),
  isModelAllowed: vi.fn(),
  codexExecute: vi.fn(),
  hostedWip: false,
}));
// Keep regression coverage of the dormant implementation. Production is
// unconditionally WIP; the explicit block tests below use the real gate value.
vi.mock("@/shared/constants/hostedTools.js", () => ({
  get HOSTED_TOOLS_WIP() { return mocks.hostedWip; },
  HOSTED_TOOLS_WIP_MESSAGE: "Hosted tools connector is WIP and unavailable.",
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.settings,
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getProviderConnectionById: vi.fn(),
}));
vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: (request) => request.headers.get("authorization")?.slice(7),
  getApiKeyInfo: mocks.key,
  getProviderCredentials: mocks.credentials,
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(),
}));
vi.mock("@/sse/services/internalTrust.js", () => ({ isTrustedInternalRequest: vi.fn(async () => false) }));
vi.mock("@/sse/services/allowedModels.js", () => ({ isModelAllowed: mocks.isModelAllowed }));
vi.mock("@/lib/db/index.js", () => ({ getProviderNodeById: mocks.node }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_, credentials) => credentials),
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/search/index.js", () => ({ handleSearchCore: mocks.searchCore }));
vi.mock("open-sse/executors/codex.js", () => ({
  CodexExecutor: class { execute(options) { return mocks.codexExecute(options); } },
}));
vi.mock("@/models", () => ({
  createProviderNode: mocks.createNode,
  getProviderNodes: vi.fn(async () => []),
  getProviderNodeById: mocks.getNodeById,
  updateProviderNode: mocks.updateNode,
  deleteProviderNode: vi.fn(),
  getProviderConnections: vi.fn(async () => []),
  updateProviderConnection: vi.fn(),
  deleteProviderConnectionsByProvider: vi.fn(),
}));

import { handleSearch } from "@/sse/handlers/search";
import { POST as postNode } from "@/app/api/provider-nodes/route.js";
import { PUT as putNode } from "@/app/api/provider-nodes/[id]/route.js";
import { buildSearchRequest } from "open-sse/handlers/search/callers.js";
import { normalizeSearchResponse } from "open-sse/handlers/search/normalizers.js";
import { buildProviderList } from "@/shared/utils/aclProviderList.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";

const NODE_ID = "custom-websearch-abc123";
const SEARCH_PROVIDER = AI_PROVIDERS.exa?.searchConfig ? "exa" : "searxng";
const NON_SEARCH_PROVIDER = Object.values(AI_PROVIDERS).find((p) => !p.searchConfig && !p.searchViaChat)?.id || "ollama";
const OLLAMA_SEARCH = AI_PROVIDERS["ollama-search"];
const SEARXNG_SOURCE = AI_PROVIDERS.searxng?.noAuth && AI_PROVIDERS.searxng?.searchConfig ? "searxng" : null;

const searchRequest = (body, headers = {}) => new Request("http://localhost:20129/v1/search", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer synthetic-key", ...headers },
  body: JSON.stringify(body),
});

const nodeRequest = (url, body, method = "POST") => new Request(url, {
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  mocks.hostedWip = false;
  vi.clearAllMocks();
  mocks.settings.mockResolvedValue({ requireApiKey: true });
  mocks.key.mockResolvedValue({ id: "synthetic", isActive: true, allowedKinds: null, allowedProviders: null, allowedCombos: null });
  mocks.credentials.mockResolvedValue({ apiKey: "key", connectionId: "conn-1", connectionName: "acct" });
  mocks.searchCore.mockImplementation(async () => ({ success: true, response: Response.json({ results: [] }) }));
  mocks.node.mockResolvedValue(null);
  mocks.createNode.mockImplementation(async (data) => ({ ...data }));
  mocks.getNodeById.mockResolvedValue(null);
  mocks.updateNode.mockImplementation(async (_id, data) => ({ id: _id, ...data }));
  mocks.isModelAllowed.mockResolvedValue(true);
  delete globalThis[Symbol.for("srouter.hostedSearch.plugins.v1")];
});

describe("hosted tools WIP request boundary", () => {
  it("creates and edits an explicit local plugin node while builtins remain WIP", async () => {
    mocks.hostedWip = true;
    const state = Symbol.for("srouter.hostedSearch.plugins.v1");
    globalThis[state] = Promise.resolve(new Map([["plugin:direct", {
      id: "plugin:direct", providerIds: ["codex"], search: vi.fn(),
    }]]));
    try {
      const body = { type: "custom-websearch", name: "Direct", mode: "plugin",
        sourceProviderId: "codex", sourceAdapterId: "plugin:direct" };
      const created = await postNode(nodeRequest("http://localhost/api/provider-nodes", body));
      expect(created.status).toBe(201);
      expect(mocks.createNode).toHaveBeenCalledWith(expect.objectContaining({ mode: "plugin", sourceModel: null, baseUrl: null }));
      mocks.getNodeById.mockResolvedValue({ ...body, id: NODE_ID });
      const updated = await putNode(nodeRequest(`http://localhost/api/provider-nodes/${NODE_ID}`,
        { ...body, sourceConnectionId: null }, "PUT"), { params: Promise.resolve({ id: NODE_ID }) });
      expect(updated.status).toBe(200);
      expect(mocks.updateNode).toHaveBeenCalledWith(NODE_ID, expect.objectContaining({ mode: "plugin", sourceModel: null }));
    } finally { delete globalThis[state]; }
  });

  it.each([
    { sourceAdapterId: "builtin:codex" },
    { sourceAdapterId: "plugin:missing" },
    { sourceAdapterId: "plugin:direct", sourceModel: "gpt-test" },
  ])("rejects invalid plugin runtime config before credentials: %j", async (fields) => {
    mocks.hostedWip = true;
    mocks.node.mockResolvedValue({ id: NODE_ID, type: "custom-websearch", mode: "plugin",
      sourceProviderId: "codex", ...fields });
    expect((await handleSearch(searchRequest({ provider: NODE_ID, query: "hello" }))).status).toBe(400);
    expect(mocks.credentials).not.toHaveBeenCalled();
    expect(mocks.searchCore).not.toHaveBeenCalled();
    expect(mocks.codexExecute).not.toHaveBeenCalled();
  });

  it("enforces source ACL for local plugins before account access", async () => {
    mocks.hostedWip = true;
    const state = Symbol.for("srouter.hostedSearch.plugins.v1");
    const search = vi.fn();
    globalThis[state] = Promise.resolve(new Map([["plugin:direct", { id: "plugin:direct", providerIds: ["*"], search }]]));
    try {
      mocks.node.mockResolvedValue({ id: NODE_ID, type: "custom-websearch", mode: "plugin",
        sourceProviderId: "codex", sourceAdapterId: "plugin:direct" });
      mocks.key.mockResolvedValue({ id: "restricted", isActive: true, allowedKinds: ["webSearch"], allowedProviders: [NODE_ID] });
      expect((await handleSearch(searchRequest({ provider: NODE_ID, query: "hello" }))).status).toBe(403);
      expect(mocks.credentials).not.toHaveBeenCalled();
      expect(search).not.toHaveBeenCalled();
    } finally { delete globalThis[state]; }
  });

  it.each(["codex", "openai", "exa"])("blocks existing %s linked nodes before account or model calls", async (sourceProviderId) => {
    mocks.hostedWip = true;
    mocks.node.mockResolvedValue({ id: NODE_ID, type: "custom-websearch", mode: "linked", sourceProviderId });
    const response = await handleSearch(searchRequest({ provider: NODE_ID, query: "hello" }));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("WIP");
    expect(mocks.credentials).not.toHaveBeenCalled();
    expect(mocks.searchCore).not.toHaveBeenCalled();
    expect(mocks.codexExecute).not.toHaveBeenCalled();
  });

  it("rejects linked node creation without writing a node", async () => {
    mocks.hostedWip = true;
    const response = await postNode(nodeRequest("http://localhost/api/provider-nodes", {
      type: "custom-websearch", name: "Hosted", mode: "linked", sourceProviderId: "codex",
    }));
    expect(response.status).toBe(503);
    expect(mocks.createNode).not.toHaveBeenCalled();
  });

  it("rejects linked node edits without modifying existing data", async () => {
    mocks.hostedWip = true;
    mocks.getNodeById.mockResolvedValue({ id: NODE_ID, type: "custom-websearch", mode: "linked", sourceProviderId: "codex" });
    const response = await putNode(nodeRequest(`http://localhost/api/provider-nodes/${NODE_ID}`, {
      name: "Hosted", mode: "linked", sourceProviderId: "codex",
    }, "PUT"), { params: Promise.resolve({ id: NODE_ID }) });
    expect(response.status).toBe(503);
    expect(mocks.updateNode).not.toHaveBeenCalled();
  });

  it("leaves SearXNG endpoint requests available while hosted tools are WIP", async () => {
    mocks.hostedWip = true;
    mocks.node.mockResolvedValue({ id: NODE_ID, type: "custom-websearch", mode: "searxng", authHeader: "none", baseUrl: "https://example.org" });
    expect((await handleSearch(searchRequest({ provider: NODE_ID, query: "hello" }))).status).toBe(200);
    expect(mocks.searchCore).toHaveBeenCalled();
  });
});

describe("ordinary linked hosted tool integration", () => {
  it("uses the existing Codex OAuth connection with strict pinning, not OpenAI API credentials", async () => {
    mocks.node.mockResolvedValue({
      id: NODE_ID, type: "custom-websearch", mode: "linked", sourceProviderId: "codex",
      sourceConnectionId: "codex-account", sourceAdapterId: "builtin:codex", sourceModel: "gpt-5.5",
    });
    mocks.credentials.mockResolvedValue({ accessToken: "synthetic-oauth", connectionId: "codex-account", connectionName: "test" });
    mocks.codexExecute.mockResolvedValue({ response: new Response(`data: ${JSON.stringify({
      type: "response.completed", response: { status: "completed", output: [
        { type: "web_search_call", action: { sources: [{ url: "https://example.org" }] } },
      ] },
    })}\n\n`) });
    const response = await handleSearch(searchRequest({ provider: NODE_ID, query: "hello", provider_options: { baseUrl: "https://untrusted.invalid" } }));
    expect(response.status).toBe(200);
    expect(mocks.credentials).toHaveBeenCalledWith("codex", expect.any(Set), `websearch:${NODE_ID}`, {
      preferredConnectionId: "codex-account", strictPreferredConnection: true,
    });
    expect(mocks.codexExecute.mock.calls[0][0].body).not.toHaveProperty("provider_options");
    expect(mocks.isModelAllowed).toHaveBeenCalledWith("codex/gpt-5.5", expect.any(Object), "llm");
    expect((await response.json()).provider).toBe(NODE_ID);
    expect(mocks.searchCore).not.toHaveBeenCalled();
  });

  it("a wrapper cannot evade source Codex ACL", async () => {
    mocks.node.mockResolvedValue({
      id: NODE_ID, type: "custom-websearch", mode: "linked", sourceProviderId: "codex", sourceAdapterId: "builtin:codex",
    });
    mocks.key.mockResolvedValue({ id: "restricted", isActive: true, allowedKinds: ["webSearch"], allowedProviders: [NODE_ID] });
    const response = await handleSearch(searchRequest({ provider: NODE_ID, query: "hello" }));
    expect(response.status).toBe(403);
    expect(mocks.codexExecute).not.toHaveBeenCalled();
    expect(mocks.credentials).not.toHaveBeenCalled();
  });

  it("checks disabled real source model before using OAuth credentials", async () => {
    mocks.node.mockResolvedValue({
      id: NODE_ID, type: "custom-websearch", mode: "linked", sourceProviderId: "codex",
      sourceAdapterId: "builtin:codex", sourceModel: "gpt-5.5",
    });
    mocks.isModelAllowed.mockImplementation(async (id) => id !== "codex/gpt-5.5");
    const response = await handleSearch(searchRequest({ provider: NODE_ID, query: "hello" }));
    expect(response.status).toBe(404);
    expect(mocks.credentials).not.toHaveBeenCalled();
  });

  it("loaded wildcard plugin dispatches a non-search provider with selected account", async () => {
    const state = Symbol.for("srouter.hostedSearch.plugins.v1");
    const search = vi.fn(async () => ({ results: [{ url: "https://example.org" }] }));
    globalThis[state] = Promise.resolve(new Map([["plugin:local", {
      id: "plugin:local", providerIds: ["*"], search, defaultModel: "",
    }]]));
    try {
      mocks.node.mockResolvedValue({
        id: NODE_ID, type: "custom-websearch", mode: "plugin", sourceProviderId: "claude",
        sourceAdapterId: "plugin:local", sourceConnectionId: "own",
      });
      mocks.hostedWip = true;
      const response = await handleSearch(searchRequest({ provider: NODE_ID, query: "hello" }));
      expect(response.status).toBe(200);
      expect(search.mock.calls[0][0].providerId).toBe("claude");
      expect(search.mock.calls[0][0]).not.toHaveProperty("model");
      expect(mocks.searchCore).not.toHaveBeenCalled();
      expect(mocks.codexExecute).not.toHaveBeenCalled();
      expect(mocks.credentials).toHaveBeenCalledWith("claude", expect.any(Set), expect.any(String), {
        preferredConnectionId: "own", strictPreferredConnection: true,
      });
    } finally { delete globalThis[state]; }
  });
});

describe("custom search builders", () => {
  const params = { query: "hello world", searchType: "web", maxResults: 5 };

  it("joins a SearXNG root to /search without duplicating an explicit /search endpoint", () => {
    const root = buildSearchRequest({ id: NODE_ID, builder: "custom-searxng", baseUrl: "https://searx.example.org", authHeader: "none" }, params);
    expect(root.url).toContain("https://searx.example.org/search?");
    expect(root.url).toContain("q=hello+world");
    expect(root.url).toContain("format=json");
    const explicit = buildSearchRequest({ id: NODE_ID, builder: "custom-searxng", baseUrl: "https://searx.example.org/search", authHeader: "none" }, params);
    expect(explicit.url).toContain("https://searx.example.org/search?");
    expect(explicit.url).not.toContain("/search/search");
    expect(root.init.method).toBe("GET");
  });

  it("adds the configured auth header for custom SearXNG endpoints", () => {
    const bearer = buildSearchRequest({ id: NODE_ID, builder: "custom-searxng", baseUrl: "https://searx.example.org", authHeader: "bearer" }, { ...params, token: "tok" });
    expect(bearer.init.headers.Authorization).toBe("Bearer tok");
    const apiKey = buildSearchRequest({ id: NODE_ID, builder: "custom-searxng", baseUrl: "https://searx.example.org", authHeader: "x-api-key" }, { ...params, token: "tok" });
    expect(apiKey.init.headers["X-API-Key"]).toBe("tok");
    expect(apiKey.init.headers.Authorization).toBeUndefined();
    expect(bearer.init.headers["X-API-Key"]).toBeUndefined();
  });

  it("never redirects a stored key through a client baseUrl override", () => {
    const result = buildSearchRequest(
      { id: NODE_ID, builder: "custom-searxng", baseUrl: "https://searx.example.org", authHeader: "bearer" },
      { ...params, token: "tok", providerOptions: { baseUrl: "https://attacker.example.org" } }
    );
    expect(result.url).toContain("https://searx.example.org/search");
    expect(result.url).not.toContain("attacker.example.org");
  });

  it("ignores an invalid client override for a keyed custom SearXNG endpoint", () => {
    const result = buildSearchRequest(
      { id: NODE_ID, builder: "custom-searxng", baseUrl: "https://searx.example.org", authHeader: "bearer" },
      { ...params, token: "tok", providerOptions: { baseUrl: "not a url" } }
    );
    expect(result.url).toContain("https://searx.example.org/search");
  });

  it("still honors the public baseUrl override for keyless custom SearXNG", () => {
    const result = buildSearchRequest(
      { id: NODE_ID, builder: "custom-searxng", baseUrl: "https://searx.example.org", authHeader: "none" },
      { ...params, providerOptions: { baseUrl: "https://mirror.example.org" } }
    );
    expect(result.url).toContain("https://mirror.example.org/search");
  });

  it("sends the generic JSON contract with the configured auth header", () => {
    const result = buildSearchRequest({ id: NODE_ID, builder: "custom-json", baseUrl: "https://api.example.org/search", authHeader: "bearer" }, { ...params, token: "tok", searchType: "news" });
    expect(result.url).toBe("https://api.example.org/search");
    expect(result.init.method).toBe("POST");
    expect(JSON.parse(result.init.body)).toEqual({ query: "hello world", max_results: 5, search_type: "news" });
    expect(result.init.headers.Authorization).toBe("Bearer tok");
    const keyHeader = buildSearchRequest({ id: NODE_ID, builder: "custom-json", baseUrl: "https://api.example.org/search", authHeader: "x-api-key" }, { ...params, token: "tok" });
    expect(keyHeader.init.headers["X-API-Key"]).toBe("tok");
  });
});

describe("custom search normalizers", () => {
  it("normalizes a generic JSON payload through the config-driven normalizer key", () => {
    const normalized = normalizeSearchResponse(
      NODE_ID,
      { results: [{ title: "T", url: "https://a.example", content: "c" }, { name: "N", link: "https://b.example", description: "d" }] },
      "q", "web",
      { normalizer: "custom-json" }
    );
    expect(normalized.results).toHaveLength(2);
    expect(normalized.results[0]).toMatchObject({ title: "T", url: "https://a.example", snippet: "c", position: 1 });
    expect(normalized.results[0].display_url).toBe("a.example");
    expect(normalized.results[0].citation.provider).toBe(NODE_ID);
    expect(normalized.results[1]).toMatchObject({ title: "N", url: "https://b.example", snippet: "d", position: 2 });
  });

  it("maps date/score fields into the shared makeResult shape", () => {
    const normalized = normalizeSearchResponse(
      NODE_ID,
      { results: [{ title: "T", url: "https://a.example/p?q=1", date: "2025-01-02", score: 2 }] },
      "q", "web",
      { normalizer: "custom-json" }
    );
    const result = normalized.results[0];
    expect(result.published_at).toBe("2025-01-02");
    expect(result.display_url).toBe("a.example/p");
    expect(result.score).toBe(1);
    expect(result.citation.provider).toBe(NODE_ID);
  });

  it("accepts data/organic arrays and drops items without a URL", () => {
    const normalized = normalizeSearchResponse(
      NODE_ID,
      { data: [{ title: "T", url: "https://a.example" }, { title: "NoUrl" }] },
      "q", "web",
      { normalizer: "custom-json" }
    );
    expect(normalized.results).toHaveLength(1);
    expect(normalized.totalResults).toBe(1);
  });

  it("keeps the empty fallback for unknown ids without a normalizer key", () => {
    expect(normalizeSearchResponse("totally-unknown", { results: [{ url: "x" }] }, "q", "web")).toEqual({ results: [], totalResults: null });
  });

  it("reuses the SearXNG adapter through the normalizer key", () => {
    const normalized = normalizeSearchResponse(
      NODE_ID,
      { results: [{ title: "T", url: "https://a.example", content: "snippet" }] },
      "q", "web",
      { normalizer: "searxng" }
    );
    expect(normalized.results).toHaveLength(1);
    expect(normalized.results[0].snippet).toBe("snippet");
    expect(normalized.results[0].citation.provider).toBe(NODE_ID);
  });
});

describe("custom web search dispatch via /v1/search", () => {
  it("runs a keyless SearXNG node without credentials", async () => {
    mocks.node.mockResolvedValue({ id: NODE_ID, type: "custom-websearch", mode: "searxng", authHeader: "none", baseUrl: "https://searx.example.org" });
    const response = await handleSearch(searchRequest({ provider: NODE_ID, query: "test" }));
    expect(response.ok).toBe(true);
    expect(mocks.credentials).not.toHaveBeenCalled();
    expect(mocks.searchCore).toHaveBeenCalledTimes(1);
    const call = mocks.searchCore.mock.calls[0][0];
    expect(call.credentials).toBeNull();
    expect(call.provider.id).toBe(NODE_ID);
    expect(call.providerConfig.builder).toBe("custom-searxng");
    expect(call.providerConfig.authType).toBe("none");
    expect(call.body.provider).toBe(NODE_ID);
  });

  it("runs an authenticated JSON API node through the node's own connections", async () => {
    mocks.node.mockResolvedValue({ id: NODE_ID, type: "custom-websearch", mode: "json", authHeader: "bearer", baseUrl: "https://api.example.org/search" });
    const response = await handleSearch(searchRequest({ provider: NODE_ID, query: "test" }));
    expect(response.ok).toBe(true);
    expect(mocks.credentials).toHaveBeenCalledWith(NODE_ID, expect.any(Set), `websearch:${NODE_ID}`, {});
    const call = mocks.searchCore.mock.calls[0][0];
    expect(call.providerConfig.builder).toBe("custom-json");
    expect(call.providerConfig.authType).toBe("apiKey");
    expect(call.credentials).toMatchObject({ apiKey: "key" });
  });

  it("dispatches a linked node through the source adapter with strict account pinning", async () => {
    mocks.node.mockResolvedValue({ id: NODE_ID, type: "custom-websearch", mode: "linked", sourceProviderId: SEARCH_PROVIDER, sourceConnectionId: "conn-9" });
    const response = await handleSearch(searchRequest({ provider: NODE_ID, query: "test" }));
    expect(response.ok).toBe(true);
    expect(mocks.credentials).toHaveBeenCalledWith(SEARCH_PROVIDER, expect.any(Set), `websearch:${NODE_ID}`, { preferredConnectionId: "conn-9", strictPreferredConnection: true });
    const call = mocks.searchCore.mock.calls[0][0];
    expect(call.provider.id).toBe(SEARCH_PROVIDER);
    expect(call.attributionId).toBe(NODE_ID);
    expect(call.credentials).toMatchObject({ connectionId: "conn-1" });
  });

  it("rotates any active account when a linked node pins no specific connection", async () => {
    mocks.node.mockResolvedValue({ id: NODE_ID, type: "custom-websearch", mode: "linked", sourceProviderId: SEARCH_PROVIDER });
    await handleSearch(searchRequest({ provider: NODE_ID, query: "test" }));
    expect(mocks.credentials).toHaveBeenCalledWith(SEARCH_PROVIDER, expect.any(Set), `websearch:${NODE_ID}`, {});
  });

  it("strips a caller baseUrl override before dispatching to the linked source adapter", async () => {
    mocks.node.mockResolvedValue({ id: NODE_ID, type: "custom-websearch", mode: "linked", sourceProviderId: SEARCH_PROVIDER });
    await handleSearch(searchRequest({
      provider: NODE_ID,
      query: "test",
      provider_options: { baseUrl: "https://attacker.example.org", extra: "keep" },
    }));
    const call = mocks.searchCore.mock.calls[0][0];
    expect(call.body.provider_options.baseUrl).toBeUndefined();
    expect(call.body.provider_options.extra).toBe("keep");
  });

  it.skipIf(!SEARXNG_SOURCE)("dispatches a linked no-auth source (SearXNG) without a credential lookup", async () => {
    mocks.node.mockResolvedValue({ id: NODE_ID, type: "custom-websearch", mode: "linked", sourceProviderId: SEARXNG_SOURCE });
    const response = await handleSearch(searchRequest({ provider: NODE_ID, query: "test" }));
    expect(response.ok).toBe(true);
    expect(mocks.credentials).not.toHaveBeenCalled();
    const call = mocks.searchCore.mock.calls[0][0];
    expect(call.credentials).toBeNull();
    expect(call.provider.id).toBe(SEARXNG_SOURCE);
    expect(call.attributionId).toBe(NODE_ID);
  });

  it.skipIf(!OLLAMA_SEARCH?.credentialFallback)("falls back to the source provider's related credentials (ollama-search → ollama)", async () => {
    mocks.node.mockResolvedValue({ id: NODE_ID, type: "custom-websearch", mode: "linked", sourceProviderId: "ollama-search" });
    mocks.credentials
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ apiKey: "ollama-key", connectionId: "conn-ollama", connectionName: "ollama acct" });
    const response = await handleSearch(searchRequest({ provider: NODE_ID, query: "test" }));
    expect(response.ok).toBe(true);
    const providerCalls = mocks.credentials.mock.calls.map((call) => call[0]);
    expect(providerCalls).toEqual(["ollama-search", "ollama"]);
    const call = mocks.searchCore.mock.calls[0][0];
    expect(call.credentials).toMatchObject({ apiKey: "ollama-key" });
    expect(call.provider.id).toBe("ollama-search");
    expect(call.attributionId).toBe(NODE_ID);
  });

  it.skipIf(!OLLAMA_SEARCH?.credentialFallback)("strict pinning disables the credential fallback", async () => {
    mocks.node.mockResolvedValue({ id: NODE_ID, type: "custom-websearch", mode: "linked", sourceProviderId: "ollama-search", sourceConnectionId: "conn-9" });
    mocks.credentials.mockResolvedValue(null);
    const response = await handleSearch(searchRequest({ provider: NODE_ID, query: "test" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain("ollama-search");
    const providerCalls = mocks.credentials.mock.calls.map((call) => call[0]);
    expect(providerCalls).toEqual(["ollama-search"]);
    expect(mocks.credentials.mock.calls[0][3]).toEqual({ preferredConnectionId: "conn-9", strictPreferredConnection: true });
  });

  it("denies a linked node when the source provider's search model is not allowed", async () => {
    mocks.node.mockResolvedValue({ id: NODE_ID, type: "custom-websearch", mode: "linked", sourceProviderId: SEARCH_PROVIDER });
    mocks.isModelAllowed.mockImplementation(async (model) => model !== `${SEARCH_PROVIDER}/search`);
    const response = await handleSearch(searchRequest({ provider: NODE_ID, query: "test" }));
    expect(response.status).toBe(404);
    expect(mocks.searchCore).not.toHaveBeenCalled();
  });

  it("rejects an unknown custom provider id", async () => {
    mocks.node.mockResolvedValue(null);
    const response = await handleSearch(searchRequest({ provider: NODE_ID, query: "test" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain(`Unknown provider: ${NODE_ID}`);
    expect(mocks.searchCore).not.toHaveBeenCalled();
  });

  it("enforces provider ACL before dispatch", async () => {
    mocks.key.mockResolvedValue({ id: "synthetic", isActive: true, allowedKinds: null, allowedProviders: [], allowedCombos: null });
    mocks.node.mockResolvedValue({ id: NODE_ID, type: "custom-websearch", mode: "searxng", authHeader: "none", baseUrl: "https://searx.example.org" });
    const response = await handleSearch(searchRequest({ provider: NODE_ID, query: "test" }));
    expect(response.status).toBe(403);
    expect(mocks.searchCore).not.toHaveBeenCalled();
  });

  it("does not let a linked wrapper evade the source provider's ACL", async () => {
    mocks.key.mockResolvedValue({ id: "synthetic", isActive: true, allowedKinds: null, allowedProviders: [NODE_ID], allowedCombos: null });
    mocks.node.mockResolvedValue({ id: NODE_ID, type: "custom-websearch", mode: "linked", sourceProviderId: SEARCH_PROVIDER });
    const response = await handleSearch(searchRequest({ provider: NODE_ID, query: "test" }));
    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toContain(SEARCH_PROVIDER);
    expect(mocks.searchCore).not.toHaveBeenCalled();
  });

  it("accepts a linked wrapper when both the node and the source provider are allowed", async () => {
    mocks.key.mockResolvedValue({ id: "synthetic", isActive: true, allowedKinds: null, allowedProviders: [NODE_ID, SEARCH_PROVIDER], allowedCombos: null });
    mocks.node.mockResolvedValue({ id: NODE_ID, type: "custom-websearch", mode: "linked", sourceProviderId: SEARCH_PROVIDER });
    const response = await handleSearch(searchRequest({ provider: NODE_ID, query: "test" }));
    expect(response.ok).toBe(true);
  });
});

describe("ACL provider list: custom web search nodes", () => {
  it("lists a keyless/linked custom node as grantable without connections", () => {
    const list = buildProviderList(
      [],
      [{ id: NODE_ID, type: "custom-websearch", name: "My SearXNG" }],
      []
    );
    const entry = list.find((provider) => provider.id === NODE_ID);
    expect(entry).toBeDefined();
    expect(entry.displayName).toBe("My SearXNG");
    expect(entry.count).toBe(0);
    expect(entry.serviceKinds).toEqual(["webSearch"]);
  });

  it("does not duplicate a custom node that already has connections", () => {
    const list = buildProviderList(
      [{ provider: NODE_ID, alias: null }],
      [{ id: NODE_ID, type: "custom-websearch", name: "N" }],
      []
    );
    expect(list.filter((provider) => provider.id === NODE_ID)).toHaveLength(1);
    expect(list.find((provider) => provider.id === NODE_ID).count).toBe(1);
  });
});

describe("provider-nodes API: custom-websearch validation", () => {
  it("creates a SearXNG node without a prefix and with sanitized defaults", async () => {
    const response = await postNode(nodeRequest("http://localhost/api/provider-nodes", {
      type: "custom-websearch", name: "My SearXNG", mode: "searxng", baseUrl: "https://searx.example.org/",
    }));
    expect(response.status).toBe(201);
    const created = (await response.json()).node;
    expect(created.id).toMatch(/^custom-websearch-/);
    expect(created.mode).toBe("searxng");
    expect(created.authHeader).toBe("none");
    expect(created.baseUrl).toBe("https://searx.example.org");
    expect(mocks.createNode).toHaveBeenCalledWith(expect.objectContaining({ type: "custom-websearch", name: "My SearXNG" }));
  });

  it("rejects an invalid mode or a bad base URL", async () => {
    const badMode = await postNode(nodeRequest("http://localhost/api/provider-nodes", {
      type: "custom-websearch", name: "x", mode: "nope", baseUrl: "https://a.example",
    }));
    expect(badMode.status).toBe(400);
    const badUrl = await postNode(nodeRequest("http://localhost/api/provider-nodes", {
      type: "custom-websearch", name: "x", mode: "json",
    }));
    expect(badUrl.status).toBe(400);
  });

  it("only links providers with an implemented search adapter", async () => {
    const bad = await postNode(nodeRequest("http://localhost/api/provider-nodes", {
      type: "custom-websearch", name: "x", mode: "linked", sourceProviderId: NON_SEARCH_PROVIDER,
    }));
    expect(bad.status).toBe(400);
    const good = await postNode(nodeRequest("http://localhost/api/provider-nodes", {
      type: "custom-websearch", name: "x", mode: "linked", sourceProviderId: SEARCH_PROVIDER, sourceConnectionId: "conn-2",
    }));
    expect(good.status).toBe(201);
    expect((await good.json()).node.sourceConnectionId).toBe("conn-2");
  });

  it("still requires a prefix for existing node types", async () => {
    const response = await postNode(nodeRequest("http://localhost/api/provider-nodes", {
      type: "custom-embedding", name: "x", baseUrl: "https://a.example/v1",
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Prefix is required");
  });

  it("updates a custom web search node without a prefix requirement", async () => {
    mocks.getNodeById.mockResolvedValue({ id: NODE_ID, type: "custom-websearch", mode: "searxng", name: "old", baseUrl: "https://old.example", authHeader: "none" });
    const response = await putNode(
      nodeRequest(`http://localhost/api/provider-nodes/${NODE_ID}`, { name: "new", mode: "json", baseUrl: "https://api.example.org/search", authHeader: "bearer" }, "PUT"),
      { params: Promise.resolve({ id: NODE_ID }) }
    );
    expect(response.status).toBe(200);
    expect(mocks.updateNode).toHaveBeenCalledWith(NODE_ID, expect.objectContaining({ name: "new", mode: "json", authHeader: "bearer", baseUrl: "https://api.example.org/search" }));
  });

  it("clears a stale strict pin when the edit sends an explicit null account", async () => {
    mocks.getNodeById.mockResolvedValue({ id: NODE_ID, type: "custom-websearch", mode: "linked", name: "x", sourceProviderId: SEARCH_PROVIDER, sourceConnectionId: "conn-old" });
    const response = await putNode(
      nodeRequest(`http://localhost/api/provider-nodes/${NODE_ID}`, { name: "x", mode: "linked", sourceProviderId: SEARCH_PROVIDER, sourceConnectionId: null }, "PUT"),
      { params: Promise.resolve({ id: NODE_ID }) }
    );
    expect(response.status).toBe(200);
    expect(mocks.updateNode).toHaveBeenCalledWith(NODE_ID, expect.objectContaining({ sourceConnectionId: null }));
  });

  it("rejects switching a node to a linked provider without a search adapter", async () => {
    mocks.getNodeById.mockResolvedValue({ id: NODE_ID, type: "custom-websearch", mode: "searxng", name: "x", baseUrl: "https://a.example", authHeader: "none" });
    const response = await putNode(
      nodeRequest(`http://localhost/api/provider-nodes/${NODE_ID}`, { name: "x", mode: "linked", sourceProviderId: NON_SEARCH_PROVIDER }, "PUT"),
      { params: Promise.resolve({ id: NODE_ID }) }
    );
    expect(response.status).toBe(400);
    expect(mocks.updateNode).not.toHaveBeenCalled();
  });
});
