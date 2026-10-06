import { PROVIDER_OAUTH, PROVIDER_MODELS } from "open-sse/providers/index.js";
import { ZCODE_CONFIG } from "open-sse/config/zcodeConfig.js";
import { buildZCodeSourceHeaders } from "open-sse/utils/zcodeIdentity.js";
import { randomUUID } from "node:crypto";

const config = PROVIDER_OAUTH.zcode;
const zcode = {
  config,
  flowType: "authorization_code",
  fixedRedirectUri: ZCODE_CONFIG.redirectUri,
  buildAuthUrl: (settings, redirectUri, state) => {
    const params = new URLSearchParams({
      redirect_uri: ZCODE_CONFIG.redirectUri, response_type: "code", client_id: settings.clientId, state,
    });
    return `${settings.authorizeUrl}?${params}`;
  },
  exchangeToken: async (settings, code, redirectUri, codeVerifier, state) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(settings.tokenUrl, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ provider: "zai", code, redirect_uri: ZCODE_CONFIG.redirectUri, state: state || "" }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || (data.code !== undefined && data.code !== 0)) {
        throw new Error(`ZCode token exchange failed (HTTP ${response.status})`);
      }
      const tokens = data.data;
      const accessToken = tokens?.zai?.access_token || tokens?.access_token;
      if (!accessToken) throw new Error("ZCode token exchange returned no access token");
      return {
        accessToken, refreshToken: tokens?.zai?.refresh_token || tokens?.refresh_token,
        zcodeJwtToken: tokens?.token || "", expiresIn: tokens?.expires_in,
      };
    } finally {
      clearTimeout(timeout);
    }
  },
  postExchange: async (tokens) => {
    // The pinned registry has no usable profile/subscription URLs. Do not
    // fabricate zero quotas or query undefined URLs. Business login is the
    // same source-backed endpoint used by the specialized executor.
    try {
      const response = await fetch(ZCODE_CONFIG.businessLoginUrl, {
        method: "POST", headers: { "Content-Type": "application/json", ...buildZCodeSourceHeaders(), "x-request-id": randomUUID() },
        body: JSON.stringify({ token: tokens.accessToken }), signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) return null;
      const data = await response.json();
      return { businessToken: data?.data?.access_token || data?.data?.token || "" };
    } catch {
      return null;
    }
  },
  mapTokens: (tokens, extra) => ({
    accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresIn: tokens.expiresIn,
    providerSpecificData: {
      sub: "zai", region: "global", zcodeJwtToken: tokens.zcodeJwtToken,
      businessToken: extra?.businessToken || "", apiBaseUrl: ZCODE_CONFIG.apiBaseUrl,
      zcodePlanBaseUrl: ZCODE_CONFIG.planBaseUrl,
      enabledModels: (PROVIDER_MODELS.zc || PROVIDER_MODELS.zcode || []).map((model) => model.id),
    },
  }),
};
export default zcode;
