// Dev-only credential mirror (T-0037).
//
// In a dev instance configured by ../SrouterDev/SrouterDev.ps1 the engine never
// refreshes rotating provider tokens. When a refresh is needed, this module
// copies the *current* credentials of the matching connection from the
// authoritative instance's SQLite database, read-only, and hands them back to
// the existing persistence paths (which write only to the dev DATA_DIR).
//
// Guarantees:
// - The authoritative database is opened read-only; nothing is ever written.
// - Only one matching row (connection id + provider) is read; the rest of the
//   database is not copied.
// - Only credential/expiry/credential-metadata fields are returned. Dev-local
//   configuration (for example providerSpecificData.serviceTier or baseUrl) is
//   preserved.
// - Missing, mismatched, stale or unreadable authoritative credentials fail
//   closed with a non-secret error; the provider is never contacted.
//
// Importing this module registers the mirror with the engine
// (open-sse/services/refreshPolicy.js).

import fs from "node:fs";
import path from "node:path";
import {
  registerCredentialMirror,
  parseRefreshPolicy,
  devMirrorError,
} from "open-sse/services/refreshPolicy.js";

// Provider-specific credential metadata that describes *which* account/token
// the authoritative instance currently holds. Anything not listed here stays
// owned by the dev instance to preserve its local configuration.
const CREDENTIAL_METADATA_KEYS = [
  "chatgptAccountId",
  "workspaceId",
  "accountId",
  "username",
  "githubLogin",
  "githubEmail",
  "githubName",
  "deviceId",
  "resourceUrl",
  "copilotToken",
  "copilotTokenExpiresAt",
];

function parseTimeMs(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? (value < 1e12 ? value * 1000 : value) : null;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

// Trusted SQLite columns must stay authoritative. A malformed or hostile `data`
// blob may not override the id/provider/authType that matched this row.
function rowToCredential(row) {
  if (!row) return null;
  let extra = {};
  try {
    extra = JSON.parse(row.data || "{}");
  } catch {
    extra = {};
  }
  return {
    ...extra,
    id: row.id,
    provider: row.provider,
    authType: row.authType,
  };
}

function resolveConnectionId(credentials) {
  const id = credentials?.connectionId || credentials?.id;
  return typeof id === "string" && id ? id : null;
}

function normalizeAuthType(value) {
  return String(value ?? "").trim().toLowerCase().replace(/_/g, "");
}

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

// The authoritative source must never resolve inside this dev instance's data
// directory (including Windows case aliases and symlink/junction aliases).
function isSelfReference(authoritativePath, dataDir) {
  if (!dataDir) return false;
  return isPathInside(bestEffortRealPath(authoritativePath), bestEffortRealPath(dataDir));
}

const EXPIRY_CLOCK_SKEW_MS = 60 * 1000;

/**
 * Decide whether the authoritative credentials are safely newer than this dev
 * copy. Never reads or compares secret material; uses only persisted freshness
 * provenance (lastRefreshAt and/or token expiry).
 * @returns {{ ok: boolean, reason: "expired"|"invalid"|"stale"|null }}
 */
function adjudicateFreshness(devCredentials, mainCredential, nowMs) {
  const mainLast = parseTimeMs(
    mainCredential.lastRefreshAt ?? mainCredential.providerSpecificData?.lastRefreshAt
  );
  const devLast = parseTimeMs(
    devCredentials?.lastRefreshAt ?? devCredentials?.providerSpecificData?.lastRefreshAt
  );
  const expiryValue = mainCredential.expiresAt ?? mainCredential.tokenExpiresAt;
  const mainExpiry = parseTimeMs(expiryValue);
  const devExpiry = parseTimeMs(devCredentials?.expiresAt ?? devCredentials?.tokenExpiresAt);

  // A malformed declared expiry is not evidence of a usable token, even when
  // its refresh timestamp is newer. Missing expiry is a separate provider case.
  if (expiryValue !== undefined && expiryValue !== null && mainExpiry === null) {
    return { ok: false, reason: "invalid" };
  }

  // A present-but-expired authoritative token is unusable even if a timestamp
  // looks newer. Do not accept it; do not tolerate skew into the past.
  if (mainExpiry !== null && mainExpiry <= nowMs) {
    return { ok: false, reason: "expired" };
  }

  // Freshness provenance: a strictly newer refresh timestamp, or a strictly
  // newer token expiry. Freshly authorized credentials may legitimately lack
  // lastRefreshAt, so an identifiable newer future expiry is sufficient.
  const lastNewer = mainLast !== null && (devLast === null || mainLast > devLast);
  const expiryNewer =
    mainExpiry !== null &&
    (devExpiry === null || mainExpiry > devExpiry + EXPIRY_CLOCK_SKEW_MS);

  if (!lastNewer && !expiryNewer) {
    return { ok: false, reason: "stale" };
  }
  return { ok: true, reason: null };
}

function buildMirrorResult(devCredentials, mainCredential) {
  const result = {};
  if (mainCredential.accessToken) result.accessToken = mainCredential.accessToken;
  if (mainCredential.refreshToken) result.refreshToken = mainCredential.refreshToken;
  if (mainCredential.idToken) result.idToken = mainCredential.idToken;
  const mainExpiry = mainCredential.expiresAt ?? mainCredential.tokenExpiresAt;
  if (mainExpiry) result.expiresAt = mainExpiry;
  if (mainCredential.lastRefreshAt) result.lastRefreshAt = mainCredential.lastRefreshAt;

  const nextSpecific = { ...(devCredentials?.providerSpecificData || {}) };
  const mainSpecific = mainCredential.providerSpecificData || {};
  for (const key of CREDENTIAL_METADATA_KEYS) {
    if (mainSpecific[key] !== undefined) nextSpecific[key] = mainSpecific[key];
  }
  if (Object.keys(nextSpecific).length > 0) result.providerSpecificData = nextSpecific;

  result.mirroredFrom = "authoritative";
  return result;
}

/**
 * Mirror credentials from the authoritative instance. Never contacts a provider.
 * @param {string} provider
 * @param {object} credentials dev-side credentials (must include connectionId)
 * @param {object} [log]
 * @returns {Promise<object>} refresh-shaped credentials or a devMirrorError
 */
export async function mirrorCredentialsFromAuthoritative(provider, credentials, log) {
  const policy = parseRefreshPolicy();
  if (!policy.mirrorOnly) {
    return devMirrorError(
      "dev_mirror_inactive",
      "Dev refresh is disabled and the credential mirror is not active."
    );
  }

  const connectionId = resolveConnectionId(credentials);
  if (!connectionId) {
    log?.warn?.("TOKEN_REFRESH", "Dev mirror skipped: no connection id to match");
    return devMirrorError(
      "dev_mirror_unidentified",
      "Dev refresh is disabled and this connection cannot be matched to the authoritative instance."
    );
  }

  // Config validation happens before any path.resolve/fs.existsSync. A blank
  // path is a hard configuration error — never a silent real refresh.
  if (!policy.pathConfigured || !policy.authoritativeDbPath) {
    log?.warn?.("TOKEN_REFRESH", `Dev mirror misconfigured (provider=${provider}, code=dev_mirror_config)`);
    return devMirrorError(
      "dev_mirror_config",
      "Dev refresh is disabled and no authoritative credentials database is configured."
    );
  }

  const dbPath = policy.authoritativeDbPath;
  if (isSelfReference(dbPath, process.env.DATA_DIR)) {
    return devMirrorError(
      "dev_mirror_self",
      "Dev refresh is disabled; the authoritative database must not be the dev data directory."
    );
  }
  if (!fs.existsSync(dbPath)) {
    log?.warn?.("TOKEN_REFRESH", `Dev mirror source missing (provider=${provider}, code=dev_mirror_missing)`);
    return devMirrorError(
      "dev_mirror_missing",
      "Dev refresh is disabled and the authoritative credentials database is not available."
    );
  }

  let db = null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare("SELECT id, provider, authType, data FROM providerConnections WHERE id = ? AND provider = ?")
      .get(connectionId, provider);
    if (!row) {
      return devMirrorError(
        "dev_mirror_missing",
        "Dev refresh is disabled and no matching connection exists in the authoritative instance."
      );
    }

    const main = rowToCredential(row);
    const mainAuthType = normalizeAuthType(main.authType);
    const devAuthType = credentials?.authType ? normalizeAuthType(credentials.authType) : null;

    // Never copy an API-key row into an OAuth dev connection, and never cross an
    // explicit authType mismatch.
    if (mainAuthType === "apikey" || (devAuthType !== null && mainAuthType !== devAuthType)) {
      return devMirrorError(
        "dev_mirror_mismatch",
        "Dev refresh is disabled and the authoritative connection type does not match this connection."
      );
    }

    if (!main.accessToken) {
      return devMirrorError(
        "dev_mirror_missing",
        "Dev refresh is disabled and the authoritative connection has no access token."
      );
    }

    const freshness = adjudicateFreshness(credentials, main, Date.now());
    if (!freshness.ok) {
      return devMirrorError(
        "dev_mirror_stale",
        freshness.reason === "expired"
          ? "Dev refresh is disabled and the authoritative access token is expired; refresh the authoritative instance first."
          : freshness.reason === "invalid"
          ? "Dev refresh is disabled and the authoritative access token expiry is invalid."
          : "Dev refresh is disabled and the authoritative credentials are not newer than this instance; refresh the authoritative instance first."
      );
    }

    log?.info?.("TOKEN_REFRESH", `Dev credentials mirrored from authoritative (provider=${provider})`);
    return buildMirrorResult(credentials, main);
  } catch {
    // Deliberately do not log the SQLite error/path or any credential material.
    log?.warn?.("TOKEN_REFRESH", `Dev mirror failed (provider=${provider}, code=dev_mirror_error)`);
    return devMirrorError(
      "dev_mirror_error",
      "Dev refresh is disabled and reading the authoritative credentials failed."
    );
  } finally {
    try {
      db?.close?.();
    } catch {
      /* ignore */
    }
  }
}

// Self-register the mirror so any application import of this file enables the
// dev-only path. Without it, mirror-only mode fails closed in the engine.
registerCredentialMirror(mirrorCredentialsFromAuthoritative);

export default mirrorCredentialsFromAuthoritative;
