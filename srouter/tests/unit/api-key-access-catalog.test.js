import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  info: vi.fn(), connections: vi.fn(), settings: vi.fn(),
  disabled: vi.fn(),
}));
vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: (request) => request?.headers?.get("authorization")?.slice(7) || null,
  getApiKeyInfo: mocks.info,
}));
vi.mock("@/sse/services/internalTrust.js", () => ({ isTrustedInternalRequest: vi.fn(async () => false) }));
vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.settings, getProviderConnections: mocks.connections,
  getCombos: vi.fn(async () => [{ name: "public", models: ["oa/gpt"] }, { name: "private", models: ["other/model"] }]),
  getCustomModels: vi.fn(async () => []), getModelAliases: vi.fn(async () => ({})),
}));
vi.mock("@/lib/db/index.js", () => ({ getProviderNodeById: vi.fn(async () => null) }));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: mocks.disabled }));
vi.mock("@/shared/constants/models", () => ({
  PROVIDER_MODELS: { oa: [{ id: "gpt" }, { id: "disabled" }], other: [{ id: "model" }], f: [{ id: "free-model" }] },
  PROVIDER_ID_TO_ALIAS: { openai: "oa", other: "other", free: "f" },
  getModelKind: (model) => model.type || "llm",
}));
vi.mock("@/shared/constants/providers", () => ({
  ALIAS_TO_ID: { oa: "openai", f: "free" },
  AI_PROVIDERS: {
    openai: { id: "openai", serviceKinds: ["llm"] }, other: { id: "other", serviceKinds: ["llm"] },
    free: { id: "free", noAuth: true, serviceKinds: ["llm"] },
  },
  getProviderAlias: (id) => ({ openai: "oa", free: "f" })[id] || id,
  resolveProviderId: (id) => ({ oa: "openai", f: "free" })[id] || id,
  isOpenAICompatibleProvider: () => false, isAnthropicCompatibleProvider: () => false,
  isCustomEmbeddingProvider: () => false,
}));

const { buildModelsList, GET } = await import("@/app/api/v1/models/route.js");
const { GET: lookup } = await import("@/app/api/v1/models/[...model]/route.js");
const { isModelAllowed } = await import("@/sse/services/allowedModels.js");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockResolvedValue({ requireApiKey: true });
  mocks.info.mockResolvedValue({ allowedProviders: ["openai"], allowedCombos: ["public"], allowedKinds: ["llm"] });
  mocks.connections.mockResolvedValue([{ provider: "openai" }, { provider: "other" }]);
  mocks.disabled.mockResolvedValue({ oa: ["disabled"] });
});
function request(key = true) {
  return new Request("http://127.0.0.1:20999/v1/models", {
    headers: { ...(key ? { authorization: "Bearer synthetic-test-key" } : {}), "x-9r-internal-models-fetch": "1" },
  });
}

describe("ACL catalog and lookups", () => {
  it("filters providers, combos and disabled models without replacing the catalog", async () => {
    const data = (await (await GET(request())).json()).data;
    expect(data.map((model) => model.id)).toEqual(["public", "oa/gpt"]);
  });

  it("preserves unrestricted catalog callers, including free providers with connections elsewhere", async () => {
    const ids = (await buildModelsList(["llm"], { skipDynamicFetch: true })).map((model) => model.id);
    expect(ids).toEqual(expect.arrayContaining(["public", "private", "oa/gpt", "other/model", "f/free-model"]));
    expect(ids).not.toContain("oa/disabled");
  });

  it("denies all kinds with [] and does not run catalog queries", async () => {
    expect(await buildModelsList(["llm", "tts"], { apiKeyInfo: { allowedKinds: [] } })).toEqual([]);
    expect(mocks.connections).not.toHaveBeenCalled();
  });

  it("requires keys on public model lists", async () => {
    expect((await GET(request(false))).status).toBe(401);
    mocks.info.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
  });

  it("returns 404 for a forbidden provider lookup", async () => {
    expect((await lookup(request(), { params: Promise.resolve({ model: ["other", "model"] }) })).status).toBe(404);
    expect((await lookup(request(), { params: Promise.resolve({ model: ["oa", "gpt"] }) })).status).toBe(200);
  });

  it("returns an empty capability list when that kind is denied", async () => {
    const response = await lookup(request(), { params: Promise.resolve({ model: ["tts"] }) });
    expect((await response.json()).data).toEqual([]);
  });

  it("availability normalizes provider aliases but rejects disabled and unknown models", async () => {
    const info = { allowedProviders: null };
    expect(await isModelAllowed("openai/gpt", info)).toBe(true);
    expect(await isModelAllowed("oa/gpt", info)).toBe(true);
    expect(await isModelAllowed("openai/disabled", info)).toBe(false);
    expect(await isModelAllowed("openai/unknown", info)).toBe(false);
  });

  it("does not reuse a previous key's provider/combo grants for later public catalogs", async () => {
    expect((await (await GET(request())).json()).data.map(model => model.id)).toEqual(["public", "oa/gpt"]);
    mocks.info.mockResolvedValue({ allowedProviders: [], allowedCombos: [], allowedKinds: ["llm"] });
    expect((await (await GET(request())).json()).data).toEqual([]);
    mocks.info.mockResolvedValue({ allowedProviders: ["free"], allowedCombos: [], allowedKinds: ["llm"] });
    expect((await (await GET(request())).json()).data.map(model => model.id)).toEqual(["f/free-model"]);
  });

  it("optional-key mode keeps recognized deny-all catalog restrictions", async () => {
    mocks.settings.mockResolvedValue({ requireApiKey: false });
    mocks.info.mockResolvedValue({ allowedProviders: [], allowedCombos: [], allowedKinds: [] });
    expect((await (await GET(request())).json()).data).toEqual([]);
    const anonymous = (await (await GET(request(false))).json()).data.map(model => model.id);
    expect(anonymous).toEqual(expect.arrayContaining(["oa/gpt", "other/model", "f/free-model"]));
  });

  it("availability reuse is scoped to the principal object and rechecks disabled models", async () => {
    const first = { id: "first", allowedProviders: null };
    const second = { id: "second", allowedProviders: null };
    expect(await isModelAllowed("oa/gpt", first)).toBe(true);
    expect(await isModelAllowed("openai/gpt", first)).toBe(true);
    expect(mocks.connections).toHaveBeenCalledTimes(1);
    expect(await isModelAllowed("oa/gpt", second)).toBe(true);
    expect(mocks.connections).toHaveBeenCalledTimes(2);
    mocks.disabled.mockResolvedValue({ openai: ["gpt"] });
    expect(await isModelAllowed("oa/gpt", first)).toBe(false);
    expect(mocks.connections).toHaveBeenCalledTimes(2);
  });
});
