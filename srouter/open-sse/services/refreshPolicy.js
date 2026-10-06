// App-independent refresh policy for the Srouter routing engine.
//
// Normal instances (production delivery, packaged CLI, defaults) always refresh
// OAuth credentials exactly as before. A dev instance may be explicitly
// configured by the dev launcher to NEVER refresh rotating provider tokens and
// instead mirror the current credentials from the authoritative instance. The
// policy is opt-in through two environment variables that only
// ../SrouterDev/SrouterDev.ps1 sets:
//
//   SROUTER_DEV_MIRROR_REFRESH=1          enable dev mirror-only refresh
//   SROUTER_DEV_AUTHORITATIVE_DB=<path>   authoritative SQLite file (read-only)
//
// The flag alone selects the restriction (non-production). A missing or blank
// authoritative path is a configuration error that must fail closed in the
// mirror; it must never silently fall back to a real provider refresh, because
// that is exactly the token rotation the dev instance must not perform.
//
// Release guard: mirror-only is refused whenever NODE_ENV=production. A future
// packaged release therefore cannot silently inherit the dev restriction even
// if these variables leak into its environment.
//
// The engine is provider-agnostic and has no database access. The actual
// read-only mirror implementation is injected by the application layer through
// registerCredentialMirror(). Until it is registered, mirror-only mode fails
// closed: it never falls back to a real provider refresh.

export const DEV_MIRROR_FLAG = "SROUTER_DEV_MIRROR_REFRESH";
export const DEV_AUTHORITATIVE_DB = "SROUTER_DEV_AUTHORITATIVE_DB";

let credentialMirror = null;

/**
 * Inject the application-side credential mirror. Passing a non-function resets
 * the registration (used by tests and by shutdown paths).
 * @param {Function|null} fn async (provider, credentials, log) => credentials|error
 */
export function registerCredentialMirror(fn) {
  credentialMirror = typeof fn === "function" ? fn : null;
}

export function resetCredentialMirror() {
  credentialMirror = null;
}

export function getCredentialMirror() {
  return credentialMirror;
}

function isTruthy(value) {
  if (value == null || value === "") return false;
  const v = String(value).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Parse the refresh policy for an environment. Pure and dependency-free so it
 * can be unit tested without touching the real process environment.
 *
 * @param {object} [env] process.env-like map
 * @param {string} [nodeEnv] override for NODE_ENV detection
 * @returns {{ mirrorOnly: boolean, authoritativeDbPath: string|null, pathConfigured: boolean, flag: boolean, production: boolean }}
 */
export function parseRefreshPolicy(env = process.env, nodeEnv = undefined) {
  const environment = env || {};
  const authored = environment[DEV_AUTHORITATIVE_DB];
  const dbPath = typeof authored === "string" ? authored.trim() : "";
  const resolvedNodeEnv = String(nodeEnv ?? environment.NODE_ENV ?? "").trim().toLowerCase();
  const production = resolvedNodeEnv === "production";
  const flag = isTruthy(environment[DEV_MIRROR_FLAG]);
  // The dev restriction is selected by the flag alone; a missing path is a
  // fail-closed configuration error handled by the mirror, not a silent
  // fallback to real refresh.
  const mirrorOnly = flag && !production;
  return {
    mirrorOnly,
    authoritativeDbPath: dbPath || null,
    pathConfigured: dbPath.length > 0,
    flag,
    production,
  };
}

export function isMirrorOnlyRefresh(env = process.env, nodeEnv = undefined) {
  return parseRefreshPolicy(env, nodeEnv).mirrorOnly;
}

/**
 * Failure object shaped so existing callers treat dev mirror problems as an
 * unrecoverable refresh failure (never retried, never falls back to upstream).
 * @param {string} code machine code (dev_mirror_*)
 * @param {string} message non-secret, user-facing explanation
 */
export function devMirrorError(code, message) {
  return {
    error: "dev_refresh_disabled",
    code,
    message,
    unrecoverable: true,
  };
}
