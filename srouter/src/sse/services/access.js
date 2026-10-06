import { getProviderNodeById } from "@/lib/db/index.js";
import { getProviderAlias, resolveProviderId, isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider, isCustomEmbeddingProvider, isCustomWebSearchProvider } from "@/shared/constants/providers";
import { getProviderAliases } from "@/shared/constants/providerAliases.js";

function permits(list, target) {
  return list === null || list === undefined || (Array.isArray(list) && list.includes(target));
}

export function isKindAllowed(info, kind) {
  const accessKind = kind === "webSearch" || kind === "webFetch" ? "web" : kind === "imageToText" ? "llm" : kind;
  return permits(info?.allowedKinds, accessKind);
}

export function isComboAllowed(info, name) {
  return permits(info?.allowedCombos, name.startsWith("combo/") ? name.slice(6) : name);
}

export async function isProviderAllowed(info, provider) {
  if (info?.allowedProviders === null || info?.allowedProviders === undefined) return true;
  const id = resolveProviderId(provider);
  // Reciprocal alias forms: a persisted grant under any declared alias of the
  // canonical target (e.g. `gb` or `grok-build` for `grok-cli`) authorizes it,
  // and a request arriving under an alias is authorized by the canonical grant.
  // `resolveProviderId` may not know registry-only aliases (e.g. under partial
  // module mocks), so canonicalize the target through the registry map too.
  const { id: canonicalId, aliases } = getProviderAliases(id || provider);
  const candidates = new Set([provider, id, canonicalId, getProviderAlias(canonicalId), ...aliases]);
  if (isOpenAICompatibleProvider(id) || isAnthropicCompatibleProvider(id) || isCustomEmbeddingProvider(id) || isCustomWebSearchProvider(id)) {
    const node = await getProviderNodeById(id);
    if (node?.prefix) candidates.add(node.prefix);
  }
  return [...candidates].some((candidate) => permits(info.allowedProviders, candidate));
}
