import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// P9-F4 positive regressions for the legacy-JSON import contract:
//   1. an aborted (row-count mismatch) import stays retryable;
//   2. a process interruption after _meta/schema stamping but before a successful
//      import still retries — the intent lives in the DB, not a sidecar file, and
//      is armed before any stamp;
//   3. an unexpected (non-MigrationAborted) SQLite error also preserves the retry.
// Runs the real migrate pipeline against a real isolated node:sqlite file — never
// the srouter/srouter-dev/9router data. The temp root is owned by this test and
// marked PASS9-OWNED so teardown cannot touch foreign data.

let baseDir, dataDir, dbDir, sqliteFile;
let migrateModule, createNodeSqliteAdapter;

const PENDING_KEY = "legacyImportPending";

function writeLegacyJson(obj) {
  fs.writeFileSync(path.join(dataDir, "db.json"), JSON.stringify(obj, null, 2));
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function removeWithRetry(target) {
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(target, { force: true }); return; }
    catch { sleepSync(60); } // Windows may hold the SQLite file lock briefly
  }
}

function resetState() {
  for (const [dir, name] of [
    [dbDir, "data.sqlite"], [dbDir, "data.sqlite-wal"], [dbDir, "data.sqlite-shm"],
    [dbDir, ".migrated-from-json"], [dataDir, "db.json"], [dataDir, "usage.json"],
  ]) removeWithRetry(path.join(dir, name));
}

function pendingValue(adapter) {
  return adapter.get(`SELECT value FROM _meta WHERE key = ?`, [PENDING_KEY])?.value ?? null;
}

beforeAll(async () => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pass9-migrate-"));
  fs.writeFileSync(path.join(baseDir, "PASS9-OWNED"), "1");
  dataDir = path.join(baseDir, "data");
  dbDir = path.join(dataDir, "db");
  fs.mkdirSync(path.join(dbDir, "backups"), { recursive: true });
  sqliteFile = path.join(dbDir, "data.sqlite");

  // Must be set before paths.js is first imported anywhere in this worker.
  process.env.DATA_DIR = dataDir;

  ({ createNodeSqliteAdapter } = await import("../../src/lib/db/adapters/nodeSqliteAdapter.js"));
  migrateModule = await import("../../src/lib/db/migrate.js");
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  if (!baseDir || !fs.existsSync(path.join(baseDir, "PASS9-OWNED")) || !baseDir.includes("pass9-migrate-")) return;
  for (let attempt = 0; attempt < 5; attempt++) {
    try { fs.rmSync(baseDir, { recursive: true, force: true }); return; }
    catch { await new Promise((r) => setTimeout(r, 150)); }
  }
});

const legacyRecord = {
  id: "legacy-conn-1",
  provider: "openai",
  authType: "apikey",
  apiKey: "legacy-key",
  name: "legacy",
  isActive: true,
};

describe("P9-F4 legacy import retry", () => {
  it("keeps an aborted import retryable and imports corrected JSON on reboot", async () => {
    resetState();
    // Duplicate primary keys -> importWithAssertion aborts the transaction.
    writeLegacyJson({ providerConnections: [legacyRecord, legacyRecord], apiKeys: [] });

    const first = await createNodeSqliteAdapter(sqliteFile);
    await migrateModule.runMigrationOnce(first);
    expect(first.get("SELECT COUNT(*) AS n FROM providerConnections").n).toBe(0);
    expect(fs.existsSync(path.join(dbDir, ".migrated-from-json"))).toBe(false);
    // Intent is durable in the DB, so freshness is not required to re-attempt.
    expect(pendingValue(first)).toBe("1");
    first.close();

    writeLegacyJson({ providerConnections: [legacyRecord], apiKeys: [] });
    const second = await createNodeSqliteAdapter(sqliteFile);
    await migrateModule.runMigrationOnce(second);
    expect(second.get("SELECT COUNT(*) AS n FROM providerConnections").n).toBe(1);
    const row = second.get("SELECT name, data FROM providerConnections WHERE id = ?", ["legacy-conn-1"]);
    expect(row.name).toBe("legacy");
    expect(row.data).toContain("legacy-key");
    expect(fs.existsSync(path.join(dbDir, ".migrated-from-json"))).toBe(true);
    expect(pendingValue(second)).toBe("0");
    second.close();
  });

  it("retries after an interruption that left schema stamped but import unfinished", async () => {
    resetState();
    writeLegacyJson({ providerConnections: [legacyRecord], apiKeys: [] });

    // Simulate a boot that armed the intent and stamped the schema version, then
    // died before the import finished: non-fresh DB, no migrated marker, and no
    // sidecar file — only the durable DB intent.
    const seeded = await createNodeSqliteAdapter(sqliteFile);
    seeded.exec("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    seeded.run(`INSERT OR REPLACE INTO _meta(key, value) VALUES(?, '1')`, [PENDING_KEY]);
    seeded.close();

    const boot = await createNodeSqliteAdapter(sqliteFile);
    await migrateModule.runMigrationOnce(boot);
    expect(boot.get("SELECT COUNT(*) AS n FROM providerConnections").n).toBe(1);
    expect(pendingValue(boot)).toBe("0");
    expect(fs.existsSync(path.join(dbDir, ".migrated-from-json"))).toBe(true);
    boot.close();
  });

  it("preserves the retry on an unexpected (non-MigrationAborted) SQLite error", async () => {
    resetState();
    writeLegacyJson({ providerConnections: [legacyRecord], apiKeys: [] });
    // The legacy usage file is a separate file in LEGACY_FILES.
    fs.writeFileSync(
      path.join(dataDir, "usage.json"),
      JSON.stringify({ history: [{ timestamp: "2026-01-01T00:00:00.000Z", provider: "openai", model: "m", tokens: { prompt_tokens: 1, completion_tokens: 1 } }] })
    );

    const base = await createNodeSqliteAdapter(sqliteFile);
    // Wrapper that raises a generic SQLite error on a specific insert (not a
    // row-count MigrationAborted), simulating an unexpected persistence failure.
    const faulty = {
      run(sql, params) {
        if (sql.includes("INSERT INTO usageHistory")) throw new Error("disk I/O error");
        return base.run(sql, params);
      },
      get: (...a) => base.get(...a),
      all: (...a) => base.all(...a),
      exec: (...a) => base.exec(...a),
      transaction: (fn) => base.transaction(fn),
      close: () => base.close(),
    };

    await expect(migrateModule.runMigrationOnce(faulty)).rejects.toThrow(/disk I\/O error/);
    // Main import was rolled back with the failed transaction.
    expect(base.get("SELECT COUNT(*) AS n FROM providerConnections").n).toBe(0);
    expect(pendingValue(base)).toBe("1");
    expect(fs.existsSync(path.join(dbDir, ".migrated-from-json"))).toBe(false);
    base.close();

    // A healthy next boot retries and completes.
    const healthy = await createNodeSqliteAdapter(sqliteFile);
    await migrateModule.runMigrationOnce(healthy);
    expect(healthy.get("SELECT COUNT(*) AS n FROM providerConnections").n).toBe(1);
    expect(pendingValue(healthy)).toBe("0");
    healthy.close();
  });
});
