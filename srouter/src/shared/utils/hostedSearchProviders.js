import { AI_PROVIDERS, resolveProviderId } from "@/shared/constants/providers.js";

export function getHostedProviderFamilyIds(providerId) {
  return ["openai", "codex"].includes(providerId) ? ["openai", "codex"] : [providerId];
}

export function getHostedFamilyAccounts(connections, providerId) {
  const ids = getHostedProviderFamilyIds(providerId);
  return connections.filter((connection) => ids.includes(resolveProviderId(connection.provider)));
}

export function sortHostedProviders(providers, connections) {
  const rank = (provider) => {
    const accounts = getHostedFamilyAccounts(connections, provider.id);
    if (accounts.some((account) => account.isActive !== false && account.hasCredential !== false)) return 2;
    return accounts.length ? 1 : 0;
  };
  return [...providers].sort((a, b) => rank(b) - rank(a) || (a.name || a.id).localeCompare(b.name || b.id));
}

export function getHostedProviderCatalog(nodes = [], connections = []) {
  const regular = Object.values(AI_PROVIDERS)
    .filter((provider) => !provider.hidden && provider.id !== "codex" && (provider.serviceKinds || ["llm"]).includes("llm"))
    .map((provider) => provider.id === "openai" ? {
      ...provider, name: "OpenAI", connectionLabel: "API / Codex OAuth", searchTerms: "Codex cx",
    } : provider);
  const custom = nodes.filter((node) => ["openai-compatible", "anthropic-compatible"].includes(node.type))
    .map((node) => ({ id: node.id, name: node.name, serviceKinds: ["llm"], custom: true }));
  return sortHostedProviders([...regular, ...custom], connections);
}

// A family is presentation only. Always persist the actual credential owner
// and pick that owner's adapter, never send an OAuth token to the API endpoint.
export function selectHostedSource(providerId, connections, adapters, connectionId = null) {
  const ids = getHostedProviderFamilyIds(providerId);
  const account = connectionId ? getHostedFamilyAccounts(connections, providerId).find((item) => item.id === connectionId) : null;
  if (connectionId && !account) throw new Error("Account does not belong to this provider family");
  const actualId = account ? resolveProviderId(account.provider)
    : ids.find((id) => getHostedProviderAccounts(connections, id).some((item) => item.isActive !== false && item.hasCredential !== false)) || providerId;
  return {
    sourceProviderId: actualId,
    sourceConnectionId: account?.id || "",
    sourceAdapterId: getProviderHostedAdapters(adapters, actualId)[0]?.id || "",
    sourceModel: "",
  };
}

export function getHostedProviderAccounts(connections, providerId) {
  // API responses store canonical ids; aliases can occur in imported connections.
  return connections.filter((connection) => resolveProviderId(connection.provider) === providerId);
}

export function getProviderHostedAdapters(adapters, providerId) {
  return adapters.filter((adapter) => adapter.providerIds?.includes("*") || adapter.providerIds?.includes(providerId));
}

export async function loadHostedSearchCatalog(fetchImpl = fetch) {
  const urls = ["/api/providers", "/api/provider-nodes", "/api/hosted-search-adapters"];
  const data = await Promise.all(urls.map(async (url) => {
    const response = await fetchImpl(url, { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load providers, accounts or hosted search adapters.");
    return response.json();
  }));
  return {
    connections: data[0].connections || [], nodes: data[1].nodes || [],
    adapters: data[2].adapters || [],
  };
}
