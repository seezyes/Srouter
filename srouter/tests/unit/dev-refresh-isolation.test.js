/**
 * T-0037 — Dev-only credential refresh isolation.
 *
 * Synthetic and offline. This suite creates its own temporary DATA_DIR and its
 * own synthetic authoritative SQLite database; it never opens the real main,
 * dev or 9router databases, never reads real credentials and never contacts a
 * provider (global.fetch is blocked).
 *
 * Proves:
 * - dev mirror-only mode never calls a provider refresh (spies stay untouched),
 *   including when the authoritative path is missing/blank (fail-closed config);
 * - normal/production instances still refresh as before (release guard);
 * - missing / mismatched / stale / expired / unidentified authoritative
 *   credentials fail closed with a non-secret error and no upstream call;
 * - trusted DB columns stay authoritative over a hostile `data` blob;
 * - freshness accepts a strictly newer refresh timestamp OR a strictly newer
 *   future expiry (freshly authorized credentials may lack lastRefreshAt);
 * - the authoritative database is read-only (bytes unchanged);
 * - credential/expiry metadata is mirrored while dev-local config is preserved;
 * - the executor refresh entry point and the engine refresh entry points are all
 *   guarded (executor retry, on-demand, scheduler/manual, model discovery);
 * - symlink/junction self-reference aliases are refused where the OS supports it;
 * - error logs never print the SQLite path or credential material;
 * - packaged/build/CLI/delivery sources do not enable the dev restriction.
 *
 * A companion file (dev-refresh-persistence.test.js) verifies real persistence.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  parseRefreshPolicy,
  registerCredentialMirror,
  resetCredentialMirror,
} from "open-sse/services/refreshPolicy.js";
import { mirrorCredentialsFromAuthoritative } from "@/sse/services/devCredentialMirror.js";
import { refreshProviderCredentials } from "open-sse/services/oauthCredentialManager.js";
import {
  refreshTokenByProvider,
  getAccessToken,
} from "open-sse/services/tokenRefresh.js";
import { getExecutor } from "open-sse/executors/index.js";

const ENV_KEYS = [
  "SROUTER_DEV_MIRROR_REFRESH",
  "SROUTER_DEV_AUTHORITATIVE_DB",
  "DATA_DIR",
  "NODE_ENV",
];

const DEV_CONNECTION_ID = "conn-codex-dev-1";
const OLDER = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
const NEWER = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const STALEST = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
const FUTURE_LONG = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const FUTURE_SHORT = new Date(Date.now() + 5 * 60 * 1000).toISOString();

let tmpRoot = "";
let devDataDir = "";
let authoritativeDb = "";
const savedEnv = {};

function createAuthoritativeDb(file, rows) {
  const db = new DatabaseSync(file);
  db.exec("DROP TABLE IF EXISTS providerConnections");
  db.exec(
    `CREATE TABLE providerConnections (
       id TEXT PRIMARY KEY, provider TEXT, authType TEXT, name TEXT, email TEXT,
       priority INTEGER, isActive INTEGER, data TEXT, createdAt TEXT, updatedAt TEXT
     )`
  );
  const stmt = db.prepare(
    `INSERT INTO providerConnections
       (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const r of rows) {
    const now = new Date().toISOString();
    stmt.run(
      r.id,
      r.provider,
      r.authType ?? "oauth",
      r.name ?? null,
      r.email ?? null,
      r.priority ?? 1,
      1,
      JSON.stringify(r.data ?? {}),
      r.createdAt ?? now,
      r.updatedAt ?? now
    );
  }
  db.close();
}

function mainCodexRow(overrides = {}) {
  return {
    id: DEV_CONNECTION_ID,
    provider: "codex",
    data: {
      accessToken: "main-access",
      refreshToken: "main-refresh",
      idToken: "main-id",
      expiresAt: FUTURE_LONG,
      lastRefreshAt: NEWER,
      providerSpecificData: { chatgptAccountId: "acct-main", workspaceId: "ws-main" },
      ...overrides,
    },
  };
}

function devCredentials(overrides = {}) {
  return {
    connectionId: DEV_CONNECTION_ID,
    accessToken: "dev-access",
    refreshToken: "dev-refresh",
    lastRefreshAt: OLDER,
    providerSpecificData: { chatgptAccountId: "acct-stale", serviceTier: "fast", baseUrl: "https://dev.local" },
    ...overrides,
  };
}

function enableDevMirror(options = {}) {
  const { nodeEnv = "test" } = options;
  const dbPath = Object.prototype.hasOwnProperty.call(options, "dbPath") ? options.dbPath : authoritativeDb;
  process.env.SROUTER_DEV_MIRROR_REFRESH = "1";
  if (dbPath === undefined || dbPath === null) delete process.env.SROUTER_DEV_AUTHORITATIVE_DB;
  else process.env.SROUTER_DEV_AUTHORITATIVE_DB = dbPath;
  process.env.DATA_DIR = devDataDir;
  if (nodeEnv !== undefined) process.env.NODE_ENV = nodeEnv;
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-dev-refresh-test-"));
  devDataDir = path.join(tmpRoot, "srouter-dev");
  fs.mkdirSync(path.join(devDataDir, "db"), { recursive: true });
  authoritativeDb = path.join(tmpRoot, "srouter", "db", "data.sqlite");
  fs.mkdirSync(path.dirname(authoritativeDb), { recursive: true });
  createAuthoritativeDb(authoritativeDb, [mainCodexRow()]);
  registerCredentialMirror(mirrorCredentialsFromAuthoritative);
  // Network blocker: any real provider refresh would throw and be observable.
  global.fetch = vi.fn(async () => {
    throw new Error("network blocked in dev-refresh-isolation test");
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  registerCredentialMirror(mirrorCredentialsFromAuthoritative);
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("refresh policy defaults and release guard", () => {
  it("is off with no configuration", () => {
    expect(parseRefreshPolicy({}).mirrorOnly).toBe(false);
  });

  it("is refused in production even when the dev variables are present", () => {
    const env = { SROUTER_DEV_MIRROR_REFRESH: "1", SROUTER_DEV_AUTHORITATIVE_DB: "/tmp/x.sqlite" };
    expect(parseRefreshPolicy(env, "production").mirrorOnly).toBe(false);
  });

  it("is refused when only the authoritative path is present", () => {
    expect(parseRefreshPolicy({ SROUTER_DEV_AUTHORITATIVE_DB: "/tmp/x.sqlite" }, "development").mirrorOnly).toBe(false);
  });

  it("selects the restriction from the flag alone; a missing path is fail-closed config, not real refresh", () => {
    const policy = parseRefreshPolicy({ SROUTER_DEV_MIRROR_REFRESH: "1" }, "development");
    expect(policy.mirrorOnly).toBe(true);
    expect(policy.pathConfigured).toBe(false);
    expect(policy.authoritativeDbPath).toBe(null);
  });

  it("is on with the flag and a path outside production", () => {
    const policy = parseRefreshPolicy(
      { SROUTER_DEV_MIRROR_REFRESH: "1", SROUTER_DEV_AUTHORITATIVE_DB: "/tmp/x.sqlite" },
      "development"
    );
    expect(policy.mirrorOnly).toBe(true);
    expect(policy.pathConfigured).toBe(true);
  });

  it("treats a whitespace-only path as not configured", () => {
    const policy = parseRefreshPolicy(
      { SROUTER_DEV_MIRROR_REFRESH: "1", SROUTER_DEV_AUTHORITATIVE_DB: "   " },
      "development"
    );
    expect(policy.mirrorOnly).toBe(true);
    expect(policy.pathConfigured).toBe(false);
  });

  it("keeps normal refresh in production even with leaked dev variables", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "prod-access", refresh_token: "prod-refresh", expires_in: 3600 }),
    }));
    enableDevMirror({ nodeEnv: "production" });
    const result = await refreshProviderCredentials("codex", devCredentials({ refreshToken: "prod-dev-refresh" }), null);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result.accessToken).toBe("prod-access");
    expect(result.refreshToken).toBe("prod-refresh");
  });
});

describe("flag without an authoritative path fails closed at every entry point", () => {
  const entries = [
    ["refreshProviderCredentials", (p, c) => refreshProviderCredentials(p, c, null)],
    ["refreshTokenByProvider", (p, c) => refreshTokenByProvider(p, c, null)],
    ["getAccessToken", (p, c) => getAccessToken(p, c, null)],
    ["executor.refreshCredentials", (p, c) => getExecutor(p).refreshCredentials(c, null)],
  ];

  for (const [label, invoke] of entries) {
    it(`${label} never contacts the provider and returns dev_mirror_config (missing path)`, async () => {
      enableDevMirror({ dbPath: undefined });
      const result = await invoke("codex", devCredentials());
      expect(global.fetch).not.toHaveBeenCalled();
      expect(result.error).toBe("dev_refresh_disabled");
      expect(result.code).toBe("dev_mirror_config");
      expect(typeof result.message).toBe("string");
    });

    it(`${label} never contacts the provider and returns dev_mirror_config (whitespace path)`, async () => {
      enableDevMirror({ dbPath: "   " });
      const result = await invoke("codex", devCredentials());
      expect(global.fetch).not.toHaveBeenCalled();
      expect(result.error).toBe("dev_refresh_disabled");
      expect(result.code).toBe("dev_mirror_config");
    });
  }
});

describe("normal refresh is unchanged when the policy is off", () => {
  it("refreshes the provider and rotates the refresh token", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "new-access", refresh_token: "rotated-refresh", expires_in: 3600 }),
    }));
    delete process.env.SROUTER_DEV_MIRROR_REFRESH;
    delete process.env.SROUTER_DEV_AUTHORITATIVE_DB;

    const result = await refreshProviderCredentials("codex", devCredentials({ refreshToken: "normal-dev-refresh" }), null);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result.accessToken).toBe("new-access");
    expect(result.refreshToken).toBe("rotated-refresh");
    expect(result.lastRefreshAt).toBeTruthy();
  });
});

describe("dev mirror-only never refreshes the provider", () => {
  it("mirrors authoritative credentials and preserves dev-local config", async () => {
    enableDevMirror();
    const result = await refreshProviderCredentials("codex", devCredentials(), null);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.accessToken).toBe("main-access");
    expect(result.refreshToken).toBe("main-refresh");
    expect(result.idToken).toBe("main-id");
    expect(result.lastRefreshAt).toBe(NEWER);
    expect(result.providerSpecificData.chatgptAccountId).toBe("acct-main");
    expect(result.providerSpecificData.workspaceId).toBe("ws-main");
    expect(result.providerSpecificData.serviceTier).toBe("fast");
    expect(result.providerSpecificData.baseUrl).toBe("https://dev.local");
  });

  it("guards refreshTokenByProvider (on-demand / video entry point)", async () => {
    enableDevMirror();
    const result = await refreshTokenByProvider("codex", devCredentials(), null);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.accessToken).toBe("main-access");
  });

  it("guards getAccessToken (all-access-token entry point)", async () => {
    enableDevMirror();
    const result = await getAccessToken("codex", devCredentials(), null);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.accessToken).toBe("main-access");
  });

  it("guards executor.refreshCredentials (chat/image/embeddings/usage retry path)", async () => {
    enableDevMirror();
    const executor = getExecutor("codex");
    const result = await executor.refreshCredentials(devCredentials(), null);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.accessToken).toBe("main-access");
  });

  it("does not attempt a provider refresh for API-key connections without refresh tokens", async () => {
    enableDevMirror();
    const result = await refreshProviderCredentials("codex", { connectionId: DEV_CONNECTION_ID, apiKey: "key" }, null);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

describe("freshness provenance and expiry", () => {
  it("does not replace dev-local GCP project selection with main configuration", async () => {
    createAuthoritativeDb(authoritativeDb, [
      mainCodexRow({
        projectId: "main-project",
        providerSpecificData: { projectId: "main-project", chatgptAccountId: "acct-main" },
      }),
    ]);
    enableDevMirror();
    const result = await refreshProviderCredentials("codex", devCredentials({
      projectId: "dev-project",
      providerSpecificData: { projectId: "dev-project", serviceTier: "fast" },
    }), null);
    expect(result.projectId).toBeUndefined();
    expect(result.providerSpecificData.projectId).toBe("dev-project");
    expect(result.providerSpecificData.chatgptAccountId).toBe("acct-main");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("mirrors freshly authorized credentials that lack lastRefreshAt but have a newer future expiry", async () => {
    createAuthoritativeDb(authoritativeDb, [
      mainCodexRow({ lastRefreshAt: undefined, expiresAt: FUTURE_LONG }),
    ]);
    enableDevMirror();
    const result = await refreshProviderCredentials(
      "codex",
      devCredentials({ lastRefreshAt: undefined, expiresAt: FUTURE_SHORT }),
      null
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.accessToken).toBe("main-access");
  });

  it("fails closed when a newer timestamp accompanies an expired authoritative token", async () => {
    createAuthoritativeDb(authoritativeDb, [
      mainCodexRow({ lastRefreshAt: NEWER, expiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }),
    ]);
    enableDevMirror();
    const result = await refreshProviderCredentials("codex", devCredentials(), null);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.error).toBe("dev_refresh_disabled");
    expect(result.code).toBe("dev_mirror_stale");
  });

  it("fails closed when the authoritative refresh timestamp is not newer", async () => {
    createAuthoritativeDb(authoritativeDb, [
      mainCodexRow({ lastRefreshAt: OLDER, expiresAt: FUTURE_SHORT }),
    ]);
    enableDevMirror();
    const result = await refreshProviderCredentials(
      "codex",
      devCredentials({ lastRefreshAt: OLDER, expiresAt: FUTURE_LONG }),
      null
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.code).toBe("dev_mirror_stale");
  });

  it("fails closed when neither timestamp nor expiry is a usable newer provenance", async () => {
    createAuthoritativeDb(authoritativeDb, [
      mainCodexRow({ lastRefreshAt: undefined, expiresAt: undefined }),
    ]);
    enableDevMirror();
    const result = await refreshProviderCredentials("codex", devCredentials(), null);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.code).toBe("dev_mirror_stale");
  });

  it("fails closed for an invalid expiry even when the timestamp is strictly newer", async () => {
    createAuthoritativeDb(authoritativeDb, [
      mainCodexRow({ lastRefreshAt: NEWER, expiresAt: "not-a-date" }),
    ]);
    enableDevMirror();
    const result = await refreshProviderCredentials("codex", devCredentials(), null);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.code).toBe("dev_mirror_stale");
    expect(result.accessToken).toBeUndefined();
    expect(result.message).toContain("expiry is invalid");
  });

  it("allows a provider without declared expiry when its refresh timestamp is newer", async () => {
    createAuthoritativeDb(authoritativeDb, [
      mainCodexRow({ lastRefreshAt: NEWER, expiresAt: undefined }),
    ]);
    enableDevMirror();
    const result = await refreshProviderCredentials("codex", devCredentials(), null);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.accessToken).toBe("main-access");
  });

  it("fails closed for an invalid expiry without newer provenance", async () => {
    createAuthoritativeDb(authoritativeDb, [
      mainCodexRow({ lastRefreshAt: OLDER, expiresAt: "not-a-date" }),
    ]);
    enableDevMirror();
    const result = await refreshProviderCredentials("codex", devCredentials({ lastRefreshAt: OLDER }), null);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.code).toBe("dev_mirror_stale");
  });
});

describe("trusted identity beats a hostile data blob", () => {
  it("keeps trusted id/provider/authType authoritative over data overrides", async () => {
    createAuthoritativeDb(authoritativeDb, [
      mainCodexRow({
        data: {
          ...mainCodexRow().data,
          id: "evil-id",
          provider: "claude",
          authType: "apikey",
        },
      }),
    ]);
    enableDevMirror();
    // Would be dev_mirror_mismatch if the hostile data.authType won.
    const result = await refreshProviderCredentials("codex", devCredentials(), null);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.accessToken).toBe("main-access");
  });

  it("refuses to copy a trusted API-key row into an OAuth dev connection", async () => {
    const apiKeyRow = {
      id: DEV_CONNECTION_ID,
      provider: "codex",
      authType: "apikey",
      data: {
        accessToken: "main-access",
        refreshToken: "main-refresh",
        expiresAt: FUTURE_LONG,
        lastRefreshAt: NEWER,
      },
    };
    createAuthoritativeDb(authoritativeDb, [apiKeyRow]);
    enableDevMirror();
    const result = await refreshProviderCredentials("codex", devCredentials({ authType: "oauth" }), null);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.code).toBe("dev_mirror_mismatch");
  });

  it("refuses an explicit authType mismatch between dev and authoritative rows", async () => {
    createAuthoritativeDb(authoritativeDb, [
      { id: DEV_CONNECTION_ID, provider: "codex", authType: "access_token", data: mainCodexRow().data },
    ]);
    enableDevMirror();
    const result = await refreshProviderCredentials("codex", devCredentials({ authType: "oauth" }), null);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.code).toBe("dev_mirror_mismatch");
  });
});

describe("dev mirror-only fails closed", () => {
  it("fails closed with a useful non-secret error when the mirror is not configured", async () => {
    enableDevMirror();
    resetCredentialMirror();
    const result = await refreshProviderCredentials("codex", devCredentials(), null);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.code).toBe("dev_mirror_unavailable");
    expect(typeof result.message).toBe("string");
    expect(result.message).not.toContain("main-access");
  });

  it("fails closed when no authoritative row matches", async () => {
    enableDevMirror();
    const result = await refreshProviderCredentials("codex", devCredentials({ connectionId: "unknown-id" }), null);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.code).toBe("dev_mirror_missing");
  });

  it("fails closed on provider mismatch", async () => {
    enableDevMirror();
    const result = await refreshProviderCredentials("claude", devCredentials(), null);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.code).toBe("dev_mirror_missing");
  });

  it("fails closed when the authoritative row has no access token", async () => {
    createAuthoritativeDb(authoritativeDb, [mainCodexRow({ accessToken: undefined })]);
    enableDevMirror();
    const result = await refreshProviderCredentials("codex", devCredentials(), null);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.code).toBe("dev_mirror_missing");
  });

  it("fails closed when the authoritative database is missing", async () => {
    enableDevMirror({ dbPath: path.join(tmpRoot, "does-not-exist.sqlite") });
    const result = await refreshProviderCredentials("codex", devCredentials(), null);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.code).toBe("dev_mirror_missing");
  });

  it("fails closed for an unidentified connection", async () => {
    enableDevMirror();
    const result = await refreshProviderCredentials("codex", { refreshToken: "dev-refresh" }, null);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.code).toBe("dev_mirror_unidentified");
  });

  it("refuses to mirror from the dev data directory itself (lexical)", async () => {
    const selfPath = path.join(devDataDir, "db", "data.sqlite");
    createAuthoritativeDb(selfPath, [mainCodexRow()]);
    enableDevMirror({ dbPath: selfPath });
    const result = await refreshProviderCredentials("codex", devCredentials(), null);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.code).toBe("dev_mirror_self");
  });

  it("refuses a symlink/junction alias that resolves into the dev data directory", async (ctx) => {
    const selfPath = path.join(devDataDir, "db", "data.sqlite");
    createAuthoritativeDb(selfPath, [mainCodexRow()]);
    const alias = path.join(tmpRoot, "authoritative-alias");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    try {
      fs.symlinkSync(devDataDir, alias, linkType);
    } catch {
      ctx.skip();
      return;
    }
    enableDevMirror({ dbPath: path.join(alias, "db", "data.sqlite") });
    const result = await refreshProviderCredentials("codex", devCredentials(), null);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.code).toBe("dev_mirror_self");
  });

  it("refuses a case-alias that resolves into the dev data directory (Windows)", async (ctx) => {
    if (process.platform !== "win32") {
      ctx.skip();
      return;
    }
    const selfPath = path.join(devDataDir, "db", "data.sqlite");
    createAuthoritativeDb(selfPath, [mainCodexRow()]);
    const upper = path.join(devDataDir, "DB", "DATA.SQLITE");
    if (!fs.existsSync(upper)) {
      ctx.skip();
      return;
    }
    enableDevMirror({ dbPath: upper });
    const result = await refreshProviderCredentials("codex", devCredentials(), null);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.code).toBe("dev_mirror_self");
  });
});

describe("error logging is sanitized", () => {
  it("does not print the SQLite path or credential material on read failure", async () => {
    const brokenDb = path.join(tmpRoot, "broken.sqlite");
    fs.writeFileSync(brokenDb, "this is not a sqlite database");
    enableDevMirror({ dbPath: brokenDb });
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const result = await refreshProviderCredentials("codex", devCredentials(), log);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.code).toBe("dev_mirror_error");

    const messages = [
      ...log.warn.mock.calls.flat(),
      ...log.info.mock.calls.flat(),
      ...log.error.mock.calls.flat(),
    ].map(String).join("\n");
    expect(messages).not.toContain(brokenDb);
    expect(messages).not.toContain("main-access");
    expect(messages).not.toContain("dev-refresh");
  });
});

describe("authoritative database is never mutated", () => {
  it("leaves the authoritative database bytes unchanged after a mirror", async () => {
    enableDevMirror();
    const before = fs.readFileSync(authoritativeDb);
    const result = await refreshProviderCredentials("codex", devCredentials(), null);
    const after = fs.readFileSync(authoritativeDb);
    expect(result.accessToken).toBe("main-access");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(Buffer.compare(before, after)).toBe(0);
  });
});

describe("manual provider-test path is guarded", () => {
  it("routes an expired OAuth connection through the mirror, not a provider refresh", async () => {
    const claudeRow = {
      id: "conn-claude-dev-1",
      provider: "claude",
      data: {
        accessToken: "main-claude-access",
        refreshToken: "main-claude-refresh",
        expiresAt: FUTURE_LONG,
        lastRefreshAt: NEWER,
        providerSpecificData: { accountId: "acct-main" },
      },
    };
    createAuthoritativeDb(authoritativeDb, [claudeRow]);
    enableDevMirror();

    const connection = {
      id: "conn-claude-dev-1",
      provider: "claude",
      authType: "oauth",
      accessToken: "dev-claude-access",
      refreshToken: "dev-claude-refresh",
      expiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      lastRefreshAt: OLDER,
      providerSpecificData: { accountId: "acct-stale", serviceTier: "fast" },
    };

    const { testOAuthConnection } = await import("@/app/api/providers/[id]/test/testUtils.js");
    const result = await testOAuthConnection(connection);

    const tokenEndpointCalls = global.fetch.mock.calls.filter((c) =>
      /oauth\/token|oauth2\.googleapis|auth\.openai|\/oauth2\//.test(String(c[0]?.url || c[0]))
    );
    expect(tokenEndpointCalls).toHaveLength(0);
    expect(result.refreshed).toBe(true);
    expect(result.newTokens.accessToken).toBe("main-claude-access");
    expect(result.newTokens.refreshToken).toBe("main-claude-refresh");
  });
});

describe("release sources do not enable the dev restriction", () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(testDir, "../..");
  const sharedRoot = path.resolve(repoRoot, "..");

  const mustNotContain = [
    path.join(repoRoot, ".env.example"),
    path.join(repoRoot, "package.json"),
    path.join(repoRoot, "next.config.mjs"),
    path.join(repoRoot, "custom-server.js"),
    path.join(repoRoot, "cli", "package.json"),
    path.join(repoRoot, "cli", "cli.js"),
    path.join(sharedRoot, "delivery", "Srouter.ps1"),
    path.join(sharedRoot, "delivery", "Srouter.vbs"),
    path.join(sharedRoot, "delivery", "SrouterTray.ps1"),
    path.join(sharedRoot, "delivery", "README.md"),
    path.join(sharedRoot, "delivery", "app", "package.json"),
  ];

  it("keeps the dev flag variables out of packaging/build/CLI/delivery sources", () => {
    const scanned = [];
    for (const file of mustNotContain) {
      if (!fs.existsSync(file)) continue;
      scanned.push(file);
      const text = fs.readFileSync(file, "utf8");
      expect(text, `${file} must not define SROUTER_DEV_MIRROR_REFRESH`).not.toContain("SROUTER_DEV_MIRROR_REFRESH");
      expect(text, `${file} must not define SROUTER_DEV_AUTHORITATIVE_DB`).not.toContain("SROUTER_DEV_AUTHORITATIVE_DB");
    }
    // The guard is only meaningful if it actually read release sources.
    expect(scanned.length).toBeGreaterThan(0);
  });

  it("sets the dev flag variables only in the SrouterDev launcher", () => {
    const launcher = path.join(sharedRoot, "SrouterDev", "SrouterDev.ps1");
    expect(fs.existsSync(launcher)).toBe(true);
    const text = fs.readFileSync(launcher, "utf8");
    expect(text).toContain("SROUTER_DEV_MIRROR_REFRESH");
    expect(text).toContain("SROUTER_DEV_AUTHORITATIVE_DB");
  });
});
