import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { normalizeRequireLogin } from "@/lib/auth/loginPolicy";
import { normalizeVisionAdvisor } from "@/shared/utils/visionAdvisorConfig.js";
import { normalizeCustomSystemPrompts, validateCustomSystemPrompts } from "@/shared/utils/customSystemPrompts.js";
import { DEFAULT_SROUTER_SEARCH, normalizeSrouterSearch } from "@/shared/utils/srouterSearchConfig.js";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20127";
const DEFAULT_HEADROOM_URL = process.env.HEADROOM_URL || "http://localhost:8787";

const DEFAULT_SETTINGS = {
  cloudEnabled: false,
  tunnelEnabled: false,
  tunnelUrl: "",
  tunnelProvider: "cloudflare",
  tailscaleEnabled: false,
  tailscaleUrl: "",
  stickyRoundRobinLimit: 3,
  providerStrategies: {},
  quotaVisibility: {},
  comboStrategy: "fallback",
  comboStickyRoundRobinLimit: 1,
  comboStrategies: {},
  visionAdvisor: { enabled: false, models: [], overrides: {} },
  customSystemPrompts: { enabled: false, prompts: [] },
  srouterSearch: DEFAULT_SROUTER_SEARCH,
  capacityAdapter: {
    vision: { enabled: true, roundRobin: false, models: [] },
    pdf: { enabled: false, roundRobin: false, models: [] },
    audioInput: { enabled: true, roundRobin: false, models: [] },
    videoInput: { enabled: false, roundRobin: false, models: [] },
  },
  // Login policy: true = password always, "local" = no login from this machine,
  // false = no login anywhere. See src/lib/auth/loginPolicy.js.
  requireLogin: true,
  // Block browser requests from foreign origins (CSRF / DNS rebinding) while the
  // login window is bypassed. Only meaningful for the two bypass levels.
  originGuard: true,
  requireApiKey: true,
  tunnelDashboardAccess: true,
  authMode: "password",
  ssoType: "oidc",
  oidcIssuerUrl: "",
  oidcClientId: "",
  oidcClientSecret: "",
  oidcScopes: "openid profile email",
  oidcLoginLabel: "Sign in with OIDC",
  samlEntryPoint: "",
  samlIssuer: "urn:srouter:sp",
  samlCert: "",
  samlLoginLabel: "Sign in with SAML SSO",
  samlAttributeEmail: "email",
  samlAttributeName: "name",
  enableObservability: false,
  observabilityMaxRecords: 1000,
  observabilityBatchSize: 20,
  observabilityFlushIntervalMs: 5000,
  observabilityMaxJsonSize: 5,
  outboundProxyEnabled: false,
  outboundProxyUrl: "",
  outboundNoProxy: "",
  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
  dnsToolEnabled: {},
  rtkEnabled: false,
  headroomEnabled: false,
  headroomUrl: DEFAULT_HEADROOM_URL,
  headroomCompressUserMessages: false,
  headroomTimeoutMs: 3000,
  cavemanEnabled: false,
  cavemanLevel: "full",
  ponytailEnabled: false,
  ponytailLevel: "full",
  pxpipeEnabled: false,
  pxpipeAutoInstall: true,
  pxpipeMinChars: 25000,
  pxpipeTimeoutMs: 15000,
  loopGuardEnabled: false,
  // Per-provider account pools: { [providerId]: [{ id, name, models: string[] }] }.
  // Empty object = feature unused (routing must be a strict no-op).
  accountPools: {},
  // Per-provider user header overrides applied at dispatch: { [providerId]: { headers: {..} } }
  providerOverrides: {},
};

async function readRaw() {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  return row ? parseJson(row.data, {}) : {};
}

// Merge raw settings with defaults; backward-compat for missing keys
export function mergeWithDefaults(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  merged.srouterSearch = normalizeSrouterSearch(merged.srouterSearch);
  for (const [key, defVal] of Object.entries(DEFAULT_SETTINGS)) {
    if (merged[key] === undefined) {
      if (
        key === "outboundProxyEnabled" &&
        typeof merged.outboundProxyUrl === "string" &&
        merged.outboundProxyUrl.trim()
      ) {
        merged[key] = true;
      } else {
        merged[key] = defVal;
      }
    }
  }
  // Unknown / legacy values fall back to the safe default instead of being trusted.
  merged.requireLogin = normalizeRequireLogin(merged.requireLogin);
  merged.originGuard = merged.originGuard !== false;
  merged.visionAdvisor = normalizeVisionAdvisor(merged.visionAdvisor);
  merged.customSystemPrompts = normalizeCustomSystemPrompts(merged.customSystemPrompts);

  if (merged.capacityAdapter && typeof merged.capacityAdapter === "object") {
    for (const capKey of Object.keys(merged.capacityAdapter)) {
      const entry = merged.capacityAdapter[capKey];
      if (Array.isArray(entry?.models)) {
        entry.models = entry.models.map((m) =>
          m === "oc/mimo-v2.5-free" ? "oc/mimo-v2.6-flash-free" : m
        );
      }
    }
  }
  return merged;
}

export async function getSettings() {
  const raw = await readRaw();
  return mergeWithDefaults(raw);
}

// Atomic read-merge-write inside transaction (prevents losing concurrent updates)
export async function updateSettings(updates) {
  if (Object.hasOwn(updates, "customSystemPrompts")) {
    const error = validateCustomSystemPrompts(updates.customSystemPrompts);
    if (error) throw new Error(error);
    updates = { ...updates, customSystemPrompts: normalizeCustomSystemPrompts(updates.customSystemPrompts) };
  }
  const db = await getAdapter();
  let next;
  db.transaction(function () {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const current = row ? parseJson(row.data, {}) : {};
    next = { ...current, ...updates };
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)],
    );
  });
  return mergeWithDefaults(next);
}

// Merge one provider inside the transaction, not a stale whole settings map.
export async function updateProviderFeatures(provider, patch) {
  const db = await getAdapter();
  let next;
  db.transaction(() => {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const current = row ? parseJson(row.data, {}) : {};
    next = {
      ...current,
      providerFeatures: {
        ...(current.providerFeatures || {}),
        [provider]: { ...(current.providerFeatures?.[provider] || {}), ...patch },
      },
    };
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)],
    );
  });
  return mergeWithDefaults(next);
}

export async function isCloudEnabled() {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

export async function getCloudUrl() {
  const settings = await getSettings();
  return (
    settings.cloudUrl ||
    process.env.CLOUD_URL ||
    process.env.NEXT_PUBLIC_CLOUD_URL ||
    ""
  );
}

export async function exportSettings() {
  return await readRaw();
}

// ── Account pools ─────────────────────────────────────────────────────────────
// Pools are stored inside the single settings document under `accountPools`
// ({ [providerId]: [{ id, name, models: [] }] }) so the feature needs no schema
// migration. Membership lives on each connection's providerSpecificData
// (`accountPoolId`, optional `assignedModels`) — see connectionsRepo.

function normalizePoolIdList(models) {
  if (!Array.isArray(models)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of models) {
    const id = typeof entry === "string" ? entry.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Coerce whatever is stored in `settings.accountPools` into a safe shape.
 * Unknown/legacy garbage is dropped rather than trusted.
 * @param {unknown} raw
 * @returns {Record<string, Array<{id: string, name: string, models: string[]}>>}
 */
export function normalizeAccountPools(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const out = {};
  for (const [providerId, pools] of Object.entries(raw)) {
    if (!providerId || !Array.isArray(pools)) continue;
    const list = [];
    for (const pool of pools) {
      if (!pool || typeof pool !== "object") continue;
      const id = typeof pool.id === "string" ? pool.id.trim() : "";
      if (!id) continue;
      list.push({
        id,
        name: typeof pool.name === "string" ? pool.name.trim() : "",
        models: normalizePoolIdList(pool.models),
      });
    }
    if (list.length > 0) out[providerId] = list;
  }
  return out;
}

async function mutateAccountPools(mutate) {
  const raw = await readRaw();
  const all = normalizeAccountPools(raw.accountPools);
  const next = mutate(all);
  const normalized = normalizeAccountPools(next);
  // Persist only this key so the rest of the raw settings document is untouched.
  await updateSettings({ accountPools: normalized });
  return normalized;
}

/**
 * List pools for one provider, or every provider's pools when no id is given.
 * @param {string|null} providerId
 */
export async function getAccountPools(providerId = null) {
  const raw = await readRaw();
  const all = normalizeAccountPools(raw.accountPools);
  if (!providerId) return all;
  return all[providerId] || [];
}

export async function createAccountPool(providerId, data = {}) {
  const pid = typeof providerId === "string" ? providerId.trim() : "";
  const name = typeof data.name === "string" ? data.name.trim() : "";
  if (!pid) throw new Error("provider is required");
  if (!name) throw new Error("name is required");

  const pool = {
    id: uuidv4(),
    name,
    models: normalizePoolIdList(data.models),
  };

  await mutateAccountPools((all) => ({
    ...all,
    [pid]: [...(all[pid] || []), pool],
  }));

  return pool;
}

export async function updateAccountPool(providerId, poolId, data = {}) {
  const pid = typeof providerId === "string" ? providerId.trim() : "";
  const id = typeof poolId === "string" ? poolId.trim() : "";
  if (!pid || !id) return null;

  let updated = null;
  await mutateAccountPools((all) => {
    const pools = all[pid] || [];
    const index = pools.findIndex((pool) => pool.id === id);
    if (index === -1) return all;

    const current = pools[index];
    const nextPool = {
      ...current,
      name: data.name === undefined ? current.name : String(data.name).trim(),
      models: data.models === undefined ? current.models : normalizePoolIdList(data.models),
    };
    if (!nextPool.name) return all;

    updated = nextPool;
    const nextPools = [...pools];
    nextPools[index] = nextPool;
    return { ...all, [pid]: nextPools };
  });

  return updated;
}

export async function deleteAccountPool(providerId, poolId) {
  const pid = typeof providerId === "string" ? providerId.trim() : "";
  const id = typeof poolId === "string" ? poolId.trim() : "";
  if (!pid || !id) return null;

  let removed = null;
  await mutateAccountPools((all) => {
    const pools = all[pid] || [];
    const target = pools.find((pool) => pool.id === id);
    if (!target) return all;
    removed = target;
    return { ...all, [pid]: pools.filter((pool) => pool.id !== id) };
  });

  return removed;
}

/**
 * Find a pool by id across every provider (pool ids are uuids, so this is a
 * convenience for routes that were not given a provider id).
 * @returns {{ providerId: string, pool: object } | null}
 */
export async function findAccountPoolById(poolId) {
  const id = typeof poolId === "string" ? poolId.trim() : "";
  if (!id) return null;
  const all = await getAccountPools();
  for (const [providerId, pools] of Object.entries(all)) {
    const pool = pools.find((entry) => entry.id === id);
    if (pool) return { providerId, pool };
  }
  return null;
}
