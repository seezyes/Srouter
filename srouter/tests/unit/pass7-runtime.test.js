import { afterEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";
import { FORMATS } from "open-sse/translator/formats.js";
import { translateRequest } from "open-sse/translator/index.js";
import { handleForcedSSEToJson } from "open-sse/handlers/chatCore/sseToJsonHandler.js";
import { handleStreamingResponse } from "open-sse/handlers/chatCore/streamingHandler.js";
import { prepareUpstreamStream } from "open-sse/utils/streamReadiness.js";
import { createStreamController } from "open-sse/utils/streamHandler.js";
import { handleComboChat, runComboTarget } from "open-sse/services/combo.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { evaluateFile, quietLog } from "./pass7-source-fixtures.js";

vi.mock("@/lib/usageDb.js", () => ({ saveRequestDetail: vi.fn(async () => {}), appendRequestLog: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}), saveUsageStats: vi.fn(async () => {}), addUsageRecord: vi.fn(async () => {}) }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const sse = data => new Response(data, { headers: { "content-type": "text/event-stream" } });
describe("HR-13/16/17 format preservation", () => {
  it("HR-16 retains a document-only Claude PDF through registered bridge", () => {
    const translated = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, "glm-5.3-flash", {
      messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "RklYVFVSRVBERg==" } }] }],
    }, true, null, "opencode-go");
    expect(translated.messages[0].content[0]).toMatchObject({ type: "file", file: { file_data: "data:application/pdf;base64,RklYVFVSRVBERg==" } });
  });
  it.each([
    { type: "image_url", image_url: { url: "data:image/png;base64,RklYVFVSRQ==" } },
    { type: "file", file: { filename: "fixture.pdf", file_data: "data:application/pdf;base64,RklYVFVSRQ==" } },
  ])("HR-17 preserves inline media in Antigravity Claude envelope", part => {
    const translated = translateRequest(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, "claude-sonnet-4-6", {
      messages: [{ role: "user", content: [part] }],
    }, true, { projectId: "fixture-project", connectionId: "fixture-connection" }, "antigravity");
    expect(translated.request.contents[0].parts).toContainEqual(expect.objectContaining({ inlineData: expect.objectContaining({ data: "RklYVFVSRQ==" }) }));
  });
  it("HR-17 preserves URL images as fileData", () => {
    const translated = translateRequest(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, "claude-sonnet-4-6", {
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://fixture.example/image.png" } }] }],
    }, true, { projectId: "fixture-project" }, "antigravity");
    expect(JSON.stringify(translated)).toContain("https://fixture.example/image.png");
  });
  it.each(["responses", "chat"])("HR-13 forced %s SSE yields native Claude tool JSON", async format => {
    const providerResponse = format === "responses"
      ? sse([
        { type: "response.created", response: { id: "resp_fixture" } },
        { type: "response.output_item.done", output_index: 0, item: { type: "message", content: [{ type: "output_text", text: "answer" }] } },
        { type: "response.output_item.done", output_index: 1, item: { type: "function_call", call_id: "call_fixture", name: "lookup", arguments: '{"query":"fixture"}' } },
        { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } },
      ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""))
      : sse(`data: ${JSON.stringify({ id: "fixture", choices: [{ delta: { content: "answer", tool_calls: [{ index: 0, id: "call_fixture", function: { name: "lookup", arguments: '{"query":"fixture"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
    const success = vi.fn();
    const result = await handleForcedSSEToJson({
      providerResponse, sourceFormat: FORMATS.CLAUDE, targetFormat: format === "responses" ? FORMATS.OPENAI_RESPONSES : FORMATS.OPENAI,
      provider: format === "responses" ? "codex" : "openai", model: "fixture", body: { stream: false },
      requestStartTime: Date.now(), trackDone() {}, appendLog() {}, onRequestSuccess: success, log: quietLog,
    });
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expect(json.choices).toBeUndefined();
    expect(json.content).toContainEqual({ type: "tool_use", id: "call_fixture", name: "lookup", input: { query: "fixture" } });
    expect(json.stop_reason).toBe("tool_use");
    expect(json.usage).toMatchObject({ input_tokens: 5, output_tokens: 2 });
    expect(success).toHaveBeenCalledOnce();
  });
});
describe("HR-14 readiness and bounded retries", () => {
  it("HR-14 refuses immediate EOF before success callback", async () => {
    const success = vi.fn();
    const result = await handleStreamingResponse({
      providerResponse: sse(new ReadableStream({ start(c) { c.close(); } })),
      provider: "openai", model: "fixture", sourceFormat: FORMATS.OPENAI, targetFormat: FORMATS.OPENAI,
      body: {}, requestStartTime: Date.now(), onRequestSuccess: success,
      streamController: createStreamController({ log: quietLog }),
    });
    expect(result).toMatchObject({ success: false, status: 502, earlyEof: true });
    expect(success).not.toHaveBeenCalled();
  });
  it("HR-14 keeps a delayed first read after readiness timeout byte-exact", async () => {
    let controller;
    const response = sse(new ReadableStream({ start(c) { controller = c; } }));
    const ready = await prepareUpstreamStream(response, null, 5);
    controller.enqueue(new TextEncoder().encode("data: fixture\n\n"));
    controller.close();
    expect(await ready.response.text()).toBe("data: fixture\n\n");
  });
  it("HR-14 cancellation cancels the retained pending reader", async () => {
    const cancel = vi.fn();
    const ready = await prepareUpstreamStream(sse(new ReadableStream({ cancel })), null, 5);
    await ready.response.body.cancel();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("HR-14 preflight honours abort without leaving upstream reader", async () => {
    const cancel = vi.fn(), ac = new AbortController();
    const pending = prepareUpstreamStream(sse(new ReadableStream({ cancel })), ac.signal, 1000);
    ac.abort();
    await expect(pending).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
describe("HR-15 combo deadlines", () => {
  it("HR-15 aborts a stalled first target and advances to healthy fallback", async () => {
    let firstSignal;
    const handle = vi.fn((_body, model, options) => {
      if (model === "cursor/fixture") { firstSignal = options.signal; return new Promise(() => {}); }
      return Response.json({ ok: true });
    });
    const response = await handleComboChat({ body: {}, models: ["cursor/fixture", "openai/fixture"], autoSwitch: false,
      handleSingleModel: handle, log: quietLog, targetTimeoutMs: 10 });
    expect(response.ok).toBe(true);
    expect(firstSignal.aborted).toBe(true);
    expect(handle).toHaveBeenCalledTimes(2);
  });
  it("HR-15 caller abort prevents fallback and cancels the target", async () => {
    const ac = new AbortController();
    let selectedSignal;
    const handle = vi.fn((_b, _m, { signal }) => { selectedSignal = signal; ac.abort(); return new Promise(() => {}); });
    const response = await handleComboChat({ body: {}, models: ["cursor/fixture", "openai/fixture"], handleSingleModel: handle,
      log: quietLog, signal: ac.signal, targetTimeoutMs: 20 });
    expect(response.status).toBe(499); expect(handle).toHaveBeenCalledOnce(); expect(selectedSignal.aborted).toBe(true);
  });
  it("HR-15 discards and cancels a late response from the timed-out target", async () => {
    let resolve;
    const cancel = vi.fn();
    await expect(runComboTarget(() => new Promise(r => { resolve = r; }), {}, "fixture", { timeoutMs: 5 })).rejects.toThrow(/timed out/);
    resolve(new Response(new ReadableStream({ cancel })));
    await new Promise(r => setImmediate(r));
    expect(cancel).toHaveBeenCalledOnce();
  });
});
describe("HR-01/19/21/26 selection and defaults", () => {
  it("HR-01 preserves strict pool flags and HR-21 refuses unavailable pin", async () => {
    const auth = evaluateFile("src/sse/services/auth.js", {
      getProviderConnections: async () => [{ id: "account-B", provider: "openai", apiKey: "fixture", authType: "apikey", providerSpecificData: { proxyPoolId: "strict-pool" } }],
      getSettings: async () => ({}), resolveProviderId: id => id, FREE_PROVIDERS: {},
      isModelLockActive: () => false, log: quietLog,
      resolveConnectionProxyConfig: async () => ({ connectionProxyEnabled: false, proxyPoolId: "strict-pool", strictProxy: true, noFitPool: true }),
    });
    const selected = await auth.getProviderCredentials("openai");
    expect(selected.providerSpecificData).toMatchObject({ proxyPoolId: "strict-pool", strictProxy: true, noFitPool: true });
    expect(await auth.getProviderCredentials("openai", null, null, { preferredConnectionId: "account-A", strictPreferredConnection: true })).toBeNull();
  });
  it.each([undefined, true, false])("HR-19 responses normalizes only omitted stream (%s)", async stream => {
    const dispatch = vi.fn(async request => {
      expect(request.headers.get("content-length")).toBeNull();
      expect((await request.json()).stream).toBe(stream ?? false);
      return Response.json({ ok: true });
    });
    const route = evaluateFile("src/app/api/v1/responses/route.js", {
      initTranslators: async () => {}, handleChat: dispatch,
      readBoundedJson: async request => ({ body: await request.json() }),
    });
    await route.POST(new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-length": "999", "x-api-key": "fixture" }, body: JSON.stringify({ model: "fixture", stream }) }));
    expect(dispatch).toHaveBeenCalledOnce();
  });
  it("HR-21 polling requires creator pin and rejects a mismatched selected account", async () => {
    const core = vi.fn();
    const selector = vi.fn(async () => ({ connectionId: "B" }));
    const route = evaluateFile("src/sse/handlers/videoGeneration.js", {
      authenticateRequest: async () => ({ apiKeyInfo: {} }), checkKindAccess: () => null, checkTargetAccess: async () => null,
      getProviderConnectionById: async () => ({ provider: "xai" }), getVideoConfig: () => ({}),
      getProviderCredentials: selector, handleVideoProxyCore: core, HTTP_STATUS,
      errorResponse: (status, message) => Response.json({ error: message }, { status }),
    });
    expect((await route.handleVideoGet(new Request("http://localhost/v1/videos/job"), "job")).status).toBe(400);
    expect(selector).not.toHaveBeenCalled();
    expect((await route.handleVideoGet(new Request("http://localhost/v1/videos/job", { headers: { "x-srouter-connection-id": "A" } }), "job")).status).toBe(400);
    expect(selector.mock.calls[0][3]).toMatchObject({ preferredConnectionId: "A", strictPreferredConnection: true });
    expect(core).not.toHaveBeenCalled();
  });
  it("HR-26 retries quota after a soft failure instead of caching its promise forever", async () => {
    const fetch = vi.fn(async () => { throw new Error("fixture transport failure"); });
    const quota = evaluateFile("open-sse/services/usage/claude.js", {
      proxyAwareFetch: fetch, ANTHROPIC_API_VERSION: "fixture", CLAUDE_CLI_VERSION: "fixture",
      U: () => ({}), parseResetTime: x => x,
    });
    await quota.getClaudeUsage("fixture-token");
    await quota.getClaudeUsage("fixture-token");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
