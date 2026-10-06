"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Providers whose detail page exposes Account Pools. The routing filter
 * (`filterConnectionsForAccountPools` in src/sse/services/auth.js) and the
 * `/api/account-pools` namespace are provider-agnostic, so adopting the feature
 * for another provider is just adding its id here.
 *
 * `codex` is the id ChatGPT/Codex OAuth accounts are stored under — without it
 * the pools UI never appears for an install whose OpenAI accounts were connected
 * through Codex rather than by API key.
 */
export const ACCOUNT_POOL_PROVIDERS = new Set(["openai", "codex"]);

export function isAccountPoolProvider(providerId) {
  return ACCOUNT_POOL_PROVIDERS.has(providerId);
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

const EMPTY_POOLS = [];

/**
 * Account-pool state for one provider.
 * @param {string} providerId
 * @param {boolean} enabled - false keeps the feature inert (no requests fired)
 */
export function useAccountPools(providerId, enabled = true) {
  const active = enabled === true && !!providerId;
  const [loadedPools, setLoadedPools] = useState([]);
  const [loadedLoading, setLoadedLoading] = useState(active);
  const [loadedError, setLoadedError] = useState("");

  // Inactive providers expose an inert, empty view — no reset effect needed
  // (and no state write during the render of an unused feature).
  const accountPools = active ? loadedPools : EMPTY_POOLS;
  const loading = active ? loadedLoading : false;
  const error = active ? loadedError : "";

  const refreshPools = useCallback(async () => {
    if (!active) return EMPTY_POOLS;
    try {
      const res = await fetch(`/api/account-pools?provider=${encodeURIComponent(providerId)}`, { cache: "no-store" });
      const data = await readJson(res);
      if (!res.ok) {
        setLoadedError(data.error || "Failed to load account pools");
        return EMPTY_POOLS;
      }
      const pools = data.accountPools || [];
      setLoadedPools(pools);
      setLoadedError("");
      return pools;
    } catch (e) {
      console.log("account pools fetch error:", e);
      setLoadedError("Failed to load account pools");
      return EMPTY_POOLS;
    } finally {
      setLoadedLoading(false);
    }
  }, [providerId, active]);

  // Initial load. The fetch lives inline (rather than calling refreshPools) so
  // no state write happens synchronously from the effect body, which the
  // react-hooks/set-state-in-effect rule rejects.
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    fetch(`/api/account-pools?provider=${encodeURIComponent(providerId)}`, { cache: "no-store" })
      .then(async (res) => ({ ok: res.ok, data: await readJson(res) }))
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (!ok) {
          setLoadedError(data.error || "Failed to load account pools");
          return;
        }
        setLoadedPools(data.accountPools || []);
        setLoadedError("");
      })
      .catch((e) => {
        if (cancelled) return;
        console.log("account pools fetch error:", e);
        setLoadedError("Failed to load account pools");
      })
      .finally(() => {
        if (!cancelled) setLoadedLoading(false);
      });
    return () => { cancelled = true; };
  }, [providerId, active]);

  const createPool = useCallback(async ({ name, models }) => {
    if (!active) return { ok: false, error: "Account pools are not available for this provider" };
    try {
      const res = await fetch("/api/account-pools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, name, models: models || [] }),
      });
      const data = await readJson(res);
      if (!res.ok) return { ok: false, error: data.error || "Failed to create pool" };
      await refreshPools();
      return { ok: true, accountPool: data.accountPool };
    } catch (e) {
      console.log("create account pool error:", e);
      return { ok: false, error: "Failed to create pool" };
    }
  }, [providerId, active, refreshPools]);

  const updatePool = useCallback(async (poolId, patch) => {
    try {
      const res = await fetch(`/api/account-pools/${poolId}?provider=${encodeURIComponent(providerId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await readJson(res);
      if (!res.ok) return { ok: false, error: data.error || "Failed to update pool" };
      await refreshPools();
      return { ok: true, accountPool: data.accountPool };
    } catch (e) {
      console.log("update account pool error:", e);
      return { ok: false, error: "Failed to update pool" };
    }
  }, [providerId, refreshPools]);

  const deletePool = useCallback(async (poolId) => {
    try {
      const res = await fetch(`/api/account-pools/${poolId}?provider=${encodeURIComponent(providerId)}`, { method: "DELETE" });
      const data = await readJson(res);
      if (!res.ok) return { ok: false, error: data.error || "Failed to delete pool" };
      await refreshPools();
      return { ok: true };
    } catch (e) {
      console.log("delete account pool error:", e);
      return { ok: false, error: "Failed to delete pool" };
    }
  }, [providerId, refreshPools]);

  // Move one account into a pool, into another pool, or out of every pool (null).
  const moveConnection = useCallback(async (connectionId, poolId) => {
    try {
      const res = await fetch(`/api/providers/${connectionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountPoolId: poolId || null }),
      });
      const data = await readJson(res);
      if (!res.ok) return { ok: false, error: data.error || "Failed to move account" };
      await refreshPools();
      return { ok: true };
    } catch (e) {
      console.log("move account to pool error:", e);
      return { ok: false, error: "Failed to move account" };
    }
  }, [refreshPools]);

  return { active, accountPools, loading, error, refreshPools, createPool, updatePool, deletePool, moveConnection };
}
