// One broken model must not mark the whole account (and provider) as down
// (T-0050, owner report 2026-10-05).
//
// A per-model failure is stored with `lastErrorModel`, so:
//   - the row keeps serving every other model (selection never sees the lock),
//   - the error and the "unavailable" badge disappear with the blocking retry
//     probe instead of hanging until a successful request or a proxy restart,
//   - a credential failure (401/403) stays account-level, because a bad key
//     really does break every model.
//
// Real SQLite/sql.js layer against a temp DATA_DIR — never the working DB.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

async function setup() {
  // The DB adapter is cached on globalThis and survives vi.resetModules().
  try { globalThis._dbAdapter?.instance?.close?.(); } catch { /* already closed */ }
  delete globalThis._dbAdapter;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-model-scoped-error-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();

  const connectionsRepo = await import("@/lib/db/repos/connectionsRepo.js");
  const { markAccountUnavailable, getProviderCredentials } = await import("@/sse/services/auth.js");
  const { getEffectiveConnectionStatus } = await import("@/shared/utils/connectionStatus.js");
  const { computeProviderStats } = await import("@/app/(dashboard)/dashboard/providers/connectionStats.js");

  return {
    connectionsRepo,
    markAccountUnavailable,
    getProviderCredentials,
    getEffectiveConnectionStatus,
    computeProviderStats,
    cleanup() {
      try { globalThis._dbAdapter?.instance?.close?.(); } catch { /* already closed */ }
      delete globalThis._dbAdapter;
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

async function account(ctx, name = "acct") {
  return ctx.connectionsRepo.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name,
    apiKey: "sk-test",
  });
}

describe("model-scoped error attribution", () => {
  let ctx = null;

  afterEach(() => {
    vi.resetModules();
    if (ctx) ctx.cleanup();
    ctx = null;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("records which model failed and keeps the row serving the others", async () => {
    ctx = await setup();
    const connection = await account(ctx);

    await ctx.markAccountUnavailable(connection.id, 404, "[404]: model not found", "openai", "gpt-6-sol");

    const stored = await ctx.connectionsRepo.getProviderConnectionById(connection.id);
    expect(stored.lastErrorModel).toBe("gpt-6-sol");

    // Another model on the same account is still selectable right away.
    const other = await ctx.getProviderCredentials("openai", null, "gpt-6-luna");
    expect(other.connectionId).toBe(connection.id);
    // ...and the failing model is only briefly held back by the retry probe.
    const failing = await ctx.getProviderCredentials("openai", null, "gpt-6-sol");
    expect(failing.allRateLimited).toBe(true);
  });

  it("drops the model-scoped error as soon as its retry probe is over", async () => {
    ctx = await setup();
    const connection = await account(ctx);

    await ctx.markAccountUnavailable(connection.id, 404, "[404]: model not found", "openai", "gpt-6-sol");
    // Age the probe past its window without touching the error TTL.
    await ctx.connectionsRepo.updateProviderConnection(connection.id, {
      "modelLock_gpt-6-sol": new Date(Date.now() - 1000).toISOString(),
    });

    const stored = await ctx.connectionsRepo.getProviderConnectionById(connection.id);
    expect(stored.lastError).toBeNull();
    expect(stored.lastErrorModel).toBeNull();
    expect(stored.testStatus).toBe("active");
  });

  it("keeps a credential failure on the account until its own TTL", async () => {
    ctx = await setup();
    const connection = await account(ctx);

    await ctx.markAccountUnavailable(connection.id, 401, "invalid api key", "openai", "gpt-6-sol");
    await ctx.connectionsRepo.updateProviderConnection(connection.id, {
      "modelLock_gpt-6-sol": new Date(Date.now() - 1000).toISOString(),
    });

    const stored = await ctx.connectionsRepo.getProviderConnectionById(connection.id);
    expect(stored.lastError).toBe("invalid api key");
    expect(stored.testStatus).toBe("unavailable");
  });

  it("does not paint the provider card red for one broken model", async () => {
    ctx = await setup();
    const connection = await account(ctx);

    await ctx.markAccountUnavailable(connection.id, 402, "[402]: service error", "openai", "gpt-6-sol");

    const rows = await ctx.connectionsRepo.getProviderConnections({ provider: "openai" });
    const stats = ctx.computeProviderStats(rows, "openai", "apikey");
    expect(stats).toMatchObject({ total: 1, connected: 1, error: 0 });

    // The row badge names the failing model instead of the account.
    expect(ctx.getEffectiveConnectionStatus(rows[0], true)).toBe("active");
    expect(rows[0].lastErrorModel).toBe("gpt-6-sol");
  });

  it("clears the attribution together with the error on a successful request", async () => {
    ctx = await setup();
    const connection = await account(ctx);
    const { clearAccountError } = await import("@/sse/services/auth.js");

    await ctx.markAccountUnavailable(connection.id, 404, "[404]: model not found", "openai", "gpt-6-sol");
    const locked = await ctx.connectionsRepo.getProviderConnectionById(connection.id);
    await clearAccountError(connection.id, { ...locked, _connection: locked }, "gpt-6-sol");

    const stored = await ctx.connectionsRepo.getProviderConnectionById(connection.id);
    expect(stored.lastError).toBeNull();
    expect(stored.lastErrorModel).toBeNull();
    expect(stored.testStatus).toBe("active");
  });

  // Rows written before the attribution existed (the live BurnGate case: a 402
  // from one model, stored 4 hours ago, with no lastErrorModel) must not keep
  // the account "unavailable" forever. 402/404 are no longer credential-class,
  // so they expire with the transient TTL instead of the 24h one.
  it("expires a legacy per-model error that has no attribution recorded", async () => {
    ctx = await setup();
    const connection = await account(ctx, "legacy");
    await ctx.connectionsRepo.updateProviderConnection(connection.id, {
      testStatus: "unavailable",
      lastError: '[402]: {"error":{"message":"Service error. Please try again.","type":"upstream_error"}}',
      errorCode: 402,
      lastErrorAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      "modelLock_stealth/space-bunny-alpha": new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });

    const stored = await ctx.connectionsRepo.getProviderConnectionById(connection.id);
    expect(stored.lastError).toBeNull();
    expect(stored.errorCode).toBeNull();
    expect(stored.testStatus).toBe("active");
    expect(stored["modelLock_stealth/space-bunny-alpha"]).toBeNull();
  });
});
