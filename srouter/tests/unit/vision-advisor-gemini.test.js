import { describe, expect, it, vi } from "vitest";
import { advisorCanHandleImages, runVisionAdvisor, shouldUseVisionAdvisor } from "../../src/sse/services/visionAdvisor.js";

const main = "cmc/deepseek/deepseek-v4-pro";
const advisor = "openai/gpt-4o";
const settings = { visionAdvisor: { enabled: true, models: [advisor] } };
const endpoint = "/api/v1beta/models/deepseek/deepseek-v4-pro:generateContent";
const image = { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } };
// The v1beta route already converted the native Gemini body to the internal
// Chat Completions shape before handleChat sees it.
const body = (stream = false) => ({
  model: main, stream,
  messages: [{ role: "user", content: [{ type: "text", text: "What is here?" }, image] }],
});
const reply = (message) => Response.json({
  id: "chatcmpl_test", object: "chat.completion", created: 1, model: main,
  choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
});
const toolReply = () => reply({ content: null, tool_calls: [{
  id: "call_1", type: "function", function: { name: "srouter_vision_advisor", arguments: '{"question":"What color?"}' },
}] });

describe("Gemini generateContent Vision Advisor", () => {
  it("accepts the converted body on both Gemini actions", () => {
    expect(shouldUseVisionAdvisor(body(), main, settings, endpoint)).toBe(true);
    expect(shouldUseVisionAdvisor(body(), main, settings, "/api/v1beta/models/deepseek/deepseek-v4-pro:streamGenerateContent")).toBe(true);
    expect(advisorCanHandleImages(body(), settings, endpoint)).toBe(true);
    // Unrelated endpoints keep their previous behavior.
    expect(shouldUseVisionAdvisor(body(), main, settings, "/api/v1beta/models/deepseek/deepseek-v4-pro:countTokens")).toBe(false);
    expect(shouldUseVisionAdvisor(body(), main, settings, "/api/v1beta/models")).toBe(false);
    expect(shouldUseVisionAdvisor(body(), main, settings, "/api/v1/messages")).toBe(false);
    expect(shouldUseVisionAdvisor(body(), advisor, settings, endpoint)).toBe(false);
  });

  it("keeps the internal Chat body across the private rounds", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(toolReply())
      .mockResolvedValueOnce(reply({ content: "The image is blue." }))
      .mockResolvedValueOnce(new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } }));
    const final = await runVisionAdvisor({ body: body(true), modelStr: main, endpoint, advisorModels: [advisor], send });
    expect(final.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);

    const first = send.mock.calls[0][1];
    expect(first.stream).toBe(false);
    expect(first.messages[0].content).not.toContainEqual(image);
    expect(first.tools.at(-1).function.name).toBe("srouter_vision_advisor");
    expect(send.mock.calls[1][1].messages[1].content).toContainEqual(image);
    const resumed = send.mock.calls[2][1];
    expect(resumed.stream).toBe(true);
    expect(resumed.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "call_1", content: "The image is blue." });
    expect(body().messages[0].content).toContainEqual(image);
  });

  it("serializes a no-tool answer as internal OpenAI SSE for the route to convert", async () => {
    const send = vi.fn().mockResolvedValue(reply({ role: "assistant", content: "No inspection needed." }));
    const response = await runVisionAdvisor({ body: body(true), modelStr: main, endpoint, advisorModels: [advisor], send });
    const text = await response.text();
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain("data: [DONE]");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
