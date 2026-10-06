/**
 * T-0037 — real-persistence proof for dev mirror-only refresh.
 *
 * Uses a real (temporary) DATA_DIR SQLite database through the production DB
 * layer, and a synthetic read-only authoritative database. Proves that the
 * existing persistence path writes the mirrored credentials to the *dev* store,
 * stamps lastRefreshAt from the authoritative row, and does not overwrite
 * dev-local configuration. No provider is contacted (global.fetch blocked).
 *
 * Companion to dev-refresh-isolation.test.js (offline unit coverage).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const OLDER = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
const NEWER = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const FUTURE_MAIN = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const FUTURE_DEV = new Date(Date.now() + 5 * 60 * 1000).toISOString();

let tmpRoot = "";
let devDataDir = "";
let authoritativeDb = "";
let db = null;
let driver = null;
let fetchSpy = null;

function createAuthoritativeDb(file, connectionId) {
  const sqlite = new DatabaseSync(file);
  sqlite.exec("DROP TABLE IF EXISTS providerConnections");
  sqlite.exec(
    `CREATE TABLE providerConnections (
       id TEXT PRIMARY KEY, provider TEXT, authType TEXT, name TEXT, email TEXT,
       priority INTEGER, isActive INTEGER, data TEXT, createdAt TEXT, updatedAt TEXT
     )`
  );
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO providerConnections
         (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      connectionId,
      "codex",
      "oauth",
      "main-codex",
      null,
      1,
      1,
      JSON.stringify({
        accessToken: "main-access",
        refreshToken: "main-refresh",
        idToken: "main-id",
        expiresAt: FUTURE_MAIN,
        lastRefreshAt: NEWER,
        providerSpecificData: { chatgptAccountId: "acct-main", workspaceId: "ws-main" },
      }),
      now,
      now
    );
  sqlite.close();
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-dev-refresh-persist-"));
  devDataDir = path.join(tmpRoot, "srouter-dev");
  fs.mkdirSync(path.join(devDataDir, "db"), { recursive: true });
  authoritativeDb = path.join(tmpRoot, "srouter", "db", "data.sqlite");
  fs.mkdirSync(path.dirname(authoritativeDb), { recursive: true });

  // Block network: any real provider refresh would throw and be observable.
  fetchSpy = vi.fn(async () => {
    throw new Error("network blocked in dev-refresh-persistence test");
  });
  global.fetch = fetchSpy;

  vi.stubEnv("DATA_DIR", devDataDir);
  vi.stubEnv("SROUTER_DEV_MIRROR_REFRESH", "1");
  vi.stubEnv("SROUTER_DEV_AUTHORITATIVE_DB", authoritativeDb);
  vi.resetModules();

  db = await import("@/lib/db/index.js");
  driver = await import("@/lib/db/driver.js");
  await db.initDb();

  // proxyFetch patches global.fetch as an import side effect; reinstall the spy
  // so the assertion observes every real network attempt.
  global.fetch = fetchSpy;
});

afterAll(() => {
  try {
    driver?.getAdapterSync()?.close();
  } catch {
    /* ignore */
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (tmpRoot) {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("dev mirror-only persists mirrored credentials to the dev store", () => {
  it("writes authoritative tokens, keeps dev config, and never contacts the provider", async () => {
    const connection = await db.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      name: "dev-codex",
      accessToken: "dev-access",
      refreshToken: "dev-refresh",
      idToken: "dev-id",
      expiresAt: FUTURE_DEV,
      lastRefreshAt: OLDER,
      providerSpecificData: { serviceTier: "fast", baseUrl: "https://dev.local" },
      isActive: true,
    });
    // The authoritative instance owns the *same* connection id + provider.
    createAuthoritativeDb(authoritativeDb, connection.id);

    const { checkAndRefreshToken } = await import("@/sse/services/tokenRefresh.js");
    const refreshed = await checkAndRefreshToken("codex", connection, { force: true });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(refreshed.accessToken).toBe("main-access");

    const persisted = await db.getProviderConnectionById(connection.id);
    expect(persisted.accessToken).toBe("main-access");
    expect(persisted.refreshToken).toBe("main-refresh");
    expect(persisted.idToken).toBe("main-id");
    expect(persisted.lastRefreshAt).toBe(NEWER);
    expect(new Date(persisted.expiresAt).getTime()).toBe(new Date(FUTURE_MAIN).getTime());
    // Mirrored credential metadata...
    expect(persisted.providerSpecificData.chatgptAccountId).toBe("acct-main");
    expect(persisted.providerSpecificData.workspaceId).toBe("ws-main");
    // ...while dev-local configuration is preserved.
    expect(persisted.providerSpecificData.serviceTier).toBe("fast");
    expect(persisted.providerSpecificData.baseUrl).toBe("https://dev.local");
  });
});
