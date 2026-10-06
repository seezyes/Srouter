/**
 * Per-provider connection stats for the Providers grid.
 *
 * Kept as plain functions (no React) so the numbers the grid paints can be unit
 * tested: the grid only has the list from `GET /api/providers`, and it must
 * agree with what the provider detail page lists.
 *
 * `testStatus` is per-install health state stored inside a connection's JSON
 * payload, so a row can exist with no status at all. That is the normal state
 * for every freshly imported account — the 9router import deliberately drops the
 * source install's health (`VOLATILE_FIELDS` in src/lib/import/connectionMapping.js)
 * — and such a row is still a working account: routing only needs `isActive` and
 * an unexpired credential (`getProviderCredentials` in src/sse/services/auth.js).
 * So a status-less row that carries credential material (the API exposes the
 * non-secret `hasCredential` flag) is counted as `connected`, which is what made
 * imported accounts stop reading like something is wrong with them.
 *
 * `untested` survives only for the defensive case: a row with no status AND no
 * credential material at all, i.e. nothing that could serve a request.
 */

import { getErrorCode, getRelativeTime } from "@/shared/utils";
import { getEffectiveConnectionStatus as getSharedConnectionStatus } from "@/shared/utils/connectionStatus";

/** Numeric/known-code tag shown next to an error count, e.g. "429" or "AUTH". */
export function getConnectionErrorTag(connection) {
  if (!connection) return null;

  const explicitType = connection.lastErrorType;
  if (explicitType === "runtime_error") return "RUNTIME";
  if (
    explicitType === "upstream_auth_error" ||
    explicitType === "auth_missing" ||
    explicitType === "token_refresh_failed" ||
    explicitType === "token_expired"
  )
    return "AUTH";
  if (explicitType === "upstream_rate_limited") return "429";
  if (explicitType === "upstream_unavailable") return "5XX";
  if (explicitType === "network_error") return "NET";

  const numericCode = Number(connection.errorCode);
  if (Number.isFinite(numericCode) && numericCode >= 400)
    return String(numericCode);

  const fromMessage = getErrorCode(connection.lastError);
  if (fromMessage === "401" || fromMessage === "403") return "AUTH";
  if (fromMessage && fromMessage !== "ERR") return fromMessage;

  const msg = (connection.lastError || "").toLowerCase();
  if (
    msg.includes("runtime") ||
    msg.includes("not runnable") ||
    msg.includes("not installed")
  )
    return "RUNTIME";
  if (
    msg.includes("invalid api key") ||
    msg.includes("token invalid") ||
    msg.includes("revoked") ||
    msg.includes("unauthorized")
  )
    return "AUTH";

  return "ERR";
}

/**
 * A connection that is still inside a model-lock cooldown is reported as
 * "unavailable" until the lock expires, then falls back to "active".
 *
 * A MODEL-scoped failure never counts as account health (see
 * getEffectiveConnectionStatus in shared/utils/connectionStatus): only that one
 * model failed, so the provider card must not report a broken account — and a
 * broken provider — while every other model still answers.
 */
export function getEffectiveConnectionStatus(connection, now = Date.now()) {
  const isCooldown = Object.entries(connection).some(
    ([k, v]) =>
      k.startsWith("modelLock_") && v && new Date(v).getTime() > now,
  );
  return getSharedConnectionStatus(connection, isCooldown);
}

/**
 * @param {Array<object>} connections - rows from GET /api/providers
 * @param {string} providerId
 * @param {string|string[]} authType
 * @param {number} [now] - injectable clock, for tests
 */
export function computeProviderStats(connections, providerId, authType, now = Date.now()) {
  const authTypes = Array.isArray(authType) ? authType : [authType];
  const providerConnections = (connections || []).filter(
    (c) => c.provider === providerId && authTypes.includes(c.authType),
  );

  const connected = providerConnections.filter((c) => {
    // "Connected" means "can serve a request right now", so a switched-off row
    // is reported under `disabled` instead of here.
    if (c.isActive === false) return false;
    const status = getEffectiveConnectionStatus(c, now);
    if (status === "active" || status === "success") return true;
    // No status recorded yet (fresh import, or never used): the account is
    // usable as soon as it has credential material.
    return !status && c.hasCredential === true;
  }).length;

  const errorConns = providerConnections.filter((c) => {
    const status = getEffectiveConnectionStatus(c, now);
    return (
      status === "error" || status === "expired" || status === "unavailable"
    );
  });

  const error = errorConns.length;
  const total = providerConnections.length;
  // Nothing to test: no status, no credential material, so there is no account
  // to serve a request with. Kept as its own count instead of "No connections".
  const untested = providerConnections.filter((c) => {
    if (c.isActive === false) return false;
    const status = getEffectiveConnectionStatus(c, now);
    return !status && c.hasCredential !== true;
  }).length;
  const disabled = providerConnections.filter((c) => c.isActive === false).length;
  const allDisabled =
    total > 0 && providerConnections.every((c) => c.isActive === false);

  const latestError = errorConns.sort(
    (a, b) => new Date(b.lastErrorAt || 0) - new Date(a.lastErrorAt || 0),
  )[0];
  const errorCode = latestError ? getConnectionErrorTag(latestError) : null;
  const errorTime = latestError?.lastErrorAt
    ? getRelativeTime(latestError.lastErrorAt)
    : null;

  return { connected, error, errorCode, errorTime, total, untested, disabled, allDisabled };
}
