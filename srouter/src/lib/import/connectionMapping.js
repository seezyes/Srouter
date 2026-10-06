// Map a foreign (9router) `providerConnections` row onto the input shape
// accepted by `createProviderConnection` in src/lib/db/repos/connectionsRepo.js.
//
// The row is (provider, authType, name, email, priority, isActive) plus a JSON
// `data` column holding the credentials (apiKey / OAuth tokens /
// providerSpecificData). `createProviderConnection` spreads unknown keys of its
// input into the `data` column, so the mapped object is simply
// { ...credentialData, provider, authType, name, email, priority, isActive }.

import crypto from "node:crypto";
import { parseJson } from "@/lib/db/helpers/jsonCol.js";
import { maskSecret } from "./secretMask.js";

export const VALID_AUTH_TYPES = ["oauth", "apikey", "access_token"];

// Per-install runtime state. It describes the SOURCE install's health, not the
// account, so importing it would mark brand-new local accounts as failed /
// rate-limited / model-locked.
export const VOLATILE_FIELDS = new Set([
  "testStatus",
  "lastTested",
  "lastError",
  "lastErrorAt",
  // Which model the imported error belonged to travels with that error.
  "lastErrorModel",
  "lastErrorType",
  "errorCode",
  "backoffLevel",
  "rateLimitedUntil",
  "quotaExhaustedAt",
  "consecutiveUseCount",
  "lastPingedResetAt",
  "lastPingedResetKey",
  "lastPingAt",
]);

// Connection-scoped networking. Proxy pools themselves live in the source
// database and are not imported, so a copied `proxyPoolId` would dangle and a
// copied legacy `connectionProxyUrl` (typically a local port on the other
// install) would silently reroute every request through a proxy that may not
// exist here.
export const PROXY_SCOPED_FIELDS = new Set([
  "proxyPoolId",
  "proxyPoolIds",
  "proxyRotationStrategy",
  "proxyPoolScope",
  "targetProxyPoolIds",
  "connectionProxyEnabled",
  "connectionProxyUrl",
  "connectionNoProxy",
  "strictProxy",
]);

const MODEL_LOCK_PREFIX = "modelLock_";

function asStringOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length ? text : null;
}

function asPriority(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Normalize one source row (SQLite shape, `data` may be a JSON string or an
 * already-parsed object) into a flat descriptor.
 */
export function normalizeSourceConnection(raw) {
  const data = parseJson(raw?.data, {});
  return {
    sourceId: asStringOrNull(raw?.id),
    provider: asStringOrNull(raw?.provider),
    authType: asStringOrNull(raw?.authType) || "oauth",
    name: asStringOrNull(raw?.name),
    email: asStringOrNull(raw?.email),
    priority: asPriority(raw?.priority),
    isActive: raw?.isActive === 1 || raw?.isActive === true || raw?.isActive === "1",
    data: data && typeof data === "object" && !Array.isArray(data) ? data : {},
  };
}

function stripInstanceState(data) {
  const dropped = [];
  const credential = {};
  for (const [key, value] of Object.entries(data)) {
    if (VOLATILE_FIELDS.has(key) || key.startsWith(MODEL_LOCK_PREFIX)) {
      dropped.push(key);
      continue;
    }
    credential[key] = value;
  }
  const providerSpecificData = credential.providerSpecificData;
  if (providerSpecificData && typeof providerSpecificData === "object" && !Array.isArray(providerSpecificData)) {
    const kept = {};
    for (const [key, value] of Object.entries(providerSpecificData)) {
      if (PROXY_SCOPED_FIELDS.has(key)) {
        dropped.push(`providerSpecificData.${key}`);
        continue;
      }
      kept[key] = value;
    }
    if (Object.keys(kept).length) credential.providerSpecificData = kept;
    else delete credential.providerSpecificData;
  }
  return { credential, dropped };
}

/**
 * Build the payload for `createProviderConnection`.
 * Returns { ok: true, payload, preview, notes } or { ok: false, reason }.
 */
export function mapSourceConnection(raw, index = 0) {
  const normalized = normalizeSourceConnection(raw);
  if (!normalized.provider) return { ok: false, reason: "source row has no provider" };
  if (!VALID_AUTH_TYPES.includes(normalized.authType)) {
    return { ok: false, reason: `unsupported authType "${normalized.authType}"` };
  }

  const { credential, dropped } = stripInstanceState(normalized.data);
  const hasApiKey = typeof credential.apiKey === "string" && credential.apiKey.length > 0;
  const hasAccessToken = typeof credential.accessToken === "string" && credential.accessToken.length > 0;
  const hasRefreshToken = typeof credential.refreshToken === "string" && credential.refreshToken.length > 0;
  if (!hasApiKey && !hasAccessToken && !hasRefreshToken) {
    return { ok: false, reason: "no reusable credential (apiKey/accessToken/refreshToken) in source row" };
  }

  // `createProviderConnection` only dedups api-key rows when a name is present,
  // so a nameless row would be re-inserted on every import. Derive a stable
  // name from the source id to keep re-imports idempotent.
  let name = normalized.name;
  if (!name && normalized.authType === "apikey") {
    const suffix = (normalized.sourceId || `row${index}`).replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || `row${index}`;
    name = `${normalized.provider} ${suffix}`;
  }

  const payload = {
    ...credential,
    provider: normalized.provider,
    authType: normalized.authType,
    isActive: normalized.isActive,
  };
  if (name) payload.name = name;
  if (normalized.email) payload.email = normalized.email;
  if (normalized.priority !== null) payload.priority = normalized.priority;

  const notes = [];
  if (dropped.length) {
    const shown = dropped.slice(0, 6).join(", ");
    notes.push(`per-install state not imported: ${shown}${dropped.length > 6 ? `, +${dropped.length - 6} more` : ""}`);
  }

  return {
    ok: true,
    payload,
    providerSpecificDataKeys: Object.keys(payload.providerSpecificData || {}),
    notes,
    credentialPreview: {
      apiKey: hasApiKey ? maskSecret(credential.apiKey) : null,
      accessToken: hasAccessToken ? maskSecret(credential.accessToken) : null,
      refreshToken: hasRefreshToken ? maskSecret(credential.refreshToken) : null,
      expiresAt: typeof credential.expiresAt === "string" ? credential.expiresAt : null,
      hasApiKey,
      hasAccessToken,
      hasRefreshToken,
    },
  };
}

/** Identity-free fingerprint of the credential material (for idempotency checks). */
export function credentialFingerprint(source) {
  const parts = ["apiKey", "accessToken", "refreshToken", "idToken"].map((field) => {
    const value = source?.[field];
    return typeof value === "string" ? value : "";
  });
  return crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

/**
 * Read-only mirror of the matching rules in
 * src/lib/db/repos/connectionsRepo.js `createProviderConnection`.
 *
 * Kept deliberately in sync with that function: the preview predicts
 * create-vs-update with it, while the actual write still goes through
 * `createProviderConnection` (which re-applies the same rules). The unit test
 * `preview predictions match the repo's real dedup behaviour` pins the mirror.
 */
export function matchesExistingConnection(candidate, existing) {
  if (!candidate || !existing) return false;
  if (existing.provider !== candidate.provider) return false;

  if (candidate.authType === "oauth" && candidate.email) {
    if (existing.authType !== "oauth" || existing.email !== candidate.email) return false;

    const incomingWorkspaceId = candidate.providerSpecificData?.chatgptAccountId;
    const existingWorkspaceId = existing.providerSpecificData?.chatgptAccountId;

    // Codex issues several OAuth grants per email — only collapse when both
    // rows expose the same ChatGPT account id.
    if (candidate.provider === "codex") {
      return !!incomingWorkspaceId && !!existingWorkspaceId && incomingWorkspaceId === existingWorkspaceId;
    }
    if (incomingWorkspaceId && existingWorkspaceId) return incomingWorkspaceId === existingWorkspaceId;
    if (incomingWorkspaceId && !existingWorkspaceId) return false;
    if (!incomingWorkspaceId && existingWorkspaceId) return false;

    const incomingUsername = candidate.providerSpecificData?.username;
    const existingUsername = existing.providerSpecificData?.username;
    if (incomingUsername && existingUsername) return incomingUsername === existingUsername;
    if (incomingUsername || existingUsername) return false;
    return true;
  }

  if (candidate.authType === "apikey" && candidate.name) {
    return existing.authType === "apikey" && existing.name === candidate.name;
  }

  // access_token rows are never deduped by the repo (the user manages duplicates).
  return false;
}
