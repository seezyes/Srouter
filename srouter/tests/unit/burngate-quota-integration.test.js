import { readFileSync } from "node:fs";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { loadBindings, transform } from "next/dist/build/swc/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  connection: vi.fn(),
  update: vi.fn(),
}));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.connection,
  updateProviderConnection: mocks.update,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: async () => ({ connectionProxyEnabled: false }),
}));

import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { USAGE_SUPPORTED_PROVIDERS, USAGE_APIKEY_PROVIDERS } from "@/shared/constants/providers";
import { GET } from "@/app/api/usage/[connectionId]/route.js";
import * as quotaUtils from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { normalizeBurnGateUsage } from "../../open-sse/services/usage/burngate.js";

const usageBody = (unlimited = false) => ({
  used: { input: 20, output: 40 },
  limits: { dailyInput: unlimited ? null : 1000, dailyOutput: unlimited ? null : 2000 },
  remaining: { user_output: unlimited ? null : 1960, pool_output: 500, effective_output: 500 },
});

async function loadQuotaTable() {
  await loadBindings();
  const source = readFileSync(new URL("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaTable.js", import.meta.url), "utf8");
  const { code } = await transform(source, {
    filename: "QuotaTable.js",
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" },
  });
  const compiledModule = { exports: {} };
  const imports = { react: React, "react/jsx-runtime": jsxRuntime, "./utils": quotaUtils };
  new Function("module", "exports", "require", code)(compiledModule, compiledModule.exports, (id) => {
    if (!(id in imports)) throw new Error(`Unexpected import: ${id}`);
    return imports[id];
  });
  return compiledModule.exports.default;
}

describe("BurnGate quota integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetch.mockResolvedValue({
      ok: true, status: 200, json: async () => usageBody(),
    });
  });

  it("advertises usage and API-key eligibility through the registry", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("burngate");
    expect(USAGE_APIKEY_PROVIDERS).toContain("burngate");
  });

  it("dispatches through the real timeout helper to the registry usage URL", async () => {
    const proxy = { connectionProxyEnabled: false };
    const result = await getUsageForProvider({ provider: "burngate", apiKey: "fixture-key" }, proxy);
    expect(result.quotas["User daily input tokens"].total).toBe(1000);
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith("https://burngate.space/api/v1/usage", expect.objectContaining({
      method: "GET", headers: { Authorization: "Bearer fixture-key", Accept: "application/json" },
      signal: expect.any(AbortSignal),
    }), proxy);
  });

  it("aborts a stalled quota read after ten seconds without inference fallback", async () => {
    vi.useFakeTimers();
    try {
      mocks.fetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("fixture-key timeout")));
      }));
      const pending = getUsageForProvider({ provider: "burngate", apiKey: "fixture-key" });
      await vi.advanceTimersByTimeAsync(10000);
      expect(await pending).toEqual({ message: "Unable to read BurnGate usage. Try again later." });
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["apikey", "api_key"])("allows %s connections through the existing usage API without DB writes", async (authType) => {
    mocks.connection.mockResolvedValue({ id: "fixture", provider: "burngate", authType, apiKey: "fixture-key" });
    const response = await GET(new Request("http://localhost/api/usage/fixture"), { params: Promise.resolve({ connectionId: "fixture" }) });
    expect(response.status).toBe(200);
    expect((await response.json()).quotas).toBeDefined();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("keeps absolute token balances separate from UI percentages", () => {
    const rows = quotaUtils.parseQuotaData("burngate", normalizeBurnGateUsage(usageBody()));
    expect(quotaUtils.getRemainingPercentage(rows[0])).toBe(98);
    expect(quotaUtils.getRemainingPercentage(rows[1])).toBe(98);
    expect(rows[2]).toMatchObject({ name: "Effective output tokens", remainingTokens: 500 });
    expect(rows[2]).not.toHaveProperty("remaining");
  });

  it("renders finite pool headroom as tokens, never a fake percentage or unlimited", async () => {
    const Table = await loadQuotaTable();
    const rows = quotaUtils.parseQuotaData("burngate", normalizeBurnGateUsage(usageBody()));
    const html = renderToStaticMarkup(React.createElement(Table, { quotas: [rows[2]] }));
    expect(html).toContain("500 tokens remaining");
    expect(html).not.toContain("500%");
    expect(html).not.toContain("Unlimited");
    expect(html).not.toContain("0%");
  });

  it("renders explicit null user daily limits as unlimited with actual usage", async () => {
    const Table = await loadQuotaTable();
    const rows = quotaUtils.parseQuotaData("burngate", normalizeBurnGateUsage(usageBody(true)));
    const html = renderToStaticMarkup(React.createElement(Table, { quotas: rows }));
    expect(html).toContain("20 used");
    expect(html).toContain("40 used");
    expect(html).toContain("Unlimited");
    expect(html).toContain("100%");
    expect(html).toContain('width:100%');
    expect(html).toContain("bg-green-500");
    expect(html).not.toContain("text-red-600");
    expect(html).toContain("500 tokens remaining");
  });

  it("explicit unlimited overrides a stale zero percentage", () => {
    expect(quotaUtils.getRemainingPercentage({
      unlimited: true, used: 227, total: 0, remaining: 0, remainingPercentage: 0,
    })).toBe(100);
    expect(quotaUtils.getRemainingPercentage({
      unlimited: false, used: 0, total: 0, remainingPercentage: 0,
    })).toBe(0);
  });

  it("preserves zero effective output headroom", async () => {
    const data = usageBody();
    data.remaining.effective_output = 0;
    const rows = quotaUtils.parseQuotaData("burngate", normalizeBurnGateUsage(data));
    const html = renderToStaticMarkup(React.createElement(await loadQuotaTable(), { quotas: [rows[2]] }));
    expect(html).toContain("0 tokens remaining");
    expect(html).not.toContain("Unlimited");
  });

  it("leaves existing ordinary quota rows unchanged", async () => {
    const html = renderToStaticMarkup(React.createElement(await loadQuotaTable(), {
      quotas: [{ name: "Ordinary", used: 20, total: 100, resetAt: null }],
    }));
    expect(html).toContain("20 / 100");
    expect(html).toContain("80%");
    expect(html).not.toContain("tokens remaining");
  });
});
