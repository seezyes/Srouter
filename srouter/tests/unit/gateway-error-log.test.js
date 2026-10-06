import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";
import { classifyError, logGatewayError } from "../../open-sse/utils/errorLog.js";
import { buildErrorBody, createErrorResult } from "../../open-sse/utils/error.js";
import { GATEWAY_ERROR_LOG_MAX_BYTES } from "../../open-sse/config/errorConfig.js";

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("Gateway error diagnostics", () => {
  it.each([
    [{ status: 403, message: "forbidden", isPolicyError: true }, "POLICY"],
    [{ message: "tool-call failure" }, "TOOL_CALL"],
    [{ name: "TimeoutError" }, "TIMEOUT"],
    [{ message: "JSON parse" }, "PARSE"],
    [{ message: "unauthorized" }, "AUTH"],
    [{ message: "refresh token" }, "TOKEN"],
    [{ message: "stream repetition" }, "STREAM"],
    [{ status: 520 }, "PROVIDER"],
    [{ status: 520, message: "upstream unavailable" }, "PROVIDER"],
    [null, "UNKNOWN"],
  ])("classifies %j as %s", (error, expected) => expect(classifyError(error)).toBe(expected));

  it("writes only metadata under isolated DATA_DIR, without private error text or extra", () => {
    const append = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {});
    logGatewayError({
      class: "POLICY", provider: "fixture", model: "model", status: 400,
      connectionId: "connection", message: "private-prompt fixture-secret",
      extra: { Authorization: "fixture-secret" },
    });
    expect(append.mock.calls[0][0]).toBe(path.join(DATA_DIR, "logs", "gateway-errors.jsonl"));
    const row = JSON.parse(append.mock.calls[0][1]);
    expect(row).toMatchObject({ class: "POLICY", status: 400, connectionId: "connection" });
    expect(JSON.stringify(row)).not.toContain("fixture-secret");
    expect(JSON.stringify(console.error.mock.calls)).not.toContain("private-prompt");
    expect(row).not.toHaveProperty("extra");
  });

  it("rotates the JSONL file after the configured bound", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "statSync").mockReturnValue({ size: GATEWAY_ERROR_LOG_MAX_BYTES + 1 });
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => {});
    vi.spyOn(fs, "appendFileSync").mockImplementation(() => {});
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {});
    logGatewayError({ class: "PROVIDER", status: 520 });
    expect(rename).toHaveBeenCalledWith(
      path.join(DATA_DIR, "logs", "gateway-errors.jsonl"),
      path.join(DATA_DIR, "logs", "gateway-errors.jsonl.1"),
    );
  });

  it("does not throw when persistent logging is unavailable", () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => { throw new Error("read-only"); });
    expect(() => logGatewayError({ class: "PROVIDER", status: 502 })).not.toThrow();
  });

  it("keeps upstream headers and policy metadata independent", () => {
    const result = createErrorResult(400, "policy", undefined, { "x-request-id": "fixture" }, true);
    expect(result.isPolicyError).toBe(true);
    expect(result.response.headers.get("x-request-id")).toBe("fixture");
    expect(createErrorResult(502, "outage")).not.toHaveProperty("isPolicyError");
  });

  it.each([[520, "upstream_error"], [524, "upstream_timeout"]])("names edge status %s", (status, code) => {
    expect(buildErrorBody(status)).toMatchObject({ error: { type: "server_error", code } });
    expect(buildErrorBody(status).error.message).not.toBe("An error occurred");
  });
});
