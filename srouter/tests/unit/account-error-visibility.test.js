// Stale health state on connections (T-0050, owner policy 2026-10-05):
// lastError/testStatus must not hang forever, and the blocking retry probe must
// never outlive the announced quota reset.
import { describe, expect, it } from "vitest";
import {
  buildDailyQuotaLockUpdate,
  buildModelResetUpdate,
  getEarliestModelResetUntil,
  getErrorVisibilityTtlMs,
  getModelResetUntil,
  isModelScopedError,
  resolveProbeBlockMs,
  stripStaleErrorState,
} from "open-sse/services/accountFallback.js";
import {
  ACCOUNT_SCOPED_ERROR_STATUSES,
  ERROR_VISIBILITY_TTL_MS,
  RETRY_PROBE_BLOCK_MS,
  RETRY_PROBE_LONG_BLOCK_MS,
} from "open-sse/config/errorConfig.js";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

describe("resolveProbeBlockMs", () => {
  it("keeps short cooldowns as-is", () => {
    expect(resolveProbeBlockMs(5_000)).toBe(5_000);
    expect(resolveProbeBlockMs(RETRY_PROBE_BLOCK_MS)).toBe(RETRY_PROBE_BLOCK_MS);
  });

  it("caps medium cooldowns at the 60s probe window", () => {
    expect(resolveProbeBlockMs(10 * 60 * 1000)).toBe(RETRY_PROBE_BLOCK_MS);
  });

  it("uses the wide probe window for hour-scale quota cooldowns", () => {
    expect(resolveProbeBlockMs(60 * 60 * 1000)).toBe(RETRY_PROBE_LONG_BLOCK_MS);
    expect(resolveProbeBlockMs(6 * 60 * 60 * 1000)).toBe(RETRY_PROBE_LONG_BLOCK_MS);
  });

  it("never blocks longer than the cooldown itself", () => {
    expect(resolveProbeBlockMs(30_000)).toBe(30_000);
    expect(resolveProbeBlockMs(0)).toBe(0);
  });
});

describe("getErrorVisibilityTtlMs", () => {
  it("keeps only credential errors for the long TTL", () => {
    expect(getErrorVisibilityTtlMs(401)).toBe(ERROR_VISIBILITY_TTL_MS.credential);
    expect(getErrorVisibilityTtlMs(403)).toBe(ERROR_VISIBILITY_TTL_MS.credential);
    expect(ACCOUNT_SCOPED_ERROR_STATUSES.has(404)).toBe(false);
    expect(ACCOUNT_SCOPED_ERROR_STATUSES.has(402)).toBe(false);
    expect(getErrorVisibilityTtlMs(429)).toBe(ERROR_VISIBILITY_TTL_MS.quota);
    expect(getErrorVisibilityTtlMs(500)).toBe(ERROR_VISIBILITY_TTL_MS.transient);
    expect(getErrorVisibilityTtlMs(null)).toBe(ERROR_VISIBILITY_TTL_MS.default);
  });
});

describe("isModelScopedError", () => {
  it("treats a per-model failure as model-scoped, a credential one as account-level", () => {
    expect(isModelScopedError({ lastError: "not found", lastErrorModel: "gpt", errorCode: 404 })).toBe(true);
    expect(isModelScopedError({ lastError: "upstream", lastErrorModel: "gpt", errorCode: 402 })).toBe(true);
    expect(isModelScopedError({ lastError: "limit", lastErrorModel: "gpt", errorCode: 429 })).toBe(true);
    // A bad key breaks every model, so it stays on the account.
    expect(isModelScopedError({ lastError: "bad key", lastErrorModel: "gpt", errorCode: 401 })).toBe(false);
    expect(isModelScopedError({ lastError: "forbidden", lastErrorModel: "gpt", errorCode: 403 })).toBe(false);
    // No attribution recorded (older rows, account-level locks) → account-level.
    expect(isModelScopedError({ lastError: "upstream", errorCode: 402 })).toBe(false);
    expect(isModelScopedError({ lastErrorModel: "gpt", errorCode: 402 })).toBe(false);
    expect(isModelScopedError(null)).toBe(false);
  });
});

describe("stripStaleErrorState", () => {
  it("keeps a fresh failure visible", () => {
    const connection = {
      testStatus: "unavailable",
      lastError: "upstream exploded",
      errorCode: 500,
      lastErrorAt: iso(-60_000),
      modelLock_gpt: iso(30_000),
    };
    expect(stripStaleErrorState(connection, NOW)).toEqual(connection);
  });

  it("hides a model-scoped failure once its retry probe expired", () => {
    const stripped = stripStaleErrorState({
      testStatus: "unavailable",
      lastError: "[404]: model not found",
      lastErrorModel: "gpt",
      errorCode: 404,
      lastErrorAt: iso(-60_000),
      modelLock_gpt: iso(-1000),
    }, NOW);

    expect(stripped.lastError).toBeNull();
    expect(stripped.lastErrorModel).toBeNull();
    expect(stripped.errorCode).toBeNull();
    // The account still serves every other model, so it is not "unavailable".
    expect(stripped.testStatus).toBe("active");
  });

  it("keeps a model-scoped failure visible while its retry probe runs", () => {
    const connection = {
      testStatus: "unavailable",
      lastError: "[404]: model not found",
      lastErrorModel: "gpt",
      errorCode: 404,
      lastErrorAt: iso(-60_000),
      modelLock_gpt: iso(30_000),
    };
    expect(stripStaleErrorState(connection, NOW)).toEqual(connection);
  });

  it("keeps a credential failure on the account until its own TTL", () => {
    const connection = {
      testStatus: "unavailable",
      lastError: "invalid api key",
      lastErrorModel: "gpt",
      errorCode: 401,
      lastErrorAt: iso(-(ERROR_VISIBILITY_TTL_MS.transient + 1000)),
    };
    expect(stripStaleErrorState(connection, NOW)).toEqual(connection);
  });

  it("hides a transient failure once its TTL passed", () => {
    const stripped = stripStaleErrorState({
      testStatus: "unavailable",
      lastError: "upstream exploded",
      errorCode: 500,
      lastErrorAt: iso(-(ERROR_VISIBILITY_TTL_MS.transient + 1000)),
    }, NOW);

    expect(stripped.lastError).toBeNull();
    expect(stripped.errorCode).toBeNull();
    expect(stripped.lastErrorAt).toBeNull();
    expect(stripped.testStatus).toBe("active");
  });

  it("keeps a credential failure past the transient TTL", () => {
    const connection = {
      testStatus: "unavailable",
      lastError: "invalid api key",
      errorCode: 401,
      lastErrorAt: iso(-(ERROR_VISIBILITY_TTL_MS.transient + 1000)),
    };
    expect(stripStaleErrorState(connection, NOW)).toEqual(connection);
  });

  it("hides a stale quota failure after its own TTL", () => {
    const stripped = stripStaleErrorState({
      testStatus: "unavailable",
      lastError: "monthly limit reached",
      errorCode: 429,
      lastErrorAt: iso(-(ERROR_VISIBILITY_TTL_MS.quota + 1000)),
    }, NOW);
    expect(stripped.lastError).toBeNull();
    expect(stripped.testStatus).toBe("active");
  });

  it("drops expired lock and reset fields but keeps active ones", () => {
    const stripped = stripStaleErrorState({
      modelLock_gpt: iso(-1000),
      modelResetAt_gpt: iso(-1000),
      modelLock_other: iso(60_000),
      modelResetAt_other: iso(60 * 60 * 1000),
    }, NOW);

    expect(stripped.modelLock_gpt).toBeNull();
    expect(stripped.modelResetAt_gpt).toBeNull();
    expect(stripped.modelLock_other).toBe(iso(60_000));
    expect(stripped.modelResetAt_other).toBe(iso(60 * 60 * 1000));
  });

  it("keeps the unavailable badge while a lock is still active", () => {
    const stripped = stripStaleErrorState({
      testStatus: "unavailable",
      lastError: "old failure",
      errorCode: 500,
      lastErrorAt: iso(-(ERROR_VISIBILITY_TTL_MS.transient + 1000)),
      modelLock_gpt: iso(30_000),
    }, NOW);

    expect(stripped.lastError).toBeNull();
    expect(stripped.testStatus).toBe("unavailable");
  });

  it("keeps an active soft warning (test result, not a failure state)", () => {
    const connection = {
      testStatus: "active",
      lastError: "Connected, but credits are exhausted",
      errorCode: null,
      lastErrorAt: iso(-30 * 24 * 60 * 60 * 1000),
    };
    expect(stripStaleErrorState(connection, NOW)).toEqual(connection);
  });

  it("does not mutate the input connection", () => {
    const connection = {
      testStatus: "unavailable",
      lastError: "old failure",
      errorCode: 500,
      lastErrorAt: iso(-(ERROR_VISIBILITY_TTL_MS.transient + 1000)),
    };
    stripStaleErrorState(connection, NOW);
    expect(connection.lastError).toBe("old failure");
    expect(connection.testStatus).toBe("unavailable");
  });

  it("returns the same object when there is nothing to strip", () => {
    const connection = { id: "c1", testStatus: "active" };
    expect(stripStaleErrorState(connection, NOW)).toBe(connection);
  });
});

describe("announced quota reset fields", () => {
  it("is written only when it adds information over the retry probe", () => {
    expect(buildModelResetUpdate("gpt", 60 * 60 * 1000, RETRY_PROBE_LONG_BLOCK_MS)).toHaveProperty("modelResetAt_gpt");
    expect(buildModelResetUpdate("gpt", RETRY_PROBE_BLOCK_MS, RETRY_PROBE_BLOCK_MS)).toEqual({});
    expect(buildModelResetUpdate(null, 60 * 60 * 1000, 0)).toEqual({});
  });

  it("reads back only a future reset", () => {
    const inFuture = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
    const future = { modelResetAt_gpt: inFuture(60_000) };
    const past = { modelResetAt_gpt: inFuture(-60_000) };
    expect(getModelResetUntil(future, "gpt")).toBe(future.modelResetAt_gpt);
    expect(getModelResetUntil(past, "gpt")).toBeNull();
    expect(getEarliestModelResetUntil({ modelResetAt_a: inFuture(120_000), modelResetAt_b: inFuture(60_000) }))
      .toBe(getEarliestModelResetUntil({ modelResetAt_b: inFuture(60_000) }));
    expect(getEarliestModelResetUntil({ modelResetAt_a: inFuture(-60_000) })).toBeNull();
  });

  it("daily quota announces the reset instead of blocking until midnight", () => {
    const update = buildDailyQuotaLockUpdate("gpt", new Date(NOW));
    expect(update).toHaveProperty("modelResetAt_gpt");
    expect(update).not.toHaveProperty("modelLock_gpt");
    expect(new Date(update.modelResetAt_gpt).getTime()).toBeGreaterThan(NOW);
  });
});
