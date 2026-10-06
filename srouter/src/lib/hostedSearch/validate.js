import { AI_PROVIDERS, isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers.js";
import { getProviderNodeById, getProviderConnections } from "@/models";
import { adapterSupportsProvider, getHostedSearchAdapters } from "./registry.js";
import { HOSTED_TOOLS_WIP, HOSTED_TOOLS_WIP_MESSAGE } from "@/shared/constants/hostedTools.js";

export async function validateLinkedSearchSource({ sourceProviderId, sourceConnectionId, sourceAdapterId, sourceModel, mode = "linked" }) {
  const isPlugin = mode === "plugin";
  if (HOSTED_TOOLS_WIP && !isPlugin) return { error: HOSTED_TOOLS_WIP_MESSAGE, status: 503 };
  const providerId = String(sourceProviderId || "").trim();
  const connectionId = sourceConnectionId ? String(sourceConnectionId).trim() : null;
  let adapterId = sourceAdapterId ? String(sourceAdapterId).trim() : null;
  const model = typeof sourceModel === "string" ? sourceModel.trim() : "";
  if (isPlugin && (!adapterId?.startsWith("plugin:") || model)) {
    return { error: "Local plugin mode requires a loaded plugin ID and does not accept a source model" };
  }
  if (model.length > 200) return { error: "Source model is too long" };
  let source = AI_PROVIDERS[providerId];
  if (!source && (isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId))) {
    const node = await getProviderNodeById(providerId);
    if (node && ["openai-compatible", "anthropic-compatible"].includes(node.type)) {
      source = { id: node.id, serviceKinds: ["llm"] };
    }
  }
  if (!source) return { error: "Unknown linked provider" };
  if (!adapterId && providerId === "codex") adapterId = "builtin:codex";
  if (adapterId) {
    if (!(source.serviceKinds || ["llm"]).includes("llm")) return { error: "Choose a regular LLM provider" };
    const adapters = await getHostedSearchAdapters();
    if (!adapterSupportsProvider(adapters.get(adapterId), providerId)) {
      return { error: "Hosted search adapter is not loaded for this provider. Install a local plugin and restart SRouter." };
    }
    if (connectionId) {
      const accounts = await getProviderConnections({ provider: providerId });
      if (!accounts.some((account) => account.id === connectionId && account.provider === providerId)) {
        return { error: "Account does not belong to the selected provider" };
      }
    }
  } else if (!(source.searchConfig || source.searchViaChat)) {
    return { error: "Linked provider has no implemented web search adapter. Install a local hosted search plugin." };
  }
  return {
    sourceProviderId: providerId, sourceConnectionId: connectionId,
    sourceAdapterId: adapterId, sourceModel: model || null,
  };
}
