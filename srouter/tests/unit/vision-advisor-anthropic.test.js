import { describe, expect, it, vi } from "vitest";
import { runVisionAdvisor, shouldUseVisionAdvisor } from "../../src/sse/services/visionAdvisor.js";

const main = "cmc/deepseek/deepseek-v4-pro";
const advisor = "openai/gpt-4o";
const settings = { visionAdvisor: { enabled: true, models: [advisor] } };
const endpoint = "/api/v1/messages";
const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } };
const body = {
  model: main, max_tokens: 4096, system: [{ type: "text", text: "Original system", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "What color?" }, image] }],
};
const tool = { type: "tool_use", id: "private_1", name: "srouter_vision_advisor", input: { question: "Color?" } };
const thinking = { type: "thinking", thinking: "Consider it", signature: "signed" };
const reply = (content, stop_reason = "end_turn") => Response.json({
  id: "msg_1", type: "message", role: "assistant", model: main,
  content, stop_reason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 },
});
const run = (send, overrides = {}) => runVisionAdvisor({ body, endpoint, modelStr: main, advisorModels: [advisor], send, ...overrides });

describe("Anthropic Vision Advisor", () => {
  it("accepts native base64/URL images, but not unsupported sources or forced tools", () => {
    expect(shouldUseVisionAdvisor(body, main, settings, endpoint)).toBe(true);
    const withImage = (block) => ({ ...body, messages: [{ role: "user", content: [block] }] });
    expect(shouldUseVisionAdvisor(withImage({ type: "image", source: { type: "url", url: "https://example.com/image.png" } }), main, settings, endpoint)).toBe(true);
    expect(shouldUseVisionAdvisor(withImage({ type: "image", source: { type: "file", file_id: "file_1" } }), main, settings, endpoint)).toBe(false);
    expect(shouldUseVisionAdvisor({ ...body, tool_choice: { type: "any" } }, main, settings, endpoint)).toBe(false);
    expect(shouldUseVisionAdvisor({ ...body, tools: [{ name: tool.name }] }, main, settings, endpoint)).toBe(false);
    expect(shouldUseVisionAdvisor(body, advisor, settings, endpoint)).toBe(false);
    expect(shouldUseVisionAdvisor(body, main, settings, "/v1/responses")).toBe(false);
  });

  it("preserves native system/history, sends native images, resumes original streaming format", async () => {
    const history = [
      { role: "assistant", content: [thinking, { type: "tool_use", id: "old", name: "search", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "old", content: "found", is_error: false }] },
    ];
    const request = { ...body, stream: true, messages: [...history, ...body.messages], tools: [{ name: "search", input_schema: { type: "object" } }] };
    const final = new Response("event: message_stop\n\n", { headers: { "Content-Type": "text/event-stream" } });
    const send = vi.fn().mockResolvedValueOnce(reply([thinking, tool], "tool_use"))
      .mockResolvedValueOnce(reply([{ type: "text", text: "Blue." }]))
      .mockResolvedValueOnce(final);
    expect(await run(send, { body: request })).toBe(final);
    const first = send.mock.calls[0][1];
    expect(first.system).toEqual(body.system);
    expect(first.messages.slice(0, 2)).toEqual(history);
    expect(first.messages.at(-1).content).not.toContainEqual(image);
    expect(first.tools.at(-1).input_schema).toBeDefined();
    expect(first.tools[0]).toEqual(request.tools[0]);
    expect(first.tool_choice).toEqual({ type: "auto" });
    const inspected = send.mock.calls[1][1];
    expect(inspected.messages[0].content).toContainEqual(image);
    expect(inspected.max_tokens).toBeGreaterThan(0);
    expect(inspected.system).toContain("untrusted");
    const resumed = send.mock.calls[2][1];
    expect(resumed.stream).toBe(true);
    expect(resumed.messages.at(-2).content).toEqual([thinking, tool]);
    expect(resumed.messages.at(-1)).toEqual({
      role: "user", content: [{ type: "tool_result", tool_use_id: "private_1", content: "Blue." }],
    });
    expect(body.messages[0].content).toContainEqual(image);
  });

  it("serializes no-advisor replies into native SSE, including client tools and signed thinking", async () => {
    const clientTool = { ...tool, name: "search", input: { query: "blue" } };
    const send = vi.fn().mockResolvedValue(reply([thinking, { type: "text", text: "Hello" }, clientTool], "tool_use"));
    const response = await run(send, { body: { ...body, stream: true } });
    const text = await response.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: message_stop");
    expect(text).toContain('"type":"signature_delta","signature":"signed"');
    expect(text).toContain('"type":"input_json_delta"');
    expect(text).toContain('"stop_reason":"tool_use"');
    expect(text).not.toContain("[DONE]");
    expect(text).not.toContain("srouter_vision_advisor");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("falls back in order after empty/failed advisors and never executes client tools", async () => {
    const send = vi.fn().mockResolvedValueOnce(reply([tool], "tool_use"))
      .mockResolvedValueOnce(reply([]))
      .mockResolvedValueOnce(reply([{ type: "text", text: "Observation" }]))
      .mockResolvedValueOnce(reply([{ type: "text", text: "Answer" }]));
    expect((await run(send, { advisorModels: [advisor, "cmc/moonshotai/Kimi-K3"] })).ok).toBe(true);
    expect(send.mock.calls.map(([model]) => model)).toEqual([main, advisor, "cmc/moonshotai/Kimi-K3", main]);
    const mixed = vi.fn().mockResolvedValue(reply([tool, { ...tool, id: "client", name: "search" }]));
    expect((await run(mixed)).status).toBe(502);
    expect(mixed).toHaveBeenCalledTimes(1);
  });

  it("skips nested tool-result images instead of leaking them to the blind model", () => {
    const nested = { ...body, messages: [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "old", content: [image] }] },
      ...body.messages,
    ] };
    expect(shouldUseVisionAdvisor(nested, main, settings, endpoint)).toBe(false);
  });

  it("returns native JSON unchanged when no private tool is used", async () => {
    const send = vi.fn().mockResolvedValue(reply([{ type: "text", text: "Answer" }]));
    const result = await (await run(send)).json();
    expect(result.type).toBe("message");
    expect(result.content).toEqual([{ type: "text", text: "Answer" }]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("returns an Anthropic error envelope for malformed main responses", async () => {
    const send = vi.fn().mockResolvedValue(Response.json({ content: "invalid" }));
    const response = await run(send);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ type: "error", error: { type: "api_error" } });
  });

  it("stops on cancellation without calling another advisor", async () => {
    const controller = new AbortController();
    const send = vi.fn().mockResolvedValueOnce(reply([tool], "tool_use"))
      .mockImplementationOnce(() => { controller.abort(); throw new Error("cancelled"); });
    const response = await run(send, { signal: controller.signal, advisorModels: [advisor, "cmc/moonshotai/Kimi-K3"] });
    expect(response.status).toBe(499);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
