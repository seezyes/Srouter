import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let adapter;

beforeEach(async () => {
  globalThis._dbAdapter?.instance?.close();
  delete globalThis._dbAdapter;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-acl-db-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
});

afterEach(() => {
  adapter?.close();
  delete globalThis._dbAdapter;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("API key access persistence", () => {
  it("fresh keys are unrestricted and boolean validation remains boolean", async () => {
    const key = await db.createApiKey("owner", "test-machine");
    expect(key).toMatchObject({ allowedProviders: null, allowedCombos: null, allowedKinds: null });
    expect(await db.validateApiKey(key.key)).toBe(true);
    expect(await db.validateApiKey("unknown-test-key")).toBe(false);
    await db.updateApiKey(key.id, { isActive: false });
    expect(await db.validateApiKey(key.key)).toBe(false);
    expect(await db.getApiKeyByKey(key.key)).toMatchObject({ isActive: false });
  });

  it("preserves deny-all, omitted fields, rename, pause and immutable identity", async () => {
    const key = await db.createApiKey("restricted", "test-machine", { allowedProviders: [], allowedCombos: ["coding"], allowedKinds: ["llm"] });
    await db.updateApiKey(key.id, { name: "renamed", isActive: false, key: "do-not-replace", machineId: "other" });
    expect(await db.getApiKeyById(key.id)).toMatchObject({
      key: key.key, machineId: "test-machine", name: "renamed", isActive: false,
      allowedProviders: [], allowedCombos: ["coding"], allowedKinds: ["llm"],
    });
    await db.updateApiKey(key.id, { allowedProviders: null });
    expect(await db.getApiKeyById(key.id)).toMatchObject({ allowedProviders: null, allowedKinds: ["llm"] });
  });

  it("exports and restores permissions, including explicit []", async () => {
    const key = await db.createApiKey("backup", "test-machine", { allowedProviders: ["openai"], allowedCombos: [], allowedKinds: [] });
    const exported = await db.exportDb();
    await db.deleteApiKey(key.id);
    await db.importDb(exported);
    expect(await db.getApiKeyById(key.id)).toMatchObject({ allowedProviders: ["openai"], allowedCombos: [], allowedKinds: [] });
  });

  it.each([{ allowedProviders: "all" }, { allowedCombos: [5] }, { allowedKinds: ["invalid-kind"] }])("rejects malformed permissions: %j", async (access) => {
    await expect(db.createApiKey("invalid", "test-machine", access)).rejects.toThrow();
    expect(await db.getApiKeys()).toEqual([]);
  });

  it("corrupt stored permissions deny access rather than grant unrestricted access", async () => {
    const key = await db.createApiKey("corrupt", "test-machine");
    adapter.run("UPDATE apiKeys SET allowedProviders = ?, allowedKinds = ? WHERE id = ?", ["not-json", "null", key.id]);
    expect(await db.getApiKeyById(key.id)).toMatchObject({ allowedProviders: [], allowedKinds: [] });
  });

  it("migration after v3 adds nullable columns without losing legacy keys", async () => {
    adapter.run("INSERT INTO apiKeys(id, key, name, isActive, createdAt) VALUES(?, ?, ?, ?, ?)",
      ["legacy", "legacy-test-key", "Legacy", 1, "2024-01-01"]);
    for (const column of ["allowedProviders", "allowedCombos", "allowedKinds"]) {
      adapter.exec(`ALTER TABLE apiKeys DROP COLUMN ${column}`);
    }
    adapter.run("UPDATE _meta SET value = '3' WHERE key = 'schemaVersion'");
    adapter.close();
    delete globalThis._dbAdapter;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    expect(await db.getApiKeyById("legacy")).toMatchObject({ name: "Legacy", allowedProviders: null, allowedCombos: null, allowedKinds: null });
    expect(adapter.get("SELECT value FROM _meta WHERE key = 'schemaVersion'").value).toBe("4");
  });

  it("idempotent migration does not reinterpret existing [] as NULL", async () => {
    const key = await db.createApiKey("deny-all", "test-machine", { allowedProviders: [], allowedCombos: [], allowedKinds: [] });
    const migration = (await import("@/lib/db/migrations/004-add-api-key-access.js")).default;
    migration.up(adapter);
    migration.up(adapter);
    expect(await db.getApiKeyById(key.id)).toMatchObject({ allowedProviders: [], allowedCombos: [], allowedKinds: [] });
  });
});
