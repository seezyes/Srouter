import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getApiKeyInfo: vi.fn(), getProviderCredentials: vi.fn(), getSettings: vi.fn(),
  getProviderConnectionById: vi.fn(), getComboModels: vi.fn(), core: vi.fn(),
}));
vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: (request) => request.headers.get("authorization")?.slice(7) || request.headers.get("x-api-key") || null,
  getApiKeyInfo: mocks.getApiKeyInfo, getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: vi.fn(), clearAccountError: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings, getCombos: vi.fn(async () => []), getCustomModels: vi.fn(async () => []),
  getProviderConnectionById: mocks.getProviderConnectionById, updateProviderConnection: vi.fn(),
}));
vi.mock("@/lib/db/index.js", () => ({ getProviderNodeById: vi.fn(async () => ({ prefix: "custom" })) }));
vi.mock("@/sse/services/internalTrust.js", () => ({ isTrustedInternalRequest: vi.fn(async () => false) }));
vi.mock("@/sse/services/allowedModels.js", () => ({ isModelAllowed: vi.fn(async () => true) }));
vi.mock("@/sse/services/model.js", () => ({
  getComboModels: mocks.getComboModels,
  getModelInfo: vi.fn(async (value) => ({ provider: value.split("/")[0], model: value.split("/").slice(1).join("/") })),
}));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrlResolved: vi.fn() }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (provider, credentials) => credentials), updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.core }));
vi.mock("open-sse/handlers/embeddingsCore.js", () => ({ handleEmbeddingsCore: mocks.core }));
vi.mock("open-sse/handlers/systemoneCore.js", () => ({ handleSystemoneCore: mocks.core }));
vi.mock("open-sse/handlers/imageGenerationCore.js", () => ({ handleImageGenerationCore: mocks.core }));
vi.mock("open-sse/handlers/ttsCore.js", () => ({ handleTtsCore: mocks.core }));
vi.mock("open-sse/handlers/sttCore.js", () => ({ handleSttCore: mocks.core }));
vi.mock("open-sse/handlers/search/index.js", () => ({ handleSearchCore: mocks.core }));
vi.mock("open-sse/handlers/fetch/index.js", () => ({ handleFetchCore: mocks.core }));
vi.mock("open-sse/handlers/videoCore.js", () => ({
  handleVideoProxyCore: mocks.core, getVideoConfig: (provider) => provider === "xai" ? {} : null,
  sanitizeSecrets: (error) => error,
}));
vi.mock("open-sse/services/combo.js", async (importOriginal) => ({
  ...await importOriginal(),
  handleComboChat: async ({ body, models, handleSingleModel }) => handleSingleModel(body, models[0]),
}));

const { handleChat } = await import("@/sse/handlers/chat.js");
const { handleEmbeddings } = await import("@/sse/handlers/embeddings.js");
const { handleSystemone } = await import("@/sse/handlers/systemone.js");
const { handleImageGeneration } = await import("@/sse/handlers/imageGeneration.js");
const { handleTts } = await import("@/sse/handlers/tts.js");
const { handleStt } = await import("@/sse/handlers/stt.js");
const { handleSearch } = await import("@/sse/handlers/search.js");
const { handleFetch } = await import("@/sse/handlers/fetch.js");
const { handleVideoCreate, handleVideoGet } = await import("@/sse/handlers/videoGeneration.js");

function request(model = "openai/gpt-4o", key = true) {
  return new Request("http://127.0.0.1:20999/v1/test", {
    method: "POST", headers: key ? { authorization: "Bearer synthetic-test-key", "content-type": "application/json" } : {},
    body: JSON.stringify({ model, provider: "exa", prompt: "test", input: "test", messages: [{ role: "user", content: "hi" }],
      query: "test", url: "https://example.com/", state: {}, questions: { valid: "?" } }),
  });
}
function sttRequest(key = true) {
  const body = new FormData();
  body.set("model", "whisper/whisper-1");
  body.set("file", new Blob(["test"]), "test.wav");
  return new Request("http://127.0.0.1:20999/v1/audio/transcriptions", {
    method: "POST", headers: key ? { authorization: "Bearer synthetic-test-key" } : {}, body,
  });
}
const routes = [
  ["llm", handleChat, () => request()],
  ["embedding", handleEmbeddings, () => request()],
  ["systemone", handleSystemone, () => request()],
  ["image", handleImageGeneration, () => request("sdwebui/image")],
  ["tts", handleTts, () => request("edge-tts/voice")],
  ["stt", handleStt, sttRequest],
  ["webSearch", handleSearch, () => request()],
  ["webFetch", handleFetch, () => request()],
  ["video create", (req) => handleVideoCreate(req, "generations"), () => request("xai/grok-imagine-video")],
  ["video poll", (req) => handleVideoGet(req, "job"), () => new Request("http://127.0.0.1:20999/v1/videos/job", { headers: { authorization: "Bearer synthetic-test-key" } })],
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({ requireApiKey: true });
  mocks.getApiKeyInfo.mockResolvedValue({ id: "test", allowedKinds: null, allowedProviders: null, allowedCombos: null });
  mocks.getComboModels.mockResolvedValue(null);
  mocks.core.mockImplementation(async () => ({ success: true, response: new Response("ok") }));
});

describe.each(routes)("ACL %s", (name, handler, makeRequest) => {
  it("blocks kind denial before credentials or upstream execution", async () => {
    mocks.getApiKeyInfo.mockResolvedValue({ id: "test", allowedKinds: [] });
    expect((await handler(makeRequest())).status).toBe(403);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.core).not.toHaveBeenCalled();
  });
  it("blocks provider denial even for no-auth capabilities and polls", async () => {
    mocks.getApiKeyInfo.mockResolvedValue({ id: "test", allowedProviders: [] });
    expect((await handler(makeRequest())).status).toBe(403);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.core).not.toHaveBeenCalled();
  });
});

it("known restricted keys stay restricted when API keys are optional", async () => {
  mocks.getSettings.mockResolvedValue({ requireApiKey: false });
  mocks.getApiKeyInfo.mockResolvedValue({ id: "test", allowedKinds: [] });
  expect((await handleTts(request("edge-tts/voice"))).status).toBe(403);
});

it.each([
  [handleChat, "openai/gpt-4o"],
  [handleImageGeneration, "sdwebui/image"],
  [handleTts, "edge-tts/voice"],
])("combo target cannot escape a provider restriction", async (handler, target) => {
  mocks.getApiKeyInfo.mockResolvedValue({ id: "test", allowedProviders: [], allowedCombos: ["permitted"] });
  mocks.getComboModels.mockImplementation(async (value) => value === "permitted" ? [target] : null);
  expect((await handler(request("permitted"))).status).toBe(403);
  expect(mocks.core).not.toHaveBeenCalled();
});
