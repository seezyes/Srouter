import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleChat: vi.fn(),
  getSettings: vi.fn(),
  isValidApiKey: vi.fn(),
  getApiKeyInfo: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
}));

vi.mock("@/sse/handlers/chat.js", () => ({
  handleChat: mocks.handleChat,
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  isValidApiKey: mocks.isValidApiKey,
  getApiKeyInfo: mocks.getApiKeyInfo,
  extractApiKey: (request) => {
    const bearer = request?.headers?.get("Authorization");
    if (bearer?.startsWith("Bearer ")) return bearer.slice(7);
    return request?.headers?.get("x-goog-api-key") || (request?.url ? new URL(request.url).searchParams.get("key") : null);
  },
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
}));
vi.mock("@/sse/services/allowedModels.js", () => ({ isModelAllowed: vi.fn(async () => true) }));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

const { GET } = await import("../../src/app/api/v1beta/models/route.js");
const { POST } = await import("../../src/app/api/v1beta/models/[...path]/route.js");

function makeGeminiRequest(path, body, headers = {}, signal) {
  return new Request(`https://router.test/v1beta/models/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer router-client-key",
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });
}

function audioBody() {
  return {
    contents: [{ parts: [{ text: "Speak naturally: hello" }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: "Kore" },
        },
      },
      temperature: 0.01,
      seed: 123,
    },
  };
}

describe("Gemini native v1beta endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    mocks.isValidApiKey.mockResolvedValue(true);
    mocks.getApiKeyInfo.mockImplementation(async (key) => await mocks.isValidApiKey(key) ? { id: "test" } : null);
    mocks.getProviderCredentials.mockResolvedValue({
      apiKey: "real-gemini-key",
      connectionId: "gemini-conn",
      connectionName: "Gemini Test",
      providerSpecificData: {},
    });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    mocks.handleChat.mockResolvedValue(
      Response.json({ candidates: [{ content: { parts: [{ text: "chat" }] } }] })
    );
  });

  it("lists Gemini TTS models using standard Google model names", async () => {
    const response = await GET(new Request("https://router.test/v1beta/models", { headers: { Authorization: "Bearer router-client-key" } }));
    const body = await response.json();
    const names = body.models.map((model) => model.name);

    expect(names).toContain("models/gemini-3.1-flash-tts-preview");
    expect(names).toContain("models/gemini-2.5-flash-preview-tts");
    expect(names).toContain("models/gemini-2.5-pro-preview-tts");
  });

  it.each([{ allowedKinds: ["llm"] }, { allowedProviders: [] }])("enforces ACL on native TTS before upstream calls: %j", async (access) => {
    mocks.getApiKeyInfo.mockResolvedValue({ id: "restricted", ...access });
    const response = await POST(makeGeminiRequest("gemini-3.1-flash-tts-preview:generateContent", audioBody()), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
    });
    expect(response.status).toBe(403);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("passes Gemini AUDIO generateContent requests through to Google's native endpoint", async () => {
    const body = audioBody();
    const response = await POST(makeGeminiRequest("gemini-3.1-flash-tts-preview:generateContent", body), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
    });

    expect(response.status).toBe(200);
    expect(mocks.handleChat).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent"
    );

    const options = global.fetch.mock.calls[0][1];
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual(body);
    expect(options.headers["x-goog-api-key"]).toBe("real-gemini-key");
    expect(options.headers.Authorization).toBeUndefined();
  });

  it("accepts Google-style client keys without forwarding them upstream", async () => {
    const request = makeGeminiRequest(
      "gemini-2.5-flash-preview-tts:generateContent?key=query-router-key",
      audioBody(),
      {
        Authorization: "",
        "x-goog-api-key": "client-router-key",
      }
    );
    await POST(request, {
      params: Promise.resolve({ path: ["gemini-2.5-flash-preview-tts:generateContent"] }),
    });

    expect(mocks.isValidApiKey).toHaveBeenCalledWith("client-router-key");
    expect(global.fetch.mock.calls[0][1].headers["x-goog-api-key"]).toBe("real-gemini-key");
    expect(global.fetch.mock.calls[0][1].headers["x-goog-api-key"]).not.toBe("client-router-key");
  });

  it("does not forward stale compression headers from native upstream responses", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
          "Content-Length": "123",
        },
      })
    );

    const response = await POST(makeGeminiRequest("gemini-3.1-flash-tts-preview:generateContent", audioBody()), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
  });

  it("falls back to the next Gemini credential when native fetch times out before headers", async () => {
    const timeoutError = new TypeError("fetch failed");
    timeoutError.cause = { code: "UND_ERR_HEADERS_TIMEOUT", name: "HeadersTimeoutError" };

    mocks.getProviderCredentials
      .mockResolvedValueOnce({
        apiKey: "first-gemini-key",
        connectionId: "first-conn",
        connectionName: "First Gemini",
        providerSpecificData: {},
      })
      .mockResolvedValueOnce({
        apiKey: "second-gemini-key",
        connectionId: "second-conn",
        connectionName: "Second Gemini",
        providerSpecificData: {},
      });
    mocks.markAccountUnavailable.mockResolvedValueOnce({ shouldFallback: true });
    global.fetch
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: "pcm" } }] } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

    const response = await POST(makeGeminiRequest("gemini-3.1-flash-tts-preview:generateContent", audioBody()), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
    });

    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][1].headers["x-goog-api-key"]).toBe("first-gemini-key");
    expect(global.fetch.mock.calls[1][1].headers["x-goog-api-key"]).toBe("second-gemini-key");
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "first-conn",
      504,
      expect.stringContaining("UND_ERR_HEADERS_TIMEOUT"),
      "gemini",
      "gemini-3.1-flash-tts-preview"
    );
    expect(mocks.clearAccountError).toHaveBeenCalledWith(
      "second-conn",
      expect.objectContaining({ apiKey: "second-gemini-key" }),
      "gemini-3.1-flash-tts-preview"
    );
  });

  it("returns 502 for native fetch failures when credential fallback is not allowed", async () => {
    const networkError = new TypeError("fetch failed");
    networkError.cause = { code: "ECONNRESET" };
    mocks.markAccountUnavailable.mockResolvedValueOnce({ shouldFallback: false });
    global.fetch.mockRejectedValueOnce(networkError);

    const response = await POST(makeGeminiRequest("gemini-3.1-flash-tts-preview:generateContent", audioBody()), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
    });
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error.message).toContain("ECONNRESET");
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "gemini-conn",
      502,
      expect.stringContaining("ECONNRESET"),
      "gemini",
      "gemini-3.1-flash-tts-preview"
    );
  });

  it("does not mark Gemini credentials unavailable when the native client aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    global.fetch.mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));

    const response = await POST(
      makeGeminiRequest("gemini-3.1-flash-tts-preview:generateContent", audioBody(), {}, controller.signal),
      {
        params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
      }
    );

    expect(response.status).toBe(499);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("keeps non-audio Gemini requests on the existing chat conversion path", async () => {
    const body = {
      contents: [{ parts: [{ text: "hello" }] }],
      generationConfig: { temperature: 0.3 },
    };

    await POST(makeGeminiRequest("gemini-2.5-flash:generateContent", body), {
      params: Promise.resolve({ path: ["gemini-2.5-flash:generateContent"] }),
    });

    expect(mocks.handleChat).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("preserves inline images, tools, toolConfig and the client maxOutputTokens in the internal body", async () => {
    const body = {
      systemInstruction: { parts: [{ text: "Be brief" }] },
      contents: [{
        role: "user",
        parts: [
          { text: "What is here?" },
          { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
        ],
      }],
      tools: [{ functionDeclarations: [{
        name: "search", description: "Search",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      }] }],
      toolConfig: { functionCallingConfig: { mode: "NONE" } },
      generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
    };

    await POST(makeGeminiRequest("gemini-2.5-flash:generateContent", body), {
      params: Promise.resolve({ path: ["gemini-2.5-flash:generateContent"] }),
    });

    const forwarded = await mocks.handleChat.mock.calls[0][0].json();
    expect(forwarded.messages).toEqual([
      { role: "system", content: "Be brief" },
      {
        role: "user",
        content: [
          { type: "text", text: "What is here?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
        ],
      },
    ]);
    expect(forwarded.tools[0]).toMatchObject({
      type: "function",
      function: { name: "search", description: "Search" },
    });
    expect(forwarded.tool_choice).toBe("none");
    expect(forwarded.max_tokens).toBe(1024);
    expect(forwarded.temperature).toBe(0.3);
    expect(forwarded.stream).toBe(false);
  });

  it("round-trips functionCall/functionResponse history into tool_calls and a tool message", async () => {
    const body = {
      contents: [
        { role: "user", parts: [{ text: "find blue" }] },
        { role: "model", parts: [{ functionCall: { name: "search", args: { q: "blue" } } }] },
        { role: "user", parts: [{ functionResponse: { name: "search", response: { result: "found" } } }] },
      ],
    };

    await POST(makeGeminiRequest("gemini-2.5-flash:generateContent", body), {
      params: Promise.resolve({ path: ["gemini-2.5-flash:generateContent"] }),
    });

    const forwarded = await mocks.handleChat.mock.calls[0][0].json();
    expect(forwarded.messages[1]).toEqual({
      role: "assistant",
      tool_calls: [{
        id: "call_search", type: "function",
        function: { name: "search", arguments: '{"q":"blue"}' },
      }],
    });
    expect(forwarded.messages[2]).toEqual({
      role: "tool", tool_call_id: "call_search", content: '"found"',
    });
  });

  it("serializes internal tool_calls back as Gemini functionCall parts", async () => {
    mocks.handleChat.mockResolvedValue(Response.json({
      id: "chatcmpl-1", object: "chat.completion", created: 1, model: "gemini-2.5-flash",
      choices: [{
        index: 0,
        message: {
          role: "assistant", content: null,
          tool_calls: [{ id: "call_9", type: "function", function: { name: "search", arguments: '{"q":"blue"}' } }],
        },
        finish_reason: "tool_calls",
      }],
    }));

    const response = await POST(makeGeminiRequest("gemini-2.5-flash:generateContent", {
      contents: [{ role: "user", parts: [{ text: "find blue" }] }],
    }), { params: Promise.resolve({ path: ["gemini-2.5-flash:generateContent"] }) });

    const result = await response.json();
    const parts = result.candidates[0].content.parts;
    expect(parts).toContainEqual({
      functionCall: { id: "call_9", name: "search", args: { q: "blue" } },
    });
    expect(result.candidates[0].finishReason).toBe("STOP");
  });

  it("streams accumulated tool_call fragments as one Gemini functionCall part", async () => {
    const sse = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gemini-2.5-flash","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"search","arguments":""}}]},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":\\"blue\\"}"}}]},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
      "data: [DONE]",
      "",
    ].join("\n");
    mocks.handleChat.mockResolvedValue(new Response(sse, {
      headers: { "Content-Type": "text/event-stream" },
    }));

    const response = await POST(makeGeminiRequest("gemini-2.5-flash:streamGenerateContent?alt=sse", {
      contents: [{ role: "user", parts: [{ text: "find blue" }] }],
    }), { params: Promise.resolve({ path: ["gemini-2.5-flash:streamGenerateContent"] }) });

    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain('"functionCall":{"id":"call_9","name":"search","args":{"q":"blue"}}');
    expect(text).toContain('"finishReason":"STOP"');
    expect(text).not.toContain("[DONE]");
  });

  it("does not hijack provider-prefixed non-Gemini audio requests", async () => {
    await POST(makeGeminiRequest("openai/gpt-4o-mini-tts:generateContent", audioBody()), {
      params: Promise.resolve({ path: ["openai", "gpt-4o-mini-tts:generateContent"] }),
    });

    expect(mocks.handleChat).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
