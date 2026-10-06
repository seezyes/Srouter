import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCursorModelCache,
  parseCursorUsableModels,
  resolveCursorModels,
} from "../../open-sse/services/cursorModels.js";

const transport = vi.hoisted(() => ({ payload: null, status: 200, connect: vi.fn(), request: vi.fn() }));
vi.mock("http2", async () => {
  const { EventEmitter } = await import("node:events");
  transport.connect.mockImplementation(() => {
    const client = new EventEmitter();
    client.close = vi.fn();
    client.request = transport.request.mockImplementation(() => {
      const request = new EventEmitter();
      request.end = () => queueMicrotask(() => {
        request.emit("response", { ":status": transport.status });
        request.emit("data", transport.payload);
        request.emit("end");
      });
      return request;
    });
    return client;
  });
  return { default: { connect: transport.connect } };
});

function varint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}

function field(fieldNumber, value) {
  return Uint8Array.from([(fieldNumber << 3) | 2, ...varint(value.length), ...value]);
}

function text(value) {
  return new TextEncoder().encode(value);
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function model(id, name) {
  return field(1, concat(field(1, text(id)), field(4, text(name))));
}

describe("Cursor live model catalog", () => {
  beforeEach(() => {
    clearCursorModelCache();
    transport.connect.mockClear();
    transport.request.mockClear();
    transport.status = 200;
  });

  afterEach(() => {
    clearCursorModelCache();
  });

  it("decodes the GetUsableModels protobuf response", () => {
    const payload = concat(
      model("default", "Auto"),
      model("gpt-5.3-codex", "GPT 5.3 Codex"),
      model("gpt-5.3-codex", "Duplicate"),
    );

    expect(parseCursorUsableModels(payload)).toEqual([
      { id: "default", name: "Auto" },
      { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    ]);
  });

  it("fetches the account-specific catalog and caches it", async () => {
    const payload = concat(model("claude-4.6-opus", "Claude 4.6 Opus"));
    transport.payload = payload;
    const credentials = {
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    };

    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });
    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });

    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(transport.connect).toHaveBeenCalledWith("https://agent.api5.cursor.sh");
    expect(transport.request).toHaveBeenCalledWith(
      expect.objectContaining({
        ":method": "POST",
        ":path": "/agent.v1.AgentService/GetUsableModels",
        "content-type": "application/proto",
        accept: "application/proto",
      }),
    );
  });

  it("fails open when the Cursor catalog request fails", async () => {
    transport.status = 403;
    transport.payload = Buffer.from("no");

    await expect(resolveCursorModels({
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    })).resolves.toBeNull();
  });
});
