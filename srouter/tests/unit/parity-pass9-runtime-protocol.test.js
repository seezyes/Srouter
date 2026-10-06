// Pass9 runtime-protocol regressions (T-0030 P9-F6 / P9-F7).
//
// P9-F6 — Kimi native tool-call normalization: Kimi K2.x leaks
//         `functions.NAME:ID {json}` markup into `content` instead of structured
//         tool_calls. Covers the parser, the streaming normalizer wired through
//         the real createSSETransformStreamWithLogger, and the non-streaming
//         handler reached through the real handleChatCore caller.
// P9-F7 — JSON→SSE upstream mismatch recovery: when the client requested SSE but
//         the upstream is coerced to non-streaming (NVIDIA NIM Kimi), the JSON
//         body is re-serialized into the correct client SSE format.
//
// These drive the actual production modules (handleChatCore, stream.js,
// nonStreamingHandler, kimiToolParser, coercedSseHandler) — not clones.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractKimiToolCalls, hasKimiToolMarkup, kimiMarkerPrefixLength, normalizeKimiToolCalls, parseKimiToolCallFragment, parseKimiToolRegion } from "../../open-sse/utils/kimiToolParser.js";
import { buildCoercedSSEResponse } from "../../open-sse/handlers/chatCore/coercedSseHandler.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

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
  // Faithful enough for handler-level assertions: the real helper pipes the
  // provider body through the transform stream (plus disconnect/stall handling).
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
  id: "chatcmpl-kimi",
  object: "chat.completion.chunk",
  created: 1,
  model: "kimi-k2.7",
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...(usage ? { usage } : {}),
});

function makeChatOptions({ provider, model, stream, bodyExtra = {} }) {
  const body = { model, messages: [{ role: "user", content: "hello" }], ...(stream === undefined ? {} : { stream }), ...bodyExtra };
  return {
    body,
    modelInfo: { provider, model },
    credentials: { apiKey: "sk-test" },
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body,
      headers: { accept: stream === false ? "application/json" : "text/event-stream" },
    },
    connectionId: "test-connection",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe("P9-F6 Kimi native tool-call parser", () => {
  it("strips the functions. prefix, parses args, supports multiple + nested calls", () => {
    expect(hasKimiToolMarkup("prefix functions.echo:0 {}")).toBe(true);
    expect(hasKimiToolMarkup("no markup")).toBe(false);

    const calls = extractKimiToolCalls('intro functions.echo:0 {"path":"/x"}functions.lookup:7 {"query":{"a":1},"tags":["x","y"]}');
    expect(calls).toHaveLength(2);
    expect(calls[0].function.name).toBe("echo");
    expect(calls[0].id).toBe("functions.echo:0");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ path: "/x" });
    expect(calls[1].function.name).toBe("lookup");
    expect(JSON.parse(calls[1].function.arguments)).toEqual({ query: { a: 1 }, tags: ["x", "y"] });
  });

  it("normalizes an assistant message and reports hasTools; respects existing tool_calls", () => {
    const { message, hasTools } = normalizeKimiToolCalls({ role: "assistant", content: 'prose functions.echo:0 {"path":"/x"}' });
    expect(hasTools).toBe(true);
    expect(message.content).toBe("prose");
    expect(message.tool_calls[0].function.name).toBe("echo");

    const existing = normalizeKimiToolCalls({ role: "assistant", content: "irrelevant", tool_calls: [{ id: "t1" }] });
    expect(existing.hasTools).toBe(true);
    expect(existing.message.tool_calls).toEqual([{ id: "t1" }]);
    expect(existing.message.content).toBe("irrelevant");
  });

  it("never throws on malformed/partial markup and returns null for unparseable fragments", () => {
    expect(extractKimiToolCalls("functions.echo:0 {unbalanced")).toEqual([]);
    expect(parseKimiToolCallFragment("echo:0 not json", 0)).toBeNull();
    expect(parseKimiToolCallFragment("echo:0 {", 0)).toBeNull();
    expect(extractKimiToolCalls("")).toEqual([]);
  });
});

describe("P9-F6 Kimi streaming normalization through the real stream", () => {
  it("replaces leaked markup with a structured tool_calls chunk for a Kimi model", async () => {
    const input = sse([
      `data: ${JSON.stringify(openaiChunk({ content: 'Here: functions.echo:0 {"path":"/x"}' }))}\n\n`,
      `data: ${JSON.stringify(openaiChunk({}, "stop"))}\n\n`,
      "data: [DONE]\n\n",
    ]);
    const out = await new Response(input.pipeThrough(createSSETransformStreamWithLogger(
      FORMATS.OPENAI, FORMATS.OPENAI, "kimchi", null, null, "kimi-k2.7", null, null, null, null, null, null, normalizeKimiToolCalls,
    ))).text();
    const events = parseSSE(out);

    const toolEvent = events.find((e) => e.data?.choices?.[0]?.delta?.tool_calls);
    expect(toolEvent).toBeTruthy();
    expect(toolEvent.data.choices[0].finish_reason).toBe("tool_calls");
    expect(toolEvent.data.choices[0].delta.tool_calls[0].function.name).toBe("echo");
    expect(JSON.parse(toolEvent.data.choices[0].delta.tool_calls[0].function.arguments)).toEqual({ path: "/x" });

    const contentDeltas = events.map((e) => e.data?.choices?.[0]?.delta?.content).filter((c) => typeof c === "string");
    expect(contentDeltas).toContain("Here:");
    expect(contentDeltas.every((c) => !c.includes("functions."))).toBe(true);
    // The synthetic chunk is the terminal frame the client sees.
    expect(toolEvent.data.choices[0].finish_reason).toBe("tool_calls");
    // The plain upstream finish chunk must not also be forwarded.
    expect(events.some((e) => e.data?.choices?.[0]?.finish_reason === "stop")).toBe(false);
  });

  it("leaves non-Kimi models untouched even when a normalizer is supplied", async () => {
    const input = sse([
      `data: ${JSON.stringify(openaiChunk({ content: 'Here: functions.echo:0 {"path":"/x"}', model: "gpt-4o" }))}\n\n`,
      `data: ${JSON.stringify(openaiChunk({}, "stop"))}\n\n`,
      "data: [DONE]\n\n",
    ]);
    const out = await new Response(input.pipeThrough(createSSETransformStreamWithLogger(
      FORMATS.OPENAI, FORMATS.OPENAI, "openai", null, null, "gpt-4o", null, null, null, null, null, null, normalizeKimiToolCalls,
    ))).text();
    expect(out).not.toContain('"tool_calls"');
    expect(out).toContain("functions.echo:0");
  });
});

describe("P9-F6 Kimi tool preservation across client formats", () => {
  const NAME_MAP = new Map([["echoshrt", "echo_full_name"]]);
  const MODEL = "kimi-k2.7";

  function stream(sourceFormat, toolNameMap = null) {
    return createSSETransformStreamWithLogger(
      FORMATS.OPENAI, sourceFormat, "kimchi", null, toolNameMap, MODEL, null, null, null, null, null, null, normalizeKimiToolCalls,
    );
  }

  async function run(sourceFormat, chunks, toolNameMap = null) {
    const out = await new Response(sse(chunks).pipeThrough(stream(sourceFormat, toolNameMap))).text();
    return { out, events: parseSSE(out) };
  }

  const markupChunk = (text) => `data: ${JSON.stringify(openaiChunk({ content: text }))}\n\n`;
  const finishChunk = (reason = "stop") => `data: ${JSON.stringify(openaiChunk({}, reason))}\n\n`;
  const DONE = "data: [DONE]\n\n";

  it("parses markup regions with offsets and holds partial markers", () => {
    const region = parseKimiToolRegion('prose functions.a:0 {"x":1}functions.b:1 {"y":{"z":2}} tail');
    expect(region.start).toBe(6);
    expect(region.calls).toHaveLength(2);
    expect(region.calls[0].function.name).toBe("a");
    expect(region.consumed).toBe('functions.a:0 {"x":1}functions.b:1 {"y":{"z":2}}'.length);
    expect(parseKimiToolRegion("no markup here")).toMatchObject({ calls: [], start: -1, consumed: 0 });
    expect(kimiMarkerPrefixLength("functio")).toBe(7);
    expect(kimiMarkerPrefixLength("done ")).toBe(0);
  });

  it("releases prose that merely contains the marker word instead of holding it", async () => {
    const { events } = await run(FORMATS.OPENAI, [
      markupChunk("the functions.run API and functions. The result is 42"),
      finishChunk("stop"),
      DONE,
    ]);

    expect(events.some((e) => e.data?.choices?.[0]?.delta?.tool_calls)).toBe(false);
    expect(events.map((e) => e.data?.choices?.[0]?.delta?.content).filter((c) => typeof c === "string").join(""))
      .toBe("the functions.run API and functions. The result is 42");
  });

  it("OpenAI: recovers markup fragmented across deltas, emits one call, keeps terminal order", async () => {
    const { out, events } = await run(FORMATS.OPENAI, [
      markupChunk("checking "),
      markupChunk("func"),
      markupChunk("tions."),
      markupChunk('echo:0 {"pa'),
      markupChunk('th":"/x"}'),
      finishChunk("stop"),
      DONE,
    ]);

    const calls = events.filter((e) => e.data?.choices?.[0]?.delta?.tool_calls);
    expect(calls).toHaveLength(1);
    expect(calls[0].data.choices[0].delta.tool_calls).toHaveLength(1);
    expect(calls[0].data.choices[0].delta.tool_calls[0].function.name).toBe("echo");
    expect(calls[0].data.choices[0].finish_reason).toBe("tool_calls");
    // No markup text reaches the client (the call id keeps Kimi's own spelling),
    // and the plain finish frame was replaced instead of preceding the tool call.
    const contents = events.map((e) => e.data?.choices?.[0]?.delta?.content).filter((c) => typeof c === "string");
    // "checking " was already flushed before the marker started, so only the
    // markup region is withheld — prose is never re-trimmed across deltas.
    expect(contents.join("")).toBe("checking ");
    expect(events.some((e) => e.data?.choices?.[0]?.finish_reason === "stop")).toBe(false);
  });

  it("OpenAI: restores a fitted tool name through the inverse tool-name map", async () => {
    const { events } = await run(FORMATS.OPENAI, [
      markupChunk('go functions.echoshrt:0 {"path":"/x"}'),
      finishChunk("stop"),
      DONE,
    ], NAME_MAP);

    const call = events.find((e) => e.data?.choices?.[0]?.delta?.tool_calls)?.data.choices[0].delta.tool_calls[0];
    expect(call.function.name).toBe("echo_full_name");
    expect(call.index).toBe(0);
  });

  it("Responses: emits function_call item, argument deltas/done and response.completed", async () => {
    const { out, events } = await run(FORMATS.OPENAI_RESPONSES, [
      markupChunk('ok functions.echoshrt:0 {"path":"/x"}'),
      finishChunk("stop"),
      DONE,
    ], NAME_MAP);

    const added = events.find((e) => e.type === "response.output_item.added" && e.data.item?.type === "function_call");
    expect(added).toBeTruthy();
    expect(added.data.item.name).toBe("echo_full_name");
    expect(added.data.item.call_id).toBe("functions.echoshrt:0");

    const argsDelta = events.find((e) => e.type === "response.function_call_arguments.delta");
    expect(argsDelta.data.delta).toBe('{"path":"/x"}');

    const argsDone = events.find((e) => e.type === "response.function_call_arguments.done");
    expect(JSON.parse(argsDone.data.arguments)).toEqual({ path: "/x" });

    const itemDone = events.find((e) => e.type === "response.output_item.done" && e.data.item?.type === "function_call");
    expect(itemDone.data.item.name).toBe("echo_full_name");

    const completed = events.find((e) => e.type === "response.completed");
    expect(completed).toBeTruthy();
    expect(completed.data.response.output.some((i) => i.type === "function_call" && i.name === "echo_full_name")).toBe(true);
    expect(events.at(-1).type).toBe("response.completed");
    expect(out).not.toContain("[DONE]");
  });

  it("Claude: emits tool_use block start, input_json_delta, block stop and message terminal", async () => {
    const { out, events } = await run(FORMATS.CLAUDE, [
      markupChunk('ok functions.echoshrt:0 {"path":"/x"}'),
      finishChunk("stop"),
      DONE,
    ], NAME_MAP);

    const types = events.map((e) => e.type);
    const start = events.find((e) => e.type === "content_block_start" && e.data.content_block?.type === "tool_use");
    expect(start).toBeTruthy();
    expect(start.data.content_block.name).toBe("echo_full_name");
    expect(start.data.content_block.id).toBe("functions.echoshrt:0");

    const jsonDelta = events.find((e) => e.type === "content_block_delta" && e.data.delta?.type === "input_json_delta");
    expect(JSON.parse(jsonDelta.data.delta.partial_json)).toEqual({ path: "/x" });
    expect(types).toContain("content_block_stop");
    expect(events.find((e) => e.type === "message_delta").data.delta.stop_reason).toBe("tool_use");
    expect(types.at(-1)).toBe("message_stop");
    // Block ordering: the tool block is opened and closed before the terminal.
    expect(types.indexOf("message_stop")).toBeGreaterThan(types.indexOf("content_block_stop"));
    const textDeltas = events.filter((e) => e.data?.delta?.type === "text_delta").map((e) => e.data.delta.text);
    expect(textDeltas.join("")).toBe("ok");
  });

  it("Gemini: emits functionCall parts in the bare candidates envelope", async () => {
    const { out, events } = await run(FORMATS.GEMINI, [
      markupChunk('ok functions.echoshrt:0 {"path":"/x"}'),
      finishChunk("stop"),
      DONE,
    ], NAME_MAP);

    const callEvent = events.find((e) => e.data?.candidates?.[0]?.content?.parts?.some((p) => p.functionCall));
    expect(callEvent).toBeTruthy();
    const part = callEvent.data.candidates[0].content.parts.find((p) => p.functionCall);
    expect(part.functionCall.name).toBe("echo_full_name");
    expect(part.functionCall.args).toEqual({ path: "/x" });
    expect(callEvent.data.candidates[0].content.role).toBe("model");
    expect(callEvent.data.candidates[0].finishReason).toBe("STOP");
    expect(callEvent.data.response).toBeUndefined();
    expect(out).not.toContain("[DONE]");
  });

  it("keeps the upstream structured tool_calls authoritative and does not duplicate them", async () => {
    const { out, events } = await run(FORMATS.OPENAI, [
      markupChunk('calling functions.echo:0 {"path":"/x"}'),
      `data: ${JSON.stringify(openaiChunk({ tool_calls: [{ index: 0, id: "call_upstream", type: "function", function: { name: "echo", arguments: '{"path":"/x"}' } }] }))}\n\n`,
      finishChunk("stop"),
      DONE,
    ]);

    const calls = events.filter((e) => e.data?.choices?.[0]?.delta?.tool_calls);
    expect(calls).toHaveLength(1);
    expect(calls[0].data.choices[0].delta.tool_calls[0].id).toBe("call_upstream");
    expect(calls[0].data.choices[0].delta.tool_calls).toHaveLength(1);
    // The duplicate markup text is removed even though the upstream call wins.
    expect(out).not.toContain("functions.");
    expect(events.map((e) => e.data?.choices?.[0]?.delta?.content).filter((c) => typeof c === "string").join("")).toBe("calling");
  });

  it("does not strip markup for a client format that cannot carry the call", async () => {
    const { events } = await run(FORMATS.KIRO, [
      markupChunk('ok functions.echo:0 {"path":"/x"}'),
      finishChunk("stop"),
      DONE,
    ]);

    expect(events.some((e) => e.data?.choices?.[0]?.delta?.tool_calls)).toBe(false);
    expect(events.map((e) => e.data?.choices?.[0]?.delta?.content).filter((c) => typeof c === "string").join(""))
      .toBe('ok functions.echo:0 {"path":"/x"}');
    expect(events.some((e) => e.data?.choices?.[0]?.finish_reason === "stop")).toBe(true);
  });

  it("re-emits a never-completing markup fragment as content instead of dropping it", async () => {
    const { out, events } = await run(FORMATS.OPENAI, [
      markupChunk("partial "),
      markupChunk('functions.echo:0 {"path":"/x"'),
      DONE,
    ]);

    expect(events.some((e) => e.data?.choices?.[0]?.delta?.tool_calls)).toBe(false);
    expect(events.map((e) => e.data?.choices?.[0]?.delta?.content).filter((c) => typeof c === "string").join(""))
      .toBe('partial functions.echo:0 {"path":"/x"');
    expect(out).toContain("partial");
  });

  it("defers the terminal while markup is still in flight, then releases text before it", async () => {
    const { events } = await run(FORMATS.OPENAI, [
      markupChunk("partial "),
      markupChunk('functions.echo:0 {"path":"/x"'),
      finishChunk("stop"),
      DONE,
    ]);

    // No call can be recovered, so the held text and then the upstream finish
    // boundary are both released — the terminal is never emitted ahead of it.
    const contents = events.map((e) => e.data?.choices?.[0]?.delta?.content).filter((c) => typeof c === "string");
    expect(contents.join("")).toBe('partial functions.echo:0 {"path":"/x"');
    const finish = events.find((e) => e.data?.choices?.[0]?.finish_reason);
    expect(finish.data.choices[0].finish_reason).toBe("stop");
    expect(events.indexOf(finish)).toBe(events.length - 1);
    expect(events.some((e) => e.data?.choices?.[0]?.delta?.tool_calls)).toBe(false);
  });

  it("emits nothing after the client cancels mid-stream", async () => {
    const reader = sse([
      markupChunk("start "),
      markupChunk('functions.'),
      markupChunk('echo:0 {"path":"/x"}'),
      finishChunk("stop"),
      DONE,
    ]).pipeThrough(stream(FORMATS.OPENAI)).getReader();

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("start");
    await reader.cancel();
    const rest = await reader.read();
    expect(rest.done).toBe(true);
    // The recovered call must not be synthesized into a cancelled stream.
    expect(new TextDecoder().decode(first.value)).not.toContain("tool_calls");
  });
});

describe("P9-F7 JSON→SSE coercion serializers", () => {
  const openaiBody = {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "kimi-k2.7",
    choices: [{ index: 0, message: { role: "assistant", content: "answer", reasoning_content: "think", tool_calls: [{ id: "call_1", type: "function", function: { name: "echo", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  };

  it("OpenAI: emits role/content/tool_calls/finish chunks plus [DONE]", async () => {
    const text = await buildCoercedSSEResponse(openaiBody, FORMATS.OPENAI).text();
    const events = parseSSE(text);
    expect(events.some((e) => e.data?.choices?.[0]?.delta?.content === "answer")).toBe(true);
    expect(events.some((e) => e.data?.choices?.[0]?.delta?.reasoning_content === "think")).toBe(true);
    expect(events.some((e) => e.data?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name === "echo")).toBe(true);
    const finish = events.find((e) => e.data?.choices?.[0]?.finish_reason === "tool_calls");
    expect(finish.data.usage).toMatchObject({ total_tokens: 5 });
    expect(text).toContain("data: [DONE]");
  });

  it("Responses: emits response.created + response.completed and NO [DONE]", async () => {
    const responseBody = { id: "resp_1", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    const text = await buildCoercedSSEResponse(responseBody, FORMATS.OPENAI_RESPONSES).text();
    const events = parseSSE(text);
    expect(events.find((e) => e.type === "response.completed").data.response.output[0].content[0].text).toBe("answer");
    expect(events.some((e) => e.type === "response.created")).toBe(true);
    expect(text).not.toContain("[DONE]");
  });

  it("Claude: emits a full Anthropic message event sequence", async () => {
    const claudeBody = { id: "msg_1", type: "message", role: "assistant", model: "claude", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "answer" }, { type: "tool_use", id: "toolu_1", name: "echo", input: { path: "/x" } }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 2 } };
    const text = await buildCoercedSSEResponse(claudeBody, FORMATS.CLAUDE).text();
    const events = parseSSE(text);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("message_start");
    expect(types).toContain("content_block_start");
    expect(events.find((e) => e.type === "content_block_delta" && e.data.delta.type === "text_delta").data.delta.text).toBe("answer");
    expect(events.find((e) => e.type === "content_block_delta" && e.data.delta.type === "input_json_delta").data.delta.partial_json).toBe('{"path":"/x"}');
    expect(events.find((e) => e.type === "message_delta").data.delta.stop_reason).toBe("tool_use");
    expect(types.at(-1)).toBe("message_stop");
    expect(text).not.toContain("[DONE]");
  });

  it("Gemini: emits the body as a single data frame with no [DONE]", async () => {
    const geminiBody = { candidates: [{ content: { role: "model", parts: [{ text: "answer" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } };
    const text = await buildCoercedSSEResponse(geminiBody, FORMATS.GEMINI).text();
    const events = parseSSE(text);
    expect(events).toHaveLength(1);
    expect(events[0].data.candidates[0].content.parts[0].text).toBe("answer");
    expect(text).not.toContain("[DONE]");
  });
});

describe("P9-F7 JSON→SSE recovery through the real handleChatCore", () => {
  beforeEach(() => {
    executeMock.mockReset();
  });

  it("coerces NVIDIA Kimi upstream to stream:false and re-emits client SSE", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify(openaiBodyForCore()), { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      headers: {},
      transformedBody: { model: "kimi-k2.7", stream: false },
    });

    const result = await handleChatCore(makeChatOptions({ provider: "nvidia", model: "kimi-k2.7", stream: true }));

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock.mock.calls[0][0].stream).toBe(false);
    expect(executeMock.mock.calls[0][0].body.stream).toBe(false);

    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toBe("text/event-stream");
    const text = await result.response.text();
    expect(text).toContain("data: [DONE]");
    const events = parseSSE(text);
    expect(events.some((e) => e.data?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name === "echo")).toBe(true);
  });

  it("does not coerce a non-Kimi NVIDIA model", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    executeMock.mockResolvedValue({
      response: new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { "content-type": "text/event-stream" } }),
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      headers: {},
      transformedBody: { model: "llama-3.1-70b", stream: true },
    });

    await handleChatCore(makeChatOptions({ provider: "nvidia", model: "llama-3.1-70b", stream: true }));

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock.mock.calls[0][0].stream).toBe(true);
    expect(executeMock.mock.calls[0][0].body.stream).not.toBe(false);
  });

  it("normalizes leaked Kimi markup for non-streaming clients (stream:false)", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify(openaiBodyForCore()), { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      headers: {},
      transformedBody: { model: "kimi-k2.7", stream: false },
    });

    const result = await handleChatCore(makeChatOptions({ provider: "nvidia", model: "kimi-k2.7", stream: false }));
    const json = await result.response.json();
    expect(json.choices[0].message.tool_calls[0].function.name).toBe("echo");
    expect(json.choices[0].message.content).toBe("answer");
    expect(json.choices[0].finish_reason).toBe("tool_calls");
  });
});

describe("P9-F6 Kimi preservation through the real handleChatCore", () => {
  beforeEach(() => {
    executeMock.mockReset();
  });

  function kimiSse() {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(openaiChunk({ content: 'ok functions.echo:0 {"path":"/x"}' }))}\n\n`));
        controller.enqueue(enc.encode(`data: ${JSON.stringify(openaiChunk({}, "stop"))}\n\n`));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
  }

  it("Claude streaming client receives a tool_use block instead of markup text", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    executeMock.mockResolvedValue({
      response: new Response(kimiSse(), { status: 200, headers: { "content-type": "text/event-stream" } }),
      url: "https://api.kimchi.example/v1/chat/completions",
      headers: {},
      transformedBody: { model: "kimi-k2.7", stream: true },
    });

    const options = makeChatOptions({ provider: "kimchi", model: "kimi-k2.7", stream: true });
    options.body = { model: "kimi-k2.7", max_tokens: 64, stream: true, system: "be brief", messages: [{ role: "user", content: "hello" }] };
    options.clientRawRequest = {
      endpoint: "/v1/messages",
      body: options.body,
      headers: { accept: "text/event-stream" },
    };

    const result = await handleChatCore(options);
    expect(result.success).toBe(true);
    const text = await result.response.text();
    expect(text).toContain("event: content_block_start");
    const start = parseSSE(text).find((e) => e.type === "content_block_start" && e.data.content_block?.type === "tool_use");
    expect(start).toBeTruthy();
    expect(start.data.content_block.name).toBe("echo");
    expect(parseSSE(text).find((e) => e.type === "content_block_delta" && e.data.delta?.type === "input_json_delta")).toBeTruthy();
    expect(text).toContain("event: message_stop");
    expect(text).not.toContain("functions.echo:0 {");
  });

  it("Claude non-streaming client receives a tool_use block", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify(openaiBodyForCore()), { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://api.kimchi.example/v1/chat/completions",
      headers: {},
      transformedBody: { model: "kimi-k2.7", stream: false },
    });

    const options = makeChatOptions({ provider: "kimchi", model: "kimi-k2.7", stream: false });
    options.body = { model: "kimi-k2.7", max_tokens: 64, stream: false, system: "be brief", messages: [{ role: "user", content: "hello" }] };
    options.clientRawRequest = {
      endpoint: "/v1/messages",
      body: options.body,
      headers: { accept: "application/json" },
    };

    const result = await handleChatCore(options);
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expect(json.content.find((b) => b.type === "text").text).toBe("answer");
    const tool = json.content.find((b) => b.type === "tool_use");
    expect(tool.name).toBe("echo");
    expect(tool.input).toEqual({ path: "/x" });
    expect(json.stop_reason).toBe("tool_use");
  });

  it("Responses non-streaming client receives a function_call item", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify(openaiBodyForCore()), { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://api.kimchi.example/v1/chat/completions",
      headers: {},
      transformedBody: { model: "kimi-k2.7", stream: false },
    });

    const options = makeChatOptions({ provider: "kimchi", model: "kimi-k2.7", stream: false });
    options.body = { model: "kimi-k2.7", stream: false, input: [{ role: "user", content: "hello" }] };
    options.clientRawRequest = {
      endpoint: "/v1/responses",
      body: options.body,
      headers: { accept: "application/json" },
    };

    const result = await handleChatCore(options);
    const json = await result.response.json();
    expect(json.object).toBe("response");
    const item = json.output.find((i) => i.type === "function_call");
    expect(item.name).toBe("echo");
    expect(JSON.parse(item.arguments)).toEqual({ path: "/x" });
  });
});

function openaiBodyForCore() {
  return {
    id: "chatcmpl-kimi",
    object: "chat.completion",
    created: 1,
    model: "kimi-k2.7",
    choices: [{ index: 0, message: { role: "assistant", content: 'answer functions.echo:0 {"path":"/x"}' }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  };
}
