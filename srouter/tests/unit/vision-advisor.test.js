import { describe, expect, it, vi } from "vitest";
import { advisorCanHandleImages, getVisionAdvisorModels, runVisionAdvisor, shouldUseVisionAdvisor } from "../../src/sse/services/visionAdvisor.js";

const main = "cmc/deepseek/deepseek-v4-pro";
const advisor = "cmc/moonshotai/Kimi-K3";
const settings = { visionAdvisor: { enabled: true, model: advisor } };
const image = { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } };
const body = (stream = false) => ({
  model: main, stream,
  messages: [{ role: "user", content: [{ type: "text", text: "What is here?" }, image] }],
});
const endpoint = "/api/v1/chat/completions";
const reply = (message) => Response.json({
  id: "test", created: 1, model: main,
  choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
});
const toolReply = () => reply({ content: null, tool_calls: [{
  id: "call_1", type: "function", function: { name: "srouter_vision_advisor", arguments: '{"question":"What color?"}' },
}] });
const backup = "openai/gpt-4o";

describe("Vision Advisor", () => {
  it("offers the tool only for image requests to non-vision models", () => {
    expect(shouldUseVisionAdvisor(body(), main, settings, endpoint)).toBe(true);
    expect(shouldUseVisionAdvisor(body(), advisor, settings, endpoint)).toBe(false);
    expect(shouldUseVisionAdvisor(body(), main, settings, "/v1/messages")).toBe(false);
    expect(shouldUseVisionAdvisor({ ...body(), tool_choice: "none" }, main, settings, endpoint)).toBe(false);
    expect(shouldUseVisionAdvisor({ ...body(), messages: [{ role: "user", images: ["raw"], content: "hi" }] }, main, settings, endpoint)).toBe(false);
    expect(shouldUseVisionAdvisor(body(), main, { visionAdvisor: { enabled: true, model: main } }, endpoint)).toBe(false);
    expect(shouldUseVisionAdvisor({ messages: [{ role: "user", content: "hi" }] }, main, settings, endpoint)).toBe(false);
    expect(advisorCanHandleImages(body(), settings, endpoint)).toBe(true);
    expect(advisorCanHandleImages(body(), { visionAdvisor: { enabled: false, model: advisor } }, endpoint)).toBe(false);
  });

  it("strips images from the main model, calls advisor, and resumes with a tool result", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(reply({ content: null, tool_calls: [{
        id: "call_1", type: "function", function: { name: "srouter_vision_advisor", arguments: '{"question":"What color?"}' },
      }] }))
      .mockResolvedValueOnce(reply({ content: "The image is blue." }))
      .mockResolvedValueOnce(reply({ content: "It is blue." }));

    const response = await runVisionAdvisor({ body: body(), modelStr: main, advisorModel: advisor, send });
    expect(response.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
    const [firstModel, firstBody] = send.mock.calls[0];
    expect(firstModel).toBe(main);
    expect(firstBody.stream).toBe(false);
    expect(firstBody.messages[0].content).not.toContainEqual(image);
    expect(firstBody.tools.at(-1).function.name).toBe("srouter_vision_advisor");
    expect(send.mock.calls[1][0]).toBe(advisor);
    expect(send.mock.calls[1][1].messages[1].content).toContainEqual(image);
    expect(send.mock.calls[2][1].messages.at(-1)).toEqual({
      role: "tool", tool_call_id: "call_1", content: "The image is blue.",
    });
    expect(send.mock.calls[2][1].messages[0].content).not.toContainEqual(image);
  });

  it("returns a streamed answer without an extra call when the tool is not used", async () => {
    const send = vi.fn().mockResolvedValue(reply({ role: "assistant", content: "No inspection needed." }));
    const response = await runVisionAdvisor({ body: body(true), modelStr: main, advisorModel: advisor, send });
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(await response.text()).toContain("data: [DONE]");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("preserves client tool calls instead of executing them", async () => {
    const clientCall = { id: "client_1", function: { name: "search", arguments: "{}" } };
    const send = vi.fn().mockResolvedValue(reply({ content: null, tool_calls: [clientCall] }));
    const response = await runVisionAdvisor({
      body: { ...body(), tools: [{ type: "function", function: { name: "search", parameters: { type: "object" } } }] },
      modelStr: main, advisorModel: advisor, send,
    });
    expect((await response.json()).choices[0].message.tool_calls).toEqual([clientCall]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1].tools).toHaveLength(2);
  });

  it("does not repeat a failed single advisor or fabricate an observation", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(reply({ tool_calls: [{
        id: "call_1", function: { name: "srouter_vision_advisor", arguments: "{}" },
      }] }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    const response = await runVisionAdvisor({ body: body(), modelStr: main, advisorModel: advisor, send });
    expect(response.status).toBe(502);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("uses only a model override, resolving provider aliases and ignoring the global chain", () => {
    const config = { visionAdvisor: {
      enabled: true, models: [advisor], overrides: { [main]: [backup] },
    } };
    expect(getVisionAdvisorModels(config, main)).toEqual([backup]);
    expect(getVisionAdvisorModels(config, "commandcode/deepseek/deepseek-v4-pro")).toEqual([backup]);
    expect(getVisionAdvisorModels(config, "other/model")).toEqual([advisor]);
    expect(shouldUseVisionAdvisor(body(), main, config, endpoint)).toBe(true);
    expect(shouldUseVisionAdvisor(body(), backup, config, endpoint)).toBe(false);
  });

  it("supports override-only configuration and an explicit empty override", () => {
    const config = { visionAdvisor: { enabled: true, models: [], overrides: { [main]: [advisor] } } };
    expect(advisorCanHandleImages(body(), config, endpoint)).toBe(true);
    expect(shouldUseVisionAdvisor(body(), main, config, endpoint)).toBe(true);
    config.visionAdvisor.models = [advisor];
    config.visionAdvisor.overrides[main] = [];
    expect(getVisionAdvisorModels(config, main)).toEqual([]);
    expect(shouldUseVisionAdvisor(body(), main, config, endpoint)).toBe(false);
    delete config.visionAdvisor.overrides[main];
    expect(getVisionAdvisorModels(config, main)).toEqual([advisor]);
    config.visionAdvisor.enabled = false;
    expect(getVisionAdvisorModels(config, main)).toEqual([]);
  });

  it("skips non-vision advisors without falling back to the global override", () => {
    const config = { visionAdvisor: { enabled: true, models: [advisor], overrides: { [main]: [main, backup] } } };
    expect(getVisionAdvisorModels(config, main)).toEqual([backup]);
    config.visionAdvisor.overrides[main] = [main];
    expect(getVisionAdvisorModels(config, main)).toEqual([]);
    expect(shouldUseVisionAdvisor(body(), main, { visionAdvisor: { enabled: true } }, endpoint)).toBe(false);
  });

  it.each([401, 403, 429, 503])("tries the next advisor after HTTP %s, then resumes the original model", async (status) => {
    const send = vi.fn()
      .mockResolvedValueOnce(toolReply())
      .mockResolvedValueOnce(new Response("failed", { status }))
      .mockResolvedValueOnce(reply({ content: "Blue from backup." }))
      .mockResolvedValueOnce(reply({ content: "Final." }));
    const response = await runVisionAdvisor({ body: body(true), modelStr: main, advisorModels: [advisor, backup], send });
    expect(response.ok).toBe(true);
    expect(send.mock.calls.map(([model]) => model)).toEqual([main, advisor, backup, main]);
    expect(send.mock.calls[2][1].messages[1].content).toContainEqual(image);
    expect(send.mock.calls[3][1].stream).toBe(true);
    expect(send.mock.calls[3][1].messages.at(-1).content).toBe("Blue from backup.");
    expect(body().messages[0].content).toContainEqual(image);
  });

  it.each(["throw", "invalid-json", "empty", "null"])("tries backup after an advisor's %s response", async (kind) => {
    const send = vi.fn().mockResolvedValueOnce(toolReply());
    if (kind === "throw") send.mockRejectedValueOnce(new Error("network"));
    else if (kind === "invalid-json") send.mockResolvedValueOnce(new Response("not-json"));
    else send.mockResolvedValueOnce(reply({ content: kind === "empty" ? "  " : null }));
    send.mockResolvedValueOnce(reply({ content: "Observation." })).mockResolvedValueOnce(reply({ content: "Answer." }));
    expect((await runVisionAdvisor({ body: body(), modelStr: main, advisorModels: [advisor, backup], send })).ok).toBe(true);
    expect(send.mock.calls.map(([model]) => model)).toEqual([main, advisor, backup, main]);
  });

  it("stops after the first successful advisor", async () => {
    const send = vi.fn().mockResolvedValueOnce(toolReply())
      .mockResolvedValueOnce(reply({ content: "Observation." }))
      .mockResolvedValueOnce(reply({ content: "Answer." }));
    await runVisionAdvisor({ body: body(), modelStr: main, advisorModels: [advisor, backup], send });
    expect(send.mock.calls.map(([model]) => model)).toEqual([main, advisor, main]);
  });

  it("returns 502 only after exhausting the unique chain, without resuming the main model", async () => {
    const send = vi.fn().mockResolvedValueOnce(toolReply())
      .mockResolvedValueOnce(new Response("failed", { status: 503 }))
      .mockResolvedValueOnce(reply({ content: "" }));
    const response = await runVisionAdvisor({
      body: body(), modelStr: main, advisorModels: [advisor, advisor, backup], send,
    });
    expect(response.status).toBe(502);
    expect((await response.json()).error.type).toBe("vision_advisor_error");
    expect(send.mock.calls.map(([model]) => model)).toEqual([main, advisor, backup]);
  });

  it("never tries a fallback after cancellation", async () => {
    const controller = new AbortController();
    const send = vi.fn().mockResolvedValueOnce(toolReply()).mockImplementationOnce(() => {
      controller.abort();
      throw new Error("aborted");
    });
    const response = await runVisionAdvisor({
      body: body(), modelStr: main, advisorModels: [advisor, backup], send, signal: controller.signal,
    });
    expect(response.status).toBe(499);
    expect(send.mock.calls.map(([model]) => model)).toEqual([main, advisor]);
  });

  it("makes no requests when already cancelled", async () => {
    const send = vi.fn();
    const response = await runVisionAdvisor({
      body: body(), modelStr: main, advisorModels: [advisor], send, signal: AbortSignal.abort(),
    });
    expect(response.status).toBe(499);
    expect(send).not.toHaveBeenCalled();
  });
});
