// Diagnostic model test vs local retry locks (T-0050).
//
// A local modelLock_* window is our own bookkeeping, not the provider's verdict:
// the dashboard "Test" / one-by-one probe must always reach the upstream, so it
// passes ignoreModelLocks (set only by the authenticated internal probe). Normal
// traffic keeps honouring the lock, so a rate-limited account is not hammered.
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

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-model-probe-locks-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();

  const connectionsRepo = await import("@/lib/db/repos/connectionsRepo.js");
  const { getProviderCredentials } = await import("@/sse/services/auth.js");

  return {
    connectionsRepo,
    getProviderCredentials,
    cleanup() {
      try { globalThis._dbAdapter?.instance?.close?.(); } catch { /* already closed */ }
      delete globalThis._dbAdapter;
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

async function lockedAccount(ctx, { model = "gpt-5.5", lockedMs = 5 * 60 * 1000, active = true } = {}) {
  const connection = await ctx.connectionsRepo.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "locked-account",
    apiKey: "sk-test",
  });
  await ctx.connectionsRepo.updateProviderConnection(connection.id, {
    isActive: active,
    testStatus: "unavailable",
    lastError: "rate limit exceeded",
    errorCode: 429,
    lastErrorAt: new Date().toISOString(),
    [`modelLock_${model}`]: new Date(Date.now() + lockedMs).toISOString(),
    [`modelResetAt_${model}`]: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  return connection;
}

describe("model-test probe vs local retry locks", () => {
  let ctx = null;

  afterEach(() => {
    vi.resetModules();
    if (ctx) ctx.cleanup();
    ctx = null;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("normal traffic still honours the retry lock", async () => {
    ctx = await setup();
    await lockedAccount(ctx);

    const credentials = await ctx.getProviderCredentials("openai", null, "gpt-5.5");
    expect(credentials.allRateLimited).toBe(true);
    expect(credentials.retryAfter).toBeTruthy();
    // The announced reset travels with the lock for the dashboard/503 body.
    expect(credentials.lastError).toBe("rate limit exceeded");
  });

  it("a trusted probe reaches the upstream despite the lock", async () => {
    ctx = await setup();
    const connection = await lockedAccount(ctx);

    const credentials = await ctx.getProviderCredentials("openai", null, "gpt-5.5", { ignoreModelLocks: true });
    expect(credentials.connectionId).toBe(connection.id);
    expect(credentials.allRateLimited).toBeUndefined();
  });

  it("an expired lock releases the account without the bypass", async () => {
    ctx = await setup();
    const connection = await lockedAccount(ctx, { lockedMs: -1000 });

    const credentials = await ctx.getProviderCredentials("openai", null, "gpt-5.5");
    expect(credentials.connectionId).toBe(connection.id);
  });

  it("only a literal true enables the bypass", async () => {
    ctx = await setup();
    await lockedAccount(ctx);

    expect((await ctx.getProviderCredentials("openai", null, "gpt-5.5", { ignoreModelLocks: "true" })).allRateLimited).toBe(true);
    expect((await ctx.getProviderCredentials("openai", null, "gpt-5.5", { ignoreModelLocks: 1 })).allRateLimited).toBe(true);
  });

  it("the bypass does not resurrect disabled accounts", async () => {
    ctx = await setup();
    await lockedAccount(ctx, { active: false });

    expect(await ctx.getProviderCredentials("openai", null, "gpt-5.5", { ignoreModelLocks: true })).toBeNull();
  });

  it("does not leak a stale error after its visibility TTL", async () => {
    ctx = await setup();
    const connection = await ctx.connectionsRepo.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "stale-error",
      apiKey: "sk-test",
    });
    await ctx.connectionsRepo.updateProviderConnection(connection.id, {
      testStatus: "unavailable",
      lastError: "gateway timeout",
      errorCode: 504,
      lastErrorAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    const credentials = await ctx.getProviderCredentials("openai", null, "gpt-5.5");
    expect(credentials.connectionId).toBe(connection.id);
    expect(credentials.lastError).toBeNull();
    expect(credentials.testStatus).toBe("active");
  });
});
