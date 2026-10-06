// Diagnostic model test vs account pools.
//
// A freshly added custom model is not listed by any pool yet. The dashboard
// "Test" probe must still reach an active account (option ignoreAccountPools,
// set only by the authenticated internal probe); normal traffic must keep
// enforcing pool model groups and per-account pins.
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

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-model-probe-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();

  const settingsRepo = await import("@/lib/db/repos/settingsRepo.js");
  const connectionsRepo = await import("@/lib/db/repos/connectionsRepo.js");
  const { getProviderCredentials } = await import("@/sse/services/auth.js");

  return {
    settingsRepo,
    connectionsRepo,
    getProviderCredentials,
    cleanup() {
      try { globalThis._dbAdapter?.instance?.close?.(); } catch { /* already closed */ }
      delete globalThis._dbAdapter;
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

async function pooledCodexAccount(ctx, { models = ["gpt-5.5"], assignedModels, active = true } = {}) {
  const pool = await ctx.settingsRepo.createAccountPool("codex", { name: "Sol pool", models });
  const connection = await ctx.connectionsRepo.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: "codex-account",
    accessToken: "test-token",
    providerSpecificData: {
      accountPoolId: pool.id,
      ...(assignedModels ? { assignedModels } : {}),
    },
  });
  if (!active) {
    await ctx.connectionsRepo.updateProviderConnection(connection.id, { isActive: false });
  }
  return { pool, connection };
}

describe("model-test probe vs account pools", () => {
  let ctx = null;

  afterEach(() => {
    vi.resetModules();
    if (ctx) ctx.cleanup();
    ctx = null;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("normal traffic keeps enforcing pools: a model no pool lists gets no credentials", async () => {
    ctx = await setup();
    await pooledCodexAccount(ctx);

    expect(await ctx.getProviderCredentials("codex", null, "gpt-6-luna")).toBeNull();
    // The pooled model itself still resolves.
    expect((await ctx.getProviderCredentials("codex", null, "gpt-5.5")).connectionId).toBeTruthy();
  });

  it("a trusted probe ignores pool membership and reaches the active account", async () => {
    ctx = await setup();
    const { connection } = await pooledCodexAccount(ctx);

    const credentials = await ctx.getProviderCredentials("codex", null, "gpt-6-luna", { ignoreAccountPools: true });

    expect(credentials.connectionId).toBe(connection.id);
  });

  it("the bypass also covers a per-account assignedModels pin inside a pool", async () => {
    ctx = await setup();
    const { connection } = await pooledCodexAccount(ctx, {
      models: ["gpt-5.5"],
      assignedModels: ["gpt-5.5"],
    });

    expect(await ctx.getProviderCredentials("codex", null, "gpt-6.1-sol")).toBeNull();
    const credentials = await ctx.getProviderCredentials("codex", null, "gpt-6.1-sol", { ignoreAccountPools: true });
    expect(credentials.connectionId).toBe(connection.id);
  });

  it("the probe bypass does not resurrect disabled accounts", async () => {
    ctx = await setup();
    await pooledCodexAccount(ctx, { active: false });

    expect(await ctx.getProviderCredentials("codex", null, "gpt-6-luna", { ignoreAccountPools: true })).toBeNull();
  });

  it("only a literal true enables the bypass", async () => {
    ctx = await setup();
    await pooledCodexAccount(ctx);

    // Truthy-but-not-true values must not weaken pool enforcement.
    expect(await ctx.getProviderCredentials("codex", null, "gpt-6-luna", { ignoreAccountPools: "true" })).toBeNull();
    expect(await ctx.getProviderCredentials("codex", null, "gpt-6-luna", { ignoreAccountPools: 1 })).toBeNull();
  });

  it("counts only extended-model eligible accounts, before per-request exclusions", async () => {
    ctx = await setup();
    const ids = [];
    for (const [name, enabledModels, isActive] of [
      ["extended-a", ["gpt-6-luna[1m]"], true],
      ["extended-b", ["gpt-6-luna[1m]"], true],
      ["base-only", ["gpt-6-luna"], true],
      ["disabled", ["gpt-6-luna[1m]"], false],
    ]) {
      const connection = await ctx.connectionsRepo.createProviderConnection({
        provider: "codex", authType: "oauth", name, accessToken: "synthetic-token",
        providerSpecificData: { enabledModels },
      });
      if (!isActive) await ctx.connectionsRepo.updateProviderConnection(connection.id, { isActive: false });
      ids.push(connection.id);
    }
    const credentials = await ctx.getProviderCredentials("codex", new Set([ids[0]]), "gpt-6-luna", {
      requestedModel: "gpt-6-luna[1m]",
    });
    expect(credentials.connectionId).toBe(ids[1]);
    expect(credentials.accountCount).toBe(2);
  });
});
