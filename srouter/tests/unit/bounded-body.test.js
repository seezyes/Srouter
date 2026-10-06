import { describe, expect, it } from "vitest";
import { readBoundedJson, readBoundedText } from "../../src/sse/utils/boundedBody.js";

function jsonRequest(body, headers = {}) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST", body, headers,
  });
}

describe("bounded request bodies", () => {
  it("accepts valid JSON up to the byte limit", async () => {
    const result = await readBoundedJson(jsonRequest('{"ok":true}'), 11);
    expect(result).toMatchObject({ body: { ok: true }, bytes: 11 });
  });

  it("rejects announced oversize without pulling the stream", async () => {
    let pulls = 0;
    const body = new ReadableStream({ pull() { pulls++; } });
    const request = new Request("http://localhost/v1", {
      method: "POST", body, duplex: "half", headers: { "content-length": "200" },
    });
    const result = await readBoundedJson(request, 10);
    expect(result.error.status).toBe(413);
    expect(pulls).toBeLessThan(2);
    await body.cancel();
  });

  it("cancels an unannounced stream as soon as it exceeds the byte limit", async () => {
    let pulls = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(new TextEncoder().encode("abcdef"));
      },
    });
    const request = new Request("http://localhost/v1", { method: "POST", body, duplex: "half" });
    expect((await readBoundedJson(request, 10)).error.status).toBe(413);
    expect(pulls).toBeLessThan(5);
  });

  it("counts UTF-8 bytes and preserves raw JSON for forwarding", async () => {
    const raw = '{"text":"é"}';
    expect((await readBoundedJson(jsonRequest(raw), raw.length)).error.status).toBe(413);
    expect((await readBoundedText(jsonRequest(raw), Buffer.byteLength(raw))).raw).toBe(raw);
  });

  it("returns 400 for malformed or unreadable JSON", async () => {
    expect((await readBoundedJson(jsonRequest("{"), 10)).error.status).toBe(400);
    const stream = new ReadableStream({ start(controller) { controller.error(new Error("broken")); } });
    const request = new Request("http://localhost/v1", { method: "POST", body: stream, duplex: "half" });
    expect((await readBoundedJson(request, 10)).error.status).toBe(400);
  });
});
