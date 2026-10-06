import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

/**
 * The Providers grid reads rows from `GET /api/providers`, which strips every
 * secret. Without a non-secret marker the grid cannot tell a usable imported
 * account from an empty row, so the route exposes `hasCredential`.
 */
async function setup() {
  try { globalThis._dbAdapter?.instance?.close?.(); } catch { /* already closed */ }
  delete globalThis._dbAdapter;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-providers-list-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  vi.doMock("next/server", () => ({
    NextResponse: {
      json(body, init = {}) {
        return new Response(JSON.stringify(body), {
          status: init.status || 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  }));

  const providersRoute = await import("@/app/api/providers/route.js");
  const connectionsRepo = await import("@/lib/db/repos/connectionsRepo.js");
  return {
    providersRoute,
    connectionsRepo,
    cleanup() {
      try { globalThis._dbAdapter?.instance?.close?.(); } catch { /* best effort */ }
      delete globalThis._dbAdapter;
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

describe("GET /api/providers connection shape", () => {
  let ctx = null;
  afterEach(() => {
    vi.doUnmock("next/server");
    vi.resetModules();
    vi.clearAllMocks();
    if (ctx) ctx.cleanup();
    ctx = null;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("marks rows that hold credentials and never leaks the secrets", async () => {
    ctx = await setup();

    await ctx.connectionsRepo.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      email: "imported@example.com",
      accessToken: "access-token-value",
      refreshToken: "refresh-token-value",
    });
    await ctx.connectionsRepo.createProviderConnection({
      provider: "codex",
      authType: "apikey",
      name: "Empty key row",
      apiKey: "",
    });

    const res = await ctx.providersRoute.GET();
    const { connections } = await res.json();

    const oauthRow = connections.find((c) => c.email === "imported@example.com");
    expect(oauthRow.hasCredential).toBe(true);
    expect(oauthRow.accessToken).toBeUndefined();
    expect(oauthRow.refreshToken).toBeUndefined();

    const emptyRow = connections.find((c) => c.name === "Empty key row");
    expect(emptyRow.hasCredential).toBe(false);
    expect(emptyRow.apiKey).toBeUndefined();
  });
});
