// Wiring: the remaining pingModelByKind paths (embeddings, images, stt, systemone)
// must pass ignoreAccountPools only for the server's authenticated probe, while
// preserving their existing credential options (imageGeneration's
// preferredConnectionId). The auth service is mocked, so assertions are on the
// options object each handler hands to getProviderCredentials.
//
// DATA_DIR is pointed at a temp dir before any module import as a safety net;
// the DB layer is mocked regardless.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-probe-multimodal-"));
process.env.DATA_DIR = tempDir;

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(() => Promise.resolve({ shouldFallback: false })),
  clearAccountError: vi.fn(async () => {}),
  getSettings: vi.fn(() => Promise.resolve({})),
  getModelInfo: vi.fn(() => Promise.resolve({ provider: "openai", model: "probe-model" })),
  getComboModels: vi.fn(() => Promise.resolve(null)),
  saveRequestUsage: vi.fn(async () => {}),
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: vi.fn(async () => "a1b2c3d4e5f6a7b8"),
  getRawMachineId: vi.fn(async () => "raw-machine-id"),
  isBrowser: vi.fn(() => false),
}));

vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: (req) => {
    const auth = req?.headers?.get?.("Authorization");
    if (auth?.startsWith("Bearer ")) return auth.slice(7);
    return req?.headers?.get?.("x-api-key") || null;
  },
  isValidApiKey: vi.fn(async () => true),
  getApiKeyInfo: vi.fn(async () => null),
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
}));
vi.mock("../../src/sse/services/auth.js", () => ({
  extractApiKey: (req) => {
    const auth = req?.headers?.get?.("Authorization");
    if (auth?.startsWith("Bearer ")) return auth.slice(7);
    return req?.headers?.get?.("x-api-key") || null;
  },
  isValidApiKey: vi.fn(async () => true),
  getApiKeyInfo: vi.fn(async () => null),
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  updateProviderConnection: vi.fn(async () => ({})),
}));
vi.mock("../../src/lib/localDb.js", () => ({
  getSettings: mocks.getSettings,
  updateProviderConnection: vi.fn(async () => ({})),
}));

vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn((_provider, credentials) => Promise.resolve(credentials)),
  updateProviderCredentials: vi.fn(async () => ({})),
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn((_provider, credentials) => Promise.resolve(credentials)),
  updateProviderCredentials: vi.fn(async () => ({})),
}));

vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: mocks.saveRequestUsage }));

vi.mock("open-sse/handlers/embeddingsCore.js", () => ({
  handleEmbeddingsCore: vi.fn(async () => ({ success: true, response: new Response("ok") })),
}));
vi.mock("open-sse/handlers/imageGenerationCore.js", () => ({
  handleImageGenerationCore: vi.fn(async () => ({ success: true, response: new Response("ok") })),
}));
vi.mock("open-sse/handlers/sttCore.js", () => ({
  handleSttCore: vi.fn(async () => ({ success: true, response: new Response("ok") })),
}));
vi.mock("open-sse/handlers/systemoneCore.js", () => ({
  handleSystemoneCore: vi.fn(async () => ({ success: true, response: new Response("ok") })),
}));
vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: vi.fn(async () => new Response("combo-ok")),
}));
vi.mock("open-sse/utils/error.js", () => ({
  errorResponse: (status, message) => new Response(JSON.stringify({ error: { message } }), { status }),
  unavailableResponse: (status, message) => new Response(message, { status }),
}));

vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
  maskKey: vi.fn(() => "***"),
}));
vi.mock("../../src/sse/utils/logger.js", () => ({
  request: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
  maskKey: vi.fn(() => "***"),
}));

const { handleEmbeddings } = await import("../../src/sse/handlers/embeddings.js");
const { handleImageGeneration } = await import("../../src/sse/handlers/imageGeneration.js");
const { handleStt } = await import("../../src/sse/handlers/stt.js");
const { handleSystemone } = await import("../../src/sse/handlers/systemone.js");

const ACCOUNT = {
  connectionId: "conn-1",
  connectionName: "openai-account",
  authType: "apikey",
  providerSpecificData: {},
};

const PROBE_HEADERS = {
  "x-9r-cli-token": "a1b2c3d4e5f6a7b8",
  "x-9r-internal-probe": "model-test",
};

function makeEmbeddingsRequest(extraHeaders = {}) {
  return new Request("http://localhost/api/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-key", ...extraHeaders },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: "test" }),
  });
}

function makeImageRequest(extraHeaders = {}) {
  return new Request("http://localhost/api/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-key", ...extraHeaders },
    body: JSON.stringify({ model: "openai/gpt-image-1", prompt: "test" }),
  });
}

function makeSttRequest(extraHeaders = {}) {
  const form = new FormData();
  form.append("model", "openai/whisper-1");
  form.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }), "test.wav");
  return new Request("http://localhost/api/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: "Bearer test-key", ...extraHeaders },
    body: form,
  });
}

function makeSystemoneRequest(extraHeaders = {}) {
  return new Request("http://localhost/api/v1/systemone", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-key", ...extraHeaders },
    body: JSON.stringify({
      model: "openai/gpt-4o",
      state: "Customer: I was charged twice.",
      questions: { probe: { type: "noul", instructions: "Is this a billing problem?" } },
    }),
  });
}

describe("probe option wiring in multimodal handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderCredentials.mockReset();
    mocks.getProviderCredentials.mockResolvedValue(ACCOUNT);
    mocks.getSettings.mockResolvedValue({});
    mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "probe-model" });
    mocks.getComboModels.mockResolvedValue(null);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("embeddings: probe ignores pools, normal traffic keeps enforcing them", async () => {
    const probe = await handleEmbeddings(makeEmbeddingsRequest(PROBE_HEADERS));
    expect(probe.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenLastCalledWith(
      "openai", expect.any(Set), "probe-model", { ignoreAccountPools: true, ignoreModelLocks: true },
    );

    mocks.getProviderCredentials.mockClear();
    const normal = await handleEmbeddings(makeEmbeddingsRequest());
    expect(normal.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenLastCalledWith(
      "openai", expect.any(Set), "probe-model", { ignoreAccountPools: false, ignoreModelLocks: false },
    );
  });

  it("images: probe ignores pools but keeps preferredConnectionId", async () => {
    const probe = await handleImageGeneration(makeImageRequest({
      ...PROBE_HEADERS,
      "x-connection-id": "conn-preferred",
    }));
    expect(probe.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenLastCalledWith(
      "openai", expect.any(Set), "probe-model", { preferredConnectionId: "conn-preferred", ignoreAccountPools: true, ignoreModelLocks: true },
    );

    mocks.getProviderCredentials.mockClear();
    const normal = await handleImageGeneration(makeImageRequest());
    expect(normal.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenLastCalledWith(
      "openai", expect.any(Set), "probe-model", { preferredConnectionId: null, ignoreAccountPools: false, ignoreModelLocks: false },
    );
  });

  it("stt: probe ignores pools, normal traffic keeps enforcing them", async () => {
    const probe = await handleStt(makeSttRequest(PROBE_HEADERS));
    expect(probe.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenLastCalledWith(
      "openai", expect.any(Set), "probe-model", { ignoreAccountPools: true, ignoreModelLocks: true },
    );

    mocks.getProviderCredentials.mockClear();
    const normal = await handleStt(makeSttRequest());
    expect(normal.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenLastCalledWith(
      "openai", expect.any(Set), "probe-model", { ignoreAccountPools: false, ignoreModelLocks: false },
    );
  });

  it("a correct marker with a forged CLI token does not unlock the bypass", async () => {
    const res = await handleEmbeddings(makeEmbeddingsRequest({
      "x-9r-cli-token": "forged-token",
      "x-9r-internal-probe": "model-test",
    }));
    expect(res.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenLastCalledWith(
      "openai", expect.any(Set), "probe-model", { ignoreAccountPools: false, ignoreModelLocks: false },
    );
  });

  it("systemone: probe ignores pools, normal traffic keeps enforcing them", async () => {
    const probe = await handleSystemone(makeSystemoneRequest(PROBE_HEADERS));
    expect(probe.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenLastCalledWith(
      "openai", expect.any(Set), "probe-model", { ignoreAccountPools: true, ignoreModelLocks: true },
    );

    mocks.getProviderCredentials.mockClear();
    const normal = await handleSystemone(makeSystemoneRequest());
    expect(normal.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenLastCalledWith(
      "openai", expect.any(Set), "probe-model", { ignoreAccountPools: false, ignoreModelLocks: false },
    );
  });
});
