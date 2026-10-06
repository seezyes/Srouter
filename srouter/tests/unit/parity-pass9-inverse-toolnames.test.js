// Pass9 round-4 regressions (T-0030): inverse tool-name acceptance through the
// real handleChatCore caller, WITHOUT a supplied toolNameMap.
//
// A client that declares a tool name longer than the 64-char provider cap must
// reach the provider with the existing fitting rule applied (ensureFittedToolNames
// -> fitToolName) and must get its exact original name back in the response.
//
// Round 2/3 tests supplied an artificial inverse map; these drive the real
// caller so the map is produced by the request-side fitting pass. The Gemini
// client case is the acknowledged gap: the fitting pass walked OpenAI
// `tools[].function.name` and Claude `tools[].name`, but not Gemini
// `tools[].functionDeclarations[].name`.
//
// The provider response is built from the request the caller actually sent
// (mock echoes the received name), so "fitted out, original back" is a real
// round trip, never an assumption.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { ensureFittedToolNames } from "../../open-sse/translator/concerns/toolCall.js";
import { restoreToolNames } from "../../open-sse/utils/opencodeFingerprint.js";
import { geminiToOpenAIRequest } from "../../open-sse/translator/request/gemini-to-openai.js";
import { detectFormat } from "../../open-sse/services/provider.js";

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

const ORIGINAL = "mcp__" + "a".repeat(80) + "__inspect";
const MAX_NAME = 64;
/** The name the production fitting rule actually produces for ORIGINAL. */
const FITTED = ensureFittedToolNames({ tools: [{ function: { name: ORIGINAL, parameters: { type: "object" } } }] }).tools[0].function.name;

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
      return { type, data: data === "[DONE]" ? "[DONE]" : JSON.parse(data) };
    });
}

/** Name the caller actually sent upstream, read off the provider-format body. */
function sentToolName(body) {
  const chat = body?.tools?.[0];
  if (typeof chat?.function?.name === "string") return chat.function.name;
  if (typeof chat?.name === "string") return chat.name;
  const declaration = body?.tools?.[0]?.functionDeclarations?.[0];
  if (typeof declaration?.name === "string") return declaration.name;
  return "";
}

function streamingProviderResponse(name) {
  return new Response(sse([
    `data: ${JSON.stringify({ id: "chatcmpl-r4", object: "chat.completion.chunk", created: 1, model: "llama-3.1-70b", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "chatcmpl-r4", object: "chat.completion.chunk", created: 1, model: "llama-3.1-70b", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-r4", type: "function", function: { name, arguments: '{"path":"/x"}' } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "chatcmpl-r4", object: "chat.completion.chunk", created: 1, model: "llama-3.1-70b", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`,
    "data: [DONE]\n\n",
  ]), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function jsonProviderResponse(name) {
  return new Response(JSON.stringify({
    id: "chatcmpl-r4",
    object: "chat.completion",
    created: 1,
    model: "llama-3.1-70b",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "ok", tool_calls: [{ id: "call-r4", type: "function", function: { name, arguments: '{"path":"/x"}' } }] },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function chatOptions({ body, endpoint, stream }) {
  return {
    body,
    modelInfo: { provider: "nvidia", model: "llama-3.1-70b" },
    credentials: { apiKey: "sk-test" },
    clientRawRequest: { endpoint, body, headers: { accept: stream ? "text/event-stream" : "application/json" } },
    connectionId: "test-connection",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

/** Upstream answers with whatever name the caller sent (real provider echo). */
function echoUpstream(stream) {
  return (options) => Promise.resolve({
    response: stream ? streamingProviderResponse(sentToolName(options.body)) : jsonProviderResponse(sentToolName(options.body)),
    url: "https://integrate.api.nvidia.com/v1/chat/completions",
    headers: {},
    transformedBody: options.body,
  });
}

const clientBodies = {
  [FORMATS.OPENAI]: () => ({
    body: { model: "llama-3.1-70b", stream: true, messages: [{ role: "user", content: "hello" }], tools: [{ type: "function", function: { name: ORIGINAL, description: "fixture", parameters: { type: "object", properties: { path: { type: "string" } } } } }] },
    endpoint: "/v1/chat/completions",
  }),
  [FORMATS.CLAUDE]: () => ({
    body: { model: "llama-3.1-70b", stream: true, system: "be brief", messages: [{ role: "user", content: "hello" }], tools: [{ name: ORIGINAL, description: "fixture", input_schema: { type: "object", properties: { path: { type: "string" } } } }] },
    endpoint: "/v1/messages",
  }),
  [FORMATS.OPENAI_RESPONSES]: () => ({
    body: { model: "llama-3.1-70b", stream: true, input: [{ role: "user", content: "hello" }], tools: [{ type: "function", name: ORIGINAL, description: "fixture", parameters: { type: "object", properties: { path: { type: "string" } } } }] },
    endpoint: "/v1/responses",
  }),
  [FORMATS.GEMINI]: () => ({
    body: {
      model: "llama-3.1-70b",
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      tools: [{ functionDeclarations: [{ name: ORIGINAL, description: "fixture", parameters: { type: "object", properties: { path: { type: "string" } } } }] }],
      generationConfig: { maxOutputTokens: 256 },
    },
    endpoint: "/v1/chat/completions",
  }),
};

/** Names the client sees in its own format, from the real client-facing response. */
const clientNames = {
  [FORMATS.OPENAI]: (json) => (json.choices?.[0]?.delta?.tool_calls || json.choices?.[0]?.message?.tool_calls || []).map((c) => c.function?.name),
  [FORMATS.CLAUDE]: (json) => json.type === "content_block_start"
    ? [json.content_block?.type === "tool_use" ? json.content_block.name : null].filter(Boolean)
    : (json.content || []).filter((b) => b.type === "tool_use").map((b) => b.name),
  [FORMATS.OPENAI_RESPONSES]: (json) => json.item?.type === "function_call" ? [json.item.name] : (json.output || []).filter((i) => i.type === "function_call").map((i) => i.name),
  [FORMATS.GEMINI]: (json) => (json.candidates?.[0]?.content?.parts || []).filter((p) => p.functionCall).map((p) => p.functionCall.name),
};

describe("P9 round-4 request-side fitting covers Gemini declarations", () => {
  it("fits a Gemini body's functionDeclarations name and its history references", () => {
    const body = {
      contents: [
        { role: "user", parts: [{ text: "hi" }] },
        { role: "model", parts: [{ functionCall: { name: ORIGINAL, args: { path: "/x" } } }] },
        { role: "user", parts: [{ functionResponse: { name: ORIGINAL, response: { result: "ok" } } }] },
      ],
      tools: [{ functionDeclarations: [{ name: ORIGINAL, description: "fixture", parameters: { type: "object" } }] }],
    };
    const fitted = ensureFittedToolNames(body);
    const sent = fitted.tools[0].functionDeclarations[0].name;

    expect(sent).not.toBe(ORIGINAL);
    expect(sent.length).toBeLessThanOrEqual(MAX_NAME);
    expect(fitted._toolNameMap.get(sent)).toBe(ORIGINAL);
    // The history must reference the same fitted name the declaration carries.
    expect(fitted.contents[1].parts[0].functionCall.name).toBe(sent);
    expect(fitted.contents[2].parts[0].functionResponse.name).toBe(sent);
    // Deterministic across a retry/second turn: the same input maps the same way.
    const again = ensureFittedToolNames({
      contents: body.contents.map((c) => structuredClone(c)),
      tools: [{ functionDeclarations: [{ name: ORIGINAL, description: "fixture", parameters: { type: "object" } }] }],
    });
    expect(again.tools[0].functionDeclarations[0].name).toBe(sent);
  });

  it("restores a Gemini candidates frame on the same-format stream path", () => {
    // A Gemini client served by a Gemini-shaped provider never enters
    // translateResponse(); the parsed SSE frame goes through the inverse map on
    // the passthrough path, so the candidates shape must be handled here too.
    const payload = {
      candidates: [{ index: 0, content: { role: "model", parts: [{ functionCall: { name: FITTED, args: { path: "/x" } } }, { text: "ok" }] } }],
      usageMetadata: { promptTokenCount: 3 },
    };
    const restored = restoreToolNames(payload, new Map([[FITTED, ORIGINAL]]));
    expect(restored.candidates[0].content.parts[0].functionCall.name).toBe(ORIGINAL);
    expect(restored.candidates[0].content.parts[1].text).toBe("ok");
    expect(restored.usageMetadata).toEqual({ promptTokenCount: 3 });

    // A frame with no mapped name stays identity-equal so the stream can forward
    // the untouched raw line (byte-preserving passthrough).
    const untouched = { candidates: [{ content: { parts: [{ text: "x" }] } }] };
    expect(restoreToolNames(untouched, new Map([[FITTED, ORIGINAL]]))).toBe(untouched);
  });

  it("leaves short Gemini declaration names and other holders untouched", () => {
    const body = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [{ functionDeclarations: [{ name: "inspect", parameters: { type: "object" } }] }],
    };
    ensureFittedToolNames(body);
    expect(body.tools[0].functionDeclarations[0].name).toBe("inspect");
    expect(body._toolNameMap).toBeUndefined();
  });
});

describe("P9 round-4 inverse names through the real handleChatCore (no supplied map)", () => {
  beforeEach(() => {
    executeMock.mockReset();
  });

  for (const [format, label] of [[FORMATS.OPENAI, "OpenAI"], [FORMATS.CLAUDE, "Claude"], [FORMATS.OPENAI_RESPONSES, "Responses"], [FORMATS.GEMINI, "Gemini"]]) {
    it(`${label}: streamed tool call keeps the client's original name`, async () => {
      const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
      executeMock.mockImplementation(echoUpstream(true));
      const { body, endpoint } = clientBodies[format]();

      const result = await handleChatCore(chatOptions({ body, endpoint, stream: true }));
      expect(result.success).toBe(true);

      const sent = sentToolName(executeMock.mock.calls[0][0].body);
      expect(sent).not.toBe(ORIGINAL);
      expect(sent.length).toBeLessThanOrEqual(MAX_NAME);

      const text = await result.response.text();
      const names = parseSSE(text).flatMap((e) => clientNames[format](e.data));
      expect(names).toContain(ORIGINAL);
      expect(text).not.toContain(sent);
    });

    it(`${label}: non-streaming tool call keeps the client's original name`, async () => {
      const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
      executeMock.mockImplementation(echoUpstream(false));
      const { body, endpoint } = clientBodies[format]();
      body.stream = false;

      const result = await handleChatCore(chatOptions({ body, endpoint, stream: false }));
      expect(result.success).toBe(true);

      const sent = sentToolName(executeMock.mock.calls[0][0].body);
      expect(sent).not.toBe(ORIGINAL);
      expect(sent.length).toBeLessThanOrEqual(MAX_NAME);

      const json = await result.response.json();
      expect(clientNames[format](json)).toContain(ORIGINAL);
      expect(JSON.stringify(json)).not.toContain(sent);
    });
  }

  it("Gemini client: the provider request carries the fitted name", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    executeMock.mockImplementation(echoUpstream(true));
    const { body, endpoint } = clientBodies[FORMATS.GEMINI]();
    expect(detectFormat(body)).toBe(FORMATS.GEMINI);

    await handleChatCore(chatOptions({ body, endpoint, stream: true }));
    const outbound = executeMock.mock.calls[0][0].body;

    expect(outbound.tools[0].function.name).toBe(sentToolName(outbound));
    expect(outbound.tools[0].function.name.length).toBeLessThanOrEqual(MAX_NAME);
    // The declaration is the only tool reference in this fixture; the
    // history-consistency contract is asserted in the helper test above.
    expect(outbound.messages.filter((m) => m.role === "assistant")).toEqual([]);
  });

  it("native /v1beta bridge keeps its OpenAI-shaped conversion (fitting untouched)", () => {
    // The route converts the Gemini body itself, then handleChat detects an
    // OpenAI client body — where the existing fitting rule already applies to
    // tools[].function.name. No Gemini-declaration path is involved there.
    const converted = geminiToOpenAIRequest("gemini-2.5-pro", {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      tools: [{ functionDeclarations: [{ name: ORIGINAL, parameters: { type: "object" } }] }],
    }, true, { accessToken: "fixture" });

    expect(converted.contents).toBeUndefined();
    expect(converted.tools[0].function.name).toBe(ORIGINAL);
    expect(detectFormat(converted)).toBe(FORMATS.OPENAI);
    ensureFittedToolNames(converted);
    expect(converted.tools[0].function.name.length).toBeLessThanOrEqual(MAX_NAME);
    expect(converted._toolNameMap.get(converted.tools[0].function.name)).toBe(ORIGINAL);
  });
});
