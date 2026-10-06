// Read-only access to the sibling 9router install's data.
//
// The source lives in ANOTHER application's directory (SOURCE_APP_DIR below):
//   Windows: %APPDATA%\<SOURCE_APP_DIR>\db\data.sqlite
//   POSIX:   ~/.<SOURCE_APP_DIR>/db/data.sqlite
// plus the legacy JSON store (%APPDATA%\<SOURCE_APP_DIR>\db.json).
//
// We never open the source file itself. Instead the database bytes (main file
// + SQLite -wal / -shm sidecars) are copied into a private temp directory and
// the COPY is opened. That keeps the guarantee "never write to the source" true
// even for WAL recovery, and avoids taking locks on a database that the other
// app may be using right now. The temp copy is deleted after the read.
//
// The copy is opened with the runtime's own SQLite driver chain (node:sqlite →
// bun:sqlite → sql.js) — no npm dependency is added for this feature.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJson } from "@/lib/db/helpers/jsonCol.js";

// The sibling product's on-disk directory name. Assembled from two parts on
// purpose: a repo-wide brand rename (that product's name -> this product's
// name) must not silently retarget this reader at Srouter's OWN database —
// which would make the Import page read and re-import itself.
export const SOURCE_APP_DIR = ["9", "router"].join("");
export const SOURCE_DB_RELATIVE = path.join("db", "data.sqlite");
export const LEGACY_JSON_NAME = "db.json";

export const SOURCE_TABLE_COLUMNS = {
  providerConnections: ["id", "provider", "authType", "name", "email", "priority", "isActive", "data", "createdAt", "updatedAt"],
  apiKeys: ["id", "key", "name", "machineId", "isActive", "createdAt", "allowedProviders", "allowedCombos", "allowedKinds"],
  combos: ["id", "name", "kind", "models", "createdAt", "updatedAt"],
  settings: ["id", "data"],
};

const SNAPSHOT_PREFIX = `srouter-import-${SOURCE_APP_DIR}-`;

/**
 * Resolve the source app's data directory.
 * `NINEROUTER_DATA_DIR` overrides the platform default (useful for
 * non-standard installs; also what the unit tests use).
 */
export function resolveSourceDataDir(override) {
  if (override) return override;
  if (process.env.NINEROUTER_DATA_DIR) return process.env.NINEROUTER_DATA_DIR;
  if (process.platform === "win32") {
    const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(roaming, SOURCE_APP_DIR);
  }
  return path.join(os.homedir(), `.${SOURCE_APP_DIR}`);
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/** Resolved source locations plus existence flags (nothing is read here). */
export function resolveSourcePaths(override) {
  const dataDir = resolveSourceDataDir(override);
  const dbFile = path.join(dataDir, SOURCE_DB_RELATIVE);
  const legacyJsonFile = path.join(dataDir, LEGACY_JSON_NAME);
  return {
    dataDir,
    dbFile,
    dbFileExists: isFile(dbFile),
    dbSizeBytes: fileSize(dbFile),
    legacyJsonFile,
    legacyJsonFileExists: isFile(legacyJsonFile),
  };
}

// ─── SQLite readers (no process handlers, no writes to the source) ────────

async function loadNodeSqlite() {
  // Suppress "ExperimentalWarning: SQLite is an experimental feature" for the
  // dynamic import only — same trick as src/lib/db/adapters/nodeSqliteAdapter.js.
  const origEmit = process.emit;
  process.emit = function (name, data, ...rest) {
    if (name === "warning" && data?.name === "ExperimentalWarning" && /SQLite/i.test(data.message || "")) {
      return false;
    }
    return origEmit.call(process, name, data, ...rest);
  };
  try {
    return await import("node:sqlite");
  } finally {
    process.emit = origEmit;
  }
}

function openNodeSqlite(file) {
  return loadNodeSqlite().then((sqlite) => {
    const db = new sqlite.DatabaseSync(file);
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA query_only = true;"); // hard guarantee: the copy is read-only too
    return {
      driver: "node:sqlite",
      all: (sql) => db.prepare(sql).all().map((row) => ({ ...row })),
      close: () => db.close(),
    };
  });
}

async function openBunSqlite(file) {
  const { Database } = await import("bun:sqlite");
  const db = new Database(file);
  db.exec("PRAGMA query_only = true;");
  return {
    driver: "bun:sqlite",
    all: (sql) => db.query(sql).all(),
    close: () => db.close(),
  };
}

async function openSqlJs(file) {
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(file));
  return {
    driver: "sql.js",
    all: (sql) => {
      const result = db.exec(sql);
      if (!result.length) return [];
      const { columns, values } = result[0];
      return values.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
    },
    close: () => db.close(),
  };
}

/**
 * Copy the source DB (main file + WAL sidecars) into a temp dir and open it.
 * Returns { driver, all, cleanup } — caller must call cleanup().
 */
async function openSnapshotReader(dbFile) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), SNAPSHOT_PREFIX));
  const target = path.join(tempDir, path.basename(dbFile));
  const warnings = [];
  try {
    fs.copyFileSync(dbFile, target);
    for (const suffix of ["-wal", "-shm"]) {
      if (isFile(`${dbFile}${suffix}`)) {
        try {
          fs.copyFileSync(`${dbFile}${suffix}`, `${target}${suffix}`);
        } catch (error) {
          warnings.push(`Could not copy ${path.basename(dbFile)}${suffix}: ${error.message}`);
        }
      }
    }
  } catch (error) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new Error(`Could not snapshot ${dbFile}: ${error.message}`);
  }

  const attempts = [];
  const openers = [openNodeSqlite, openBunSqlite, openSqlJs];
  for (const opener of openers) {
    try {
      const reader = await opener(target);
      return {
        driver: reader.driver,
        warnings,
        all: reader.all,
        cleanup: () => {
          try { reader.close(); } catch { /* already closed */ }
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows may hold the handle briefly */ }
        },
      };
    } catch (error) {
      attempts.push(`${opener.name}: ${error.message}`);
    }
  }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
  throw new Error(`No SQLite reader could open the ${SOURCE_APP_DIR} snapshot (${attempts.join(" | ")})`);
}

// ─── Reading ─────────────────────────────────────────────────────────────

function tableNames(reader) {
  return reader.all(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((row) => String(row.name));
}

function tableColumns(reader, table) {
  return reader
    .all(`PRAGMA table_info(${table})`)
    .map((row) => String(row.name));
}

function readTable(reader, table, present, warnings) {
  if (!present.includes(table)) {
    warnings.push(`Source database has no "${table}" table — nothing to import from it.`);
    return [];
  }
  const available = new Set(tableColumns(reader, table));
  const columns = (SOURCE_TABLE_COLUMNS[table] || []).filter((column) => available.has(column));
  if (columns.length === 0) {
    warnings.push(`Source "${table}" table has none of the expected columns — skipped.`);
    return [];
  }
  try {
    return reader.all(`SELECT ${columns.map((column) => `"${column}"`).join(", ")} FROM "${table}"`);
  } catch (error) {
    warnings.push(`Could not read "${table}": ${error.message}`);
    return [];
  }
}

function countRows(reader, table, warnings) {
  try {
    const result = reader.all(`SELECT COUNT(*) AS rows FROM "${table}"`);
    return Number(result?.[0]?.rows ?? 0);
  } catch (error) {
    warnings.push(`Could not count "${table}": ${error.message}`);
    return 0;
  }
}

/** Normalize a legacy db.json connection into the SQLite row shape. */
function legacyConnectionToRow(entry, index) {
  const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = entry || {};
  return {
    id: id || `legacy-${index}`,
    provider,
    authType,
    name,
    email,
    priority,
    isActive,
    data: JSON.stringify(rest),
    createdAt,
    updatedAt,
  };
}

function readLegacyJson(paths) {
  const warnings = [];
  const tables = [];
  let connections = [];
  let apiKeys = [];
  let combos = [];
  let settings = null;
  try {
    const raw = parseJson(fs.readFileSync(paths.legacyJsonFile, "utf8"), null);
    if (!raw || typeof raw !== "object") {
      warnings.push(`Legacy ${LEGACY_JSON_NAME} could not be parsed as JSON.`);
    } else {
      connections = Array.isArray(raw.providerConnections)
        ? raw.providerConnections.map((entry, index) => legacyConnectionToRow(entry, index))
        : [];
      apiKeys = Array.isArray(raw.apiKeys) ? raw.apiKeys : [];
      combos = Array.isArray(raw.combos) ? raw.combos : [];
      settings = raw.settings && typeof raw.settings === "object" ? raw.settings : null;
      tables.push(
        { name: "providerConnections", rows: connections.length, legacy: true },
        { name: "apiKeys", rows: apiKeys.length, legacy: true },
        { name: "combos", rows: combos.length, legacy: true },
        { name: "settings", rows: settings ? 1 : 0, legacy: true },
      );
      warnings.push(
        `Legacy ${LEGACY_JSON_NAME} source: only connections, API key names, combos and settings are readable (health state and usage history are not imported).`,
      );
    }
  } catch (error) {
    warnings.push(`Could not read legacy ${LEGACY_JSON_NAME}: ${error.message}`);
  }
  return { connections, apiKeys, combos, settings, tables, warnings };
}

/**
 * Read the sibling source into memory (read-only).
 * `options.dataDir` overrides the default location (used by unit tests and for
 * non-standard installs, including the dev-only main-instance import);
 * `options.appLabel` only relabels human-readable messages. Returns a plain
 * object; a missing source never throws.
 */
export async function readSourceSnapshot({ dataDir, appLabel } = {}) {
  const label = appLabel || SOURCE_APP_DIR;
  const paths = resolveSourcePaths(dataDir);
  const result = {
    paths,
    found: false,
    kind: null,
    driver: null,
    error: null,
    warnings: [],
    tables: [],
    connections: [],
    apiKeys: [],
    combos: [],
    settings: null,
  };

  if (!paths.dbFileExists) {
    if (paths.legacyJsonFileExists) {
      const legacy = readLegacyJson(paths);
      return {
        ...result,
        found: true,
        kind: "legacy-json",
        driver: "db.json",
        ...legacy,
        warnings: [
          `SQLite database not found at ${paths.dbFile}; falling back to ${paths.legacyJsonFile}.`,
          ...legacy.warnings,
        ],
      };
    }
    result.error = `No ${label} database found at ${paths.dbFile}`;
    return result;
  }

  let reader = null;
  try {
    reader = await openSnapshotReader(paths.dbFile);
    const present = tableNames(reader);
    const connections = readTable(reader, "providerConnections", present, result.warnings);
    const apiKeys = readTable(reader, "apiKeys", present, result.warnings);
    const combos = readTable(reader, "combos", present, result.warnings);
    const settingsRows = readTable(reader, "settings", present, result.warnings);
    const settings = settingsRows.length ? parseJson(settingsRows[0].data, null) : null;

    result.tables = present
      .filter((name) => !name.startsWith("sqlite_"))
      .map((name) => ({ name, rows: countRows(reader, name, result.warnings) }));

    const providerNodes = result.tables.find((table) => table.name === "providerNodes");
    if (providerNodes?.rows > 0) {
      result.warnings.push(
        `Source has ${providerNodes.rows} provider node definition(s) (custom OpenAI-compatible endpoints); these are not imported — re-create them locally if a connection needs them.`,
      );
    }

    return {
      ...result,
      found: true,
      kind: "sqlite",
      driver: reader.driver,
      warnings: [...result.warnings, ...reader.warnings],
      connections,
      apiKeys,
      combos,
      settings,
    };
  } catch (error) {
    result.error = error.message;
    return result;
  } finally {
    try { reader?.cleanup(); } catch { /* best effort */ }
  }
}

/** Public (safe) source description for API responses — never includes rows. */
export function publicSource(snapshot, appLabel) {
  return {
    app: appLabel || SOURCE_APP_DIR,
    dataDir: snapshot.paths?.dataDir || null,
    dbFile: snapshot.paths?.dbFile || null,
    dbFileExists: Boolean(snapshot.paths?.dbFileExists),
    dbSizeBytes: snapshot.paths?.dbSizeBytes || 0,
    legacyJsonFile: snapshot.paths?.legacyJsonFile || null,
    legacyJsonFileExists: Boolean(snapshot.paths?.legacyJsonFileExists),
    found: Boolean(snapshot.found),
    kind: snapshot.kind,
    driver: snapshot.driver,
    error: snapshot.error,
    warnings: snapshot.warnings || [],
    tables: snapshot.tables || [],
  };
}
