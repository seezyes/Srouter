import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// testUtils reaches for local DB helpers at import time — isolate the import
// behind a fresh temp DATA_DIR so no real srouter/9router data is touched.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-factory-validation-"));
process.env.DATA_DIR = tempDir;

let testApiKeyConnection;

beforeAll(async () => {
  ({ testApiKeyConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js"));
});

afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const BILLING_URL = "https://api.factory.ai/api/billing/limits";

function connection(apiKey = "fk_test") {
  return { provider: "factory", apiKey, authType: "apikey", providerSpecificData: {} };
}

function stubFetchResponse(response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("factory API-key validation", () => {
  it("accepts a key that the billing endpoint authorizes (200) without reading the body", async () => {
    const response = new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    let bodyRead = false;
    response.text = async () => { bodyRead = true; return "{}"; };
    response.json = async () => { bodyRead = true; return {}; };
    const fetchMock = stubFetchResponse(response);

    const result = await testApiKeyConnection(connection());

    expect(result).toEqual({ valid: true, error: null });
    expect(bodyRead).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(BILLING_URL);
    expect(opts.method).toBe("GET");
    expect(opts.headers.Authorization).toBe("Bearer fk_test");
    expect(opts.headers.Accept).toBe("application/json");
    expect(opts.headers["X-Factory-Client"]).toBe("cli");
    expect(opts.headers["X-Client-Version"]).toBe("0.228.0");
    expect(opts.headers["User-Agent"]).toBe("factory-cli/0.228.0");
  });

  it("rejects an unauthorized key (401/403) with the key-specific message", async () => {
    stubFetchResponse(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    expect(await testApiKeyConnection(connection("fk_bad"))).toEqual({ valid: false, error: "Invalid Factory API key" });

    stubFetchResponse(new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }));
    expect(await testApiKeyConnection(connection("fk_bad"))).toEqual({ valid: false, error: "Invalid Factory API key" });
  });

  it("reports unexpected billing failures with the status", async () => {
    stubFetchResponse(new Response("{}", { status: 500 }));
    expect(await testApiKeyConnection(connection())).toEqual({ valid: false, error: "Factory billing API error (500)" });
  });

  it("turns transport errors into an invalid result instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    expect(await testApiKeyConnection(connection())).toEqual({ valid: false, error: "network down" });
  });
});
