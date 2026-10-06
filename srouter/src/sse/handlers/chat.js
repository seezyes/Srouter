import "open-sse/index.js";
import { getEffectiveProviderOverride } from "open-sse/config/providerFeatures.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
} from "../services/auth.js";
import { authenticateRequest, checkKindAccess, checkComboAccess, checkTargetAccess } from "../services/requestAccess.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { getSettings, updateProviderConnection } from "@/lib/localDb";
import { resolveConnectionProxyConfig, getProxyHash } from "@/lib/network/connectionProxy";
import {
  isProviderInCooldown,
  isProviderFullyBlocked,
  getProviderShortestCooldownMs,
  recordProviderFailure,
  checkFallbackError,
  clearProviderFailure,
  isKimchiQuotaExhausted,
  buildKimchiQuotaExhaustedUpdate,
  detectDailyQuotaExhaustion,
  buildDailyQuotaLockUpdate,
} from "open-sse/services/accountFallback.js";
import {
  acquire as acquireAccountSemaphore,
  resolveAccountSemaphoreKey,
  resolveAccountSemaphoreMaxConcurrency,
  isSemaphoreCapacityError,
} from "open-sse/services/accountSemaphore.js";
import { maybeWaitForCooldown, MAX_COOLDOWN_RETRIES } from "open-sse/utils/cooldownRetry.js";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { upstreamResponseHeaders } from "open-sse/utils/upstreamHeaders.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS, MAX_ACCOUNT_FALLBACK_ATTEMPTS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import { getVisionAdvisorModels, runVisionAdvisor, shouldUseVisionAdvisor } from "../services/visionAdvisor.js";
import { readBoundedJson } from "../utils/boundedBody.js";
import { isTrustedInternalProbe } from "@/lib/auth/internalProbe.js";

async function advisorTarget(modelStr) {
  if (modelStr.includes("/")) return modelStr;
  const { provider, model } = await getModelInfo(modelStr);
  return provider ? `${provider}/${model}` : modelStr;
}

async function adapterSettingsFor(body, settings, request, models) {
  if (!settings.visionAdvisor?.enabled) return settings;
  const endpoint = request && new URL(request.url).pathname;
  const targets = await Promise.all(models.map(advisorTarget));
  if (!targets.some((model) => shouldUseVisionAdvisor(body, model, settings, endpoint))) return settings;
  return { ...settings, capacityAdapter: {
    ...settings.capacityAdapter,
    vision: { ...settings.capacityAdapter?.vision, enabled: false },
  } };
}

async function routeWithAdvisor(body, modelStr, raw, request, apiKey, apiKeyInfo, settings, requestedModel = null) {
  const resolved = await getModelInfo(modelStr);
  if (resolved.provider) {
    const targetError = await checkTargetAccess(apiKeyInfo, resolved.provider, resolved.model, "llm");
    if (targetError) return targetError;
  }
  const target = settings.visionAdvisor?.enabled ? await advisorTarget(modelStr) : modelStr;
  if (!shouldUseVisionAdvisor(body, target, settings, request && new URL(request.url).pathname)) {
    return handleSingleModelChat(body, modelStr, raw, request, apiKey, apiKeyInfo, requestedModel);
  }
  return runVisionAdvisor({
    endpoint: request && new URL(request.url).pathname,
    body, modelStr, advisorModels: getVisionAdvisorModels(settings, target), signal: request?.signal,
    send: (model, internalBody) => handleSingleModelChat(
      internalBody, model, raw ? { ...raw, body: internalBody } : null, request, apiKey, apiKeyInfo,
      model === modelStr ? requestedModel : null
    ),
  });
}

function targetRequest(request, options) {
  if (!options?.signal) return request;
  return { url: request?.url, headers: request?.headers, signal: options.signal,
    routingOptions: { ...request?.routingOptions, ...options } };
}

/**
 * Circuit-breaker gate. With a proxy hash it checks that account's proxy
 * bucket; without one it falls back to the provider-wide gate (every bucket
 * OPEN ⇒ no credential can currently succeed).
 */
function checkCircuitBreaker(provider, proxyHash = null, enabled = true) {
  if (!enabled) return false;
  return proxyHash ? isProviderInCooldown(provider, proxyHash) : isProviderFullyBlocked(provider);
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  const { body, error } = await readBoundedJson(request);
  if (error) {
    log.warn("CHAT", error.status === HTTP_STATUS.PAYLOAD_TOO_LARGE ? "Body too large" : "Invalid JSON body");
    return error;
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  const { apiKeyInfo, error: authError } = await authenticateRequest(request, settings);
  if (authError) return authError;
  const kindError = checkKindAccess(apiKeyInfo, "llm");
  if (kindError) return kindError;

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    const comboError = checkComboAccess(apiKeyInfo, modelStr);
    if (comboError) return comboError;
  } else {
    const resolved = await getModelInfo(modelStr);
    if (resolved.provider) {
      const targetError = await checkTargetAccess(apiKeyInfo, resolved.provider, resolved.model, "llm");
      if (targetError) return targetError;
    }
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const adapterSettings = await adapterSettingsFor(body, settings, request, comboModels || [modelStr]);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, adapterSettings);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        signal: request?.signal,
        targetTimeoutMs: comboStrategies[modelStr]?.targetTimeoutMs ?? settings.comboTargetTimeoutMs,
        handleSingleModel: (b, m, isPanel, options) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return routeWithAdvisor(b, m, cleanRawReq, targetRequest(request, options), apiKey, apiKeyInfo, settings);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: augmentedModels,
      signal: request?.signal,
      targetTimeoutMs: comboStrategies[modelStr]?.targetTimeoutMs ?? settings.comboTargetTimeoutMs,
      queueDepth: comboStrategies[modelStr]?.queueDepth,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m, options) => routeWithAdvisor(b, m, clientRawRequest, targetRequest(request, options), apiKey, apiKeyInfo, settings),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, adapterSettings);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      signal: request?.signal,
      targetTimeoutMs: settings.comboTargetTimeoutMs,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m, options) => routeWithAdvisor(b, m, clientRawRequest, targetRequest(request, options), apiKey, apiKeyInfo, settings),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
    });
  }

  return routeWithAdvisor(body, modelStr, clientRawRequest, request, apiKey, apiKeyInfo, settings, contextMarker ? `${modelStr.slice(modelStr.indexOf('/') + 1)}[${contextMarker}]` : null);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, apiKeyInfo = null, requestedModel = null) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const comboError = checkComboAccess(apiKeyInfo, modelStr);
      if (comboError) return comboError;
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          signal: request?.signal,
          targetTimeoutMs: comboStrategies[modelStr]?.targetTimeoutMs ?? chatSettings.comboTargetTimeoutMs,
          handleSingleModel: (b, m, isPanel, options) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, targetRequest(request, options), apiKey, apiKeyInfo);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        signal: request?.signal,
        targetTimeoutMs: comboStrategies[modelStr]?.targetTimeoutMs ?? chatSettings.comboTargetTimeoutMs,
        queueDepth: comboStrategies[modelStr]?.queueDepth,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m, options) => handleSingleModelChat(b, m, clientRawRequest, targetRequest(request, options), apiKey, apiKeyInfo),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;
  const targetError = await checkTargetAccess(apiKeyInfo, provider, model, "llm");
  if (targetError) return targetError;

  // Dashboard model diagnostics ("Test" button) call this same public endpoint
  // over loopback carrying the machine-bound CLI token plus an explicit probe
  // marker. Only that authenticated pair may ignore account-pool membership in
  // credential lookup; client traffic always enforces pools.
  const internalProbe = await isTrustedInternalProbe(request);

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  let cooldownRetries = 0;
  let fallbackAttempts = 0;
  const earlyEofRetried = new Set();
  const clientSignal = request?.signal || null;

  const gateSettings = await getSettings();
  const circuitBreakerEnabled = gateSettings.circuitBreakerEnabled !== false && gateSettings.circuitBreakerEnabled !== 0;

  // Pipeline gate: check circuit breaker state BEFORE credential lookup.
  // If ALL proxy buckets for this provider are OPEN, short-circuit immediately
  // — no point querying the DB when every bucket is blocked.
  if (checkCircuitBreaker(provider, null, circuitBreakerEnabled)) {
    const cooldownMs = getProviderShortestCooldownMs(provider);
    const retryAfterSec = Math.ceil(cooldownMs / 1000) || 30;
    const retryAfterTimestamp = new Date(Date.now() + cooldownMs).toISOString();
    log.warn("GATE", `${provider} circuit breaker OPEN on all proxy buckets — short-circuiting before credential lookup`);
    return unavailableResponse(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      `[${provider}/${model}] Provider temporarily unavailable (circuit breaker open)`,
      retryAfterTimestamp,
      `${retryAfterSec}s`
    );
  }
  let lastHeaders = null;

  while (true) {
    // Abort check: stop trying accounts if the client already disconnected.
    // Prevents wasted upstream calls and circuit-breaker probe hits on a dead
    // connection.
    if (request?.signal?.aborted) {
      log.info("CHAT", `[${provider}/${model}] client disconnected — aborting fallback loop`);
      return new Response(null, { status: 499 });
    }

    if (fallbackAttempts >= MAX_ACCOUNT_FALLBACK_ATTEMPTS) {
      log.warn("CHAT", `[${provider}/${model}] account fallback attempt limit reached`);
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "Account fallback attempt limit reached");
    }

    const requestedContext = stripModelContextMarker(requestedModel).contextMarker;
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
      ignoreAccountPools: internalProbe,
      // Same trusted-probe boundary: a manual model test must reach the upstream
      // even while our own retry probe still blocks the account for normal traffic.
      ignoreModelLocks: internalProbe,
      // Aliases carry the context marker, not the target model's identity.
      requestedModel: requestedContext ? `${model}[${requestedContext}]` : requestedModel || model,
    });

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        // Cooldown-aware retry: if the earliest account comes off cooldown soon,
        // wait for it (aborted on client disconnect) then retry once.
        if (credentials.retryAfter && cooldownRetries < MAX_COOLDOWN_RETRIES) {
          const waitDecision = await maybeWaitForCooldown({
            retryAfter: credentials.retryAfter,
            retriesSoFar: cooldownRetries,
            signal: request?.signal,
          });
          if (waitDecision.shouldRetry) {
            cooldownRetries++;
            log.info("CHAT", `[${provider}/${model}] all accounts rate-limited — waited ${waitDecision.waitedMs}ms, retrying (attempt ${cooldownRetries})`);
            // Re-enter the loop WITHOUT excluding accounts — they may be usable now.
            continue;
          }
          if (waitDecision.reason === "client_disconnected") {
            log.info("CHAT", `[${provider}/${model}] client disconnected during cooldown wait — aborting`);
            // Return a minimal response; client is gone anyway.
            return new Response(null, { status: 499 });
          }
          log.info("CHAT", `[${provider}/${model}] cooldown retry skipped: ${waitDecision.reason}`);
        }
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman, lastHeaders);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable", lastHeaders);
    }

    // Compute proxy bucket key for this account — groups accounts by shared proxy.
    // Uses the original credentials: proxy config (connectionProxyUrl/proxyPoolId)
    // is a connection-level field that does not change on token refresh.
    const proxyHash = getProxyHash(credentials.providerSpecificData);

    // Proxy-aware circuit breaker: skip THIS account if its proxy bucket is OPEN.
    // Accounts on other proxies are still tried.
    if (checkCircuitBreaker(provider, proxyHash, circuitBreakerEnabled)) {
      log.warn("AUTH", `${provider} proxy bucket ${proxyHash} circuit breaker OPEN — skipping account ${credentials.connectionName}`);
      excludeConnectionIds.add(credentials.connectionId);
      continue;
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();

    // Acquire account semaphore (concurrency limiter per provider:account:proxy)
    const semaphoreKey = resolveAccountSemaphoreKey({ provider, model, connectionId: credentials.connectionId, credentials: refreshedCredentials, proxyHash });
    const semaphoreMax = resolveAccountSemaphoreMaxConcurrency(refreshedCredentials);
    const semaphoreEnabled = chatSettings.semaphoreEnabled !== false && chatSettings.semaphoreEnabled !== 0;
    let semaphoreRelease = () => {};
    if (semaphoreEnabled && semaphoreKey && semaphoreMax != null) {
      try {
        const semaphoreOptions = { maxConcurrency: semaphoreMax, timeoutMs: 30_000, signal: request?.signal };
        if (request?.routingOptions?.maxQueueSize != null) semaphoreOptions.maxQueueSize = request.routingOptions.maxQueueSize;
        semaphoreRelease = await acquireAccountSemaphore(semaphoreKey, semaphoreOptions);
      } catch (e) {
        if (isSemaphoreCapacityError(e)) {
          log.warn("AUTH", `Account ${credentials.connectionName} at capacity, trying fallback`);
          excludeConnectionIds.add(credentials.connectionId);
          continue;
        }
        throw e;
      }
    }

    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    // Wrap in try/finally so the semaphore slot is always released.
    let result;
    try {
      for (;;) {
      fallbackAttempts++;
      result = await handleChatCore({
      // Every account/combo/advisor attempt starts from the uninjected history.
      // Core translation and token savers may mutate nested request fields.
      body: { ...structuredClone(body), model: `${provider}/${model}` },
      customSystemPrompts: gateSettings.customSystemPrompts,
      modelInfo: { provider, model, accountCount: credentials.accountCount || 0 },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      apiKeyName: apiKeyInfo?.name || null,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomTimeoutMs: chatSettings.headroomTimeoutMs,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      loopGuardEnabled: !!chatSettings.loopGuardEnabled,
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      clientSignal,
      // Re-resolve the egress pool after a pool-scoped failure (the pool is
      // excluded so the retry lands on a different one).
      resolveProxyConfig: async (creds, excludePoolIds = []) => {
        const psd = { ...(creds?.providerSpecificData || {}) };
        if (psd.proxyPoolIds?.length || provider === "freebuff") psd.proxyPoolScope = `${provider}::${model}`;
        const resolved = await resolveConnectionProxyConfig(psd, creds?.connectionId || creds?.id, excludePoolIds);
        if (!resolved?.proxyPoolId && !resolved?.noFitPool) return null;
        return {
          connectionProxyEnabled: resolved.connectionProxyEnabled,
          connectionProxyUrl: resolved.connectionProxyUrl,
          connectionNoProxy: resolved.connectionNoProxy,
          connectionProxyPoolId: resolved.proxyPoolId || null,
          vercelRelayUrl: resolved.vercelRelayUrl || "",
          proxyPoolId: resolved.proxyPoolId || null,
          strictProxy: resolved.strictProxy === true,
          noFitPool: resolved.noFitPool === true,
        };
      },
      // Per-provider user overrides (custom headers / connect timeout) from settings
      providerOverrides: getEffectiveProviderOverride(provider, chatSettings),
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // "Consecutive" strikes: a success clears the breaker for this pair.
        clearAntigravityStrikes(credentials.connectionId, model);
      }
    });
      if (!result.earlyEof || earlyEofRetried.has(credentials.connectionId) ||
          fallbackAttempts >= MAX_ACCOUNT_FALLBACK_ATTEMPTS || clientSignal?.aborted) break;
      earlyEofRetried.add(credentials.connectionId);
      log.warn("CHAT", "Empty upstream stream: retrying the same connection once");
      }
    } finally {
      // Always release the semaphore slot, even if handleChatCore throws
      semaphoreRelease();
    }

    if (result.success) {
      // Circuit breaker: a successful call clears this provider's proxy bucket.
      clearProviderFailure(provider, proxyHash);
      return result.response;
    }

    // Client disconnected mid-flight: exit WITHOUT locking/marking the account —
    // the upstream failure may simply be our own abort rippling through.
    if (clientSignal?.aborted) {
      log.info("CHAT", `[${provider}/${model}] client disconnected — skipping account lock/fallback`);
      return new Response(null, { status: 499 });
    }

    // Normalize result.error to a string before passing to pattern matchers.
    // Some upstream paths may return an Error instance; JSON.stringify(new Error())
    // yields "{}" and breaks keyword matching in quota detectors.
    const errorText = result.error?.message || result.error;

    // Kimchi quota exhausted: deactivate the account until the 1st of next month.
    if (isKimchiQuotaExhausted(provider, errorText)) {
      try {
        const update = buildKimchiQuotaExhaustedUpdate();
        await updateProviderConnection(credentials.connectionId, update);
        log.warn("AUTH", `Kimchi quota exhausted: deactivated ${credentials.connectionName || credentials.connectionId} until ${update.rateLimitedUntil}`);
      } catch (e) {
        log.error("AUTH", `Failed to deactivate Kimchi account on quota exhausted: ${e.message}`);
      }
      // Fall through to fallback behavior — the next account or provider will be tried.
    }

    // Generalized daily quota detection (non-Kimchi): when a 429 error body
    const dailyQuota = detectDailyQuotaExhaustion(provider, errorText);
    if (dailyQuota && result.status === 429) {
      try {
        const lockUpdate = buildDailyQuotaLockUpdate(model);
        await updateProviderConnection(credentials.connectionId, lockUpdate);
        log.warn("AUTH", `Daily quota exhausted: ${model} on ${credentials.connectionName || credentials.connectionId} — announced reset tomorrow 00:00 UTC (blocking window is the short retry probe)`);
      } catch (e) {
        log.error("AUTH", `Failed to lock model on daily quota exhaustion: ${e.message}`);
      }
      // Fall through to fallback behavior — the next account will be tried.
    }

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    const shouldFallback = provider === "antigravity" && quotaResetMs
      ? true
      : (await markAccountUnavailable(credentials.connectionId, result.status, errorText, provider, model, resetsAtMs)).shouldFallback;

    // Record provider-level failure for circuit breaker — skip if it's a known
    // Kimchi quota-exhaustion (not a provider-wide outage). Proxy-aware: failure
    // is attributed to the specific proxy bucket.
    if (!isKimchiQuotaExhausted(provider, errorText) && !checkFallbackError(result.status, errorText).isContentFilter) {
      recordProviderFailure(provider, result.status, errorText, log, credentials.connectionId, proxyHash);
    }

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = errorText;
      lastStatus = result.status;
      lastHeaders = upstreamResponseHeaders(result.response?.headers);
      continue;
    }

    return result.response;
  }
}
