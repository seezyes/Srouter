import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { parseFactoryLimitsPayload } from "../../open-sse/services/usage/factory.js";
import {
  USAGE_SUPPORTED_PROVIDERS,
  USAGE_APIKEY_PROVIDERS,
} from "../../src/shared/constants/providers.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const BILLING_URL = "https://api.factory.ai/api/billing/limits";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();
const PAST = () => new Date(Date.now() - 3_600_000).toISOString();

function limitsPayload(overrides = {}) {
  return {
    limits: {
      standard: {
        fiveHour: { usedPercent: 1, windowEnd: FUTURE(), secondsRemaining: 3600 },
        weekly: { usedPercent: 49, windowEnd: FUTURE(), secondsRemaining: 86_400 },
        monthly: { usedPercent: 88, windowEnd: PAST(), secondsRemaining: 0 },
      },
      core: {
        fiveHour: { usedPercent: 0, windowEnd: null, secondsRemaining: 0 },
        weekly: { usedPercent: 0, windowEnd: FUTURE(), secondsRemaining: 86_400 },
        monthly: { usedPercent: 51, windowEnd: PAST(), secondsRemaining: 0 },
      },
    },
    extraUsageBalanceCents: 0,
    ...overrides,
  };
}

describe("factory registry usage flags", () => {
  it("is listed for the apikey quota dashboard", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("factory");
    expect(USAGE_APIKEY_PROVIDERS).toContain("factory");
  });
});

describe("getUsageForProvider(factory)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a message when apiKey is missing", async () => {
    const usage = await getUsageForProvider({ provider: "factory" });
    expect(usage.message).toMatch(/api key/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("GETs billing/limits with the Factory client headers", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(limitsPayload()));
    const usage = await getUsageForProvider({ provider: "factory", apiKey: "fk_test" });

    expect(usage.message).toBeUndefined();
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = proxyAwareFetch.mock.calls[0];
    expect(String(url)).toBe(BILLING_URL);
    expect(opts.method).toBe("GET");
    expect(opts.headers.Authorization).toBe("Bearer fk_test");
    expect(opts.headers["X-Factory-Client"]).toBe("cli");
    expect(opts.headers["X-Client-Version"]).toBe("0.228.0");
    expect(opts.headers["User-Agent"]).toMatch(/^factory-cli\//);
  });

  it("maps active windows, lazily resets expired/null windows and never counts them as used", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(limitsPayload()));
    const usage = await getUsageForProvider({ provider: "factory", apiKey: "fk_test" });

    expect(usage.plan).toBe("Factory");
    expect(usage.quotas["Standard 5h"]).toMatchObject({
      used: 1,
      total: 100,
      remaining: 99,
      remainingPercentage: 99,
      unlimited: false,
    });
    expect(new Date(usage.quotas["Standard 5h"].resetAt).getTime()).toBeGreaterThan(Date.now());
    expect(usage.quotas["Standard Weekly"]).toMatchObject({ used: 49, remaining: 51 });
    expect(usage.quotas["Core Weekly"]).toMatchObject({ used: 0, remaining: 100 });
    // Expired and null windowEnd → 0% used, no reset countdown.
    expect(usage.quotas["Standard Monthly"]).toMatchObject({ used: 0, resetAt: null });
    expect(usage.quotas["Core Monthly"]).toMatchObject({ used: 0, resetAt: null });
    expect(usage.quotas["Core 5h"]).toMatchObject({ used: 0, resetAt: null });
    expect(usage.quotas["Extra usage balance"]).toBeUndefined();
  });

  it("clamps malformed percentages into 0..100", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      limits: {
        standard: {
          fiveHour: { usedPercent: 150, windowEnd: FUTURE() },
          weekly: { usedPercent: -5, windowEnd: FUTURE() },
        },
      },
    }));
    const usage = await getUsageForProvider({ provider: "factory", apiKey: "fk_test" });

    expect(usage.quotas["Standard 5h"].used).toBe(100);
    expect(usage.quotas["Standard 5h"].remainingPercentage).toBe(0);
    expect(usage.quotas["Standard Weekly"].used).toBe(0);
  });

  it("accepts numeric strings and rejects malformed percentages (unknown, not exhausted)", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      limits: {
        standard: {
          fiveHour: { usedPercent: "42", windowEnd: FUTURE() },
          weekly: { usedPercent: "not-a-number", windowEnd: FUTURE() },
        },
      },
    }));
    const usage = await getUsageForProvider({ provider: "factory", apiKey: "fk_test" });

    expect(usage.quotas["Standard 5h"].used).toBe(42);
    expect(usage.quotas["Standard Weekly"]).toBeUndefined();
  });

  it("returns a message when no window has valid data", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ limits: { standard: { weekly: { usedPercent: "x" } } } }));
    const usage = await getUsageForProvider({ provider: "factory", apiKey: "fk_test" });
    expect(usage.quotas).toBeUndefined();
    expect(usage.message).toMatch(/valid quota data/i);
  });

  it("returns a message when the payload has no limits object", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ usesTokenRateLimitsBilling: false }));
    const usage = await getUsageForProvider({ provider: "factory", apiKey: "fk_test" });
    expect(usage.message).toMatch(/quota windows/i);
  });

  it("returns a message on non-JSON payloads", async () => {
    proxyAwareFetch.mockResolvedValueOnce(new Response("<html>nope</html>", { status: 200 }));
    const usage = await getUsageForProvider({ provider: "factory", apiKey: "fk_test" });
    expect(usage.message).toMatch(/not valid JSON/i);
  });

  it("returns an auth message on 401/403", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));
    const usage = await getUsageForProvider({ provider: "factory", apiKey: "bad" });
    expect(usage.message).toMatch(/authentication failed/i);

    vi.clearAllMocks();
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ error: "forbidden" }, 403));
    const usage403 = await getUsageForProvider({ provider: "factory", apiKey: "bad" });
    expect(usage403.message).toMatch(/authentication failed/i);
  });

  it("reports other HTTP failures with the status", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({}, 500));
    const usage = await getUsageForProvider({ provider: "factory", apiKey: "fk_test" });
    expect(usage.message).toBe("Factory billing API error (500).");
  });

  it("keeps transport failures unknown without echoing sensitive error details", async () => {
    proxyAwareFetch.mockRejectedValueOnce(new Error("request credential fk_private_fixture"));
    const usage = await getUsageForProvider({ provider: "factory", apiKey: "fk_test" });
    expect(usage.quotas).toBeUndefined();
    expect(usage.message).toBe("Factory billing request failed.");
    expect(usage.message).not.toContain("fk_private_fixture");
  });

  it("surfaces the extra usage balance as a credit row only when positive", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(limitsPayload({ extraUsageBalanceCents: 350 })));
    const usage = await getUsageForProvider({ provider: "factory", apiKey: "fk_test" });
    expect(usage.quotas["Extra usage balance"]).toMatchObject({
      used: 0,
      total: 3.5,
      isCreditBalance: true,
      currency: "USD",
      resetAt: null,
    });
  });
});

describe("parseFactoryLimitsPayload", () => {
  const fetchedAt = Date.parse("2026-09-29T12:00:00.000Z");

  it("treats a window ending exactly at fetchedAt as active", () => {
    const parsed = parseFactoryLimitsPayload({
      limits: { standard: { fiveHour: { usedPercent: 5, windowEnd: "2026-09-29T12:00:00.000Z" } } },
    }, fetchedAt);
    expect(parsed.quotas["Standard 5h"].used).toBe(5);
    expect(parsed.quotas["Standard 5h"].resetAt).toBe("2026-09-29T12:00:00.000Z");
  });

  it.each(["not-a-date", undefined, 1e20])("treats invalid windowEnd %s as unknown", (windowEnd) => {
    const parsed = parseFactoryLimitsPayload({
      limits: { core: { monthly: { usedPercent: 100, windowEnd } } },
    }, fetchedAt);
    expect(parsed.quotas).toBeUndefined();
    expect(parsed.message).toMatch(/valid quota data/i);
  });

  it("ignores non-object pools/windows", () => {
    const parsed = parseFactoryLimitsPayload({
      limits: { standard: "nope", core: { fiveHour: null } },
    }, fetchedAt);
    expect(parsed.message).toMatch(/valid quota data/i);
  });
});

describe("parseQuotaData(factory)", () => {
  it("forwards percentage and credit-balance fields for the dashboard table", () => {
    const rows = parseQuotaData("factory", {
      plan: "Factory",
      quotas: {
        "Standard 5h": { used: 1, total: 100, remainingPercentage: 99, resetAt: "2026-09-29T13:00:00.000Z" },
        "Extra usage balance": { used: 0, total: 3.5, remainingPercentage: 100, isCreditBalance: true, currency: "USD" },
      },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "Standard 5h", used: 1, total: 100, remainingPercentage: 99 });
    expect(rows[1]).toMatchObject({ name: "Extra usage balance", isCreditBalance: true, currency: "USD" });
  });
});
