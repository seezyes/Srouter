/**
 * Factory (Droid) subscription usage — GET https://api.factory.ai/api/billing/limits
 *
 * Auth: Bearer <Factory API key or WorkOS session token>.
 * Response (verified live with an fk- key):
 *   { limits: { standard: { fiveHour, weekly, monthly },
 *               core:     { fiveHour, weekly, monthly } },
 *     extraUsageBalanceCents: 0 }
 * Each window: { usedPercent, windowEnd, secondsRemaining }.
 *
 * Factory freezes a lapsed window at its last-used percentage instead of
 * rolling it forward: an idle pool reports e.g. 100% with a past/null
 * windowEnd, and the next window starts lazily on the next request. The
 * official CLI treats only windowEnd >= now as active, so an inactive window
 * reads as 0% used with no reset countdown here too. Malformed or failed
 * responses return a message (quota unknown) — never "exhausted".
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U } from "./shared.js";
import { FACTORY_CLIENT_VERSION } from "../../providers/registry/factory.js";

const USAGE_URL = U("factory").url;

const POOL_DEFS = [
  { key: "standard", label: "Standard" },
  { key: "core", label: "Core" },
];

const WINDOW_DEFS = [
  { key: "fiveHour", label: "5h" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Percent as a finite number, accepting numeric strings. null when malformed. */
function readPercent(value) {
  const parsed = typeof value === "number" ? value : (typeof value === "string" && value.trim() ? Number(value) : NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Epoch ms for a window end (ISO string or epoch seconds/ms). null when unusable. */
function readWindowEnd(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return Math.abs(ms) <= 8.64e15 ? ms : null;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Normalize a billing/limits payload into dashboard quotas.
 * Exported for unit tests; returns `{ quotas }` or `{ message }`.
 */
export function parseFactoryLimitsPayload(payload, fetchedAt = Date.now()) {
  if (!isRecord(payload)) {
    return { message: "Factory billing response was not valid JSON." };
  }
  if (!isRecord(payload.limits)) {
    return { message: "Factory billing response did not contain quota windows." };
  }

  const quotas = {};
  for (const pool of POOL_DEFS) {
    const poolValue = payload.limits[pool.key];
    if (!isRecord(poolValue)) continue;
    for (const windowDef of WINDOW_DEFS) {
      const windowValue = poolValue[windowDef.key];
      if (!isRecord(windowValue)) continue;

      const usedPercent = readPercent(windowValue.usedPercent);
      if (usedPercent === null) continue;

      const endMs = readWindowEnd(windowValue.windowEnd);
      // Only an explicit null or a valid elapsed date means lazy reset.
      // Missing/malformed dates mean unknown, not a fabricated 100% remaining.
      if (windowValue.windowEnd !== null && endMs === null) continue;
      const active = endMs !== null && endMs >= fetchedAt;
      const used = active ? Math.max(0, Math.min(100, usedPercent)) : 0;

      quotas[`${pool.label} ${windowDef.label}`] = {
        used,
        total: 100,
        remaining: 100 - used,
        remainingPercentage: 100 - used,
        resetAt: active ? new Date(endMs).toISOString() : null,
        unlimited: false,
      };
    }
  }

  const balanceCents = readPercent(payload.extraUsageBalanceCents);
  if (balanceCents !== null && balanceCents > 0) {
    const balanceUsd = balanceCents / 100;
    quotas["Extra usage balance"] = {
      used: 0,
      total: balanceUsd,
      resetAt: null,
      remainingPercentage: 100,
      isCreditBalance: true,
      currency: "USD",
    };
  }

  if (Object.keys(quotas).length === 0) {
    return { message: "Factory billing response did not contain valid quota data." };
  }
  return { quotas };
}

/** Headers shared by the dashboard usage call and connection validation. */
export function buildFactoryBillingHeaders(apiKey) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${String(apiKey || "").trim()}`,
    "User-Agent": `factory-cli/${FACTORY_CLIENT_VERSION}`,
    "X-Client-Version": FACTORY_CLIENT_VERSION,
    "X-Factory-Client": "cli",
  };
}

/**
 * @param {string|null|undefined} apiKey - Factory API key or WorkOS session token
 * @param {object|null} proxyOptions
 */
export async function getFactoryUsage(apiKey, proxyOptions = null) {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return { message: "Factory API key not available. Add a key to view usage." };
  }

  try {
    const response = await proxyAwareFetch(
      USAGE_URL,
      { method: "GET", headers: buildFactoryBillingHeaders(apiKey) },
      proxyOptions,
    );

    if (response.status === 401 || response.status === 403) {
      return {
        plan: "Factory",
        message: "Factory authentication failed. Check the API key.",
      };
    }
    if (!response.ok) {
      return {
        plan: "Factory",
        message: `Factory billing API error (${response.status}).`,
      };
    }

    const payload = await response.json().catch(() => null);
    const parsed = parseFactoryLimitsPayload(payload);
    if (parsed.message) return { plan: "Factory", message: parsed.message };
    return { plan: "Factory", quotas: parsed.quotas };
  } catch {
    return { message: "Factory billing request failed." };
  }
}
