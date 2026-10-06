// Wiring test: handleSingleModelChat must hand ignoreAccountPools=true to
// getProviderCredentials ONLY when the request is the server's own authenticated
// probe (machine CLI token + exact marker). The auth service is mocked so the
// assertion is on the options object chat.js passes.
//
// DATA_DIR is pointed at a temp dir before any module import as a safety net;
// the DB layer is mocked regardless.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-probe-wiring-"));
process.env.DATA_DIR = tempDir;

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(() => Promise.resolve({ shouldFallback: true })),
  clearAccountError: vi.fn(),
  getSettings: vi.fn(() => Promise.resolve({})),
  getModelInfo: vi.fn(() => Promise.resolve({ provider: "codex", model: "gpt-6-luna" })),
  getComboModels: vi.fn(() => Promise.resolve(null)),
  handleChatCore: vi.fn(() => Promise.resolve({ success: true, response: new Response("ok") })),
  handleBypassRequest: vi.fn(() => null),
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

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
  getProxyHash: vi.fn(() => "proxy-1"),
}));
vi.mock("../../src/lib/network/connectionProxy.js", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
  getProxyHash: vi.fn(() => "proxy-1"),
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn((_provider, credentials) => Promise.resolve(credentials)),
  updateProviderCredentials: vi.fn(async () => ({})),
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn((_provider, credentials) => Promise.resolve(credentials)),
  updateProviderCredentials: vi.fn(async () => ({})),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: mocks.handleBypassRequest }));
vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: vi.fn(() => new Response("combo-ok")),
  handleFusionChat: vi.fn(() => new Response("fusion-ok")),
  detectRequiredCapabilities: vi.fn(() => []),
}));
vi.mock("open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: vi.fn((models) => models),
  withCapacityAdapterStripping: vi.fn((fn) => fn),
  getActiveAdapterStrategy: vi.fn(() => "fallback"),
}));
vi.mock("open-sse/services/accountFallback.js", () => ({
  isProviderInCooldown: vi.fn(() => false),
  isProviderFullyBlocked: vi.fn(() => false),
  getProviderShortestCooldownMs: vi.fn(() => 0),
  recordProviderFailure: vi.fn(),
  clearProviderFailure: vi.fn(),
  isKimchiQuotaExhausted: vi.fn(() => false),
  buildKimchiQuotaExhaustedUpdate: vi.fn(() => ({})),
  detectDailyQuotaExhaustion: vi.fn(() => null),
  buildDailyQuotaLockUpdate: vi.fn(() => ({})),
}));
vi.mock("open-sse/services/accountSemaphore.js", () => ({
  acquire: vi.fn(async () => () => {}),
  resolveAccountSemaphoreKey: vi.fn(() => null),
  resolveAccountSemaphoreMaxConcurrency: vi.fn(() => null),
  isSemaphoreCapacityError: vi.fn(() => false),
}));
vi.mock("open-sse/utils/cooldownRetry.js", () => ({
  maybeWaitForCooldown: vi.fn(async () => ({ shouldRetry: false, reason: "budget_exhausted" })),
  MAX_COOLDOWN_RETRIES: 1,
}));
vi.mock("open-sse/utils/error.js", () => ({
  errorResponse: (status, message) => new Response(JSON.stringify({ error: { message } }), { status }),
  unavailableResponse: (status, message) => new Response(message, { status }),
}));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn(async () => null) }));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://localhost:9999" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(async () => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
  maskKey: vi.fn(() => "***"),
}));
vi.mock("../../src/sse/utils/logger.js", () => ({
  request: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
  maskKey: vi.fn(() => "***"),
}));

const { POST } = await import("../../src/app/api/v1/chat/completions/route.js");
const { handleChat } = await import("../../src/sse/handlers/chat.js");

const ACCOUNT = {
  connectionId: "conn-1",
  connectionName: "codex-account",
  authType: "oauth",
  providerSpecificData: {},
};

function makeRequest(extraHeaders = {}) {
  return new Request("http://localhost/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
      ...extraHeaders,
    },
    body: JSON.stringify({ model: "cx/gpt-6-luna", messages: [{ role: "user", content: "hi" }] }),
  });
}

describe("probe option wiring in handleSingleModelChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderCredentials.mockReset();
    mocks.getProviderCredentials.mockResolvedValue(ACCOUNT);
    mocks.handleChatCore.mockReset();
    mocks.handleChatCore.mockResolvedValue({ success: true, response: new Response("ok") });
    mocks.getSettings.mockResolvedValue({});
    mocks.getModelInfo.mockResolvedValue({ provider: "codex", model: "gpt-6-luna" });
    mocks.getComboModels.mockResolvedValue(null);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("passes ignoreAccountPools=true for the authenticated probe (CLI token + marker)", async () => {
    const response = await POST(makeRequest({
      "x-9r-cli-token": "a1b2c3d4e5f6a7b8",
      "x-9r-internal-probe": "model-test",
    }));

    expect(response.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith(
      "codex",
      expect.any(Set),
      "gpt-6-luna",
      { ignoreAccountPools: true, ignoreModelLocks: true, requestedModel: "gpt-6-luna" },
    );
  });

  it("keeps pool enforcement for normal traffic", async () => {
    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith(
      "codex",
      expect.any(Set),
      "gpt-6-luna",
      { ignoreAccountPools: false, ignoreModelLocks: false, requestedModel: "gpt-6-luna" },
    );
    expect(mocks.handleChatCore.mock.calls[0][0]).toMatchObject({
      rtkEnabled: false, loopGuardEnabled: false,
    });
  });

  it("HR-14 retries an early EOF on the same connection once before account fallback", async () => {
    mocks.handleChatCore.mockResolvedValueOnce({
      success: false, earlyEof: true, status: 502, error: "STREAM_EARLY_EOF",
      response: Response.json({ error: { message: "STREAM_EARLY_EOF" } }, { status: 502 }),
    });
    expect((await POST(makeRequest())).status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenCalledOnce();
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(2);
    expect(mocks.handleChatCore.mock.calls.map(([opts]) => opts.connectionId)).toEqual(["conn-1", "conn-1"]);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it.each(["cx/gpt-6-luna[1m]", "my-selected-alias[1m]"])("retains canonical extended identity for %s", async (input) => {
    const response = await POST(new Request("http://localhost/api/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: input, messages: [{ role: "user", content: "fixture" }] }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith(
      "codex", expect.any(Set), "gpt-6-luna",
      { ignoreAccountPools: false, ignoreModelLocks: false, requestedModel: "gpt-6-luna[1m]" },
    );
  });

  it("preserves explicit opt-in for RTK and Loop guard", async () => {
    mocks.getSettings.mockResolvedValue({ rtkEnabled: true, loopGuardEnabled: true });
    await POST(makeRequest());
    expect(mocks.handleChatCore.mock.calls[0][0]).toMatchObject({
      rtkEnabled: true, loopGuardEnabled: true,
    });
  });

  it("rejects the marker when the CLI token does not match", async () => {
    const response = await POST(makeRequest({
      "x-9r-cli-token": "forged-token",
      "x-9r-internal-probe": "model-test",
    }));

    expect(response.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith(
      "codex",
      expect.any(Set),
      "gpt-6-luna",
      { ignoreAccountPools: false, ignoreModelLocks: false, requestedModel: "gpt-6-luna" },
    );
  });

  it("keeps Anthropic format throughout the private advisor round", async () => {
    const main = "cmc/deepseek/deepseek-v4-pro";
    mocks.getSettings.mockResolvedValue({ visionAdvisor: { enabled: true, models: ["openai/gpt-4o"] } });
    mocks.getModelInfo.mockImplementation(async (value) => {
      const [provider, ...model] = value.split("/");
      return { provider, model: model.join("/") };
    });
    const payload = (content) => ({
      success: true, response: Response.json({ type: "message", role: "assistant", content }),
    });
    mocks.handleChatCore
      .mockResolvedValueOnce(payload([{ type: "tool_use", id: "v1", name: "srouter_vision_advisor", input: {} }]))
      .mockResolvedValueOnce(payload([{ type: "text", text: "Blue" }]))
      .mockResolvedValueOnce(payload([{ type: "text", text: "Final answer" }]));
    const response = await handleChat(new Request("http://localhost/api/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: main, max_tokens: 200, messages: [{
        role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/image.png" } }],
      }] }),
    }));
    expect((await response.json()).content[0].text).toBe("Final answer");
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(3);
    for (const [options] of mocks.handleChatCore.mock.calls) {
      expect(options.sourceFormatOverride).toBe("claude");
    }
  });
});
