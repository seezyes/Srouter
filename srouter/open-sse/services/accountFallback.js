import {
  ERROR_RULES,
  BACKOFF_CONFIG,
  TRANSIENT_COOLDOWN_MS,
  RETRY_PROBE_BLOCK_MS,
  RETRY_PROBE_LONG_BLOCK_MS,
  RETRY_PROBE_LONG_THRESHOLD_MS,
  ERROR_VISIBILITY_TTL_MS,
  ACCOUNT_SCOPED_ERROR_STATUSES,
} from "../config/errorConfig.js";
import {
  getCircuitBreaker,
  getAllCircuitBreakerStatuses,
  resetCircuitBreaker,
  PROVIDER_FAILURE_ERROR_CODES,
} from "../utils/circuitBreaker.js";
import { classify429 } from "../utils/classify429.js";
import { getProviderResilienceProfile } from "../config/providerProfiles.js";

/**
 * Calculate exponential backoff cooldown for rate limits (429)
 * Level 1: 1s, Level 2: 2s, Level 3: 4s... → max 4 min
 * @param {number} backoffLevel - Current backoff level
 * @returns {number} Cooldown in milliseconds
 */
export function getQuotaCooldown(backoffLevel = 0) {
  const level = Math.max(0, backoffLevel - 1);
  const cooldown = BACKOFF_CONFIG.base * Math.pow(2, level);
  return Math.min(cooldown, BACKOFF_CONFIG.max);
}

/**
 * Check if error should trigger account fallback (switch to next account)
 * Config-driven: matches ERROR_RULES top-to-bottom (text rules first, then status)
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message text
 * @param {number} backoffLevel - Current backoff level for exponential backoff
 * @returns {{ shouldFallback: boolean, cooldownMs: number, newBackoffLevel?: number }}
 */
export function checkFallbackError(status, errorText, backoffLevel = 0, provider = null) {
  const lowerError = errorText
    ? (typeof errorText === "string" ? errorText : JSON.stringify(errorText)).toLowerCase()
    : "";

  for (const rule of ERROR_RULES) {
    if (rule.provider && rule.provider !== provider) continue;
    // Text-based rule: match substring in error message
    if (rule.text && lowerError && lowerError.includes(rule.text)) {
      if (rule.shouldFallback === false) {
        return { shouldFallback: false, cooldownMs: 0, isContentFilter: rule.isContentFilter === true };
      }
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs };
    }

    // Status-based rule: match HTTP status code
    if (rule.status && rule.status === status) {
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs };
    }
  }

  // Request-scoped client errors that matched no rule above: a 400 caused by the
  // request itself (context overflow, malformed body, unsupported parameter) says
  // nothing about the credential, so cooling the account down only removes a
  // healthy connection from rotation. With a single connection it is worse: every
  // later request in the window fails with a copy of this very error
  // ("all 1 accounts locked for <model> | lastError=[400]: ..."), which hides the
  // real cause from the caller and makes unrelated sessions look like they hit the
  // same limit. Hand the upstream error back for this request instead.
  // Account-scoped statuses keep their rules above (401/402/403/404/429), and the
  // text rules still win for rate-limit / quota / capacity wording.
  if (status >= 400 && status < 500 && status !== 401 && status !== 402 && status !== 403 && status !== 429) {
    return { shouldFallback: false, cooldownMs: 0 };
  }

  // Default: transient cooldown for any unmatched error
  return { shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS };
}

/**
 * Check if account is currently unavailable (cooldown not expired)
 */
export function isAccountUnavailable(unavailableUntil) {
  if (!unavailableUntil) return false;
  return new Date(unavailableUntil).getTime() > Date.now();
}

/**
 * Calculate unavailable until timestamp
 */
export function getUnavailableUntil(cooldownMs) {
  return new Date(Date.now() + cooldownMs).toISOString();
}

/**
 * Get the earliest rateLimitedUntil from a list of accounts
 * @param {Array} accounts - Array of account objects with rateLimitedUntil
 * @returns {string|null} Earliest rateLimitedUntil ISO string, or null
 */
export function getEarliestRateLimitedUntil(accounts) {
  let earliest = null;
  const now = Date.now();
  for (const acc of accounts) {
    if (!acc.rateLimitedUntil) continue;
    const until = new Date(acc.rateLimitedUntil).getTime();
    if (until <= now) continue;
    if (!earliest || until < earliest) earliest = until;
  }
  if (!earliest) return null;
  return new Date(earliest).toISOString();
}

/**
 * Format rateLimitedUntil to human-readable "reset after Xm Ys"
 * @param {string} rateLimitedUntil - ISO timestamp
 * @returns {string} e.g. "reset after 2m 30s"
 */
export function formatRetryAfter(rateLimitedUntil) {
  if (!rateLimitedUntil) return "";
  const diffMs = new Date(rateLimitedUntil).getTime() - Date.now();
  if (diffMs <= 0) return "reset after 0s";
  const totalSec = Math.ceil(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return `reset after ${parts.join(" ")}`;
}

/**
 * Patterns that indicate the Kimchi provider has exhausted its credits.
 * Specific enough to avoid matching transient errors like "exhausted all retries".
 * Matches: "exhausted its credits", "quota exhausted", "no remaining credits",
 * "insufficient credits", "payment required".
 */
const KIMCHI_QUOTA_EXHAUSTED_PATTERNS = [
  /credits?.{0,20}exhausted/i,
  /quota.{0,20}exhausted/i,
  /no remaining credits/i,
  /insufficient[ _-]?credits/i,
  /payment.{0,10}required/i,
  /has exhausted its credits/i,
];

/**
 * Detect whether an error body / message indicates Kimchi quota exhaustion.
 * Pure check — provider name passed in so this can be reused for other providers.
 * @param {string} provider - provider id (e.g. "kimchi")
 * @param {string|object} errorText - raw error body or message
 * @returns {boolean}
 */
export function isKimchiQuotaExhausted(provider, errorText) {
  if (!errorText || provider !== "kimchi") return false;
  const text = typeof errorText === "string"
    ? errorText
    : (() => { try { return JSON.stringify(errorText); } catch { return String(errorText); } })();
  return KIMCHI_QUOTA_EXHAUSTED_PATTERNS.some(p => p.test(text));
}

/**
 * Compute the next-day reset timestamp (00:00 UTC tomorrow).
 * @param {Date} [now=new Date()]
 * @returns {Date}
 */
export function getNextDayReset(now = new Date()) {
  const d = new Date(now.getTime());
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0));
}

/**
 * Build update payload that deactivates a Kimchi account due to quota exhaustion.
 * Sets testStatus="quota_exhausted" (distinguishable from manual deactivation)
 * and rateLimitedUntil to next-day reset, so the existing cooldown filters
 * skip it until then. Auto-reactivation runs on startup / periodically.
 * @param {Date} [now]
 * @returns {{ isActive: boolean, rateLimitedUntil: string, testStatus: string, lastErrorType: string, errorCode: number, quotaExhaustedAt: string }}
 */
export function buildKimchiQuotaExhaustedUpdate(now = new Date()) {
  const reset = getNextDayReset(now);
  return {
    isActive: false,
    rateLimitedUntil: reset.toISOString(),
    testStatus: "quota_exhausted",
    lastErrorType: "quota_exhausted",
    errorCode: 402,
    quotaExhaustedAt: now.toISOString(),
    quotaResetsAt: reset.toISOString(),
  };
}

/**
 * Build update payload to reactivate a quota-exhausted Kimchi account whose
 * rateLimitedUntil has passed (start of new month).
 * @returns {{ isActive: boolean, rateLimitedUntil: null, testStatus: string }}
 */
export function buildKimchiQuotaReactivatedUpdate() {
  return {
    isActive: true,
    rateLimitedUntil: null,
    testStatus: "active",
    quotaExhaustedAt: null,
    quotaResetsAt: null,
  };
}

/**
 * Detect whether a NON-Kimchi 429 error indicates a DAILY quota exhaustion
 * ("today's quota", "daily quota exhausted", "reset tomorrow", etc.).
 *
 * This generalizes beyond Kimchi's monthly quota (which keeps its own
 * isKimchiQuotaExhausted / next-month deactivation logic untouched). When a
 * daily quota is detected, the SPECIFIC model on that connection is locked
 * until tomorrow 00:00 UTC via buildDailyQuotaLockUpdate().
 *
 * Returns the classified cooldown info, or null when the error is not a
 * daily-quota 429 (e.g. it's a plain rate_limit or a Kimchi quota).
 *
 * @param {string} provider - provider id
 * @param {string|object} errorText - raw error body or message
 * @returns {{ kind: "daily_quota", cooldownMs: number } | null}
 */
export function detectDailyQuotaExhaustion(provider, errorText) {
  if (!errorText || provider === "kimchi") return null;
  const text = typeof errorText === "string"
    ? errorText
    : (() => { try { return JSON.stringify(errorText); } catch { return String(errorText); } })();
  // classify429 returns { kind, cooldownMs }. We only act on daily_quota here;
  // quota_exhausted (monthly/billing) is handled separately and rate_limit
  // is handled by the normal account cooldown/backoff path.
  const classification = classify429({ status: 429, body: text, provider });
  if (classification.kind !== "daily_quota") return null;
  return classification;
}

/**
 * Build update payload for a DAILY quota exhaustion.
 *
 * Writes the INFORMATIONAL reset field (`modelResetAt_${model}` = tomorrow
 * 00:00 UTC), not the blocking lock: the blocking window is the short retry
 * probe written by markAccountUnavailable, so a limit the provider lifts
 * earlier than announced is picked up by the next probe instead of waiting
 * out the whole day.
 *
 * @param {string} model - the model id (without provider prefix)
 * @param {Date} [now=new Date()]
 * @returns {Record<string, string>} partial update object with the reset key set
 */
export function buildDailyQuotaLockUpdate(model, now = new Date()) {
  if (!model) return {};
  const resetMs = getMsUntilTomorrowMidnightUTC(now);
  const key = getModelResetKey(model);
  return { [key]: new Date(now.getTime() + resetMs).toISOString() };
}

/** Compute ms until next UTC midnight (tomorrow 00:00 UTC). */
function getMsUntilTomorrowMidnightUTC(now = new Date()) {
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return Math.max(tomorrow.getTime() - now.getTime(), 1000);
}

/** Prefix for model lock flat fields on connection record */
export const MODEL_LOCK_PREFIX = "modelLock_";

/** Special key used when no model is known (account-level lock) */
export const MODEL_LOCK_ALL = `${MODEL_LOCK_PREFIX}__all`;

/** Build the flat field key for a model lock */
export function getModelLockKey(model) {
  return model ? `${MODEL_LOCK_PREFIX}${model}` : MODEL_LOCK_ALL;
}

/**
 * Check if a model lock on a connection is still active.
 * Reads flat field `modelLock_${model}` (or `modelLock___all` when model=null).
 */
export function isModelLockActive(connection, model) {
  const key = getModelLockKey(model);
  const expiry = connection[key] || connection[MODEL_LOCK_ALL];
  if (!expiry) return false;
  return new Date(expiry).getTime() > Date.now();
}

/**
 * Get earliest active model lock expiry across all modelLock_* fields.
 * Used for UI cooldown display.
 */
export function getEarliestModelLockUntil(connection) {
  if (!connection) return null;
  let earliest = null;
  const now = Date.now();
  for (const [key, val] of Object.entries(connection)) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !val) continue;
    const t = new Date(val).getTime();
    if (t <= now) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

/**
 * Build update object to set a model lock on a connection.
 */
export function buildModelLockUpdate(model, cooldownMs) {
  const key = getModelLockKey(model);
  return { [key]: new Date(Date.now() + cooldownMs).toISOString() };
}

// ── Informational quota reset (never blocks selection) ─────────────────────
//
// `modelResetAt_${model}` records WHEN the provider (or the classifier) says
// the limit comes back. It is display/telemetry only: selection is decided by
// the short retry probe in `modelLock_*`, so a stale announced reset can never
// keep an account unusable after the limit is really gone.

/** Prefix for informational per-model quota reset fields */
export const MODEL_RESET_PREFIX = "modelResetAt_";

/** Build the flat field key for a model reset */
export function getModelResetKey(model) {
  return model ? `${MODEL_RESET_PREFIX}${model}` : null;
}

/**
 * Build update object to record the announced quota reset for a model.
 * Returns an empty object when the value adds nothing over the retry probe.
 */
export function buildModelResetUpdate(model, cooldownMs, probeMs = 0) {
  const key = getModelResetKey(model);
  if (!key || !(cooldownMs > probeMs + 1000)) return {};
  return { [key]: new Date(Date.now() + cooldownMs).toISOString() };
}

/** Read the announced reset for a model (ISO string or null when absent/expired). */
export function getModelResetUntil(connection, model) {
  const key = getModelResetKey(model);
  if (!key || !connection?.[key]) return null;
  const t = new Date(connection[key]).getTime();
  return t > Date.now() ? connection[key] : null;
}

/** Earliest announced reset across all modelResetAt_* fields (UI display). */
export function getEarliestModelResetUntil(connection) {
  if (!connection) return null;
  let earliest = null;
  const now = Date.now();
  for (const [key, val] of Object.entries(connection)) {
    if (!key.startsWith(MODEL_RESET_PREFIX) || !val) continue;
    const t = new Date(val).getTime();
    if (t <= now) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

/**
 * Blocking window for a LIMIT cooldown: how long a repeat attempt stays local
 * before the router probes the upstream for real. Never longer than the
 * cooldown itself, so a cooldown shorter than the probe window is unchanged.
 *
 * @param {number} cooldownMs - semantic cooldown from classify429/rules
 * @returns {number} blocking window in ms
 */
export function resolveProbeBlockMs(cooldownMs) {
  if (!(cooldownMs > 0)) return 0;
  const window = cooldownMs > RETRY_PROBE_LONG_THRESHOLD_MS
    ? RETRY_PROBE_LONG_BLOCK_MS
    : RETRY_PROBE_BLOCK_MS;
  return Math.min(cooldownMs, window);
}

// ── Stale error state ──────────────────────────────────────────────────────
//
// lastError/testStatus are written on failure and only cleared by a later
// success, so an account that is simply not used again kept showing
// "unavailable" forever (until a proxy restart). Visibility now expires by
// failure class, and a per-model failure expires together with its retry probe;
// the stored row is left untouched until some write replaces it.

/**
 * Visibility TTL for a stored failure, by failure class.
 * @param {number|null} errorCode - HTTP status stored with the failure
 * @returns {number} ms the error stays visible
 */
export function getErrorVisibilityTtlMs(errorCode) {
  const status = Number(errorCode);
  if (ACCOUNT_SCOPED_ERROR_STATUSES.has(status)) return ERROR_VISIBILITY_TTL_MS.credential;
  if (status === 429) return ERROR_VISIBILITY_TTL_MS.quota;
  if (status >= 400 && status < 600) return ERROR_VISIBILITY_TTL_MS.transient;
  return ERROR_VISIBILITY_TTL_MS.default;
}

/**
 * Whether a stored failure belongs to a MODEL rather than to the account.
 * A model-scoped failure is visible only while that model's blocking retry
 * window runs: the account keeps serving every other model, so the row must not
 * claim the account is down. Credential statuses stay account-level — a bad key
 * breaks every model and a human has to fix it.
 *
 * @param {object} connection
 * @returns {boolean}
 */
export function isModelScopedError(connection) {
  if (!connection?.lastError || !connection?.lastErrorModel) return false;
  return !ACCOUNT_SCOPED_ERROR_STATUSES.has(Number(connection.errorCode));
}

/**
 * Return a copy of a connection with expired health state removed:
 * - stale lastError/errorCode/lastErrorAt/lastErrorModel while the connection
 *   is in the FAILURE state (testStatus "unavailable"). A MODEL-scoped failure
 *   (see isModelScopedError) expires as soon as its blocking retry window is
 *   over — the account is fine, only that model failed, and the next request
 *   probes it for real. Account-scoped failures expire by class TTL,
 * - expired modelLock_* / modelResetAt_* flat fields,
 * - testStatus "unavailable" reset to "active" once nothing is active.
 *
 * Soft warnings on an active account are intentional test results and are left
 * alone. Pure: the caller decides whether to persist the result. Used on read
 * so the dashboard and the router never act on an error the account already
 * outlived.
 *
 * @param {object} connection
 * @param {number} [nowMs=Date.now()]
 * @returns {object} same shape, stale fields cleared (input untouched)
 */
export function stripStaleErrorState(connection, nowMs = Date.now()) {
  if (!connection || typeof connection !== "object") return connection;
  const keys = Object.keys(connection);
  const hasLockFields = keys.some((k) => k.startsWith(MODEL_LOCK_PREFIX) || k.startsWith(MODEL_RESET_PREFIX));
  if (!hasLockFields && !connection.lastError && !connection.lastErrorAt && connection.testStatus !== "unavailable") {
    return connection;
  }

  const next = { ...connection };
  let changed = false;

  // Read the probe from the RAW connection: the loop below nulls expired locks.
  const modelScopedError = isModelScopedError(connection);
  const errorLockActive = modelScopedError
    ? new Date(connection[`${MODEL_LOCK_PREFIX}${connection.lastErrorModel}`] || 0).getTime() > nowMs
    : false;

  for (const key of keys) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) && !key.startsWith(MODEL_RESET_PREFIX)) continue;
    const expiry = next[key];
    if (!expiry) continue;
    const t = new Date(expiry).getTime();
    if (!(t > nowMs)) {
      next[key] = null;
      changed = true;
    }
  }

  const errorAt = connection.lastErrorAt ? new Date(connection.lastErrorAt).getTime() : null;
  const errorAge = errorAt === null ? null : nowMs - errorAt;
  // Only the FAILURE state expires. A soft warning on an active account
  // ("Connected, but credits are exhausted") is an intentional test result and
  // survives, as before.
  const staleError = connection.testStatus === "unavailable"
    && connection.lastError
    && (modelScopedError
      ? !errorLockActive
      : (errorAge === null || errorAge > getErrorVisibilityTtlMs(connection.errorCode)));

  if (staleError) {
    next.lastError = null;
    next.errorCode = null;
    next.lastErrorAt = null;
    next.lastErrorModel = null;
    changed = true;
  }

  const activeLock = keys.some((k) => {
    if (!k.startsWith(MODEL_LOCK_PREFIX)) return false;
    const expiry = next[k];
    return !!expiry && new Date(expiry).getTime() > nowMs;
  });
  if (connection.testStatus === "unavailable" && !activeLock && (staleError || !connection.lastError)) {
    next.testStatus = "active";
    changed = true;
  }

  return changed ? next : connection;
}

/**
 * Build update object to clear all model locks and resets on a connection.
 */
export function buildClearModelLocksUpdate(connection) {
  const cleared = {};
  for (const key of Object.keys(connection)) {
    if (key.startsWith(MODEL_LOCK_PREFIX) || key.startsWith(MODEL_RESET_PREFIX)) cleared[key] = null;
  }
  return cleared;
}

/**
 * Filter available accounts (not in cooldown)
 */
export function filterAvailableAccounts(accounts, excludeId = null) {
  const now = Date.now();
  return accounts.filter(acc => {
    if (excludeId && acc.id === excludeId) return false;
    if (acc.rateLimitedUntil) {
      const until = new Date(acc.rateLimitedUntil).getTime();
      if (until > now) return false;
    }
    return true;
  });
}

/**
 * Reset account state when request succeeds
 * Clears cooldown and resets backoff level to 0
 * @param {object} account - Account object
 * @returns {object} Updated account with reset state
 */
export function resetAccountState(account) {
  if (!account) return account;
  return {
    ...account,
    rateLimitedUntil: null,
    backoffLevel: 0,
    lastError: null,
    status: "active"
  };
}

/**
 * Apply error state to account
 * @param {object} account - Account object
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message
 * @returns {object} Updated account with error state
 */
export function applyErrorState(account, status, errorText) {
  if (!account) return account;

  const backoffLevel = account.backoffLevel || 0;
  const { cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel);

  return {
    ...account,
    rateLimitedUntil: cooldownMs > 0 ? getUnavailableUntil(cooldownMs) : null,
    backoffLevel: newBackoffLevel ?? backoffLevel,
    lastError: { status, message: errorText, timestamp: new Date().toISOString() },
    status: "error"
  };
}

/**
 * Check if a provider proxy bucket is currently in circuit-breaker cooldown.
 * Proxy-aware: each proxy bucket has its own breaker so one dead proxy
 * doesn't block accounts on a different proxy.
 */
export function isProviderInCooldown(provider, proxyHash = "direct") {
  if (!provider) return false;
  const breaker = getCircuitBreaker(`${provider}:${proxyHash}`);
  return breaker ? !breaker.canExecute() : false;
}

/**
 * Get remaining retry-after time for a provider breaker (ms).
 * Proxy-aware.
 */
export function getProviderCooldownRemainingMs(provider, proxyHash = "direct") {
  if (!provider) return null;
  const breaker = getCircuitBreaker(`${provider}:${proxyHash}`);
  if (!breaker || breaker.canExecute()) return null;
  const remaining = breaker.getRetryAfterMs();
  return remaining > 0 ? remaining : null;
}

/**
 * Get the circuit breaker state for a provider.
 * Proxy-aware.
 */
export function getProviderBreakerState(provider, proxyHash = "direct") {
  if (!provider) return null;
  const breaker = getCircuitBreaker(`${provider}:${proxyHash}`);
  return breaker?.getStatus?.() ?? null;
}

/**
 * Record a provider failure against the shared circuit breaker.
 * Deduplicates rapid-fire failures from the same connection within 5s.
 * Proxy-aware: failures are attributed to the specific proxy bucket.
 */
const _lastProviderFailure = new Map();
const _dedupMs = 5_000;
const _dedupMaxSize = 10_000; // cap to prevent unbounded growth

/**
 * Clear the provider-failure dedup map. Used by tests and full resets.
 */
export function clearProviderFailureDedup() {
  _lastProviderFailure.clear();
}

export function recordProviderFailure(provider, statusCode, errorText, log, connectionId, proxyHash = "direct") {
  if (!provider) return;

  // Deduplicate
  if (connectionId) {
    const dedupKey = `${provider}:${proxyHash}:${connectionId}`;
    const now = Date.now();
    const last = _lastProviderFailure.get(dedupKey);
    if (last && now - last < _dedupMs) return;
    _lastProviderFailure.set(dedupKey, now);
    // Evict oldest entries when over the cap to prevent unbounded memory growth
    if (_lastProviderFailure.size > _dedupMaxSize) {
      const evictCount = Math.floor(_dedupMaxSize / 10);
      const keysToEvict = Array.from(_lastProviderFailure.keys()).slice(0, evictCount);
      for (const key of keysToEvict) _lastProviderFailure.delete(key);
    }
  }

  // Only count failure-eligible status codes
  if (statusCode && !PROVIDER_FAILURE_ERROR_CODES.has(statusCode)) return;

  const profile = getProviderResilienceProfile(provider);
  const breakerKey = `${provider}:${proxyHash}`;
  const breaker = getCircuitBreaker(breakerKey, {
    failureThreshold: profile.providerFailureThreshold,
    failureWindowMs: profile.providerFailureWindowMs,
    resetTimeout: profile.providerCooldownMs,
  });
  if (!breaker) return;
  if (!breaker.canExecute()) return; // already OPEN, skip

  breaker._onFailure({ statusCode, message: errorText });

  if (!breaker.canExecute()) {
    log?.warn?.(`[ProviderFailure] ${breakerKey}: circuit breaker opened after ${breaker.failureCount} failures`);
  }
}

/**
 * Reset the shared provider breaker for a proxy bucket.
 * Proxy-aware.
 */
export function clearProviderFailure(provider, proxyHash = "direct") {
  if (!provider) return;
  resetCircuitBreaker(`${provider}:${proxyHash}`);
}

/**
 * Check if a status code should count toward provider failure threshold.
 */
export function isProviderFailureCode(status) {
  return PROVIDER_FAILURE_ERROR_CODES.has(status);
}

/**
 * Get all providers currently blocked by the circuit breaker.
 */
export function getProvidersInCooldown() {
  return getAllCircuitBreakerStatuses()
    .filter((s) => {
      const breaker = getCircuitBreaker(s.name);
      return Boolean(breaker && !breaker.canExecute());
    })
    .map((s) => ({
      provider: s.name,
      failureCount: s.failureCount,
      cooldownRemainingMs: s.retryAfterMs || null,
      lastFailureAt: s.lastFailureTime,
    }));
}

/**
 * Pipeline gate: returns true if the circuit breaker is OPEN for ALL known proxy
 * buckets of a provider. When true, the request should short-circuit BEFORE any
 * credential lookup — no point querying the DB when every bucket is blocked.
 * If even one proxy bucket can execute, returns false so the credential loop can
 * try accounts on that bucket.
 */
export function isProviderFullyBlocked(provider) {
  if (!provider) return false;
  const all = getAllCircuitBreakerStatuses();
  // Collect breaker names matching this provider: `${provider}:${proxyHash}`
  const providerBreakers = all.filter((s) => {
    const name = s.name || "";
    return name === provider || name.startsWith(`${provider}:`);
  });
  if (providerBreakers.length === 0) return false; // no breakers registered → not blocked
  // Blocked only if EVERY registered bucket is OPEN (canExecute=false)
  return providerBreakers.every((s) => {
    const breaker = getCircuitBreaker(s.name);
    return Boolean(breaker && !breaker.canExecute());
  });
}

/**
 * Get the shortest remaining cooldown across all proxy buckets for a provider.
 * Used to populate Retry-After when the pipeline gate blocks.
 */
export function getProviderShortestCooldownMs(provider) {
  if (!provider) return 0;
  const all = getAllCircuitBreakerStatuses();
  let shortest = Infinity;
  for (const s of all) {
    const name = s.name || "";
    if (name !== provider && !name.startsWith(`${provider}:`)) continue;
    const breaker = getCircuitBreaker(s.name);
    if (breaker && !breaker.canExecute()) {
      const remaining = breaker.getRetryAfterMs();
      if (remaining > 0 && remaining < shortest) shortest = remaining;
    }
  }
  return shortest === Infinity ? 0 : shortest;
}

/**
 * Returns true when an error signals that the entire provider quota
 * is exhausted (not just one account) so the combo router can skip
 * remaining targets from the same provider.
 */
export function isProviderExhaustedReason(result) {
  if (!result) return false;
  const reason = typeof result === "string" ? result : (result.reason || result.error || "");
  const text = typeof reason === "string" ? reason : JSON.stringify(reason);
  // Specific patterns only — avoid false positives on transient errors that
  // happen to contain the word "exhausted" (e.g. "exhausted all retries").
  return /credits?.{0,20}exhausted|quota.{0,20}exhausted|no remaining credits|insufficient.{0,20}credits|payment.{0,10}required|quota.{0,20}exceeded|rate.?limit.{0,20}reached/i.test(text);
}
