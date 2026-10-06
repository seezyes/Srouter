import { afterEach, describe, expect, it, vi } from "vitest";
import muse from "../../src/lib/oauth/providers/muse.js";
import glm from "../../src/lib/oauth/providers/glm.js";
import { pollForToken } from "../../src/lib/oauth/providers/index.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });

describe("Muse subscription credential exchange", () => {
  it("mints the model credential without fabricating refresh/expiry", async () => {
    const fetch = vi.fn(async () => response({ api_key: "fixture-model-key", is_subs_active: true, user_email: "USER@EXAMPLE.COM" }));
    vi.stubGlobal("fetch", fetch);
    const extra = await muse.postExchange({ access_token: "fixture-control-token" });
    const creds = muse.mapTokens({ access_token: "fixture-control-token" }, extra);
    expect(creds).toMatchObject({ accessToken: "fixture-model-key", refreshToken: null, expiresIn: null, email: "user@example.com" });
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
    const headers = new DefaultExecutor("muse").buildHeaders(creds, true);
    expect(headers.Authorization).toBe("Bearer fixture-model-key");
    expect(headers["x-api-version"]).toBe("1.0.0");
  });
  it("parses malformed token response once without body reuse", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{", { status: 502 })));
    const result = await muse.pollToken(muse.config, "fixture-code");
    expect(result.data.error).toBe("invalid_response");
  });
  it("stops polling after a successful one-shot grant but failed key mint", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ access_token: "fixture-control-token" }))
      .mockResolvedValueOnce(response({ error: "fixture-control-token" }, 403)));
    const result = await pollForToken("muse", "fixture-code");
    expect(result).toMatchObject({ success: false, fatal: true, error: "exchange_failed" });
    expect(JSON.stringify(result)).not.toContain("fixture-control-token");
    expect(console.warn.mock.calls.flat().join("")).not.toContain("fixture-control-token");
  });
  it("bounds transient retries to three and never follows redirects", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(response({}, 429)).mockResolvedValueOnce(response({}, 503))
      .mockResolvedValueOnce(response({ api_key: "fixture-key" }));
    vi.stubGlobal("fetch", fetch);
    const pending = muse.postExchange({ access_token: "fixture-token" });
    await vi.advanceTimersByTimeAsync(15000);
    expect((await pending).key.api_key).toBe("fixture-key");
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
describe("GLM one-shot failures", () => {
  it("surfaces failed business exchange as fatal without leaking upstream text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ code: 0, data: { status: "ready", zai: { access_token: "fixture-secret" } } }))
      .mockResolvedValueOnce(response({ message: "fixture-secret" }, 500)));
    const result = await pollForToken("glm", "fixture-flow", null, { _zcodePollToken: "fixture-poll" });
    expect(result).toMatchObject({ success: false, fatal: true, error: "exchange_failed" });
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  });
});
