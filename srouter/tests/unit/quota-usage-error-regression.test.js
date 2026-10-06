/**
 * T-0037 quota regression guard (usage API half).
 *
 * Companion to quota-regression.test.js. With the dev instance in mirror-only
 * mode, an expired authoritative token must surface as a per-account 401 on
 * /api/usage/[connectionId] — never a provider refresh, never a DB mutation,
 * never an empty/dropped provider list.
 *
 * Offline: fresh owned DATA_DIR, synthetic read-only authoritative DB, and a
 * blocked global fetch. No real credentials, working DBs or provider calls.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const OLDER = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
const NEWER = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const EXPIRED = new Date(Date.now() - 60 * 60 * 1000).toISOString();

describe("/api/usage/[connectionId] reports stale dev-mirror credentials per account", () => {
  let root = "";
  let devDataDir = "";
  let authoritativeDb = "";
  let db = null;
  let driver = null;
  let fetchSpy = null;
  let connectionId = "";

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-quota-usage-"));
    devDataDir = path.join(root, "srouter-dev");
    fs.mkdirSync(path.join(devDataDir, "db"), { recursive: true });
    authoritativeDb = path.join(root, "srouter", "db", "data.sqlite");
    fs.mkdirSync(path.dirname(authoritativeDb), { recursive: true });

    fetchSpy = vi.fn(async () => {
      throw new Error("network blocked in quota regression test");
    });
    global.fetch = fetchSpy;

    vi.stubEnv("DATA_DIR", devDataDir);
    vi.stubEnv("SROUTER_DEV_MIRROR_REFRESH", "1");
    vi.stubEnv("SROUTER_DEV_AUTHORITATIVE_DB", authoritativeDb);
    vi.resetModules();

    db = await import("@/lib/db/index.js");
    driver = await import("@/lib/db/driver.js");
    await db.initDb();

    const connection = await db.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      name: "dev-codex",
      accessToken: "dev-access",
      refreshToken: "dev-refresh",
      expiresAt: EXPIRED,
      lastRefreshAt: OLDER,
      isActive: true,
    });
    connectionId = connection.id;

    const sqlite = new DatabaseSync(authoritativeDb);
    sqlite.exec("DROP TABLE IF EXISTS providerConnections");
    sqlite.exec(
      `CREATE TABLE providerConnections (
         id TEXT PRIMARY KEY, provider TEXT, authType TEXT, name TEXT, email TEXT,
         priority INTEGER, isActive INTEGER, data TEXT, createdAt TEXT, updatedAt TEXT
       )`,
    );
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO providerConnections
           (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        connectionId,
        "codex",
        "oauth",
        "dev-codex",
        null,
        1,
        1,
        JSON.stringify({
          accessToken: "main-access",
          refreshToken: "main-refresh",
          expiresAt: EXPIRED,
          lastRefreshAt: NEWER,
        }),
        now,
        now,
      );
    sqlite.close();

    // proxyFetch patches global.fetch on import; re-install the spy afterwards.
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
    if (root) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("returns a non-secret 401 for an expired authoritative token without refreshing", async () => {
    const route = await import("@/app/api/usage/[connectionId]/route.js");
    const response = await route.GET(
      new Request(`http://localhost/api/usage/${connectionId}`),
      { params: Promise.resolve({ connectionId }) },
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(String(body.error)).toMatch(/Credential refresh failed/);
    expect(String(body.error)).toMatch(/authoritative/);
    expect(String(body.error)).not.toContain("main-access");
    expect(String(body.error)).not.toContain("main-refresh");
    expect(fetchSpy).not.toHaveBeenCalled();

    const persisted = await db.getProviderConnectionById(connectionId);
    expect(persisted.accessToken).toBe("dev-access");
    expect(persisted.refreshToken).toBe("dev-refresh");
  });

  it("returns 404 for an unknown connection without touching the mirror", async () => {
    const route = await import("@/app/api/usage/[connectionId]/route.js");
    const response = await route.GET(
      new Request("http://localhost/api/usage/missing-connection"),
      { params: Promise.resolve({ connectionId: "missing-connection" }) },
    );
    expect(response.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
