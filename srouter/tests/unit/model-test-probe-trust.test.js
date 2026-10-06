// Trust boundary for dashboard model diagnostics:
// /api/models/test -> pingModelByKind -> loopback /api/v1/chat/completions may
// skip account-pool membership ONLY when the request carries the machine-bound
// CLI token plus the explicit internal probe marker. Everything else is rejected.
//
// The heavy Next.js deps of ping.js are mocked; isTrustedInternalProbe is
// exercised against the same mocked machine secret the probe sends.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({ getApiKeys: vi.fn(async () => [{ key: "test-key", isActive: true }]) }));
vi.mock("@/shared/constants/config", () => ({ UPDATER_CONFIG: { appPort: 20127 } }));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: vi.fn(async () => "a1b2c3d4e5f6a7b8") }));

const { pingModelByKind } = await import("../../src/app/api/models/test/ping.js");
const {
  isTrustedInternalProbe,
  INTERNAL_PROBE_HEADER,
  INTERNAL_PROBE_MODEL_TEST,
} = await import("../../src/lib/auth/internalProbe.js");

describe("pingModelByKind internal probe headers", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(obj) {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(obj),
      json: async () => obj,
    };
  }

  it("sends the probe marker together with the CLI token on the chat probe", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: "ok" } }] }));

    const result = await pingModelByKind("cx/gpt-6-luna", "llm", "http://127.0.0.1:20127");

    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:20127/api/v1/chat/completions");
    expect(init.headers["x-9r-cli-token"]).toBe("a1b2c3d4e5f6a7b8");
    expect(init.headers[INTERNAL_PROBE_HEADER]).toBe(INTERNAL_PROBE_MODEL_TEST);
  });
});

describe("isTrustedInternalProbe", () => {
  function probeRequest(headers) {
    return new Request("http://127.0.0.1:20127/api/v1/chat/completions", { method: "POST", headers });
  }

  it("accepts the CLI token + exact marker combination", async () => {
    expect(await isTrustedInternalProbe(probeRequest({
      [INTERNAL_PROBE_HEADER]: INTERNAL_PROBE_MODEL_TEST,
      "x-9r-cli-token": "a1b2c3d4e5f6a7b8",
    }))).toBe(true);
  });

  it("rejects marker without token, token without marker, wrong marker, wrong token and no request", async () => {
    expect(await isTrustedInternalProbe(probeRequest({
      [INTERNAL_PROBE_HEADER]: INTERNAL_PROBE_MODEL_TEST,
    }))).toBe(false);
    expect(await isTrustedInternalProbe(probeRequest({
      "x-9r-cli-token": "a1b2c3d4e5f6a7b8",
    }))).toBe(false);
    expect(await isTrustedInternalProbe(probeRequest({
      [INTERNAL_PROBE_HEADER]: "model-test-other",
      "x-9r-cli-token": "a1b2c3d4e5f6a7b8",
    }))).toBe(false);
    expect(await isTrustedInternalProbe(probeRequest({
      [INTERNAL_PROBE_HEADER]: INTERNAL_PROBE_MODEL_TEST,
      "x-9r-cli-token": "not-the-cli-token",
    }))).toBe(false);
    expect(await isTrustedInternalProbe(probeRequest({}))).toBe(false);
    expect(await isTrustedInternalProbe(null)).toBe(false);
  });
});
