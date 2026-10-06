// Verify markAccountUnavailable applies the owner's cooldown policy
// (2026-10-05, T-0050):
//   - a provider-reported reset is stored AS-IS (no 30-min clamp) as the
//     informational modelResetAt_* field;
//   - a LIMIT cooldown blocks only a short retry probe, so a limit the provider
//     lifted earlier than announced is used by the next real attempt;
//   - credential/model errors keep their own (short) cooldown.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RETRY_PROBE_BLOCK_MS, RETRY_PROBE_LONG_BLOCK_MS } from "open-sse/config/errorConfig.js";

const updateProviderConnection = vi.fn();
const getProviderConnections = vi.fn();

vi.mock("@/lib/localDb", () => ({
  getProviderConnections,
  updateProviderConnection,
  validateApiKey: vi.fn(),
  getSettings: vi.fn(),
  getProviderNodeById: vi.fn(),
}));

// Import after mock
const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

const lockMs = (update, key = "modelLock_gpt-4o") => new Date(update[key]).getTime() - Date.now();
const resetMs = (update, key = "modelResetAt_gpt-4o") => new Date(update[key]).getTime() - Date.now();

describe("markAccountUnavailable cooldown policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProviderConnections.mockResolvedValue([
      { id: "conn-1", displayName: "Test Account", backoffLevel: 0 }
    ]);
    updateProviderConnection.mockResolvedValue({});
  });

  it("keeps the 60s retry probe for a generic rate_limit 429", async () => {
    const result = await markAccountUnavailable(
      "conn-1", 429, "rate limit exceeded", "openai", "gpt-4o"
    );
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(RETRY_PROBE_BLOCK_MS);

    const update = updateProviderConnection.mock.calls[0][1];
    expect(lockMs(update)).toBeGreaterThanOrEqual(59_000);
    expect(lockMs(update)).toBeLessThanOrEqual(61_000);
    // Nothing to announce beyond the probe window itself.
    expect(update["modelResetAt_gpt-4o"]).toBeUndefined();
  });

  it("blocks quota_exhausted with the long probe and announces the 1h reset", async () => {
    const result = await markAccountUnavailable(
      "conn-1", 429, "monthly limit reached", "openai", "gpt-4o"
    );
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(RETRY_PROBE_LONG_BLOCK_MS);
    expect(result.resetMs).toBe(3_600_000);

    const update = updateProviderConnection.mock.calls[0][1];
    expect(lockMs(update)).toBeGreaterThanOrEqual(RETRY_PROBE_LONG_BLOCK_MS - 1000);
    expect(lockMs(update)).toBeLessThanOrEqual(RETRY_PROBE_LONG_BLOCK_MS + 1000);
    // The announced reset survives untouched for the dashboard.
    expect(resetMs(update)).toBeGreaterThanOrEqual(3_590_000);
    expect(resetMs(update)).toBeLessThanOrEqual(3_610_000);
  });

  it("blocks daily_quota with the long probe and announces the midnight-UTC reset", async () => {
    const result = await markAccountUnavailable(
      "conn-1", 429, "today's quota exhausted", "openai", "gpt-4o"
    );
    expect(result.shouldFallback).toBe(true);

    const now = Date.now();
    const tomorrowMidnight = Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate() + 1,
      0, 0, 0, 0
    );
    expect(result.cooldownMs).toBe(RETRY_PROBE_LONG_BLOCK_MS);
    expect(result.resetMs).toBeCloseTo(tomorrowMidnight - now, -2);

    const update = updateProviderConnection.mock.calls[0][1];
    expect(resetMs(update)).toBeCloseTo(tomorrowMidnight - now, -2);
  });

  it("stores a 6h provider reset as-is instead of clamping it to 30 minutes", async () => {
    const resetsAtMs = Date.now() + 6 * 60 * 60 * 1000;
    const result = await markAccountUnavailable(
      "conn-1", 429, "usage limit reached", "codex", "gpt-5", resetsAtMs
    );
    expect(result.shouldFallback).toBe(true);
    // Blocking stays a short probe; the announced reset is what is shown.
    expect(result.cooldownMs).toBe(RETRY_PROBE_LONG_BLOCK_MS);
    expect(result.resetMs).toBeGreaterThanOrEqual(6 * 60 * 60 * 1000 - 2000);
    expect(result.resetMs).toBeLessThanOrEqual(6 * 60 * 60 * 1000);

    const update = updateProviderConnection.mock.calls[0][1];
    expect(resetMs(update, "modelResetAt_gpt-5")).toBeGreaterThanOrEqual(6 * 60 * 60 * 1000 - 2000);
  });

  it("blocks only the probe window for a short provider reset", async () => {
    const resetsAtMs = Date.now() + 90_000;
    const result = await markAccountUnavailable(
      "conn-1", 429, "rate limit exceeded", "openai", "gpt-4o", resetsAtMs
    );
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(RETRY_PROBE_BLOCK_MS);
    expect(result.resetMs).toBeGreaterThanOrEqual(89_000);
    expect(result.resetMs).toBeLessThanOrEqual(90_000);

    const update = updateProviderConnection.mock.calls[0][1];
    expect(lockMs(update)).toBeLessThanOrEqual(61_000);
    expect(resetMs(update)).toBeGreaterThanOrEqual(89_000);
  });

  it("keeps the full cooldown for non-limit errors", async () => {
    const result = await markAccountUnavailable(
      "conn-1", 401, "invalid api key", "openai", "gpt-4o"
    );
    expect(result.shouldFallback).toBe(true);
    // Non-429 uses ERROR_RULES: 401 → 2min, not shortened by the probe policy.
    expect(result.cooldownMs).toBe(2 * 60 * 1000);

    const update = updateProviderConnection.mock.calls[0][1];
    expect(lockMs(update)).toBeGreaterThanOrEqual(119_000);
    expect(update["modelResetAt_gpt-4o"]).toBeUndefined();
  });

  it("returns no fallback for noauth connection", async () => {
    const result = await markAccountUnavailable(
      "noauth", 429, "rate limit exceeded", "openai", "gpt-4o"
    );
    expect(result.shouldFallback).toBe(false);
    expect(result.cooldownMs).toBe(0);
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("still supports the disableLock option", async () => {
    const result = await markAccountUnavailable(
      "conn-1", 429, "rate limit exceeded", "openai", "gpt-4o", null, { disableLock: true }
    );
    expect(result.shouldFallback).toBe(true);
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });
});
