// Import from 9router: source reader (read-only SQLite snapshot), row mapping,
// dedup classification and secret masking.
//
// The "foreign" fixture is built with the repo's own SQLite driver in its own
// temp DATA_DIR, so the test never touches a real 9router installation.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-import-9r-"));
const targetDir = path.join(tempRoot, "target");
const foreignDir = path.join(tempRoot, "foreign");
const missingDir = path.join(tempRoot, "no-such-install");

// Fixture credentials — every one of them must stay out of API responses.
const FOREIGN_ACCESS_TOKEN = "foreign-access-token-0001";
const FOREIGN_REFRESH_TOKEN = "foreign-refresh-token-0002";
const CLAUDE_ACCESS_TOKEN = "claude-access-token-0003";
const OPENCODE_API_KEY = "opencode-fixture-key-aaaa";
const DUPLICATE_API_KEY = "openai-dup-fixture-key-bbbb";
const ZAI_ACCESS_TOKEN = "zai-access-token-0006";
const ZAI_ACCESS_TOKEN_TWO = "zai-access-token-0011";
const SOURCE_API_KEY_ONE = "source-fixture-key-cccc";
const SOURCE_API_KEY_TWO = "source-fixture-key-dddd";

// key → expected preview action
const EXPECTED_ACTIONS = {
  "connection:f-codex-1": "update",
  "connection:f-claude-1": "create",
  "connection:f-opencode-1": "create",
  "connection:f-openai-dup": "skip",
  "connection:f-broken-1": "error",
  "connection:f-opencode-2": "skip",
  "connection:f-zai-1": "create",
  "connection:f-zai-2": "create",
};

let db;
let store; // @/lib/db/index.js (target install)
let sourceReader;
let mapping;
let planner;
let mask;
let snapshot;
// Bytes of the fixture database captured right after it was built: the reader
// must never modify the source file.
let foreignDbBytesAfterBuild;

async function activateDataDir(dir) {
  process.env.DATA_DIR = dir;
  delete global._dbAdapter;
  vi.resetModules();
  return await import("@/lib/db/index.js");
}

function foreignConnectionRow(row) {
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

async function buildForeignFixture() {
  process.env.DATA_DIR = foreignDir;
  delete global._dbAdapter;
  vi.resetModules();
  const { getAdapter } = await import("@/lib/db/driver.js");
  const adapter = await getAdapter();

  const rows = [
    foreignConnectionRow({
      id: "f-codex-1",
      provider: "codex",
      authType: "oauth",
      name: "6 PLUS ALASTOR",
      email: "existing@example.com",
      priority: 3,
      isActive: true,
      data: {
        accessToken: FOREIGN_ACCESS_TOKEN,
        refreshToken: FOREIGN_REFRESH_TOKEN,
        idToken: "foreign-id-token-0009",
        expiresAt: "2026-10-01T00:00:00.000Z",
        expiresIn: 3600,
        testStatus: "active",
        errorCode: 0,
        backoffLevel: 0,
        lastError: null,
        lastErrorAt: null,
        rateLimitedUntil: null,
        lastPingedResetKey: "gpt-6",
        "modelLock_gpt-6": { until: 1 },
        providerSpecificData: {
          chatgptAccountId: "acct-existing",
          chatgptPlanType: "plus",
          connectionProxyEnabled: false,
          connectionProxyUrl: "",
        },
      },
    }),
    foreignConnectionRow({
      id: "f-claude-1",
      provider: "claude",
      authType: "oauth",
      name: "New Claude",
      email: "new-claude@example.com",
      priority: 7,
      isActive: false,
      data: {
        accessToken: CLAUDE_ACCESS_TOKEN,
        refreshToken: "claude-refresh-token-0010",
        providerSpecificData: { username: "new-claude-user" },
      },
    }),
    foreignConnectionRow({
      id: "f-opencode-1",
      provider: "opencode-go",
      authType: "apikey",
      name: "swrdt@",
      priority: 2,
      isActive: false,
      data: {
        apiKey: OPENCODE_API_KEY,
        testStatus: "unavailable",
        lastError: "[401] unauthorized",
        providerSpecificData: {
          connectionProxyEnabled: true,
          connectionProxyUrl: "http://127.0.0.1:7897",
          connectionNoProxy: "",
        },
      },
    }),
    foreignConnectionRow({
      id: "f-openai-dup",
      provider: "openai",
      authType: "apikey",
      name: "local-dup",
      isActive: true,
      data: { apiKey: DUPLICATE_API_KEY },
    }),
    foreignConnectionRow({
      id: "f-broken-1",
      provider: "broken-provider",
      authType: "apikey",
      name: "no-credentials",
      isActive: true,
      data: { testStatus: "active" },
    }),
    foreignConnectionRow({
      id: "f-opencode-2",
      provider: "opencode-go",
      authType: "apikey",
      name: "swrdt@",
      priority: 3,
      isActive: true,
      data: { apiKey: OPENCODE_API_KEY },
    }),
    foreignConnectionRow({
      id: "f-zai-1",
      provider: "zai",
      authType: "access_token",
      name: "ZAI A",
      isActive: true,
      data: { accessToken: ZAI_ACCESS_TOKEN },
    }),
    foreignConnectionRow({
      id: "f-zai-2",
      provider: "zai",
      authType: "access_token",
      name: "ZAI B",
      isActive: true,
      data: { accessToken: ZAI_ACCESS_TOKEN_TWO },
    }),
  ];

  for (const row of rows) {
    adapter.run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.provider, row.authType, row.name, row.email, row.priority, row.isActive, row.data, row.createdAt, row.updatedAt],
    );
  }

  // The sibling schema has columns this install does not; the reader must only
  // select what it knows about.
  adapter.exec(`ALTER TABLE apiKeys ADD COLUMN foreignExtra TEXT`);
  adapter.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, allowedProviders) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ["key-1", SOURCE_API_KEY_ONE, "дроид", "source-machine-1", 1, new Date().toISOString(), "[]"],
  );
  adapter.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, allowedProviders) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ["key-2", SOURCE_API_KEY_TWO, "second-key", "source-machine-1", 0, new Date().toISOString(), null],
  );
  adapter.run("UPDATE apiKeys SET allowedKinds = ? WHERE id = ?", ["[]", "key-2"]);

  adapter.run(
    `INSERT INTO combos(id, name, kind, models, context_length, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ["combo-1", "ms1.3c", null, JSON.stringify(["oc/muse-spark", "cmc/meta/muse-spark"]), null, new Date().toISOString(), new Date().toISOString()],
  );

  adapter.run(`INSERT INTO settings(id, data) VALUES(1, ?)`, [JSON.stringify({
    rtkEnabled: true,
    providerStrategies: { zai: { strategy: "round-robin" } },
    requireLogin: false,
    password: "bcrypt-hash-must-not-be-copied",
    mitmRouterBaseUrl: "http://localhost:20128",
    headroomUrl: "http://localhost:8787",
  })]);

  adapter.close();
  delete global._dbAdapter;
  vi.resetModules();
  foreignDbBytesAfterBuild = fs.readFileSync(path.join(foreignDir, "db", "data.sqlite"));
}

async function seedTargetFixture() {
  store = await activateDataDir(targetDir);
  await store.initDb();

  const codex = await store.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: "Existing Codex",
    email: "existing@example.com",
    accessToken: "local-access-token-1001",
    refreshToken: "local-refresh-token-1002",
    providerSpecificData: { chatgptAccountId: "acct-existing", chatgptPlanType: "plus" },
  });
  expect(codex.id).toBeTruthy();

  await store.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "local-dup",
    apiKey: DUPLICATE_API_KEY,
  });

  await store.createApiKey("дроид", "target-machine-1");
  await store.createCombo({ name: "ms1.3c", models: ["oc/other-model"] });
  await store.updateSettings({ rtkEnabled: false, requireLogin: true });
}

beforeAll(async () => {
  await buildForeignFixture();
  await seedTargetFixture();

  // Imported AFTER the last module reset so they share the target adapter.
  sourceReader = await import("@/lib/import/nineRouterSource.js");
  mapping = await import("@/lib/import/connectionMapping.js");
  planner = await import("@/lib/import/importPlan.js");
  mask = await import("@/lib/import/secretMask.js");

  snapshot = await sourceReader.readSourceSnapshot({ dataDir: foreignDir });
}, 120_000);

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch { /* ignore */ }
  delete global._dbAdapter;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  // Windows keeps SQLite handles open for a moment; the OS temp dir gets cleaned.
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("secret masking", () => {
  it("masks a secret to at most four visible characters", () => {
    expect(mask.maskSecret("sk-1234567890")).toBe(`sk-1${"*".repeat(9)}`);
    expect(mask.maskSecret("abc")).toBe("***");
    expect(mask.maskSecret("")).toBe("");
    expect(mask.maskSecret(null)).toBeNull();
    expect(mask.maskSecret(undefined)).toBeNull();
  });

  it("recognises credential-looking field names", () => {
    expect(mask.isSecretKey("apiKey")).toBe(true);
    expect(mask.isSecretKey("accessToken")).toBe(true);
    expect(mask.isSecretKey("refresh_token")).toBe(true);
    expect(mask.isSecretKey("password")).toBe(true);
    expect(mask.isSecretKey("provider")).toBe(false);
    expect(mask.isSecretKey("expiresAt")).toBe(false);
  });

  it("masks credentials recursively without touching other fields", () => {
    const result = mask.maskSecretsDeep({
      provider: "codex",
      apiKey: "sk-abcdefgh",
      nested: { refreshToken: "r-1234567", chatgptPlanType: "plus" },
      list: [{ accessToken: "t-9876543" }],
    });
    expect(result.apiKey).toBe(`sk-a${"*".repeat(7)}`);
    expect(result.nested.refreshToken).toBe(`r-12${"*".repeat(5)}`);
    expect(result.nested.chatgptPlanType).toBe("plus");
    expect(result.list[0].accessToken).toBe(`t-98${"*".repeat(5)}`);
    expect(result.provider).toBe("codex");
  });
});

describe("9router source paths", () => {
  it("defaults to the 9router app directory and supports an override", () => {
    const appDir = sourceReader.SOURCE_APP_DIR;
    // Guards against a repo-wide brand rename rewriting the import target: if
    // this ever fails, something replaced the sibling product's directory name
    // and the feature would read Srouter's own database instead.
    expect(appDir).toBe("9router");
    expect(sourceReader.resolveSourcePaths().dbFile).toContain(appDir);
    expect(sourceReader.resolveSourcePaths().dbFile.endsWith("data.sqlite")).toBe(true);

    const customDir = path.join("D:", "custom", `${appDir}-playground`);
    const overridden = sourceReader.resolveSourcePaths(customDir);
    expect(overridden.dbFile).toBe(path.join(customDir, "db", "data.sqlite"));
    expect(overridden.legacyJsonFile).toBe(path.join(customDir, "db.json"));
  });

  it("reports a missing source without throwing", async () => {
    const missing = await sourceReader.readSourceSnapshot({ dataDir: missingDir });
    expect(missing.found).toBe(false);
    expect(missing.error).toContain(`No ${sourceReader.SOURCE_APP_DIR} database found`);
    expect(missing.connections).toEqual([]);
  });
});

describe("9router source reader (read-only snapshot)", () => {
  it("reads the foreign database with the runtime SQLite driver", () => {
    expect(snapshot.found).toBe(true);
    expect(snapshot.kind).toBe("sqlite");
    expect(["node:sqlite", "bun:sqlite", "sql.js"]).toContain(snapshot.driver);
    expect(snapshot.connections).toHaveLength(8);
    expect(snapshot.apiKeys).toHaveLength(2);
    expect(snapshot.combos).toHaveLength(1);
    expect(snapshot.settings.rtkEnabled).toBe(true);
  });

  it("reports table row counts and ignores the app's own extra columns", () => {
    const counts = Object.fromEntries(snapshot.tables.map((table) => [table.name, table.rows]));
    expect(counts.providerConnections).toBe(8);
    expect(counts.apiKeys).toBe(2);
    expect(counts.combos).toBe(1);
    expect(counts.settings).toBe(1);
    expect(snapshot.apiKeys[0]).not.toHaveProperty("foreignExtra");
    expect(snapshot.apiKeys[0].allowedProviders).toBe("[]");
  });

  it("never writes to the source database", () => {
    const dbFile = path.join(foreignDir, "db", "data.sqlite");
    expect(fs.readFileSync(dbFile).equals(foreignDbBytesAfterBuild)).toBe(true);
  });

  it("exposes a public source description without secret material", () => {
    const publicSource = sourceReader.publicSource(snapshot);
    expect(publicSource.found).toBe(true);
    expect(publicSource.dbFile).toBe(path.join(foreignDir, "db", "data.sqlite"));
    expect(JSON.stringify(publicSource)).not.toContain(SOURCE_API_KEY_ONE);
    expect(publicSource.connections).toBeUndefined();
  });
});

describe("connection mapping", () => {
  const rowById = (id) => snapshot.connections.find((row) => row.id === id);

  it("maps a source row onto the createProviderConnection input shape", () => {
    const result = mapping.mapSourceConnection(rowById("f-codex-1"));
    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({
      provider: "codex",
      authType: "oauth",
      name: "6 PLUS ALASTOR",
      email: "existing@example.com",
      priority: 3,
      isActive: true,
      accessToken: FOREIGN_ACCESS_TOKEN,
      refreshToken: FOREIGN_REFRESH_TOKEN,
    });
    expect(result.payload.providerSpecificData).toEqual({ chatgptAccountId: "acct-existing", chatgptPlanType: "plus" });
    expect(result.credentialPreview.accessToken).toBe(mask.maskSecret(FOREIGN_ACCESS_TOKEN));
  });

  it("drops per-install health state and non-portable proxy settings", () => {
    const result = mapping.mapSourceConnection(rowById("f-codex-1"));
    expect(result.payload.testStatus).toBeUndefined();
    expect(result.payload.errorCode).toBeUndefined();
    expect(result.payload.backoffLevel).toBeUndefined();
    expect(result.payload.rateLimitedUntil).toBeUndefined();
    expect(result.payload["modelLock_gpt-6"]).toBeUndefined();
    expect(result.payload.lastPingedResetKey).toBeUndefined();
    expect(result.notes.join(" ")).toMatch(/per-install state not imported/);

    const opencode = mapping.mapSourceConnection(rowById("f-opencode-1"));
    expect(opencode.payload.providerSpecificData).toBeUndefined();
    expect(opencode.notes.join(" ")).toMatch(/per-install state not imported/);
  });

  it("rejects rows without a reusable credential", () => {
    const result = mapping.mapSourceConnection(rowById("f-broken-1"));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no reusable credential/);
  });

  it("derives a stable name for unnamed api-key rows", () => {
    const unnamed = mapping.mapSourceConnection({ id: "abcdef123456", provider: "groq", authType: "apikey", data: "{\"apiKey\":\"k\"}" });
    expect(unnamed.ok).toBe(true);
    expect(unnamed.payload.name).toBe("groq abcdef12");

    const objectData = mapping.mapSourceConnection({ provider: "groq", authType: "apikey", data: { apiKey: "k" } });
    expect(objectData.ok).toBe(true);
    expect(objectData.payload.apiKey).toBe("k");
  });

  it("fingerprints credentials by material, not by identity", () => {
    const build = (id, name, token) => mapping.mapSourceConnection({
      id, provider: "zai", authType: "access_token", name, data: { accessToken: token },
    }).payload;
    expect(mapping.credentialFingerprint(build("x", "A", ZAI_ACCESS_TOKEN)))
      .toBe(mapping.credentialFingerprint(build("y", "A", ZAI_ACCESS_TOKEN)));
    expect(mapping.credentialFingerprint(build("x", "A", ZAI_ACCESS_TOKEN)))
      .not.toBe(mapping.credentialFingerprint(build("z", "B", ZAI_ACCESS_TOKEN_TWO)));
  });
});

describe("dedup mirror of connectionsRepo.createProviderConnection", () => {
  it("matches OAuth rows by email + account identity", () => {
    const candidate = mapping.mapSourceConnection({ provider: "claude", authType: "oauth", email: "a@b.c", data: "{\"accessToken\":\"t\"}" }).payload;
    expect(mapping.matchesExistingConnection(candidate, { provider: "claude", authType: "oauth", email: "a@b.c" })).toBe(true);
    expect(mapping.matchesExistingConnection(candidate, { provider: "claude", authType: "oauth", email: "other@b.c" })).toBe(false);

    const codex = mapping.mapSourceConnection({ provider: "codex", authType: "oauth", email: "a@b.c", data: "{\"accessToken\":\"t\"}" }).payload;
    expect(mapping.matchesExistingConnection(codex, { provider: "codex", authType: "oauth", email: "a@b.c" })).toBe(false);
    expect(mapping.matchesExistingConnection(codex, {
      provider: "codex",
      authType: "oauth",
      email: "a@b.c",
      providerSpecificData: { chatgptAccountId: "acct-1" },
    })).toBe(false);
    expect(mapping.matchesExistingConnection({ ...codex, providerSpecificData: { chatgptAccountId: "acct-1" } }, {
      provider: "codex",
      authType: "oauth",
      email: "a@b.c",
      providerSpecificData: { chatgptAccountId: "acct-1" },
    })).toBe(true);
  });

  it("matches API-key rows by name and never matches access_token rows", () => {
    const apikey = mapping.mapSourceConnection({ provider: "groq", authType: "apikey", name: "work", data: "{\"apiKey\":\"k\"}" }).payload;
    expect(mapping.matchesExistingConnection(apikey, { provider: "groq", authType: "apikey", name: "work" })).toBe(true);
    expect(mapping.matchesExistingConnection(apikey, { provider: "groq", authType: "apikey", name: "home" })).toBe(false);

    const token = mapping.mapSourceConnection({ provider: "zai", authType: "access_token", name: "A", data: "{\"accessToken\":\"t\"}" }).payload;
    expect(mapping.matchesExistingConnection(token, { provider: "zai", authType: "access_token", name: "A" })).toBe(false);
  });
});

describe("import plan (preview)", () => {
  let plan;

  beforeAll(async () => {
    plan = planner.buildPlan({
      snapshot,
      localState: await planner.collectLocalState(),
      options: { connections: true, apiKeys: true, combos: true, settings: true },
    });
  });

  it("classifies every source connection", () => {
    const actions = Object.fromEntries(plan.connections.items.map((item) => [item.key, item.action]));
    expect(actions).toEqual(EXPECTED_ACTIONS);
    expect(plan.connections.counts).toMatchObject({ total: 8, create: 4, update: 1, skip: 2, error: 1 });
  });

  it("keeps source priority and active state on the mapped payload", () => {
    const claude = plan.connections.items.find((item) => item.key === "connection:f-claude-1");
    expect(claude.payload.priority).toBe(7);
    expect(claude.payload.isActive).toBe(false);
  });

  it("plans API keys by name and combos by models", () => {
    expect(Object.fromEntries(plan.apiKeys.items.map((item) => [item.name, item.action]))).toEqual({
      "дроид": "skip",
      "second-key": "create",
    });
    expect(plan.combos.items[0]).toMatchObject({ name: "ms1.3c", action: "update" });
  });

  it("imports settings except secrets, login and endpoint settings", () => {
    expect(plan.settings.changedKeys).toContain("rtkEnabled");
    expect(plan.settings.changedKeys).toContain("providerStrategies");
    expect(plan.settings.skipped.map((entry) => entry.key)).toEqual(
      expect.arrayContaining(["password", "requireLogin", "mitmRouterBaseUrl", "headroomUrl"]),
    );
    expect(plan.settings.changedKeys).not.toContain("password");
  });

  it("never exposes a secret in the public preview", () => {
    const publicPlan = planner.publicPlan(plan);
    const serialized = JSON.stringify(publicPlan);
    for (const secret of [
      FOREIGN_ACCESS_TOKEN,
      FOREIGN_REFRESH_TOKEN,
      CLAUDE_ACCESS_TOKEN,
      OPENCODE_API_KEY,
      ZAI_ACCESS_TOKEN,
      DUPLICATE_API_KEY,
      "claude-refresh-token-0010",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    const accessItem = publicPlan.connections.find((item) => item.key === "connection:f-zai-1");
    expect(accessItem.fields.accessToken).toBe(mask.maskSecret(ZAI_ACCESS_TOKEN));
    expect(publicPlan.connections.every((item) => item.payload === undefined)).toBe(true);
  });
});

describe("import execution", () => {
  let results;
  let counts;
  let previewPlan;

  beforeAll(async () => {
    previewPlan = planner.buildPlan({
      snapshot,
      localState: await planner.collectLocalState(),
      options: { connections: true, apiKeys: true, combos: true, settings: true },
    });
    const run = await planner.runImport({
      snapshot,
      options: { connections: true, apiKeys: true, combos: true, settings: true },
    });
    results = run.results;
    counts = run.counts;
  }, 120_000);

  it("reports per-item results", () => {
    const byKey = Object.fromEntries(results.connections.map((item) => [item.key, item.status]));
    expect(byKey).toEqual({
      "connection:f-codex-1": "updated",
      "connection:f-claude-1": "created",
      "connection:f-opencode-1": "created",
      "connection:f-openai-dup": "skipped",
      "connection:f-broken-1": "failed",
      "connection:f-opencode-2": "skipped",
      "connection:f-zai-1": "created",
      "connection:f-zai-2": "created",
    });
    expect(counts.connections).toMatchObject({ total: 8, created: 4, updated: 1, skipped: 2, failed: 1 });
  });

  it("matches the repo's real dedup behaviour for every written item", () => {
    const predicted = new Map(previewPlan.connections.items.map((item) => [item.key, item.action]));
    for (const result of results.connections) {
      if (result.status === "failed" || predicted.get(result.key) === "skip") continue;
      expect(result.status).toBe(predicted.get(result.key) === "create" ? "created" : "updated");
    }
  });

  it("updates the matched account in place instead of duplicating it", async () => {
    const codex = await store.getProviderConnections({ provider: "codex" });
    expect(codex).toHaveLength(1);
    expect(codex[0].accessToken).toBe(FOREIGN_ACCESS_TOKEN);
    expect(codex[0].refreshToken).toBe(FOREIGN_REFRESH_TOKEN);
    expect(codex[0].providerSpecificData?.chatgptAccountId).toBe("acct-existing");
    expect(codex[0].testStatus).toBeUndefined();
  });

  it("creates the new accounts with their priority and active state", async () => {
    const claude = await store.getProviderConnections({ provider: "claude" });
    expect(claude).toHaveLength(1);
    expect(claude[0].accessToken).toBe(CLAUDE_ACCESS_TOKEN);
    expect(claude[0].isActive).toBe(false);

    const opencode = await store.getProviderConnections({ provider: "opencode-go" });
    expect(opencode).toHaveLength(1);
    expect(opencode[0].apiKey).toBe(OPENCODE_API_KEY);

    const openai = await store.getProviderConnections({ provider: "openai" });
    expect(openai).toHaveLength(1);

    // access_token rows are never deduped by the repo — both are imported.
    const zai = await store.getProviderConnections({ provider: "zai" });
    expect(zai).toHaveLength(2);
  });

  it("re-issues API keys and updates combos and settings", async () => {
    expect(counts.apiKeys).toMatchObject({ created: 1, skipped: 1 });
    expect(results.apiKeys.find((item) => item.name === "second-key").keyMasked).toBe(mask.maskSecret(
      (await store.getApiKeys()).find((key) => key.name === "second-key").key,
    ));
    expect((await store.getApiKeys()).some((key) => key.key === SOURCE_API_KEY_ONE)).toBe(false);
    expect((await store.getApiKeys()).find((key) => key.name === "second-key")).toMatchObject({
      allowedProviders: null, allowedCombos: null, allowedKinds: [],
    });

    expect(counts.combos).toMatchObject({ updated: 1 });
    expect((await store.getComboByName("ms1.3c")).models).toEqual(["oc/muse-spark", "cmc/meta/muse-spark"]);

    expect(counts.settings).toBe("updated");
    const settings = await store.getSettings();
    expect(settings.rtkEnabled).toBe(true);
    expect(settings.providerStrategies.zai.strategy).toBe("round-robin");
    expect(settings.requireLogin).toBe(true);
    expect(settings.mitmRouterBaseUrl).toBe("http://localhost:20127");
  });

  it("is idempotent: a second run only skips or updates", async () => {
    const second = await planner.runImport({
      snapshot,
      options: { connections: true, apiKeys: true, combos: true, settings: true },
    });
    expect(second.counts.connections.created).toBe(0);
    expect(second.counts.connections.updated).toBe(0);
    expect(second.counts.apiKeys.created).toBe(0);
    expect(second.counts.combos.created + second.counts.combos.updated).toBe(0);
    expect((await store.getProviderConnections({ provider: "claude" }))).toHaveLength(1);
    expect((await store.getProviderConnections({ provider: "zai" }))).toHaveLength(2);
  }, 120_000);
});

describe("connection selection (checkbox subset)", () => {
  it("normalizes the selection payload defensively", () => {
    expect(planner.normalizeImportSelection()).toBeNull();
    expect(planner.normalizeImportSelection(null)).toBeNull();
    // Malformed shapes must not silently mean "import everything".
    expect(planner.normalizeImportSelection("connection:f-claude-1")).toBeUndefined();
    expect(planner.normalizeImportSelection(["connection:f-claude-1"])).toBeUndefined();
    expect(planner.normalizeImportSelection({})).toBeUndefined();
    expect(planner.normalizeImportSelection({ connections: "all" })).toBeUndefined();
    expect(planner.normalizeImportSelection({ connections: [] })).toEqual(new Set());

    const selected = planner.normalizeImportSelection({
      connections: [
        " connection:f-claude-1 ",
        "connection:f-claude-1",
        42,
        null,
        "",
        "x".repeat(planner.MAX_SELECTION_KEY_LENGTH + 1),
      ],
    });
    expect(selected).toEqual(new Set(["connection:f-claude-1"]));
  });

  it("caps the number of accepted selection entries", () => {
    const many = Array.from({ length: planner.MAX_SELECTION_ENTRIES + 50 }, (_, index) => `connection:row-${index}`);
    const selected = planner.normalizeImportSelection({ connections: many });
    expect(selected.size).toBe(planner.MAX_SELECTION_ENTRIES);
    expect(selected.has(`connection:row-${planner.MAX_SELECTION_ENTRIES}`)).toBe(false);
  });

  it("right-sizes the plan: unselected rows stay listed but out of the plan", () => {
    const plan = planner.buildPlan({
      snapshot,
      localState: { connections: [], apiKeys: [], combos: [], settings: {} },
      options: { connections: true, apiKeys: false, combos: false, settings: false },
      selection: new Set(["connection:f-opencode-2"]),
    });
    const byKey = Object.fromEntries(plan.connections.items.map((item) => [item.key, item]));
    // The duplicate twin is not selected, so the selected row is a create.
    expect(byKey["connection:f-opencode-2"]).toMatchObject({ selected: true, action: "create" });
    expect(byKey["connection:f-opencode-1"]).toMatchObject({
      selected: false, action: null, reason: null, payload: null, fields: null,
    });
    expect(plan.connections.counts).toMatchObject({ total: 8, selected: 1, create: 1, update: 0, skip: 0, error: 0 });

    const publicPlan = planner.publicPlan(plan);
    expect(publicPlan.connections.find((item) => item.key === "connection:f-opencode-1")).toMatchObject({
      selected: false, action: null, fields: null, credentialKeys: [],
    });
    expect(publicPlan.counts.connections).toMatchObject({ selected: 1, create: 1 });
  });

  it("still applies the within-batch dedup when both duplicates are selected", () => {
    const plan = planner.buildPlan({
      snapshot,
      localState: { connections: [], apiKeys: [], combos: [], settings: {} },
      options: { connections: true, apiKeys: false, combos: false, settings: false },
      selection: new Set(["connection:f-opencode-1", "connection:f-opencode-2"]),
    });
    const actions = Object.fromEntries(
      plan.connections.items.filter((item) => item.selected).map((item) => [item.key, item.action]),
    );
    expect(actions).toEqual({ "connection:f-opencode-1": "create", "connection:f-opencode-2": "skip" });
  });

  it("executes only the selected connection and leaves the rest untouched", async () => {
    // The full import above created every source account. Remove the local
    // Claude row, then re-import it alone: the execute must write only it.
    const [claudeRow] = await store.getProviderConnections({ provider: "claude" });
    expect(claudeRow?.id).toBeTruthy();
    await store.deleteProviderConnection(claudeRow.id);
    expect(await store.getProviderConnections({ provider: "claude" })).toHaveLength(0);

    const zaiBefore = (await store.getProviderConnections({ provider: "zai" })).map((row) => row.id).sort();
    const run = await planner.runImport({
      snapshot,
      options: { connections: true, apiKeys: false, combos: false, settings: false },
      selection: new Set(["connection:f-claude-1"]),
    });

    expect(run.results.connections.map((item) => item.key)).toEqual(["connection:f-claude-1"]);
    expect(run.counts.connections).toMatchObject({ total: 1, created: 1, updated: 0, skipped: 0, failed: 0 });

    const claude = await store.getProviderConnections({ provider: "claude" });
    expect(claude).toHaveLength(1);
    expect(claude[0].accessToken).toBe(CLAUDE_ACCESS_TOKEN);
    const zaiAfter = (await store.getProviderConnections({ provider: "zai" })).map((row) => row.id).sort();
    expect(zaiAfter).toEqual(zaiBefore);
  }, 120_000);
});

describe("POST /api/import/9router selection enforcement", () => {
  let route;

  beforeAll(async () => {
    // Only the loopback guard is stubbed; everything below it is the real
    // route + planner. The source dir points at the fixture copy.
    process.env.NINEROUTER_DATA_DIR = foreignDir;
    route = await import("../../src/app/api/import/9router/route.js");
  });

  afterAll(() => {
    delete process.env.NINEROUTER_DATA_DIR;
  });

  const post = (body) => route.POST(new Request("http://localhost/api/import/9router", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

  it("rejects a malformed selection instead of falling back to 'import all'", async () => {
    for (const selection of ["connection:x", ["connection:x"], {}, { connections: "connection:x" }, 42]) {
      const res = await post({ mode: "execute", options: { connections: true }, selection });
      expect(res.status, `selection=${JSON.stringify(selection)}`).toBe(400);
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.error).toMatch(/Invalid selection/);
    }
  });

  it("applies the selection to both preview and execute", async () => {
    const [existing] = await store.getProviderConnections({ provider: "claude" });
    if (existing) await store.deleteProviderConnection(existing.id);

    const selection = { connections: ["connection:f-claude-1"] };
    const previewRes = await post({ mode: "preview", options: { connections: true }, selection });
    expect(previewRes.status).toBe(200);
    const previewData = await previewRes.json();
    expect(previewData.preview.counts.connections).toMatchObject({ total: 8, selected: 1, create: 1 });
    expect(previewData.preview.connections.filter((item) => item.selected)).toHaveLength(1);
    expect(JSON.stringify(previewData.preview)).not.toContain(CLAUDE_ACCESS_TOKEN);

    const zaiBefore = (await store.getProviderConnections({ provider: "zai" })).map((row) => row.id).sort();
    const executeRes = await post({ mode: "execute", options: { connections: true }, selection });
    expect(executeRes.status).toBe(200);
    const executeData = await executeRes.json();
    expect(executeData.counts.connections).toMatchObject({ total: 1, created: 1, updated: 0, failed: 0 });
    expect(executeData.results.connections.map((item) => item.key)).toEqual(["connection:f-claude-1"]);

    const claude = await store.getProviderConnections({ provider: "claude" });
    expect(claude).toHaveLength(1);
    expect(claude[0].accessToken).toBe(CLAUDE_ACCESS_TOKEN);
    const zaiAfter = (await store.getProviderConnections({ provider: "zai" })).map((row) => row.id).sort();
    expect(zaiAfter).toEqual(zaiBefore);
  }, 120_000);
});

describe("import options", () => {
  it.each([undefined, null])("legacy/NULL API-key grants remain unrestricted (%s)", grant => {
    const plan = planner.buildPlan({
      snapshot: { apiKeys: [{ id: "legacy", name: "legacy-key", allowedProviders: grant, allowedCombos: grant, allowedKinds: grant }] },
      localState: { apiKeys: [] },
      options: { connections: false, apiKeys: true },
    });
    expect(plan.apiKeys.items[0]).toMatchObject({
      action: "create", access: { allowedProviders: null, allowedCombos: null, allowedKinds: null },
    });
  });

  it.each(["[malformed", "null", "{}", 7, ["valid", 7]])("corrupt source permissions fail closed (%j)", grant => {
    const plan = planner.buildPlan({
      snapshot: { apiKeys: [{ id: "corrupt", name: "corrupt-key", allowedProviders: grant }] },
      localState: { apiKeys: [] },
      options: { connections: false, apiKeys: true },
    });
    expect(plan.apiKeys.items[0].access.allowedProviders).toEqual([]);
    expect(plan.apiKeys.items[0].access.allowedCombos).toBeNull();
  });

  it("unsupported request kinds are rejected, not imported as unrestricted", () => {
    const plan = planner.buildPlan({
      snapshot: { apiKeys: [{ id: "future", name: "future-key", allowedKinds: '["future-kind"]' }] },
      localState: { apiKeys: [] },
      options: { connections: false, apiKeys: true },
    });
    expect(plan.apiKeys.items[0]).toMatchObject({ action: "error", access: { allowedKinds: ["future-kind"] } });
  });

  it("defaults to connections only and ignores unknown input", () => {
    expect(planner.normalizeImportOptions()).toEqual({ connections: true, apiKeys: false, combos: false, settings: false });
    expect(planner.normalizeImportOptions({ combos: true, nonsense: true })).toEqual({
      connections: true, apiKeys: false, combos: true, settings: false,
    });
  });

  it("builds an empty plan when nothing is selected", () => {
    const plan = planner.buildPlan({
      snapshot,
      localState: { connections: [], apiKeys: [], combos: [], settings: {} },
      options: { connections: false, apiKeys: false, combos: false, settings: false },
    });
    expect(plan.connections.counts.total).toBe(0);
    expect(plan.apiKeys.counts.total).toBe(0);
    expect(plan.combos.counts.total).toBe(0);
    expect(plan.settings).toBeNull();
  });
});
