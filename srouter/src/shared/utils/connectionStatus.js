import { ACCOUNT_SCOPED_ERROR_STATUSES } from "open-sse/config/errorConfig.js";

export function getStatusVariant(isActive, effectiveStatus) {
  if (isActive === false) return "default";
  if (effectiveStatus === "active" || effectiveStatus === "success") return "success";
  if (effectiveStatus === "error" || effectiveStatus === "expired" || effectiveStatus === "unavailable") return "error";
  return "default";
}

/**
 * A stored failure that belongs to ONE model, not to the account: the row still
 * serves every other model, so it must not render as "unavailable". Credential
 * statuses (401/403) stay account-level — a bad key breaks every model, and a
 * human has to replace it.
 */
export function isModelScopedError(connection) {
  if (!connection?.lastError || !connection?.lastErrorModel) return false;
  return !ACCOUNT_SCOPED_ERROR_STATUSES.has(Number(connection.errorCode));
}

/**
 * Status shown on a connection row.
 * - A live local cooldown keeps "unavailable" until the retry window ends.
 * - A MODEL-scoped failure does not: only that model failed, so the row reports
 *   the failing model next to the error text instead of painting the whole
 *   account (and provider) as down while every other model still works.
 *
 * @param {object} connection
 * @param {boolean} isCooldown - a model lock is still running
 * @returns {string|undefined}
 */
export function getEffectiveConnectionStatus(connection, isCooldown) {
  const status = connection?.testStatus;
  if (status === "unavailable" && (!isCooldown || isModelScopedError(connection))) return "active";
  return status;
}
