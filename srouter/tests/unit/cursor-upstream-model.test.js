import { describe, expect, it, vi } from "vitest";
import { buildAgentRunFrame, CursorExecutor, resolveCursorUpstreamModel } from "../../open-sse/executors/cursor.js";
import { CURSOR_DEFAULT_UPSTREAM_MODEL } from "../../open-sse/config/cursorConfig.js";
import { decodeMessage } from "../../open-sse/utils/cursorProtobuf.js";

describe("Cursor upstream model compatibility", () => {
  it.each([
    ["cu/default", CURSOR_DEFAULT_UPSTREAM_MODEL],
    ["auto", CURSOR_DEFAULT_UPSTREAM_MODEL],
    ["cursor/claude-3-5-sonnet-20241022", "claude-4.5-sonnet"],
    ["claude-3-5-haiku", "claude-4.5-haiku"],
    ["gpt-4o", "gpt-5.2"],
    ["gpt-4o-mini", "gpt-5.2"],
    ["composer-2", "composer-2"],
    ["gpt-5.2", "gpt-5.2"],
  ])("resolves %s to %s", (model, expected) => {
    expect(resolveCursorUpstreamModel(model)).toBe(expected);
  });

  it("encodes the resolved model in both AgentService model fields", () => {
    const frame = buildAgentRunFrame([{ role: "user", content: "fixture" }], "cu/default");
    const run = decodeMessage(decodeMessage(frame.subarray(5)).get(1)[0].value);
    for (const field of [3, 9]) {
      const model = decodeMessage(run.get(field)[0].value);
      expect(Buffer.from(model.get(1)[0].value).toString()).toBe(CURSOR_DEFAULT_UPSTREAM_MODEL);
    }
  });

  it("preserves the requested model in a completed agent response", async () => {
    const executor = new CursorExecutor();
    const write = vi.fn();
    executor.openAgentHttp2Stream = () => ({
      responseHeaders: Promise.resolve({ ":status": 200 }),
      write, end() {}, close() {},
      read: async () => ({ done: true }),
    });
    const result = await executor.execute({
      model: "auto", body: { messages: [{ role: "user", content: "fixture" }] },
      stream: false, credentials: { accessToken: "fixture", providerSpecificData: { machineId: "a".repeat(64) } },
    });
    expect((await result.response.json()).model).toBe("auto");
    const frame = Buffer.from(write.mock.calls[0][0]);
    const run = decodeMessage(decodeMessage(frame.subarray(5)).get(1)[0].value);
    const requested = decodeMessage(run.get(9)[0].value);
    expect(Buffer.from(requested.get(1)[0].value).toString()).toBe(CURSOR_DEFAULT_UPSTREAM_MODEL);
  });

  it("resolves legacy models on the image-capable ChatService path", () => {
    const executor = new CursorExecutor();
    const frame = Buffer.from(executor.transformRequest("cu/gpt-4o", {
      messages: [{ role: "user", content: "fixture" }],
    }, false, {}));
    expect(frame.includes(Buffer.from("gpt-5.2"))).toBe(true);
    expect(frame.includes(Buffer.from("gpt-4o"))).toBe(false);
  });
});
