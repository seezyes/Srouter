import { afterEach, describe, expect, it, vi } from "vitest";
import { detectFormat } from "../../open-sse/services/provider.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { createDisconnectAwareStream } from "../../open-sse/utils/streamHandler.js";
import { buildAgentRouterHeaders } from "../../open-sse/executors/agentrouter.js";
import { baseModelId, normalizeOpencodeReasoning } from "../../open-sse/utils/opencodeIdentity.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { OpenCodeZenExecutor } from "../../open-sse/executors/opencode-zen.js";
import { takeRenamedToolNames } from "../../open-sse/utils/opencodeFingerprint.js";

afterEach(() => vi.useRealTimers());

describe("Vans runtime reliability adaptations", () => {
  it.each(["tool_use", "tool_result", "image"])("detects Claude %s after a plain-text turn", (type) => {
    expect(detectFormat({
      messages: [
        { role: "user", content: "hello" },
        { role: "user", content: [{ type, source: { type: "base64", data: "test" } }] },
      ],
    })).toBe("claude");
  });

  it("keeps OpenAI format when a later turn has an image_url", () => {
    expect(detectFormat({ messages: [
      { role: "user", content: "hello" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/image" } }] },
    ] })).toBe("openai");
  });

  it.each(["vendor/model:free", "claude-sonnet-custom-free"])("free suffix pricing is zero for %s", (model) => {
    expect(getPricingForModel("opencode", model)).toMatchObject({ input: 0, output: 0, cached: 0 });
  });

  it("keeps AgentRouter sessions request-local and honors stream mode", () => {
    const first = buildAgentRouterHeaders("test-key", false);
    const second = buildAgentRouterHeaders("test-key", true);
    expect(first.Accept).toBe("application/json");
    expect(second.Accept).toBe("text/event-stream");
    expect(first["X-Claude-Code-Session-Id"]).not.toBe(second["X-Claude-Code-Session-Id"]);
  });

  it("normalizes Responses reasoning without discarding unrelated fields", () => {
    const body = { reasoning_effort: " HIGH ", reasoning: { summary: "detailed" } };
    normalizeOpencodeReasoning("test-model(high)", body);
    expect(baseModelId("test-model(high)")).toBe("test-model");
    expect(body).toEqual({ reasoning: { effort: "high", summary: "detailed" } });
  });

  it.each([new OpenCodeExecutor(), new OpenCodeZenExecutor()])("uses Anthropic fingerprint shapes for %s", (executor) => {
    const body = { messages: [{ role: "user", content: "hello" }], tools: [
      { name: "Bash", input_schema: { type: "object", properties: {} } },
    ] };
    const out = executor.transformRequest("union-alpha", body, true, {
      runtimeTransport: { format: "claude" },
    });
    expect(out.tools.map((tool) => tool.name)).toEqual(["bash", "glob", "grep", "read"]);
    expect(out.tools.every((tool) => tool.input_schema?.type === "object")).toBe(true);
    expect(out.tool_choice).toBeUndefined();
    expect(takeRenamedToolNames(out)?.get("bash")).toBe("Bash");
  });

  it("classifies OpenCode free IP limits separately from model availability", () => {
    const executor = new OpenCodeExecutor();
    expect(executor.parseError({ status: 429 }, "free quota exhausted")).toMatchObject({
      status: 429, poolScoped: { reason: "ip-limit" },
    });
    expect(executor.parseError({ status: 401 }, "Model abc is not supported")).toMatchObject({
      status: 404, code: "model_not_found",
    });
    expect(executor.parseError({ status: 400 }, "Model is unavailable")).toMatchObject({ status: 503 });
    expect(executor.parseError({ status: 400 }, "invalid request")).toBeNull();
  });

  it("heartbeats are SSE comments and cancellation clears the timer", async () => {
    vi.useFakeTimers();
    const control = { isConnected: () => true, handleDisconnect: vi.fn(), handleError: vi.fn() };
    const output = createDisconnectAwareStream(new TransformStream(), control);
    const reader = output.getReader();
    const next = reader.read();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(new TextDecoder().decode((await next).value)).toBe(": keep-alive\n\n");
    await reader.cancel();
    expect(control.handleDisconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not queue more heartbeats while downstream is backpressured", async () => {
    vi.useFakeTimers();
    const output = createDisconnectAwareStream(new TransformStream(), {
      isConnected: () => true, handleDisconnect: vi.fn(), handleError: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const reader = output.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": keep-alive\n\n");
    let received = false;
    const next = reader.read().then((value) => { received = true; return value; });
    await Promise.resolve();
    expect(received).toBe(false);
    await reader.cancel();
    await next;
    expect(vi.getTimerCount()).toBe(0);
  });
});
