import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { DEFAULT_RETRY_CONFIG, FETCH_CONNECT_TIMEOUT_MS, capRetryAttemptsByAccountCount } from "../config/runtimeConfig.js";
import { randomUUID } from "node:crypto";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { dbg } from "../utils/debugLog.js";
import { ANTHROPIC_API_VERSION } from "../providers/shared.js";
import { ZCODE_CONFIG } from "../config/zcodeConfig.js";
import { buildZCodeSourceHeaders } from "../utils/zcodeIdentity.js";
import { solveZCodeCaptcha } from "../utils/zcodeCaptcha.js";
import { applyProviderOverride } from "../utils/providerOverrides.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";

export class ZcodeExecutor extends BaseExecutor {
  constructor() {
    super("zcode", PROVIDERS.zcode);
  }

  resolveBaseUrl() {
    return ZCODE_CONFIG.planBaseUrl;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    return `${credentials?.apiKey ? ZCODE_CONFIG.apiBaseUrl : this.resolveBaseUrl()}/v1/messages`;
  }

  buildHeaders(credentials, stream = true, captchaParam = null) {
    const zcodeJwtToken = credentials?.providerSpecificData?.zcodeJwtToken || "";
    const headers = {
      "Content-Type": "application/json",
      ...this.config.headers,
      ...buildZCodeSourceHeaders(),
      "anthropic-version": ANTHROPIC_API_VERSION,
      "x-request-id": randomUUID(),
    };
    if (credentials?.apiKey) headers["x-api-key"] = credentials.apiKey;
    else if (zcodeJwtToken) headers.Authorization = `Bearer ${zcodeJwtToken}`;
    if (captchaParam) {
      headers["X-Aliyun-Captcha-Verify-Param"] = captchaParam;
      headers["X-Aliyun-Captcha-Verify-Region"] = ZCODE_CONFIG.captchaRegion;
    }
    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  transformRequest(model, body, stream, credentials) {
    const isReasoning = typeof model === "string" && /-max$/i.test(model);
    const upstreamModel = isReasoning ? model.slice(0, -4) : model;
    const nextBody = { ...body, model: upstreamModel };

    if (isReasoning) {
      // Max is a default, not permission to override explicit client intent.
      const hasControls = nextBody.thinking != null || nextBody.output_config?.effort != null
        || nextBody.reasoning_effort != null || nextBody.reasoning?.effort != null;
      if (!hasControls) {
        nextBody.thinking = { type: "enabled" };
        // Turbo's official mapping is binary; its legacy Max alias means enabled.
        if (getCapabilitiesForModel(this.provider, model).thinkingEffortSupported) {
          nextBody.output_config = { ...nextBody.output_config, effort: ZCODE_CONFIG.maxDefaultEffort };
        }
      }
    }
    // Explicit numeric budgets are passthrough, not a documented GLM capability.
    if (isReasoning && nextBody.thinking?.type === "enabled") {
      const budget = Number(nextBody.thinking.budget_tokens);
      const currentMax = Number(nextBody.max_tokens) || 0;
      if (Number.isFinite(budget) && budget > 0 && (!currentMax || currentMax <= budget)) {
        nextBody.max_tokens = budget + ZCODE_CONFIG.thinkingOutputReserve;
      }
    }

    return injectReasoningContent({ provider: this.provider, model, body: nextBody });
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null, accountCount = 0, providerOverrides = null }) {
    signal?.throwIfAborted();
    if (!credentials?.apiKey && !credentials?.providerSpecificData?.zcodeJwtToken) {
      return { response: Response.json({ error: { message: "ZCode sign-in required" } }, { status: 401 }),
        url: this.buildUrl(model, stream, 0, credentials), headers: {}, transformedBody: body };
    }
    // API keys use the official Anthropic endpoint, not browser verification.
    if (credentials?.apiKey) return super.execute({ model, body, stream, credentials, signal, log, proxyOptions, accountCount, providerOverrides });
    const captchaParam = await solveZCodeCaptcha(log, proxyOptions, signal);
    signal?.throwIfAborted();
    const url = this.buildUrl(model, stream, 0, credentials);
    const transformedBody = this.transformRequest(model, body, stream, credentials);
    const headers = applyProviderOverride(this.buildHeaders(credentials, stream, captchaParam), providerOverrides);

    const retryConfig = capRetryAttemptsByAccountCount(
      { ...DEFAULT_RETRY_CONFIG, ...this.config.retry },
      accountCount
    );
    const retryAttempts = { count: 0 };
    const maxRetries = retryConfig[403]?.attempts ?? retryConfig[401]?.attempts ?? 1;

    while (retryAttempts.count <= maxRetries) {
      const connectCtrl = new AbortController();
      const timeoutMs = this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
      const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
      const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

      try {
        const bodyStr = JSON.stringify(transformedBody);
        dbg("FETCH", `ZCODE → ${url} | body=${bodyStr.length}B | captcha=${captchaParam ? "yes" : "no"}`);
        const response = await proxyAwareFetch(url, {
          method: "POST",
          headers,
          body: bodyStr,
          signal: mergedSignal,
        }, proxyOptions);
        clearTimeout(connectTimer);

        const ct = response.headers?.get?.("content-type") || "";
        dbg("FETCH", `ZCODE ← ${response.status} | ct=${ct}`);

        if ((response.status === 401 || response.status === 403) && retryAttempts.count < maxRetries) {
          retryAttempts.count++;
          log?.warn?.("RETRY", `${response.status}, captcha retry ${retryAttempts.count}/${maxRetries}`);
          const freshCaptcha = await solveZCodeCaptcha(log, proxyOptions, signal);
          if (freshCaptcha) {
            await response.body?.cancel();
            signal?.throwIfAborted();
            headers["X-Aliyun-Captcha-Verify-Param"] = freshCaptcha;
            continue;
          }
        }

        return { response, url, headers, transformedBody };
      } catch (error) {
        clearTimeout(connectTimer);
        if (error.name === "AbortError" && !connectCtrl.signal.aborted) throw error;
        throw error;
      }
    }

    throw new Error(`ZCode Plan request failed after ${maxRetries} retries`);
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials?.accessToken) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let response;
    try {
      response = await proxyAwareFetch(ZCODE_CONFIG.businessLoginUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-request-id": randomUUID(),
        },
        body: JSON.stringify({ token: credentials.accessToken }),
        signal: ctrl.signal,
      }, proxyOptions);
    } catch (err) {
      clearTimeout(timer);
      log?.warn?.("TOKEN", "Zcode business-token refresh failed");
      return null;
    }
    clearTimeout(timer);
    if (!response.ok) {
      log?.warn?.("TOKEN", `Zcode business-token refresh HTTP ${response.status}`);
      return null;
    }
    const data = await response.json().catch(() => null);
    const newBusinessToken = data?.data?.access_token || data?.data?.token || "";
    if (!newBusinessToken) {
      log?.warn?.("TOKEN", "Zcode business-token refresh: empty token in response");
      return null;
    }
    return {
      accessToken: credentials.accessToken,
      providerSpecificData: {
        ...(credentials.providerSpecificData || {}),
        businessToken: newBusinessToken,
      },
    };
  }
}
