import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings, getProxyPools, getApiKeyByKey } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, buildModelResetUpdate, resolveProbeBlockMs, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { classify429 } from "open-sse/utils/classify429.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { getAntigravityQuotaCache } from "./antigravityQuota.js";
import * as log from "../utils/logger.js";
import { getProviderFeatures } from "open-sse/config/providerFeatures.js";

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();

const GITHUB_MONTHLY_USAGE_LIMIT = "you've reached your additional usage limit for your plan";

function githubMonthlyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null;
  if (!String(errorText || "").toLowerCase().includes(GITHUB_MONTHLY_USAGE_LIMIT)) return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

/**
 * Freebuff locks one account to one model for the life of its session, so
 * "strict model assignment" lets the user pin each account to a model and have
 * the selector skip accounts that belong to a different one.
 */
export function filterConnectionsForModel(providerId, connections, model, settings = {}) {
  const override = (settings.providerStrategies || {})[providerId] || {};
  if (providerId !== "freebuff" || override.strictModelAssignment !== true || !model) return connections;
  return connections.filter((connection) => {
    const data = connection.providerSpecificData || {};
    const assignedModel = Object.prototype.hasOwnProperty.call(data, "assignedModel")
      ? data.assignedModel
      : (providerId === "freebuff" ? data.freebuffModel : null);
    return assignedModel === model;
  });
}

/**
 * Account pools (provider-scoped, settings key `accountPools`).
 *
 * A pool groups accounts and declares the models it may serve. For a request of
 * model M the candidates are:
 *   1. accounts whose `providerSpecificData.accountPoolId` points at a pool
 *      whose model group includes M, and
 *   2. accounts that belong to no pool at all (fallback) — a deleted/unknown
 *      pool id is treated as "no pool".
 * Accounts pinned to a pool that does not list M are skipped, which is what
 * lets two accounts in two pools serve two disjoint model groups.
 *
 * Strict no-op: when the provider has no pools configured (the default), or the
 * request carries no model, the input array is returned untouched.
 *
 * An optional per-account `providerSpecificData.assignedModels` array further
 * narrows one account inside its pool (same shape as the freebuff model pin).
 */
export function filterConnectionsForAccountPools(providerId, connections, model, settings = {}) {
  if (!getProviderFeatures(providerId, settings).accountPools) return connections;
  const pools = (settings.accountPools || {})[providerId];
  if (!Array.isArray(pools) || pools.length === 0 || !model) return connections;

  const modelsByPoolId = new Map();
  for (const pool of pools) {
    if (!pool?.id) continue;
    modelsByPoolId.set(pool.id, Array.isArray(pool.models) ? pool.models : []);
  }
  if (modelsByPoolId.size === 0) return connections;

  return connections.filter((connection) => {
    const data = connection.providerSpecificData || {};

    const poolId = data.accountPoolId;
    if (poolId && modelsByPoolId.has(poolId) && !modelsByPoolId.get(poolId).includes(model)) {
      return false;
    }

    const assignedModels = data.assignedModels;
    if (Array.isArray(assignedModels) && assignedModels.length > 0 && !assignedModels.includes(model)) {
      return false;
    }

    return true;
  });
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  const requestedModel = options?.requestedModel || model;
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const poolIds = allPools.filter(p => p.proxyUrl).map(p => p.id);
        const scope = `${providerId}::${model || "*"}`;
        pickedId = pickProxyPoolId(poolIds, strategy, providerId, { scope });
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      const selectedPoolIds = strategy !== "none"
        ? (await getProxyPools({ isActive: true })).filter((p) => p.proxyUrl).map((p) => p.id)
        : [];
      return {
        id: "noauth",
        accountCount: 1,
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
          proxyPoolId: resolvedProxy.proxyPoolId || null,
          strictProxy: resolvedProxy.strictProxy === true,
          noFitPool: resolvedProxy.noFitPool === true,
          proxyPoolIds: selectedPoolIds,
          proxyRotationStrategy: strategy,
          proxyPoolScope: `${providerId}::${model || "*"}`,
        },
      };
    }

    let connections = await getProviderConnections({ provider: providerId, isActive: true });
    const settings = await getSettings();
    const totalConnections = connections.length;
    connections = filterConnectionsForModel(providerId, connections, model, settings);
    // Account pools: no-op unless the user created pools for this provider.
    // Trusted internal probes (dashboard model diagnostics) skip the pool filter on
    // purpose: a freshly added custom model is not in any pool yet, and pool
    // membership would otherwise hide every active account ("No active
    // credentials"). The option is never derived from client-controllable input —
    // callers must have passed isTrustedInternalProbe() first. Normal traffic and
    // every other option (exclude set, model locks, account health) are unchanged.
    if (options?.ignoreAccountPools === true) {
      log.debug("AUTH", `${provider} | internal probe: account-pool filtering skipped (${totalConnections} active accounts)`);
    } else {
      connections = filterConnectionsForAccountPools(providerId, connections, model, settings);
    }
    if (providerId === "codex" && requestedModel) {
      connections = connections.filter((connection) => {
        const enabled = connection.providerSpecificData?.enabledModels;
        return !Array.isArray(enabled) || !enabled.length || enabled.includes(requestedModel);
      });
    }
    log.debug("AUTH", `${provider} | total connections: ${totalConnections}, candidates: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      // Distinguish "provider has no accounts" from "account pools filtered them
      // all out" (the latter is a user configuration, not a missing credential).
      log.warn("AUTH", totalConnections > 0
        ? `${provider} | all ${totalConnections} accounts are assigned to pools that do not serve ${model || "any model"}`
        : `No credentials for ${provider}`);
      return null;
    }

    // Antigravity quota cache is lazy: only populated after that account returns 409/429.
    const isAntigravity = providerId === "antigravity";
    const antigravityQuotaCache = isAntigravity && model ? getAntigravityQuotaCache() : null;

    // Trusted internal probes (dashboard "Test" / one-by-one model test) must
    // always reach the upstream: a local retry probe is our own bookkeeping, not
    // the provider's verdict, so a manual model test is never short-circuited by
    // it. Callers pass this only after isTrustedInternalProbe(); normal traffic
    // keeps enforcing locks.
    const ignoreModelLocks = options?.ignoreModelLocks === true;

    // Filter out model-locked, excluded, and Antigravity quota-exhausted connections.
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (!ignoreModelLocks && isModelLockActive(c, model)) return false;
      // Antigravity: skip if live quota exhausted for this model
      if (isAntigravity && model && antigravityQuotaCache) {
        const quota = antigravityQuotaCache.get(c.id)?.[model];
        if (quota && quota.remainingPercentage <= 0 && quota.resetAt && new Date(quota.resetAt).getTime() > Date.now()) {
          const account = c.id?.slice(0, 8) || "unknown";
          log.info("AG_QUOTA", `${account} | CACHE_BLOCK ${model} — skip upstream until ${quota.resetAt}`);
          return false;
        }
      }
      return true;
    });

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest persistent lock or lazy Antigravity quota-cache reset for retry timing.
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      if (isAntigravity && model && antigravityQuotaCache) {
        connections.forEach((c) => {
          const resetAt = antigravityQuotaCache.get(c.id)?.[model]?.resetAt;
          if (resetAt && new Date(resetAt).getTime() > Date.now()) expiries.push(resetAt);
        });
      }
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
      if (!connection && options?.strictPreferredConnection === true) return null;
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...availableConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...availableConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }

    // Freebuff always carries a pool scope (its free tier is IP-gated, so
    // every request must resolve through a pooled egress); other providers get
    // a scope only when they rotate over a pool.
    const psdForProxy = providerId === "freebuff"
      ? { ...(connection.providerSpecificData || {}), proxyPoolScope: `${providerId}::${model || ""}` }
      : connection.providerSpecificData?.proxyPoolIds?.length
        ? { ...connection.providerSpecificData, proxyPoolScope: `${providerId}::${model || ""}` }
        : connection.providerSpecificData;
    const resolvedProxy = await resolveConnectionProxyConfig(psdForProxy || {}, connection.id);

    return {
      // Count model/pool-eligible active accounts, before request exclusions.
      accountCount: connections.length,
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        serviceTierEnabled: getProviderFeatures(providerId, settings).serviceTier,
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        proxyPoolId: resolvedProxy.proxyPoolId || null,
        strictProxy: resolvedProxy.strictProxy === true,
        noFitPool: resolvedProxy.noFitPool === true,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 *
 * Two values are written for LIMIT failures (429 / provider-reported reset):
 *   - `modelLock_${model}` — the short blocking retry probe;
 *   - `modelResetAt_${model}` — the announced reset, display-only.
 * `lastErrorModel` records the failing model, so the dashboard shows the error
 * as model-scoped instead of painting the whole account as broken.
 * See the owner policy comment below.
 *
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @param {number|null} resetsAtMs - provider-reported reset (used as-is, never clamped)
 * @param {object} [options]
 * @returns {{ shouldFallback: boolean, cooldownMs: number, resetMs?: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null, options = {}) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // GitHub premium-request exhaustion is account-wide until the next UTC month.
  const githubResetAtMs = githubMonthlyResetMs(status, errorText, provider);

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel;
  const isA6 = provider === "a6api" || provider === "a6api-cli";
  if (githubResetAtMs) {
    shouldFallback = true;
    cooldownMs = githubResetAtMs - Date.now();
    newBackoffLevel = 0;
  } else if (isA6 && status !== 401 && status !== 402 && status !== 404) {
    shouldFallback = true;
    cooldownMs = 3000; // 3 seconds cooldown for all non-401/402/404 errors
    newBackoffLevel = 0;
  } else if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    // A provider-reported reset is authoritative and is used AS-IS (no 30-min
    // clamp): it is the value the dashboard shows as the quota reset, and the
    // blocking window below is only the short retry probe — so a stale
    // announced reset can never keep the account unusable past the real limit.
    cooldownMs = resetsAtMs - Date.now();
    newBackoffLevel = 0;
  } else if (status === 429) {
    // Use classify429 for all 429 responses so rate_limit, quota_exhausted,
    // and daily_quota get deterministic, semantically correct cooldowns
    // instead of generic exponential backoff. The daily-quota reset announced
    // earlier in the request path lives in modelResetAt_*, so this call cannot
    // overwrite it with a shorter backoff value.
    const classification = classify429({ status, body: errorText, provider });
    shouldFallback = true;
    cooldownMs = classification.cooldownMs;
    newBackoffLevel = backoffLevel;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel, resolveProviderId(provider)));
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  // Blocking window vs announced reset (owner policy 2026-10-05):
  //  - LIMIT cooldowns (429, provider-reported reset) block only a short retry
  //    probe. After it expires the router makes a REAL attempt, so a limit the
  //    provider lifted earlier than announced is used immediately instead of
  //    waiting out the whole cooldown.
  //  - account-level locks (no model) and credential/model errors keep their
  //    full cooldown — probing a bad key every minute teaches nothing.
  const isLimitCooldown = !!model && (status === 429 || (resetsAtMs && resetsAtMs > Date.now()));
  const lockMs = isLimitCooldown ? resolveProbeBlockMs(cooldownMs) : cooldownMs;

  // When the circuit-breaker / loop-guard toggle is OFF, do NOT write a per-account
  // model lock (mirrors chat behavior when the toggle is disabled). We still return
  // shouldFallback so the request falls through to the next account/provider, but we
  // leave the account lock state untouched.
  const disableLock = options && options.disableLock === true;

  const reason = typeof errorText === "string" ? errorText.slice(0, 200) : "Provider error";

  if (disableLock) {
    // Toggle OFF: skip the lock write entirely so the account stays usable.
    return { shouldFallback: true, cooldownMs: lockMs, resetMs: cooldownMs };
  }

  const lockUpdate = buildModelLockUpdate(githubResetAtMs ? null : model, lockMs);
  // Informational only: the announced reset, shown next to the local retry
  // timer. Skipped when it adds nothing over the probe window.
  const resetUpdate = githubResetAtMs ? {} : buildModelResetUpdate(model, cooldownMs, lockMs);

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    ...resetUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    // Which model the failure belongs to. A per-model failure must not read as
    // "the account is down" on the dashboard: the row keeps serving every other
    // model, and the error expires with this model's retry probe. Account-wide
    // failures (GitHub monthly exhaustion, no model known) record null.
    lastErrorModel: githubResetAtMs ? null : (model || null),
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel
  });

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  const resetKey = Object.keys(resetUpdate)[0];
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(lockMs / 1000)}s [${status}]${resetKey ? ` (quota reset ${Math.round(cooldownMs / 1000)}s)` : ""}`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs: lockMs, resetMs: cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  // Both flat-field families: blocking retry probes and informational resets.
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_") || k.startsWith("modelResetAt_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === `modelResetAt_${model}`) return true; // announced reset is over
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, {
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorModel: null,
      lastErrorAt: null,
      backoffLevel: 0
    });
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request?.headers?.get?.("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request?.headers?.get?.("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  const googleKey = request?.headers?.get?.("x-goog-api-key");
  if (googleKey) return googleKey;
  // Native Gemini SDKs use ?key=; do not silently lose that principal
  // when converting the request to Chat Completions internally.
  if (request?.url) {
    try { return new URL(request.url).searchParams.get("key") || null; } catch { /* invalid URL */ }
  }
  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}

/**
 * Resolve the API key record (id/name) for request attribution.
 * Returns null when the key is unknown or deactivated.
 * @param {string} apiKey
 * @returns {Promise<object | null>}
 */
export async function getApiKeyInfo(apiKey) {
  if (!apiKey) return null;
  const info = await getApiKeyByKey(apiKey);
  if (!info?.isActive) return null;
  return info;
}
