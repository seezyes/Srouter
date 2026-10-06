// Dev-only import from the main Srouter instance (T-0049).
//
// Covers the activation gate (dev-launcher env pair only, never production,
// no self-reference), the read-only snapshot of the source database and the
// shared preview/execute paths through the real route handlers.
//
// The "main" fixture is built with the repo's own SQLite driver in its own
// temp DATA_DIR, so the test never touches a real main/dev installation.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// The route is exercised through its exported handler; the loopback guard has
// its own tests, and NextResponse is swapped for a plain Response.
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
  },
}));
vi.mock("../../src/dashboardGuard.js", () => ({ isLocalRequest: () => true }));

const originalDataDir = process.env.DATA_DIR;
const originalFlag = process.env.SROUTER_DEV_MIRROR_REFRESH;
const originalAuthoritativeDb = process.env.SROUTER_DEV_AUTHORITATIVE_DB;
const originalNodeEnv = process.env.NODE_ENV;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-import-main-"));
const devDir = path.join(tempRoot, "dev");
const mainDir = path.join(tempRoot, "main");
const mainDbFile = path.join(mainDir, "db", "data.sqlite");
const oddShapeFile = path.join(tempRoot, "odd", "data.sqlite");

// Fixture credentials — every one of them must stay out of API responses.
const MAIN_CODEX_ACCESS = "main-codex-access-token-0001";
const MAIN_CODEX_REFRESH = "main-codex-refresh-token-0002";
const MAIN_CLAUDE_ACCESS = "main-claude-access-token-0003";
const MAIN_OPENAI_KEY = "main-openai-fixture-key-aaaa";
const MAIN_SOURCE_API_KEY = "main-source-api-key-bbbb";

let store; // @/lib/db/index.js (dev/target install)
let sourceModule;
let route;
let mainDbBytesAfterBuild;

async function activateDataDir(dir) {
  process.env.DATA_DIR = dir;
  delete global._dbAdapter;
  vi.resetModules();
  return await import("@/lib/db/index.js");
}

function mainConnectionRow(row) {
  const now = new Date().toISOString();
  return {
    id: row.id,
    provider: row.provider,
    authType: row.authType,
    name: row.name ?? null,
    email: row.email ?? null,
    priority: row.priority ?? null,
    isActive: row.isActive === false ? 0 : 1,
    data: JSON.stringify(row.data || {}),
    createdAt: row.createdAt || now,
    updatedAt: row.updatedAt || now,
  };
}

async function buildMainFixture() {
  process.env.DATA_DIR = mainDir;
  delete global._dbAdapter;
  vi.resetModules();
  const { getAdapter } = await import("@/lib/db/driver.js");
  const adapter = await getAdapter();

  const rows = [
    mainConnectionRow({
      id: "m-codex-1",
      provider: "codex",
      authType: "oauth",
      name: "Main Codex",
      email: "main-codex@example.com",
      priority: 2,
      isActive: true,
      data: {
        accessToken: MAIN_CODEX_ACCESS,
        refreshToken: MAIN_CODEX_REFRESH,
        idToken: "main-id-token-0009",
        expiresAt: "2026-10-01T00:00:00.000Z",
        testStatus: "active",
        lastError: "[429] rate limited",
        "modelLock_gpt-6": { until: 1 },
        providerSpecificData: {
          chatgptAccountId: "acct-main",
          chatgptPlanType: "plus",
          connectionProxyEnabled: true,
          connectionProxyUrl: "http://127.0.0.1:7897",
        },
      },
    }),
    mainConnectionRow({
      id: "m-claude-1",
      provider: "claude",
      authType: "oauth",
      name: "Main Claude",
      email: "main-claude@example.com",
      priority: 5,
      isActive: true,
      data: {
        accessToken: MAIN_CLAUDE_ACCESS,
        refreshToken: "main-claude-refresh-token-0010",
        providerSpecificData: { username: "main-claude-user" },
      },
    }),
    mainConnectionRow({
      id: "m-openai-1",
      provider: "openai",
      authType: "apikey",
      name: "main-openai-key",
      isActive: true,
      data: { apiKey: MAIN_OPENAI_KEY },
    }),
  ];

  for (const row of rows) {
    adapter.run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.provider, row.authType, row.name, row.email, row.priority, row.isActive, row.data, row.createdAt, row.updatedAt],
    );
  }

  adapter.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, allowedProviders) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ["main-key-1", MAIN_SOURCE_API_KEY, "main-key-name", "main-machine-1", 1, new Date().toISOString(), "[]"],
  );
  adapter.run(
    `INSERT INTO combos(id, name, kind, models, context_length, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ["main-combo-1", "ms-main", null, JSON.stringify(["oc/muse-spark", "cmc/meta/muse-spark"]), null, new Date().toISOString(), new Date().toISOString()],
  );
  adapter.run(`INSERT INTO settings(id, data) VALUES(1, ?)`, [JSON.stringify({
    rtkEnabled: true,
    requireLogin: false,
    password: "bcrypt-hash-must-not-be-copied",
    headroomUrl: "http://localhost:8787",
  })]);

  adapter.close();
  delete global._dbAdapter;
  vi.resetModules();

  mainDbBytesAfterBuild = fs.readFileSync(mainDbFile);
  return mainDbBytesAfterBuild;
}

async function seedDevFixture() {
  store = await activateDataDir(devDir);
  await store.initDb();

  // Matches the main Codex grant (email + chatgptAccountId) → update in place.
  await store.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: "Dev Codex",
    email: "main-codex@example.com",
    accessToken: "dev-access-token-1001",
    refreshToken: "dev-refresh-token-1002",
    providerSpecificData: { chatgptAccountId: "acct-main", chatgptPlanType: "plus" },
  });

  // Same combo name, different models → update; different settings values → change.
  await store.createCombo({ name: "ms-main", models: ["oc/other-model"] });
  await store.updateSettings({ rtkEnabled: false, requireLogin: true });
}

function setDevEnv({ flag = true, db = mainDbFile } = {}) {
  if (flag) process.env.SROUTER_DEV_MIRROR_REFRESH = "1";
  else delete process.env.SROUTER_DEV_MIRROR_REFRESH;
  if (db) process.env.SROUTER_DEV_AUTHORITATIVE_DB = db;
  else delete process.env.SROUTER_DEV_AUTHORITATIVE_DB;
}

beforeAll(async () => {
  await buildMainFixture();
  await seedDevFixture();

  // Imported AFTER the last module reset so they share the dev adapter and the
  // dev DATA_DIR captured by dataDir.js.
  sourceModule = await import("@/lib/import/mainInstanceSource.js");
  route = await import("../../src/app/api/import/main/route.js");
}, 120_000);

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch { /* ignore */ }
  delete global._dbAdapter;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalFlag === undefined) delete process.env.SROUTER_DEV_MIRROR_REFRESH;
  else process.env.SROUTER_DEV_MIRROR_REFRESH = originalFlag;
  if (originalAuthoritativeDb === undefined) delete process.env.SROUTER_DEV_AUTHORITATIVE_DB;
  else process.env.SROUTER_DEV_AUTHORITATIVE_DB = originalAuthoritativeDb;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  // Windows keeps SQLite handles open for a moment; the OS temp dir gets cleaned.
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("dev import activation gate", () => {
  it("is inactive without the dev launcher flag", () => {
    expect(sourceModule.resolveMainImportConfig({})).toMatchObject({ active: false, reason: "not_dev" });
  });

  it("refuses a flag without the authoritative database", () => {
    const config = sourceModule.resolveMainImportConfig({ SROUTER_DEV_MIRROR_REFRESH: "1" });
    expect(config).toMatchObject({ active: false, reason: "unconfigured" });
  });

  it("activates with the launcher pair and derives the main data directory", () => {
    const config = sourceModule.resolveMainImportConfig({
      SROUTER_DEV_MIRROR_REFRESH: "1",
      SROUTER_DEV_AUTHORITATIVE_DB: mainDbFile,
    });
    expect(config.active).toBe(true);
    expect(config.dbFile).toBe(mainDbFile);
    expect(config.dataDir).toBe(mainDir);
  });

  it("never activates in production even when the variables leak", () => {
    const config = sourceModule.resolveMainImportConfig({
      SROUTER_DEV_MIRROR_REFRESH: "1",
      SROUTER_DEV_AUTHORITATIVE_DB: mainDbFile,
    }, "production");
    expect(config).toMatchObject({ active: false, reason: "production" });
  });

  it("refuses a self-reference to this install's own database", () => {
    const config = sourceModule.resolveMainImportConfig({
      SROUTER_DEV_MIRROR_REFRESH: "1",
      SROUTER_DEV_AUTHORITATIVE_DB: path.join(devDir, "db", "data.sqlite"),
    });
    expect(config).toMatchObject({ active: false, reason: "self" });
  });

  it("refuses a path outside the <dataDir>/db/data.sqlite layout", () => {
    const config = sourceModule.resolveMainImportConfig({
      SROUTER_DEV_MIRROR_REFRESH: "1",
      SROUTER_DEV_AUTHORITATIVE_DB: oddShapeFile,
    });
    expect(config).toMatchObject({ active: false, reason: "unconfigured" });
  });
});

describe("GET /api/import/main", () => {
  it("reports inactive (no paths) on a normal install", async () => {
    setDevEnv({ flag: false, db: null });
    const res = await route.GET(new Request("http://localhost/api/import/main"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ ok: true, active: false, reason: "not_dev" });
    expect(JSON.stringify(data)).not.toContain(mainDir);
  });

  it("reports the main source read-only status in the dev mode", async () => {
    setDevEnv();
    const res = await route.GET(new Request("http://localhost/api/import/main"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ ok: true, active: true });
    expect(data.source).toMatchObject({ app: "srouter", found: true, kind: "sqlite" });
    expect(data.source.dbFile).toBe(mainDbFile);
    expect(data.options).toMatchObject({ connections: true, apiKeys: false });
  });

  it("reports the self-reference refusal as inactive", async () => {
    setDevEnv({ db: path.join(devDir, "db", "data.sqlite") });
    const res = await route.GET(new Request("http://localhost/api/import/main"));
    const data = await res.json();
    expect(data).toMatchObject({ ok: true, active: false, reason: "self" });
  });
});

describe("POST /api/import/main", () => {
  const post = (body) => route.POST(new Request("http://localhost/api/import/main", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

  it("is refused outside the dev mode (403, no data)", async () => {
    setDevEnv({ flag: false, db: null });
    const res = await post({ mode: "execute", options: { connections: true } });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data).toMatchObject({ ok: false, active: false, reason: "not_dev" });
  });

  it("is refused in production even with the launcher variables set", async () => {
    setDevEnv();
    process.env.NODE_ENV = "production";
    try {
      const res = await post({ mode: "execute", options: { connections: true } });
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data).toMatchObject({ ok: false, active: false, reason: "production" });
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("rejects a malformed selection instead of falling back to 'import all'", async () => {
    setDevEnv();
    const res = await post({ mode: "preview", options: { connections: true }, selection: ["connection:x"] });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Invalid selection/);
  });

  it("previews the main source without exposing credentials", async () => {
    setDevEnv();
    const res = await post({ mode: "preview", options: { connections: true, apiKeys: true, combos: true, settings: true } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.preview.counts.connections).toMatchObject({ total: 3, selected: 3, create: 2, update: 1, skip: 0 });
    expect(data.preview.counts.apiKeys).toMatchObject({ create: 1, skip: 0 });
    expect(data.preview.counts.combos).toMatchObject({ update: 1 });
    expect(data.preview.counts.settings).toMatchObject({ changed: 1 });
    const serialized = JSON.stringify(data);
    for (const secret of [MAIN_CODEX_ACCESS, MAIN_CODEX_REFRESH, MAIN_CLAUDE_ACCESS, MAIN_OPENAI_KEY]) {
      expect(serialized).not.toContain(secret);
    }
    // Per-install state and proxy settings are not portable; secrets are masked.
    const codex = data.preview.connections.find((item) => item.key === "connection:m-codex-1");
    expect(codex.action).toBe("update");
    expect(codex.notes.join(" ")).toMatch(/per-install state not imported/);
    expect(codex.fields?.accessToken).toMatch(/\*/);
    expect(codex.fields?.accessToken).not.toBe(MAIN_CODEX_ACCESS);
  });

  it("executes into the dev install and never modifies the main database", async () => {
    setDevEnv();
    const before = crypto.createHash("sha256").update(fs.readFileSync(mainDbFile)).digest("hex");
    expect(before).toBe(crypto.createHash("sha256").update(mainDbBytesAfterBuild).digest("hex"));

    const res = await post({ mode: "execute", options: { connections: true, apiKeys: true, combos: true, settings: true } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.counts.connections).toMatchObject({ created: 2, updated: 1, failed: 0 });
    expect(data.counts.apiKeys).toMatchObject({ created: 1, failed: 0 });
    expect(data.counts.combos).toMatchObject({ updated: 1, failed: 0 });
    expect(data.results.settings.status).toBe("updated");
    expect(data.results.settings.changed).toEqual(["rtkEnabled"]);

    // Dev install received the copied accounts (credentials included).
    const claude = await store.getProviderConnections({ provider: "claude" });
    expect(claude).toHaveLength(1);
    expect(claude[0].accessToken).toBe(MAIN_CLAUDE_ACCESS);
    const openai = await store.getProviderConnections({ provider: "openai" });
    expect(openai.map((row) => row.name)).toContain("main-openai-key");
    const codex = await store.getProviderConnections({ provider: "codex" });
    expect(codex).toHaveLength(1);
    expect(codex[0].accessToken).toBe(MAIN_CODEX_ACCESS);

    // The main database is read-only: bytes unchanged after preview+execute.
    const after = crypto.createHash("sha256").update(fs.readFileSync(mainDbFile)).digest("hex");
    expect(after).toBe(before);
  });

  it("narrows preview and execute to the selected connections", async () => {
    setDevEnv();
    // Remove the previously imported Claude row so create/2 is observable again.
    const [importedClaude] = await store.getProviderConnections({ provider: "claude" });
    if (importedClaude) await store.deleteProviderConnection(importedClaude.id);

    const selection = { connections: ["connection:m-claude-1"] };
    const previewRes = await post({ mode: "preview", options: { connections: true }, selection });
    const previewData = await previewRes.json();
    expect(previewData.preview.counts.connections).toMatchObject({ total: 3, selected: 1, create: 1 });
    expect(previewData.preview.connections.filter((item) => item.selected)).toHaveLength(1);

    const openaiBefore = (await store.getProviderConnections({ provider: "openai" })).map((row) => row.id).sort();
    const executeRes = await post({ mode: "execute", options: { connections: true }, selection });
    const executeData = await executeRes.json();
    expect(executeData.counts.connections).toMatchObject({ total: 1, created: 1, updated: 0, failed: 0 });
    const openaiAfter = (await store.getProviderConnections({ provider: "openai" })).map((row) => row.id).sort();
    expect(openaiAfter).toEqual(openaiBefore);
  }, 120_000);
});

describe("import page developer gate", () => {
  it("renders the main-instance panel only behind Developer settings and the active gate", () => {
    const page = fs.readFileSync(new URL("../../src/app/(dashboard)/dashboard/import/page.js", import.meta.url), "utf8");
    expect(page).toContain("useUIStore");
    expect(page).toContain('developerMode ? <ImportSourcePanel sourceKey="main" /> : null');
    expect(page).toContain('<ImportSourcePanel sourceKey="9router" />');
    expect(page).toContain("/api/import/main");
    // The panel hides itself when the API reports the dev mode is not active.
    expect(page).toContain("setAvailable(Boolean(data?.active))");
    // Privacy Mode markers stay on this page for both panels.
    expect(page).toContain("data-streamer-sensitive");
  });
});
