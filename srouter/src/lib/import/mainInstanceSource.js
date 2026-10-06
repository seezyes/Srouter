// Dev-only import source: the main (authoritative) Srouter instance.
//
// The feature is active exactly when the dev launcher (../SrouterDev/SrouterDev.ps1)
// sets the same environment pair that selects mirror-only refresh:
//
//   SROUTER_DEV_MIRROR_REFRESH=1          enable the dev-mode restriction
//   SROUTER_DEV_AUTHORITATIVE_DB=<path>   main instance SQLite file (read-only)
//
// It is deliberately NOT selected by NODE_ENV=development: a production runtime
// refuses the mode even if the variables leak, so a packaged release can never
// expose this import. The dev instance's own data directory is refused as a
// source (self-reference), including Windows case/symlink aliases.
//
// Reading reuses the 9router snapshot reader: the source file (+WAL/-shm
// sidecars) is copied into a temp directory and the COPY is opened read-only,
// so the live main database is never locked and never written. All writes go
// through the app's own repositories into the dev DATA_DIR only.

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";
import { parseRefreshPolicy } from "open-sse/services/refreshPolicy.js";
import { readSourceSnapshot, resolveSourcePaths } from "./nineRouterSource.js";

// Label used in status/error messages and in the public source description.
export const MAIN_IMPORT_APP_LABEL = "srouter";
// The launcher points at <DATA_DIR>/db/data.sqlite; both components are checked
// so an unrelated file path is reported as a configuration problem instead of
// silently scanning a derived directory.
export const MAIN_IMPORT_DB_BASENAME = "data.sqlite";
export const MAIN_IMPORT_DB_DIRNAME = "db";

// Resolve symlinks/junctions where the OS supports it; fall back to the lexical
// resolved path (e.g. when the target does not exist yet).
function bestEffortRealPath(value) {
  if (!value) return null;
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function normalizeForCompare(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInside(child, parent) {
  if (!child || !parent) return false;
  const c = normalizeForCompare(child);
  const p = normalizeForCompare(parent);
  return c === p || c.startsWith(p + path.sep);
}

// The source must never resolve inside this instance's own data directory.
function isSelfReference(candidatePath, dataDir) {
  if (!dataDir) return false;
  return isPathInside(bestEffortRealPath(candidatePath), bestEffortRealPath(dataDir));
}

/**
 * Decide whether the dev-only import from the main instance is available.
 * Pure with respect to its arguments so callers/tests can pass an env map.
 *
 * @param {object} [env] process.env-like map
 * @param {string} [nodeEnv] override for NODE_ENV detection
 * @returns {{ active: boolean, reason: string|null, dbFile?: string, dataDir?: string, production?: boolean }}
 *   reason: null | "not_dev" | "production" | "unconfigured" | "self"
 */
export function resolveMainImportConfig(env = process.env, nodeEnv = undefined) {
  const policy = parseRefreshPolicy(env, nodeEnv);
  if (policy.production) return { active: false, reason: "production" };
  if (!policy.flag) return { active: false, reason: "not_dev" };
  if (!policy.mirrorOnly) return { active: false, reason: "production" };
  if (!policy.pathConfigured) return { active: false, reason: "unconfigured" };

  const dbFile = policy.authoritativeDbPath;
  const dbDir = path.dirname(dbFile);
  if (
    path.basename(dbFile) !== MAIN_IMPORT_DB_BASENAME ||
    path.basename(dbDir) !== MAIN_IMPORT_DB_DIRNAME
  ) {
    return { active: false, reason: "unconfigured", dbFile };
  }
  const dataDir = path.dirname(dbDir);
  if (isSelfReference(dataDir, DATA_DIR) || isSelfReference(dbFile, DATA_DIR)) {
    return { active: false, reason: "self", dbFile, dataDir };
  }
  return { active: true, reason: null, dbFile, dataDir };
}

/** Resolved main-instance locations plus existence flags (nothing is read here). */
export function mainImportSourcePaths(config) {
  if (!config?.active) return null;
  return resolveSourcePaths(config.dataDir);
}

/**
 * Read the main instance data into memory (read-only snapshot).
 * Returns null when the dev import is not active.
 */
export async function readMainImportSnapshot(config) {
  if (!config?.active) return null;
  return readSourceSnapshot({ dataDir: config.dataDir, appLabel: MAIN_IMPORT_APP_LABEL });
}
