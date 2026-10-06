import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
} from "../services/auth.js";
import { authenticateRequest, checkKindAccess, checkComboAccess, checkTargetAccess } from "../services/requestAccess.js";
import { getSettings, getCombos } from "@/lib/localDb";
import { getProviderNodeById } from "@/lib/db/index.js";
import { AI_PROVIDERS, resolveProviderId, isCustomWebSearchProvider } from "@/shared/constants/providers.js";
import { handleSearchCore } from "open-sse/handlers/search/index.js";
import { stripClientBaseUrlOverride } from "open-sse/handlers/search/callers.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { handleComboChat, getComboModelsFromData } from "open-sse/services/combo.js";
import { readBoundedJson } from "../utils/boundedBody.js";
import { getHostedSearchAdapters, adapterSupportsProvider, runHostedSearch } from "@/lib/hostedSearch/registry.js";
import { isModelAllowed } from "../services/allowedModels.js";
import { HOSTED_TOOLS_WIP, HOSTED_TOOLS_WIP_MESSAGE } from "@/shared/constants/hostedTools.js";

/**
 * Handle web search request for the SSE/Next.js server.
 * Provider IS the model (no model field). Mirrors handleEmbeddings auth + fallback flow.
 *
 * @param {Request} request
 */
export async function handleSearch(request) {
  const { body, error } = await readBoundedJson(request);
  if (error) return error;

  const url = new URL(request.url);
  // Accept either `provider` or `model` (UI sends `model` since provider IS the model for webSearch)
  const providerInput = body.provider || body.model;
  const query = body.query;

  log.request("POST", `${url.pathname} | ${providerInput}`);

  // Log API key (masked)
  const apiKey = extractApiKey(request);
  if (apiKey) {
    log.debug("AUTH", `API Key: ${log.maskKey(apiKey)}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  const { apiKeyInfo, error: authError } = await authenticateRequest(request, settings);
  if (authError) return authError;
  const kindError = checkKindAccess(apiKeyInfo, "webSearch");
  if (kindError) return kindError;

  if (!providerInput || typeof providerInput !== "string") {
    log.warn("SEARCH", "Missing provider/model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: provider (or model)");
  }

  if (!query || typeof query !== "string" || !query.trim()) {
    log.warn("SEARCH", "Missing query");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: query");
  }

  // Combo expansion: providerInput may be a combo name → run fallback/round-robin across providers
  const combos = await getCombos();
  const comboModels = getComboModelsFromData(providerInput, combos);
  if (comboModels) {
    const comboError = checkComboAccess(apiKeyInfo, providerInput);
    if (comboError) return comboError;
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[providerInput]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("SEARCH", `Combo "${providerInput}" with ${comboModels.length} providers (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleProviderSearch(b, m, request, apiKey, settings, apiKeyInfo),
      log,
      comboName: providerInput,
      comboStrategy,
      comboStickyLimit
    });
  }

  return handleSingleProviderSearch(body, providerInput, request, apiKey, settings, apiKeyInfo);
}

async function handleSingleProviderSearch(body, providerInput, request, apiKey, settings, apiKeyInfo) {
  const query = body.query;
  const providerId = resolveProviderId(providerInput);
  const resolvedProvider = AI_PROVIDERS[providerId];
  const targetError = await checkTargetAccess(apiKeyInfo, providerId, "search", "webSearch");
  if (targetError) return targetError;

  // Custom web search provider nodes (custom-websearch-*): stable node id is
  // the request/combo target; the provider entry is synthesized from the node.
  if (isCustomWebSearchProvider(providerId)) {
    return handleCustomWebSearch(body, providerId, apiKeyInfo);
  }

  if (!resolvedProvider) {
    log.warn("SEARCH", "Unknown provider", { provider: providerInput });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown provider: ${providerInput}`);
  }

  const providerConfig = resolvedProvider.searchConfig;
  const supportsSearch = !!providerConfig || !!resolvedProvider.searchViaChat;

  if (!supportsSearch) {
    log.warn("SEARCH", "Provider does not support web search", { provider: providerId });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Provider ${providerId} does not support web search`);
  }

  if (providerInput !== providerId) {
    log.info("ROUTING", `${providerInput} → ${providerId}`);
  } else {
    log.info("ROUTING", `Provider: ${providerId}`);
  }

  // Sanitized body forwarded to core
  const coreBody = {
    query: query.trim(),
    provider: providerId,
    max_results: body.max_results,
    search_type: body.search_type,
    country: body.country,
    language: body.language,
    time_range: body.time_range,
    offset: body.offset,
    domain_filter: body.domain_filter,
    content_options: body.content_options,
    provider_options: body.provider_options
  };

  // No-auth providers (e.g. searxng) bypass credential lookup
  if (resolvedProvider.noAuth) {
    log.info("AUTH", `\x1b[32m${providerId} no-auth mode\x1b[0m`);
    const result = await handleSearchCore({
      body: coreBody,
      provider: resolvedProvider,
      providerConfig,
      credentials: null,
      log
    });
    if (result.success) return result.response;
    return result.response;
  }

  // Credential + fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  // Credential fallback: some search providers reuse the API key of a related
  // chat provider (e.g. ollama-search reuses the `ollama` chat key, zai-search
  // reuses the `glm` chat key). When the search provider has no own connection,
  // fall back to the linked provider's credentials.
  const fallbackProviderId = resolvedProvider.credentialFallback;

  // Lock scope for this handler. Without it markAccountUnavailable would write
  // an account-wide `__all` lock, which on the credentialFallback path takes
  // the shared chat key (e.g. glm) offline for chat as well. Must be passed to
  // getProviderCredentials too, so the lock is read back under the same key.
  const searchLockKey = `websearch:${providerId}`;

  while (true) {
    // Provider that actually owns the connection in use — differs from
    // providerId once we fall back, and error locks must be attributed to it.
    let credentialProviderId = providerId;
    let credentials = await getProviderCredentials(providerId, excludeConnectionIds, searchLockKey);

    // Fall back to the related chat provider's credentials when this search
    // provider has none of its own (one key, chat + search).
    if (!credentials && fallbackProviderId) {
      credentials = await getProviderCredentials(fallbackProviderId, excludeConnectionIds, searchLockKey);
      if (credentials) {
        credentialProviderId = fallbackProviderId;
        log.info("AUTH", `\x1b[32m${providerId} reusing ${fallbackProviderId} credentials\x1b[0m`);
      }
    }

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("SEARCH", `[${providerId}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${providerId}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.error("AUTH", `No credentials for provider: ${providerId}`);
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${providerId}`);
      }
      log.warn("SEARCH", "No more accounts available", { provider: providerId });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    log.info("AUTH", `\x1b[32mUsing ${providerId} account: ${credentials.connectionName}\x1b[0m`);

    const refreshedCredentials = await checkAndRefreshToken(providerId, credentials);

    const result = await handleSearchCore({
      body: coreBody,
      provider: resolvedProvider,
      providerConfig,
      credentials: refreshedCredentials,
      log,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials);
      }
    });

    if (result.success) return result.response;

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, credentialProviderId, searchLockKey);

    if (shouldFallback) {
      log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}

// ── Custom web search provider nodes (custom-websearch-*) ─────────────────
// Three modes: a user-defined SearXNG-compatible endpoint, a generic JSON
// search API, or the already-implemented search adapter of a linked provider
// (with optional strict account pinning). Adapter identity (builder/normalizer
// keys) is config-driven; response attribution stays the custom node id.

const CUSTOM_SEARCH_SEARCH_TYPES = ["web", "news"];

async function handleCustomWebSearch(body, providerId, apiKeyInfo) {
  const query = body.query;
  const node = await getProviderNodeById(providerId);
  if (!node || node.type !== "custom-websearch") {
    log.warn("SEARCH", "Unknown custom web search provider", { provider: providerId });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown provider: ${providerId}`);
  }

  const coreBody = {
    query: query.trim(),
    provider: providerId,
    max_results: body.max_results,
    search_type: body.search_type,
    country: body.country,
    language: body.language,
    time_range: body.time_range,
    offset: body.offset,
    domain_filter: body.domain_filter,
    content_options: body.content_options,
    provider_options: body.provider_options
  };

  if (["linked", "plugin"].includes(node.mode)) {
    if (HOSTED_TOOLS_WIP && node.mode !== "plugin") return errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, HOSTED_TOOLS_WIP_MESSAGE);
    return handleLinkedCustomSearch(coreBody, node, providerId, apiKeyInfo);
  }

  if (!["searxng", "json"].includes(node.mode)) {
    log.warn("SEARCH", "Invalid custom web search mode", { provider: providerId, mode: node.mode });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Custom provider ${providerId} has an invalid mode`);
  }

  const providerConfig = {
    baseUrl: node.baseUrl,
    method: node.mode === "searxng" ? "GET" : "POST",
    builder: node.mode === "searxng" ? "custom-searxng" : "custom-json",
    normalizer: node.mode === "searxng" ? "searxng" : "custom-json",
    authType: node.authHeader && node.authHeader !== "none" ? "apiKey" : "none",
    authHeader: node.authHeader || "none",
    searchTypes: CUSTOM_SEARCH_SEARCH_TYPES,
    defaultMaxResults: 5,
    maxMaxResults: 50,
    timeoutMs: 10000
  };
  const provider = { id: providerId, noAuth: providerConfig.authType === "none" };

  if (providerConfig.authType === "none") {
    log.info("AUTH", `\x1b[32m${providerId} no-auth mode\x1b[0m`);
    const result = await handleSearchCore({ body: coreBody, provider, providerConfig, credentials: null, log });
    return result.response;
  }

  return runCustomSearchCredentialLoop(coreBody, provider, providerConfig, providerId, providerId);
}

async function handleLinkedCustomSearch(coreBody, node, providerId, apiKeyInfo) {
  const isPlugin = node.mode === "plugin";
  if (isPlugin && (!node.sourceAdapterId?.startsWith("plugin:") || node.sourceModel)) {
    return errorResponse(400, "Local plugin mode requires a loaded plugin ID and does not accept a source model");
  }
  const adapterId = node.sourceAdapterId || (node.sourceProviderId === "codex" ? "builtin:codex" : null);
  const adapter = adapterId ? (await getHostedSearchAdapters()).get(adapterId) : null;
  let source = AI_PROVIDERS[node.sourceProviderId];
  if (!source && adapter) {
    const sourceNode = await getProviderNodeById(node.sourceProviderId);
    if (sourceNode && ["openai-compatible", "anthropic-compatible"].includes(sourceNode.type)) {
      source = { id: sourceNode.id, serviceKinds: ["llm"] };
    }
  }
  if (adapterId && !adapterSupportsProvider(adapter, node.sourceProviderId)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Hosted search adapter is not loaded for this provider; restart after installing the plugin");
  }
  if (!source || (!adapter && !(source.searchConfig || source.searchViaChat))) {
    log.warn("SEARCH", "Linked provider has no web search adapter", { provider: providerId, source: node.sourceProviderId });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Custom provider ${providerId}: linked provider has no web search adapter`);
  }
  // A wrapper must not evade a restricted key's provider ACL or disabled
  // models: the underlying provider must pass the same target check as a
  // direct request (kind + provider + search-model allowances).
  const nativeAdapter = adapter && (isPlugin || !adapter.legacy);
  const model = isPlugin ? "" : (node.sourceModel || adapter?.defaultModel || source.searchViaChat?.defaultModel || "");
  const sourceAccess = await checkTargetAccess(apiKeyInfo, node.sourceProviderId, nativeAdapter ? null : "search", "webSearch");
  if (sourceAccess) return sourceAccess;
  if (adapter && model && !await isModelAllowed(`${node.sourceProviderId}/${model}`, apiKeyInfo || {}, "llm")) {
    return errorResponse(404, "Hosted search model is unavailable or disabled");
  }

  // The source adapter authenticates with the source connection's stored
  // credentials, so a caller-supplied provider_options.baseUrl must never
  // redirect them to a caller-chosen origin (inherited static builders honor
  // that override; linked mode strips it).
  const linkedBody = {
    ...coreBody,
    provider_options: stripClientBaseUrlOverride(coreBody.provider_options),
  };
  const linkedSource = adapter?.legacy && model
    ? { ...source, searchViaChat: { ...source.searchViaChat, defaultModel: model } } : source;
  const runCore = nativeAdapter
    ? (options) => runHostedSearch({ ...options, adapter, model }) : handleSearchCore;

  // No-auth sources (e.g. SearXNG) dispatch without a credential lookup,
  // mirroring the static search path; a pinned account is not applicable.
  if (source.noAuth) {
    log.info("AUTH", `\x1b[32m${providerId} linked to no-auth ${source.id}\x1b[0m`);
    const result = await runCore({
      body: linkedBody,
      provider: linkedSource,
      providerConfig: adapter ? null : source.searchConfig,
      credentials: null,
      log,
      attributionId: providerId,
    });
    return result.response;
  }

  // When a specific account is selected, strict pinning refuses substitution
  // and disables the credential fallback below.
  return runCustomSearchCredentialLoop(
    linkedBody, linkedSource, adapter ? null : source.searchConfig, node.sourceProviderId,
    providerId,
    {
      preferredConnectionId: node.sourceConnectionId || null,
      fallbackProviderId: isPlugin ? null : (source.credentialFallback || null),
      runCore,
    }
  );
}

async function runCustomSearchCredentialLoop(
  coreBody, provider, providerConfig, credentialProviderId,
  attributionId, { preferredConnectionId = null, fallbackProviderId = null, runCore = handleSearchCore } = {}
) {
  // Lock scope: the public request target (in linked mode the custom node id),
  // mirroring the static path where the lock key is scoped to the public search
  // provider while error attribution (markAccountUnavailable) goes to the
  // credential-owning provider. Direct calls to the source provider keep their
  // own lock, so a linked node cannot take the source's locks offline.
  const searchLockKey = `websearch:${attributionId}`;
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    // Provider that actually owns the connection in use — differs once we fall
    // back (e.g. ollama-search reuses the `ollama` chat key), and error locks
    // must be attributed to it.
    let ownerId = credentialProviderId;
    const options = preferredConnectionId
      ? { preferredConnectionId, strictPreferredConnection: true }
      : {};
    let credentials = await getProviderCredentials(credentialProviderId, excludeConnectionIds, searchLockKey, options);

    // Credential fallback mirrors the static search path: when the source
    // provider has no own connection, reuse the related provider's key.
    if (!credentials && fallbackProviderId && !preferredConnectionId) {
      credentials = await getProviderCredentials(fallbackProviderId, excludeConnectionIds, searchLockKey);
      if (credentials) {
        ownerId = fallbackProviderId;
        log.info("AUTH", `\x1b[32m${attributionId} reusing ${fallbackProviderId} credentials\x1b[0m`);
      }
    }

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("SEARCH", `[${attributionId}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${attributionId}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.error("AUTH", `No credentials for provider: ${credentialProviderId}`);
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${credentialProviderId}`);
      }
      log.warn("SEARCH", "No more accounts available", { provider: credentialProviderId });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    log.info("AUTH", `\x1b[32mUsing ${ownerId} account: ${credentials.connectionName}\x1b[0m`);

    const refreshedCredentials = await checkAndRefreshToken(ownerId, credentials);

    const result = await runCore({
      body: coreBody,
      provider,
      providerConfig,
      credentials: refreshedCredentials,
      log,
      attributionId
    });

    if (result.success) return result.response;

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, ownerId, searchLockKey);

    if (shouldFallback) {
      log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
