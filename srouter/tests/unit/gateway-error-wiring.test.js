import { beforeEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";

const { execute, logGatewayError, refreshCredentials, executorState } = vi.hoisted(() => ({
  execute: vi.fn(), logGatewayError: vi.fn(), refreshCredentials: vi.fn(), executorState: { noAuth: true },
}));
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ execute, refreshCredentials, noAuth: executorState.noAuth }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: () => Promise.resolve(),
  saveRequestDetail: () => Promise.resolve(),
}));
vi.mock("../../open-sse/utils/errorLog.js", async (original) => ({
  ...await original(), logGatewayError,
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => new Proxy({}, { get: (_, key) => key === "then" ? undefined : vi.fn() }),
}));
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";

beforeEach(() => {
  execute.mockReset();
  logGatewayError.mockReset();
  refreshCredentials.mockReset();
  executorState.noAuth = true;
});

describe("Gateway provider-error wiring", () => {
  it("forwards the selected proxy and account count through auth-refresh replay", async () => {
    executorState.noAuth = false;
    execute
      .mockResolvedValueOnce({ response: new Response("unauthorized", { status: 401 }) })
      .mockResolvedValueOnce({ response: new Response("fixture outage", { status: 503 }) });
    refreshCredentials.mockResolvedValue({
      accessToken: "fixture-oauth", providerSpecificData: { zcodeJwtToken: "fixture-plan", businessToken: "fixture-new" },
    });
    const onCredentialsRefreshed = vi.fn();
    await handleChatCore({
      body: { messages: [{ role: "user", content: "fixture" }], stream: false },
      modelInfo: { provider: "deepseek", model: "deepseek-chat", accountCount: 5 },
      credentials: {
        accessToken: "fixture-oauth", providerSpecificData: {
          connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:1234",
        },
      },
      sourceFormatOverride: "openai", onCredentialsRefreshed,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(refreshCredentials.mock.calls[0][2]).toMatchObject({
      connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:1234",
    });
    expect(onCredentialsRefreshed).toHaveBeenCalledWith(expect.objectContaining({
      providerSpecificData: expect.objectContaining({ businessToken: "fixture-new" }),
    }));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1][0]).toMatchObject({ accountCount: 5 });
  });

  it.each([
    [400, "content-blocked", "POLICY", true],
    [520, "upstream unavailable", "PROVIDER", false],
  ])("classifies provider status %s", async (status, message, errorClass, policy) => {
    execute.mockResolvedValue({
      response: new Response(JSON.stringify({ error: { message } }), {
        status, headers: { "x-request-id": "fixture" },
      }),
    });
    const result = await handleChatCore({
      body: { messages: [{ role: "user", content: "fixture" }], stream: false },
      modelInfo: { provider: "deepseek", model: "deepseek-chat", accountCount: 5 },
      credentials: { apiKey: "fixture" },
      sourceFormatOverride: "openai",
      connectionId: "fixture-connection",
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(result.status).toBe(status);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ accountCount: 5 }));
    expect(result.isPolicyError === true).toBe(policy);
    expect(logGatewayError).toHaveBeenCalledWith(expect.objectContaining({
      class: errorClass, provider: "deepseek", status,
    }));
    expect(logGatewayError.mock.calls[0][0]).not.toHaveProperty("message");
  });
});
