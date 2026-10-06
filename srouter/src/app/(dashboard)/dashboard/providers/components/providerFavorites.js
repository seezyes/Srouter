/**
 * Providers page quick-access favorites.
 *
 * Favorites are a plain list of provider ids persisted in the existing
 * settings document (`favoriteProviders`, PATCH /api/settings) — no schema and
 * no new endpoint. Everything here is pure so the storage contract and the
 * strip order can be unit tested without React.
 */

/** Coerce whatever sits in settings into a clean id list (order preserved). */
export function normalizeFavoriteIds(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Add the id when missing, remove it when present. Returns a new list. */
export function toggleFavoriteId(ids, id) {
  const list = normalizeFavoriteIds(ids);
  if (typeof id !== "string" || !id.trim()) return list;
  const key = id.trim();
  if (list.includes(key)) return list.filter((entry) => entry !== key);
  return [...list, key];
}

/**
 * Quick-access strip above Custom Providers: union of favorited and connected
 * providers, deduplicated. Favorites keep the order the user saved them in;
 * the remaining connected providers follow sorted by name.
 *
 * @param {Array<{id: string, name?: string}>} providers - candidates to look at
 * @param {string[]} favoriteIds - stored favorites (may reference unknown ids)
 * @param {(provider: object) => boolean} hasConnections - "provider has rows in GET /api/providers"
 */
export function buildProviderStrip(providers, favoriteIds, hasConnections = () => false) {
  const list = Array.isArray(providers) ? providers : [];
  const byId = new Map();
  for (const provider of list) {
    if (!provider || typeof provider.id !== "string" || !provider.id) continue;
    if (!byId.has(provider.id)) byId.set(provider.id, provider);
  }

  const seen = new Set();
  const items = [];
  for (const id of normalizeFavoriteIds(favoriteIds)) {
    const provider = byId.get(id);
    if (!provider || seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      provider,
      favorite: true,
      connected: !!hasConnections(provider),
    });
  }

  const connected = [];
  for (const provider of list) {
    if (!provider || typeof provider.id !== "string" || !provider.id) continue;
    if (seen.has(provider.id)) continue;
    seen.add(provider.id);
    if (!hasConnections(provider)) continue;
    connected.push({
      id: provider.id,
      provider,
      favorite: false,
      connected: true,
    });
  }
  connected.sort((a, b) => (a.provider.name || "").localeCompare(b.provider.name || ""));
  return [...items, ...connected];
}
