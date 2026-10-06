import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ adapter: null }));
// Only adapter selection is mocked: importDb and each adapter's real SQLite
// transaction, schema constraints and persisted files remain under test.
vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: async () => state.adapter,
  getAdapterSync: () => state.adapter,
}));

let directory;
afterEach(() => {
  state.adapter?.close();
  state.adapter = null;
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = null;
});

const [major, minor] = process.versions.node.split(".").map(Number);
const hasNodeSqlite = !process.versions.bun && (major > 22 || (major === 22 && minor >= 5));

describe.each([
  ["node:sqlite", hasNodeSqlite],
  ["sql.js", true],
])("importDb rollback on %s", (driver, supported) => {
  it.skipIf(!supported)("preserves the entire original export after failure and close/reopen", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pass11-import-rollback-"));
    const file = path.join(directory, "data.sqlite");
    const create = driver === "node:sqlite"
      ? (await import("@/lib/db/adapters/nodeSqliteAdapter.js")).createNodeSqliteAdapter
      : (await import("@/lib/db/adapters/sqljsAdapter.js")).createSqlJsAdapter;
    state.adapter = await create(file);
    const { TABLES, buildCreateTableSql } = await import("@/lib/db/schema.js");
    for (const [name, definition] of Object.entries(TABLES)) {
      state.adapter.exec(buildCreateTableSql(name, definition));
    }
    const { importDb, exportDb } = await import("@/lib/db/index.js");
    const timestamp = "2026-01-01T00:00:00.000Z";
    const original = {
      settings: { pass11Marker: "original" },
      providerConnections: [{ id: "original-connection", provider: "test", authType: "apikey", createdAt: timestamp, updatedAt: timestamp }],
      providerNodes: [{ id: "original-node", name: "original", createdAt: timestamp, updatedAt: timestamp }],
      proxyPools: [{ id: "original-pool", createdAt: timestamp, updatedAt: timestamp }],
      proxyPoolFitness: [{ poolId: "original-pool", scope: "test", until: 42, createdAt: timestamp, updatedAt: timestamp }],
      apiKeys: [{ id: "original-key", key: "synthetic-pass11-key", createdAt: timestamp }],
      combos: [{ id: "original-combo", name: "original", models: ["test/model"], createdAt: timestamp, updatedAt: timestamp }],
      modelAliases: { original: "test/model" },
      customModels: [{ id: "original-model", providerAlias: "test" }],
      mitmAlias: { test: { original: "test/model" } },
      pricing: { test: { model: { input: 1 } } },
    };
    await importDb(original);
    const before = await exportDb();
    // Fails late, after table wipes and multiple valid replacement inserts.
    // NOT NULL on combos.name is a real SQLite failure, not a stub exception.
    await expect(importDb({
      ...original,
      settings: { pass11Marker: "replacement" },
      providerConnections: [{ ...original.providerConnections[0], id: "replacement-connection" }],
      combos: [{ id: "invalid-combo", name: null }],
    })).rejects.toThrow(/NOT NULL/i);
    expect(await exportDb()).toEqual(before);
    state.adapter.close();
    state.adapter = await create(file);
    expect(await exportDb()).toEqual(before);
    expect(state.adapter.all("PRAGMA quick_check")).toEqual([{ quick_check: "ok" }]);
  });
});
