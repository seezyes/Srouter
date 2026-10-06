import { AI_PROVIDERS, getProviderAlias, resolveProviderId, isCustomWebSearchProvider } from "@/shared/constants/providers";
import { getProviderNodeById } from "@/lib/db/index.js";
import { getDisabledModels } from "@/lib/disabledModelsDb";

const fetchedModels = new Map();
const requestCatalogs = new WeakMap();

// Pinned Vans generic catalogs, including models.dev provider dictionaries.
// A dictionary never falls back to another provider's first entry.
export async function fetchModelsFetcherIds(providerId, providerInfo) {
  const fetcher = providerInfo?.modelsFetcher;
  if (!fetcher?.url) return [];
  const key = `${providerId}:${fetcher.url}:${fetcher.type}:${providerInfo.alias || ""}`;
  const cached = fetchedModels.get(key);
  if (cached?.expires > Date.now()) return cached.ids;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(fetcher.url, {
      headers: { "Content-Type": "application/json" }, cache: "no-store", signal: controller.signal,
    });
    if (!response.ok) return [];
    const data = await response.json();
    let raw;
    if (Array.isArray(data)) raw = data;
    else if (Array.isArray(data?.data)) raw = data.data;
    else if (data?.models) raw = Array.isArray(data.models) ? data.models : Object.values(data.models);
    else if (Array.isArray(data?.results)) raw = data.results;
    else {
      const entry = data?.[providerInfo.id || providerId] || data?.[providerInfo.alias || providerInfo.uiAlias] || data?.[providerId];
      raw = entry?.models ? Object.values(entry.models) : [];
    }
    const ids = [...new Set(raw.map((model) => typeof model === "string" ? model : model?.id || model?.name || model?.model)
      .filter((id) => typeof id === "string" && id.trim() && (fetcher.type !== "opencode-free" || id.endsWith("-free"))))];
    fetchedModels.set(key, { ids, expires: Date.now() + 300000 });
    return ids;
  } catch {
    return cached?.ids || [];
  } finally {
    clearTimeout(timeout);
  }
}

// Keep Srouter's richer live catalog as the source of availability. Import
// lazily to avoid a cycle with the catalog's per-key filtering.
export async function isModelAllowed(modelStr, info = null, kind = "llm") {
  if (!info) return true;
  const slash = modelStr.indexOf("/");
  if (slash < 1) return false;
  const provider = resolveProviderId(modelStr.slice(0, slash));
  const model = modelStr.slice(slash + 1);
  const alias = getProviderAlias(provider) || provider;
  const disabled = await getDisabledModels();
  if ([provider, alias].some((id) => disabled[id]?.includes(model))) return false;

  const config = AI_PROVIDERS[provider];
  const mediaConfig = config?.[`${kind}Config`];
  if ((kind === "webSearch" && model === "search" && (config?.searchConfig || config?.searchViaChat))
    // Custom web search provider nodes are webSearch providers by construction
    // and are not part of the static catalog.
    || (kind === "webSearch" && model === "search" && !config && isCustomWebSearchProvider(provider))
    || (kind === "webFetch" && model === "fetch" && config?.fetchConfig)
    || (model === kind && (mediaConfig || config?.serviceKinds?.includes(kind)))
    || mediaConfig?.models?.some((entry) => entry.id === model)) return true;

  const { buildModelsList } = await import("@/app/api/v1/models/route.js");
  let catalogs = requestCatalogs.get(info);
  if (!catalogs) {
    catalogs = new Map();
    requestCatalogs.set(info, catalogs);
  }
  if (!catalogs.has(kind)) catalogs.set(kind, buildModelsList([kind]));
  const models = await catalogs.get(kind);
  const prefixes = new Set([provider, alias]);
  // Custom provider-node IDs resolve to their user-defined catalog prefix.
  if (!config) {
    const node = await getProviderNodeById(provider);
    if (node?.prefix) {
      if (disabled[node.prefix]?.includes(model)) return false;
      prefixes.add(node.prefix);
    }
  }
  return models.some((entry) => {
    const split = entry.id.indexOf("/");
    return split > 0 && prefixes.has(entry.id.slice(0, split)) && entry.id.slice(split + 1) === model;
  });
}
