import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/services/usage/shared.js", () => ({
  U: () => ({ url: "https://burngate.space/api/v1/usage" }),
  fetchWithTimeout: fetchMock,
}));

import { getBurnGateUsage, normalizeBurnGateUsage } from "../../open-sse/services/usage/burngate.js";

const finiteUsage = () => ({
  identity: { key: "do-not-return", email: "do-not-return" },
  day: "2026-10-01",
  used: { input: 200, output: 300 },
  limits: { dailyInput: 1000, dailyOutput: 2000, effectiveRpm: 300 },
  remaining: { user_output: 1700, pool_output: 500, effective_output: 500 },
});

describe("BurnGate usage normalization", () => {
  it("maps real user daily quotas without inventing pool totals or reset times", () => {
    const result = normalizeBurnGateUsage(finiteUsage());
    expect(result.quotas["User daily input tokens"]).toEqual({
      used: 200, total: 1000, remaining: 800, remainingPercentage: 80,
      unlimited: false, resetAt: null,
    });
    expect(result.quotas["User daily output tokens"]).toMatchObject({
      used: 300, total: 2000, remaining: 1700, remainingPercentage: 85,
    });
    expect(result.remaining).toEqual({ poolOutput: 500, effectiveOutput: 500 });
    expect(JSON.stringify(result)).not.toContain("do-not-return");
    expect(result.quotas).not.toHaveProperty("RPM");
  });

  it("maps explicit null daily limits to unlimited, preserving consumption", () => {
    const data = finiteUsage();
    data.limits.dailyInput = null;
    data.limits.dailyOutput = null;
    data.remaining = { user_output: null, pool_output: null, effective_output: null };
    const result = normalizeBurnGateUsage(data);
    expect(Object.values(result.quotas)).toEqual([
      { used: 200, total: 0, unlimited: true, remainingPercentage: 100, resetAt: null },
      { used: 300, total: 0, unlimited: true, remainingPercentage: 100, resetAt: null },
    ]);
    expect(result.remaining).toEqual({ poolOutput: null, effectiveOutput: null });
  });

  it("does not confuse unlimited user allowance with finite shared pool headroom", () => {
    const data = finiteUsage();
    data.limits.dailyOutput = null;
    expect(normalizeBurnGateUsage(data).remaining.effectiveOutput).toBe(500);
    expect(normalizeBurnGateUsage(data).quotas["User daily output tokens"].unlimited).toBe(true);
  });

  it("preserves zero limits and exhausted quotas", () => {
    const data = finiteUsage();
    data.limits.dailyInput = 0;
    data.remaining.user_output = 0;
    const result = normalizeBurnGateUsage(data);
    expect(result.quotas["User daily input tokens"]).toMatchObject({ total: 0, unlimited: false, remainingPercentage: 0 });
    expect(result.quotas["User daily output tokens"]).toMatchObject({ remaining: 0, remainingPercentage: 0 });
  });

  it("accepts numeric strings and derives remaining when absent", () => {
    const data = finiteUsage();
    data.limits.dailyOutput = "2000";
    data.used.output = "300";
    delete data.remaining.user_output;
    expect(normalizeBurnGateUsage(data).quotas["User daily output tokens"].remaining).toBe(1700);
  });

  it.each([null, {}, { limits: {} }, {
    limits: { dailyOutput: null }, used: { input: 0, output: 0 },
  }, {
    limits: { dailyInput: -1, dailyOutput: 100 }, used: { input: 0, output: 0 },
  }, {
    limits: { dailyInput: null, dailyOutput: null }, used: { input: false, output: 0 },
  }])("rejects unsupported/incomplete responses, not a fabricated healthy quota: %j", (data) => {
    expect(normalizeBurnGateUsage(data)).toEqual({ message: "BurnGate returned an unsupported usage response." });
  });
});

describe("BurnGate read-only usage request", () => {
  beforeEach(() => { fetchMock.mockReset(); });

  it("uses exactly one authenticated GET through the timeout/proxy helper", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => finiteUsage() });
    const proxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.invalid" };
    expect((await getBurnGateUsage(" fixture-key ", proxy)).quotas).toBeDefined();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("https://burngate.space/api/v1/usage", {
      method: "GET",
      headers: { Authorization: "Bearer fixture-key", Accept: "application/json" },
      cache: "no-store", redirect: "error",
    }, 10000, proxy);
  });

  it.each([undefined, null, "", "   "])("does not fetch without a key: %j", async (key) => {
    expect((await getBurnGateUsage(key)).message).toContain("key not available");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 404, 500])("handles HTTP %i without retry or inference", async (status) => {
    fetchMock.mockResolvedValue({ ok: false, status, json: vi.fn() });
    const result = await getBurnGateUsage("fixture-key");
    expect(result.message).toContain(status === 401 || status === 403 ? "authentication" : status === 429 ? "rate limit" : `${status}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not expose a network error containing the key", async () => {
    fetchMock.mockImplementation(async () => { throw new Error("fixture-key secret"); });
    expect(await getBurnGateUsage("fixture-key")).toEqual({ message: "Unable to read BurnGate usage. Try again later." });
  });

  it("handles non-JSON responses safely", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error("bad JSON"); } });
    expect((await getBurnGateUsage("fixture-key")).message).toContain("Unable to read");
  });
});
