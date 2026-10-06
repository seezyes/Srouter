import { describe, expect, it, vi } from "vitest";
import { advisorCanHandleImages, runVisionAdvisor, shouldUseVisionAdvisor } from "../../src/sse/services/visionAdvisor.js";

const main = "cmc/deepseek/deepseek-v4-pro";
const advisor = "openai/gpt-4o";
const backup = "cmc/moonshotai/Kimi-K3";
const settings = { visionAdvisor: { enabled: true, models: [advisor] } };
const endpoint = "/api/v1/responses";
const image = { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" };
const body = (stream = false) => ({
  model: main, stream, instructions: "Be brief.",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "What is here?" }, image] }],
});
const responsesReply = (output) => Response.json({
  id: "resp_test", object: "response", created_at: 1, model: main,
  status: "completed", output, usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
});
const messageReply = (text) => responsesReply([
  { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
]);
const toolReply = () => responsesReply([
  { type: "function_call", call_id: "call_1", name: "srouter_vision_advisor", arguments: '{"question":"What color?"}' },
]);

describe("Responses Vision Advisor", () => {
  it("offers the tool only for native Responses image requests", () => {
    expect(shouldUseVisionAdvisor(body(), main, settings, endpoint)).toBe(true);
    expect(advisorCanHandleImages(body(), settings, endpoint)).toBe(true);
    expect(shouldUseVisionAdvisor(body(), advisor, settings, endpoint)).toBe(false);
    expect(shouldUseVisionAdvisor({ ...body(), tool_choice: "none" }, main, settings, endpoint)).toBe(false);
    expect(shouldUseVisionAdvisor({ ...body(), input: "describe the image" }, main, settings, endpoint)).toBe(false);
    // The same endpoint must not accept another format's body, and vice versa.
    const chatBody = {
      model: main,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" },
        { type: "image_url", image_url: { url: image.image_url } }] }],
    };
    expect(shouldUseVisionAdvisor(chatBody, main, settings, endpoint)).toBe(false);
    expect(shouldUseVisionAdvisor(body(), main, settings, "/api/v1/chat/completions")).toBe(false);
    // file ids and other input parts keep the ordinary fallback path.
    const withContent = (part) => ({ ...body(), input: [{ type: "message", role: "user", content: [part] }] });
    expect(shouldUseVisionAdvisor(withContent({ type: "input_image", file_id: "file_1" }), main, settings, endpoint)).toBe(false);
    expect(shouldUseVisionAdvisor(withContent({ type: "input_file", file_data: "aGVsbG8=" }), main, settings, endpoint)).toBe(false);
    expect(shouldUseVisionAdvisor({ ...body(), tools: [{ type: "function", name: "srouter_vision_advisor", parameters: { type: "object" } }] }, main, settings, endpoint)).toBe(false);
  });

  it("runs one bounded tool round with native input items", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(toolReply())
      .mockResolvedValueOnce(messageReply("The image is blue."))
      .mockResolvedValueOnce(messageReply("It is blue."));
    const response = await runVisionAdvisor({ body: body(), modelStr: main, endpoint, advisorModels: [advisor], send });
    expect(response.ok).toBe(true);
    expect(await response.json()).toMatchObject({ object: "response" });

    const first = send.mock.calls[0][1];
    expect(first.stream).toBe(false);
    expect(first.tool_choice).toBe("auto");
    expect(first.tools.at(-1)).toMatchObject({ type: "function", name: "srouter_vision_advisor" });
    expect(first.input[0].content[0]).toEqual({ type: "input_text", text: "What is here?" });
    expect(first.input[0].content[1]).toEqual({
      type: "input_text", text: "[Image 1 attached; use srouter_vision_advisor to inspect it]",
    });

    const inspected = send.mock.calls[1][1];
    expect(send.mock.calls[1][0]).toBe(advisor);
    expect(inspected.instructions).toContain("untrusted");
    expect(inspected.input[0].content).toContainEqual(image);
    expect(inspected.input[0].content[0].text).toContain("What color?");

    const resumed = send.mock.calls[2][1];
    expect(resumed.input).toContainEqual({
      type: "function_call", call_id: "call_1", name: "srouter_vision_advisor", arguments: '{"question":"What color?"}',
    });
    expect(resumed.input.at(-1)).toEqual({
      type: "function_call_output", call_id: "call_1", output: "The image is blue.",
    });
    expect(resumed.input[0].content).not.toContainEqual(image);
    expect(body().input[0].content).toContainEqual(image);
  });

  it("serializes a no-tool reply as native Responses SSE", async () => {
    const send = vi.fn().mockResolvedValue(messageReply("No inspection needed."));
    const response = await runVisionAdvisor({ body: body(true), modelStr: main, endpoint, advisorModels: [advisor], send });
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain('"delta":"No inspection needed."');
    expect(text).toContain("event: response.completed");
    expect(text).not.toContain("[DONE]");
    expect(text).not.toContain("chat.completion.chunk");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("returns a client function call untouched instead of executing it", async () => {
    const clientCall = { type: "function_call", call_id: "client_1", name: "search", arguments: "{}" };
    const send = vi.fn().mockResolvedValue(responsesReply([clientCall]));
    const response = await runVisionAdvisor({ body: body(), modelStr: main, endpoint, advisorModels: [advisor], send });
    expect((await response.json()).output).toEqual([clientCall]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("refuses to mix the private tool with client tools, and falls back in order", async () => {
    const mixed = vi.fn().mockResolvedValue(responsesReply([
      { type: "function_call", call_id: "a", name: "srouter_vision_advisor", arguments: "{}" },
      { type: "function_call", call_id: "b", name: "search", arguments: "{}" },
    ]));
    expect((await runVisionAdvisor({ body: body(), modelStr: main, endpoint, advisorModels: [advisor], send: mixed })).status).toBe(502);
    expect(mixed).toHaveBeenCalledTimes(1);

    const send = vi.fn()
      .mockResolvedValueOnce(toolReply())
      .mockResolvedValueOnce(new Response("failed", { status: 503 }))
      .mockResolvedValueOnce(messageReply("Blue from backup."))
      .mockResolvedValueOnce(messageReply("Final."));
    expect((await runVisionAdvisor({ body: body(true), modelStr: main, endpoint, advisorModels: [advisor, backup], send })).ok).toBe(true);
    expect(send.mock.calls.map(([model]) => model)).toEqual([main, advisor, backup, main]);
    expect(send.mock.calls[3][1].stream).toBe(true);
    expect(send.mock.calls[3][1].input.at(-1).output).toBe("Blue from backup.");
  });

  it("stops on cancellation without calling another advisor", async () => {
    const controller = new AbortController();
    const send = vi.fn().mockResolvedValueOnce(toolReply()).mockImplementationOnce(() => {
      controller.abort();
      throw new Error("cancelled");
    });
    const response = await runVisionAdvisor({
      body: body(), modelStr: main, endpoint, advisorModels: [advisor, backup], send, signal: controller.signal,
    });
    expect(response.status).toBe(499);
    expect(send.mock.calls.map(([model]) => model)).toEqual([main, advisor]);
  });
});
