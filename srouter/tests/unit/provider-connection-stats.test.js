import { describe, expect, it } from "vitest";
import {
  computeProviderStats,
  getConnectionErrorTag,
  getEffectiveConnectionStatus,
} from "@/app/(dashboard)/dashboard/providers/connectionStats.js";

/**
 * The Providers grid must agree with the provider detail page about how many
 * accounts exist, and it must not make a working account look broken.
 *
 * Imported accounts carry no `testStatus` (the 9router import drops the source
 * install's health on purpose), but they do carry credentials and `isActive`,
 * which is all the router needs to use them — so the card reports them as
 * Connected. "No credentials" survives only for a row that has nothing to serve
 * a request with.
 */
describe("computeProviderStats", () => {
  const importedCodex = (overrides = {}) => ({
    provider: "codex",
    authType: "oauth",
    isActive: true,
    hasCredential: true,
    ...overrides,
  });

  it("counts status-less imported rows with credentials as connected", () => {
    const connections = [
      importedCodex(),
      importedCodex(),
      importedCodex(),
      importedCodex(),
      importedCodex(),
    ];
    const stats = computeProviderStats(connections, "codex", ["oauth", "apikey", "api_key"]);
    expect(stats).toMatchObject({ total: 5, connected: 5, error: 0, untested: 0, disabled: 0 });
  });

  it("splits connected, errored and disabled rows apart from the rest", () => {
    const connections = [
      importedCodex({ testStatus: "active" }),
      importedCodex({ testStatus: "success" }),
      importedCodex({ testStatus: "error", errorCode: 500 }),
      importedCodex({ isActive: false }),
      importedCodex(),
    ];
    const stats = computeProviderStats(connections, "codex", "oauth");
    expect(stats.connected).toBe(3);
    expect(stats.error).toBe(1);
    expect(stats.disabled).toBe(1);
    expect(stats.total).toBe(5);
  });

  it("ignores other providers and other auth types", () => {
    const connections = [
      importedCodex(),
      importedCodex({ provider: "openai", authType: "apikey" }),
      importedCodex({ authType: "api_key" }),
    ];
    expect(computeProviderStats(connections, "codex", ["oauth"]).total).toBe(1);
    expect(computeProviderStats(connections, "openai", "apikey").total).toBe(1);
    // An install that never created the row reports nothing at all.
    expect(computeProviderStats(connections, "opencode-go", "apikey")).toMatchObject({
      total: 0,
      untested: 0,
      allDisabled: false,
    });
  });

  it("reports a status-less row without credentials instead of dropping it", () => {
    const stats = computeProviderStats(
      [importedCodex({ hasCredential: false }), importedCodex()],
      "codex",
      "oauth",
    );
    expect(stats).toMatchObject({ total: 2, connected: 1, untested: 1 });
  });

  it("does not count a switched-off row twice", () => {
    const stats = computeProviderStats(
      [importedCodex({ isActive: false, hasCredential: false })],
      "codex",
      "oauth",
    );
    expect(stats).toMatchObject({ connected: 0, untested: 0, disabled: 1, allDisabled: true });
  });

  it("reports allDisabled only when every row is switched off", () => {
    expect(
      computeProviderStats([importedCodex({ isActive: false }), importedCodex({ isActive: false })], "codex", "oauth").allDisabled,
    ).toBe(true);
    expect(
      computeProviderStats([importedCodex({ isActive: false }), importedCodex()], "codex", "oauth").allDisabled,
    ).toBe(false);
  });

  it("re-tags the newest error only", () => {
    const stats = computeProviderStats(
      [
        importedCodex({ testStatus: "error", lastErrorAt: "2026-01-01T00:00:00.000Z", errorCode: 429 }),
        importedCodex({ testStatus: "error", lastErrorAt: "2026-02-01T00:00:00.000Z", lastError: "[401]: unauthorized" }),
      ],
      "codex",
      "oauth",
    );
    expect(stats.error).toBe(2);
    expect(stats.errorCode).toBe("AUTH");
  });

  it("does not count a model-scoped failure as a provider error", () => {
    const stats = computeProviderStats(
      [
        importedCodex({
          testStatus: "unavailable",
          lastError: "[402]: service error",
          lastErrorModel: "space-bunny-alpha",
          errorCode: 402,
          "modelLock_space-bunny-alpha": "2099-01-01T00:00:00.000Z",
        }),
        importedCodex({ testStatus: "active" }),
      ],
      "codex",
      "oauth",
    );
    expect(stats).toMatchObject({ total: 2, connected: 2, error: 0 });
  });
});

describe("getEffectiveConnectionStatus", () => {
  const now = Date.parse("2026-03-01T00:00:00.000Z");

  it("reads a live model lock as unavailable and an expired one as active", () => {
    expect(
      getEffectiveConnectionStatus(
        { testStatus: "unavailable", modelLock_gpt: "2026-03-01T01:00:00.000Z" },
        now,
      ),
    ).toBe("unavailable");
    expect(
      getEffectiveConnectionStatus(
        { testStatus: "unavailable", modelLock_gpt: "2026-02-01T00:00:00.000Z" },
        now,
      ),
    ).toBe("active");
  });

  it("leaves a status-less row undefined so it is not read as an error", () => {
    expect(getEffectiveConnectionStatus({}, now)).toBeUndefined();
  });

  // One broken model must not paint the whole account (and provider) as down
  // while every other model on the same account still answers.
  it("does not report a model-scoped failure as account health", () => {
    expect(
      getEffectiveConnectionStatus(
        {
          testStatus: "unavailable",
          lastError: "[404]: model not found",
          lastErrorModel: "gpt-6-sol",
          errorCode: 404,
          "modelLock_gpt-6-sol": "2026-03-01T01:00:00.000Z",
        },
        now,
      ),
    ).toBe("active");
  });

  it("still reports a credential failure on the account", () => {
    expect(
      getEffectiveConnectionStatus(
        {
          testStatus: "unavailable",
          lastError: "invalid api key",
          lastErrorModel: "gpt-6-sol",
          errorCode: 401,
          "modelLock_gpt-6-sol": "2026-03-01T01:00:00.000Z",
        },
        now,
      ),
    ).toBe("unavailable");
  });
});

describe("getConnectionErrorTag", () => {
  it("prefers the explicit error type over the message", () => {
    expect(getConnectionErrorTag({ lastErrorType: "upstream_rate_limited" })).toBe("429");
    expect(getConnectionErrorTag({ lastErrorType: "network_error" })).toBe("NET");
  });

  it("falls back to the numeric code, then to the message", () => {
    expect(getConnectionErrorTag({ errorCode: 503 })).toBe("503");
    expect(getConnectionErrorTag({ lastError: "[401]: unauthorized" })).toBe("AUTH");
    expect(getConnectionErrorTag({ lastError: "kaboom" })).toBe("ERR");
    expect(getConnectionErrorTag(null)).toBeNull();
  });
});
