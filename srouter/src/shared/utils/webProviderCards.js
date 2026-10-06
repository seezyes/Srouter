import { OAUTH_PROVIDERS, FREE_PROVIDERS, FREE_TIER_PROVIDERS, getProvidersByKind } from "@/shared/constants/providers";
import { WEB_PROVIDER_CAPABILITIES, WEB_TOOL_LABELS, WEB_CONNECTION_LABELS } from "@/shared/constants/webProviderCapabilities";

export function getWebProviders() {
  const providers = new Map();
  for (const kind of ["webSearch", "webFetch"]) {
    for (const provider of getProvidersByKind(kind)) {
      if (!providers.has(provider.id)) providers.set(provider.id, { ...provider, kinds: [] });
      providers.get(provider.id).kinds.push(kind);
    }
  }
  return [...providers.values()];
}

export function getWebConnectionLabels(provider) {
  if (provider.noAuth) return ["Free"];
  const labels = [];
  if (OAUTH_PROVIDERS[provider.id] || provider.hasOAuth || provider.authModes?.includes("oauth")) labels.push("OAuth");
  if (provider.authModes?.includes("apikey") || (!labels.length && !FREE_PROVIDERS[provider.id] && !FREE_TIER_PROVIDERS[provider.id])) labels.push("API");
  if (!labels.length) labels.push("Free");
  return provider.searchViaChat ? ["Chat adapter", ...labels] : labels;
}

export function getWebProviderToolOptions(provider) {
  const catalog = WEB_PROVIDER_CAPABILITIES[provider.id];
  const implemented = provider.kinds.map((kind) => {
    const warning = catalog?.adapterWarnings?.[kind];
    if (warning) return {
      type: kind, label: WEB_TOOL_LABELS[kind], implemented: false,
      status: "conditional", note: warning,
      sources: catalog.serviceTools.find((tool) => tool.type === kind)?.sources || [],
    };
    return {
      type: kind, label: WEB_TOOL_LABELS[kind], kind, implemented: true,
      note: "Registered SRouter adapter; live availability depends on the service and connection", sources: [],
    };
  });
  const current = new Set(implemented.map((tool) => tool.type));
  const service = catalog?.serviceTools || [];
  return [...implemented, ...service.filter((tool) => !current.has(tool.type)).map((tool) => ({
    ...tool, label: WEB_TOOL_LABELS[tool.type], implemented: false,
  }))];
}

export function getWebProviderConnectionOptions(provider) {
  const implemented = getWebConnectionLabels(provider).map((label) => ({
    type: Object.keys(WEB_CONNECTION_LABELS).find((key) => WEB_CONNECTION_LABELS[key] === label),
    label, implemented: true, sources: [],
    note: label === "Free" ? "No authentication required; service limits may apply" : "Current SRouter connection method",
  }));
  const current = new Set(implemented.map((option) => option.type));
  const future = WEB_PROVIDER_CAPABILITIES[provider.id]?.possibleConnections || [];
  return [...implemented, ...future.filter((option) => !current.has(option.type)).map((option) => ({
    ...option, label: WEB_CONNECTION_LABELS[option.type], implemented: false,
  }))];
}

const WEB_GROUPS = [
  { name: "Google", ids: ["antigravity", "gemini", "google-pse"] },
  { name: "Ollama", ids: ["ollama-search", "ollama"] },
  { name: "Perplexity", ids: ["perplexity", "perplexity-agent"] },
];

export function groupWebProviders(providers) {
  const emitted = new Set();
  return providers.flatMap((provider) => {
    const group = WEB_GROUPS.find((item) => item.ids.includes(provider.id));
    if (!group) return [{ id: provider.id, provider }];
    if (emitted.has(group.name)) return [];
    emitted.add(group.name);
    const entries = providers.filter((item) => group.ids.includes(item.id));
    if (entries.length < 2) return [{ id: provider.id, provider }];
    return [{ id: `group-${group.name}`, name: group.name, entries }];
  });
}
