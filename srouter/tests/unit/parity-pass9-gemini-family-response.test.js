// Pass9 round-3 regressions (T-0030): Gemini-family client response projection.
//
// A request detected as Gemini format (`contents: [...]`, e.g. a native
// generateContent body posted to the OpenAI-compatible endpoint) routed to an
// OpenAI-native provider used to receive a mixed envelope: the provider's raw
// `chat.completion.chunk` frames for content/reasoning/usage/finish, plus — after
// P9-F6 — a bare `candidates` frame for a recovered Kimi tool call. The response
// registry only held the OpenAI→Antigravity projection, so no translator existed
// for `openai → gemini|gemini-cli|vertex`.
//
// These tests drive the actual production modules (translateResponse registry,
// createSSETransformStreamWithLogger, translateNonStreamingResponse,
// handleChatCore, detectFormat, geminiToOpenAIRequest) — not clones.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FORMATS, detectFormatByEndpoint } from "../../open-sse/translator/formats.js";
import { translateRequest, translateResponse, initState } from "../../open-sse/translator/index.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { GEMINI_FAMILY_CLIENT_FORMATS } from "../../open-sse/translator/response/openai-to-gemini.js";
import { detectFormat } from "../../open-sse/services/provider.js";
import { geminiToOpenAIRequest } from "../../open-sse/translator/request/gemini-to-openai.js";
import { normalizeKimiToolCalls } from "../../open-sse/utils/kimiToolParser.js";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({ execute: executeMock, refreshCredentials: vi.fn().mockResolvedValue(null) })),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/utils/clientDetector.js", () => ({
  detectClientTool: vi.fn(() => null),
  isNativePassthrough: vi.fn(() => false),
}));

vi.mock("../../open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));

vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  createStreamController: vi.fn(() => ({ signal: undefined, handleComplete: vi.fn(), handleError: vi.fn() })),
  pipeWithDisconnect: vi.fn((response, transformStream) => transformStream ? response.body.pipeThrough(transformStream) : response.body),
}));

vi.mock("../../open-sse/services/tokenRefresh.js", () => ({ refreshWithRetry: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ default: vi.fn(), proxyAwareFetch: vi.fn() }));

vi.mock("../../open-sse/translator/formats/claude.js", () => ({ normalizeClaudePassthrough: vi.fn(), anchorClaudeCache: vi.fn() }));

vi.mock("../../open-sse/utils/toolDeduper.js", () => ({ dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })) }));

vi.mock("../../open-sse/rtk/caveman.js", () => ({ injectCaveman: vi.fn() }));
vi.mock("../../open-sse/rtk/ponytail.js", () => ({ injectPonytail: vi.fn() }));

vi.mock("../../open-sse/rtk/index.js", () => ({ compressMessages: vi.fn(() => null), formatRtkLog: vi.fn(() => "") }));

vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(async () => null),
  formatHeadroomLog: vi.fn(() => ""),
  formatHeadroomSizeLog: vi.fn(() => ""),
  isHeadroomPhantomSavings: vi.fn(() => false),
}));

vi.mock("../../open-sse/providers/capabilities.js", () => ({ getCapabilitiesForModel: vi.fn(() => ({})) }));

vi.mock("../../open-sse/translator/concerns/modality.js", () => ({ stripUnsupportedModalities: vi.fn(() => false) }));
vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({ prefetchRemoteImages: vi.fn(async () => 0) }));

vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((detail) => detail),
  extractRequestConfig: vi.fn((body, stream) => ({ body, stream })),
  extractUsageFromResponse: vi.fn(() => ({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 })),
  saveUsageStats: vi.fn(),
  formatDoneLine: vi.fn(() => ""),
}));

vi.mock("../../open-sse/utils/error.js", () => ({
  createErrorResult: vi.fn((status, message) => ({ success: false, status, error: message })),
  formatProviderError: vi.fn((error) => error.message),
  parseUpstreamError: vi.fn(),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

function sse(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

function parseSSE(raw) {
  return raw
    .split(/\n\n/)
    .filter(Boolean)
    .map((block) => {
      const type = block.split("\n").find((l) => l.startsWith("event: "))?.slice(7) ?? null;
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      const data = dataLine?.slice(6);
      return { type, data: data === "[DONE]" ? "[DONE]" : JSON.parse(data), raw: block };
    });
}

const openaiChunk = (delta, finish = null, usage) => ({
  id: "chatcmpl-fixture",
  object: "chat.completion.chunk",
  created: 1,
  model: "gpt-5.2",
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...(usage ? { usage } : {}),
});

const usage = { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9, completion_tokens_details: { reasoning_tokens: 3 } };

const openaiCompletion = () => ({
  id: "chatcmpl-fixture",
  object: "chat.completion",
  created: 1,
  model: "gpt-5.2",
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      reasoning_content: "summary",
      content: "answer",
      tool_calls: [{ id: "call-fixture", type: "function", function: { name: "inspect", arguments: '{"path":"/fixture"}' } }],
    },
    finish_reason: "tool_calls",
  }],
  usage,
});

const GEMINI_BODY = () => ({
  model: "nvidia/llama-3.1-70b",
  contents: [{ role: "user", parts: [{ text: "hello" }] }],
  generationConfig: { maxOutputTokens: 256 },
});

function makeChatOptions({ provider, model, body }) {
  const requestBody = { ...body, model };
  return {
    body: requestBody,
    modelInfo: { provider, model },
    credentials: { apiKey: "sk-test" },
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body: requestBody,
      headers: { accept: "text/event-stream" },
    },
    connectionId: "test-connection",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe("P9 round-3 registry wiring for Gemini-family response keys", () => {
  const contentChunk = { id: "chatcmpl-fixture", model: "gpt-5.2", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] };

  it("projects OpenAI chunks to the bare candidates envelope for each Gemini-family key", () => {
    for (const format of [FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.VERTEX]) {
      const items = translateResponse(FORMATS.OPENAI, format, structuredClone(contentChunk), initState(format));
      expect(items).toHaveLength(1);
      expect(items[0].response).toBeUndefined();
      expect(items[0].choices).toBeUndefined();
      expect(items[0].candidates[0].content.role).toBe("model");
      expect(items[0].candidates[0].content.parts).toEqual([{ text: "hi" }]);
      expect(items[0].candidates[0].index).toBe(0);
      expect(items[0].modelVersion).toBe("gpt-5.2");
    }
  });

  it("keeps the Antigravity envelope wrapped", () => {
    const items = translateResponse(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, structuredClone(contentChunk), initState(FORMATS.ANTIGRAVITY));
    expect(items).toHaveLength(1);
    expect(items[0].response.candidates[0].content.parts).toEqual([{ text: "hi" }]);
  });

  it("the family set is exactly gemini, gemini-cli and vertex", () => {
    expect([...GEMINI_FAMILY_CLIENT_FORMATS].sort()).toEqual([FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.VERTEX]);
    expect(GEMINI_FAMILY_CLIENT_FORMATS.has(FORMATS.ANTIGRAVITY)).toBe(false);
    expect(GEMINI_FAMILY_CLIENT_FORMATS.has(FORMATS.OPENAI)).toBe(false);
  });

  it("does not overwrite the existing OpenAI→Gemini request translators", () => {
    const body = { messages: [{ role: "user", content: "hello" }], tools: [{ type: "function", function: { name: "inspect", parameters: { type: "object" } } }] };
    const gemini = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, "gemini-2.5-pro", structuredClone(body), true, { accessToken: "fixture" }, "gemini");
    expect(Array.isArray(gemini.contents)).toBe(true);
    expect(gemini.contents.some((c) => (c.parts || []).some((p) => p.text === "hello"))).toBe(true);
    expect(gemini.tools?.[0]?.functionDeclarations?.[0]?.name).toBe("inspect");

    const vertex = translateRequest(FORMATS.OPENAI, FORMATS.VERTEX, "gemini-2.5-pro", structuredClone(body), true, { accessToken: "fixture" }, "vertex");
    expect(Array.isArray(vertex.contents)).toBe(true);
  });
});

describe("P9 round-3 streaming frames for a Gemini-family client", () => {
  function stream({ sourceFormat = FORMATS.GEMINI, toolNameMap = null, provider = "kimchi", model = "kimi-k2.7", targetFormat = FORMATS.OPENAI } = {}) {
    return createSSETransformStreamWithLogger(
      targetFormat, sourceFormat, provider, null, toolNameMap, model, null, null, null, null, null, null, normalizeKimiToolCalls,
    );
  }

  async function run(chunks, options) {
    const out = await new Response(sse(chunks).pipeThrough(stream(options))).text();
    return { out, events: parseSSE(out) };
  }

  const chunk = (delta, finish = null, extra) => `data: ${JSON.stringify(openaiChunk(delta, finish, extra))}\n\n`;

  it("emits content, reasoning, finish and usage as one candidates-only envelope", async () => {
    const { out, events } = await run([
      chunk({ reasoning_content: "summary" }),
      chunk({ content: "answer" }),
      chunk({}, "stop", usage),
      "data: [DONE]\n\n",
    ]);

    expect(events.every((e) => e.data.candidates && !e.data.choices)).toBe(true);
    const parts = events.flatMap((e) => e.data.candidates[0].content.parts);
    expect(parts).toContainEqual({ thought: true, text: "summary" });
    expect(parts).toContainEqual({ text: "answer" });

    const terminal = events.find((e) => e.data.candidates[0].finishReason);
    expect(terminal.data.candidates[0].finishReason).toBe("STOP");
    expect(terminal.data.usageMetadata).toEqual({
      promptTokenCount: 7,
      candidatesTokenCount: 2,
      totalTokenCount: 9,
      thoughtsTokenCount: 3,
    });
    expect(terminal.data.modelVersion).toBe("gpt-5.2");
    expect(terminal.data.responseId).toBe("chatcmpl-fixture");
    expect(terminal.data.response).toBeUndefined();
    expect(out).not.toContain("[DONE]");
    expect(out).not.toContain('"choices"');
  });

  it("accumulates fragmented tool calls into one complete functionCall part at the finish", async () => {
    const NAME_MAP = new Map([["inspects", "inspect_full_name"]]);
    const { events } = await run([
      chunk({ tool_calls: [{ index: 0, id: "call-fixture", type: "function", function: { name: "inspects", arguments: '{"path":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"/fixture"}' } }] }),
      chunk({}, "tool_calls", usage),
      "data: [DONE]\n\n",
    ], { toolNameMap: NAME_MAP });

    const callEvents = events.filter((e) => e.data.candidates?.[0]?.content?.parts?.some((p) => p.functionCall));
    expect(callEvents).toHaveLength(1);
    const part = callEvents[0].data.candidates[0].content.parts.find((p) => p.functionCall);
    expect(part.functionCall.name).toBe("inspect_full_name");
    expect(part.functionCall.args).toEqual({ path: "/fixture" });
    expect(callEvents[0].data.candidates[0].finishReason).toBe("STOP");
    expect(callEvents[0].data.usageMetadata.totalTokenCount).toBe(9);
    // Fragments emit nothing on their own: the single frame is the finish frame.
    expect(events).toHaveLength(1);
  });

  it("recovers leaked Kimi markup for a Gemini client through the same registry", async () => {
    const NAME_MAP = new Map([["echoshrt", "a".repeat(70) + "__inspect"]]);
    const { out, events } = await run([
      chunk({ content: 'checking functions.echoshrt:0 {"path":"/x"}' }),
      chunk({}, "stop"),
      "data: [DONE]\n\n",
    ], { toolNameMap: NAME_MAP });

    const callEvent = events.find((e) => e.data.candidates?.[0]?.content?.parts?.some((p) => p.functionCall));
    expect(callEvent).toBeTruthy();
    const part = callEvent.data.candidates[0].content.parts.find((p) => p.functionCall);
    expect(part.functionCall.name).toBe("a".repeat(70) + "__inspect");
    expect(part.functionCall.args).toEqual({ path: "/x" });
    expect(callEvent.data.candidates[0].finishReason).toBe("STOP");
    expect(out).not.toContain("functions.");
    expect(out).not.toContain("[DONE]");
    // Prose before the markup survives as a text part.
    expect(events.flatMap((e) => e.data.candidates[0].content.parts).some((p) => p.text === "checking")).toBe(true);
  });

  it("applies to gemini-cli and vertex clients too", async () => {
    for (const format of [FORMATS.GEMINI_CLI, FORMATS.VERTEX]) {
      const { events } = await run([chunk({ content: "hi" }), chunk({}, "stop", usage), "data: [DONE]\n\n"], { sourceFormat: format });
      expect(events.every((e) => e.data.candidates && !e.data.choices)).toBe(true);
      expect(events[0].data.response).toBeUndefined();
    }
  });

  it("reaches the projection through the OpenAI pivot for a non-OpenAI provider", async () => {
    // A Gemini client routed to a Claude-format provider: the first hop folds the
    // provider chunks into OpenAI, the second hop is this round's projection.
    const { events } = await run([
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_fixture", model: "claude-sonnet", usage: { input_tokens: 4 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-fixture", name: "inspects", input: {} } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"/fixture"}' } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ], { sourceFormat: FORMATS.GEMINI, provider: "openai", model: "claude-sonnet", targetFormat: FORMATS.CLAUDE, toolNameMap: new Map([["inspects", "inspect_full_name"]]) });

    expect(events.every((e) => e.data.candidates && !e.data.choices)).toBe(true);
    const call = events.flatMap((e) => e.data.candidates[0].content.parts).find((p) => p.functionCall);
    expect(call.functionCall.name).toBe("inspect_full_name");
    expect(call.functionCall.args).toEqual({ path: "/fixture" });
    expect(events.find((e) => e.data.candidates[0].finishReason).data.candidates[0].finishReason).toBe("STOP");
  });
});

describe("P9 round-3 non-streaming projection", () => {
  it("projects an OpenAI completion body to the bare candidates envelope", () => {
    const projected = translateNonStreamingResponse(openaiCompletion(), FORMATS.OPENAI, FORMATS.GEMINI);
    expect(projected.choices).toBeUndefined();
    expect(projected.object).toBeUndefined();
    expect(projected.usage).toBeUndefined();
    expect(projected.response).toBeUndefined();

    const candidate = projected.candidates[0];
    expect(candidate.content.role).toBe("model");
    expect(candidate.content.parts).toContainEqual({ thought: true, text: "summary" });
    expect(candidate.content.parts).toContainEqual({ text: "answer" });
    expect(candidate.content.parts.find((p) => p.functionCall).functionCall).toEqual({ name: "inspect", args: { path: "/fixture" } });
    expect(candidate.finishReason).toBe("STOP");
    expect(candidate.index).toBe(0);
    expect(projected.usageMetadata).toEqual({ promptTokenCount: 7, candidatesTokenCount: 2, totalTokenCount: 9, thoughtsTokenCount: 3 });
    expect(projected.modelVersion).toBe("gpt-5.2");
  });

  it("restores a provider-side fitted tool name", () => {
    const body = openaiCompletion();
    body.choices[0].message.tool_calls[0].function.name = "inspects";
    const projected = translateNonStreamingResponse(body, FORMATS.OPENAI, FORMATS.GEMINI, null, new Map([["inspects", "inspect_full_name"]]));
    expect(projected.candidates[0].content.parts.find((p) => p.functionCall).functionCall.name).toBe("inspect_full_name");
  });

  it("degrades malformed tool arguments to {} instead of throwing", () => {
    const body = openaiCompletion();
    body.choices[0].message.tool_calls[0].function.arguments = '{"path":';
    const projected = translateNonStreamingResponse(body, FORMATS.OPENAI, FORMATS.GEMINI);
    expect(projected.candidates[0].content.parts.find((p) => p.functionCall).functionCall.args).toEqual({});
  });

  it("projects for gemini-cli and vertex and leaves a provider error body untouched", () => {
    for (const format of [FORMATS.GEMINI_CLI, FORMATS.VERTEX]) {
      const projected = translateNonStreamingResponse(openaiCompletion(), FORMATS.OPENAI, format);
      expect(projected.candidates[0].content.parts.find((p) => p.functionCall)).toBeTruthy();
    }
    const errorBody = { error: { message: "upstream failed" } };
    expect(translateNonStreamingResponse(errorBody, FORMATS.OPENAI, FORMATS.GEMINI)).toBe(errorBody);
  });

  it("keeps the OpenAI, Responses and Claude projections unchanged", () => {
    const body = openaiCompletion();
    expect(translateNonStreamingResponse(body, FORMATS.OPENAI, FORMATS.OPENAI)).toBe(body);
    const responses = translateNonStreamingResponse(body, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
    expect(responses.object).toBe("response");
    const claude = translateNonStreamingResponse(body, FORMATS.OPENAI, FORMATS.CLAUDE);
    expect(claude.type).toBe("message");
  });
});

describe("P9 round-3 through the real handleChatCore with a detected Gemini body", () => {
  beforeEach(() => {
    executeMock.mockReset();
  });

  it("detects the Gemini client format from the body (no override) and streams candidates-only frames", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const body = GEMINI_BODY();
    // The reachable contract: a native generateContent body posted to the
    // OpenAI-compatible endpoint. Detection is the real body-shape detector.
    expect(detectFormat(body)).toBe(FORMATS.GEMINI);

    executeMock.mockResolvedValue({
      response: new Response(sse([
        `data: ${JSON.stringify(openaiChunk({ content: "answer" }))}\n\n`,
        `data: ${JSON.stringify(openaiChunk({ tool_calls: [{ index: 0, id: "call-fixture", type: "function", function: { name: "inspect", arguments: '{"path":"/fixture"}' } }] }))}\n\n`,
        `data: ${JSON.stringify(openaiChunk({}, "tool_calls", usage))}\n\n`,
        "data: [DONE]\n\n",
      ]), { status: 200, headers: { "content-type": "text/event-stream" } }),
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      headers: {},
      transformedBody: { model: "llama-3.1-70b", stream: true },
    });

    const result = await handleChatCore(makeChatOptions({ provider: "nvidia", model: "llama-3.1-70b", body }));
    expect(result.success).toBe(true);
    const text = await result.response.text();
    const frames = parseSSE(text);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.data.candidates && !f.data.choices)).toBe(true);
    expect(text).not.toContain('"choices"');
    expect(text).not.toContain("[DONE]");

    const parts = frames.flatMap((f) => f.data.candidates[0].content.parts);
    expect(parts).toContainEqual({ text: "answer" });
    const call = parts.find((p) => p.functionCall);
    expect(call.functionCall.name).toBe("inspect");
    expect(call.functionCall.args).toEqual({ path: "/fixture" });
    const terminal = frames.find((f) => f.data.candidates[0].finishReason);
    expect(terminal.data.candidates[0].finishReason).toBe("STOP");
    expect(terminal.data.usageMetadata.totalTokenCount).toBe(9);
  });

  it("returns a bare candidates body for a non-streaming Gemini client", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const body = { ...GEMINI_BODY(), stream: false };
    expect(detectFormat(body)).toBe(FORMATS.GEMINI);

    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify(openaiCompletion()), { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      headers: {},
      transformedBody: { model: "llama-3.1-70b", stream: false },
    });

    const result = await handleChatCore(makeChatOptions({ provider: "nvidia", model: "llama-3.1-70b", body }));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.choices).toBeUndefined();
    expect(json.object).toBeUndefined();
    expect(json.candidates[0].content.parts.find((p) => p.functionCall).functionCall.name).toBe("inspect");
    expect(json.candidates[0].finishReason).toBe("STOP");
    expect(json.usageMetadata.totalTokenCount).toBe(9);
  });

  it("re-serializes a coerced non-streaming upstream as a single candidates frame", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const body = GEMINI_BODY();
    expect(detectFormat(body)).toBe(FORMATS.GEMINI);

    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify(openaiCompletion()), { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      headers: {},
      transformedBody: { model: "kimi-k2.7", stream: false },
    });

    const result = await handleChatCore(makeChatOptions({ provider: "nvidia", model: "kimi-k2.7", body }));
    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toBe("text/event-stream");
    const text = await result.response.text();
    expect(text).not.toContain("[DONE]");
    const frames = parseSSE(text);
    expect(frames).toHaveLength(1);
    expect(frames[0].data.candidates[0].content.parts.find((p) => p.functionCall).functionCall.args).toEqual({ path: "/fixture" });
  });
});

describe("P9 round-3 native /v1beta Gemini route contract (must stay unconverted)", () => {
  it("the canonical bridge produces an OpenAI body, so the internal hop is never a Gemini client", () => {
    const converted = geminiToOpenAIRequest("gemini-2.5-pro", {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      generationConfig: { maxOutputTokens: 128 },
    }, true, { accessToken: "fixture" });

    expect(converted.contents).toBeUndefined();
    expect(Array.isArray(converted.messages)).toBe(true);
    expect(detectFormat(converted)).toBe(FORMATS.OPENAI);
    expect(detectFormatByEndpoint("/v1beta/models/gemini-2.5-pro:streamGenerateContent", converted)).toBeNull();
  });

  it("the v1beta action suffix never overrides the source format", () => {
    expect(detectFormatByEndpoint("/v1beta/models/gemini-2.5-pro:generateContent", GEMINI_BODY())).toBeNull();
    expect(detectFormatByEndpoint("/v1beta/models/gemini-2.5-pro:streamGenerateContent", GEMINI_BODY())).toBeNull();
  });
});
