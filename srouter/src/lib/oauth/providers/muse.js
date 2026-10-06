import { MUSE_CONFIG } from "../constants/oauth.js";
import { fetchOAuth } from "../boundedFetch.js";

// Muse Code subscription — Meta account device code flow to auth.meta.com,
// then mint the Model API key (LLM|…) the chat transport actually uses.
const MUSE_KEY_URL = "https://api.meta.ai/muse-code/key";
const API_VERSION = "1.0.0";

const muse = {
  config: MUSE_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    const response = await fetchOAuth(config.deviceCodeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "x-api-version": API_VERSION,
      },
      body: new URLSearchParams({ client_id: config.clientId }),
    });

    if (!response.ok) {
      throw new Error(`Muse Code device code request failed (HTTP ${response.status})`);
    }

    return await response.json();
  },
  pollToken: async (config, deviceCode) => {
    const response = await fetchOAuth(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "x-api-version": API_VERSION,
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: config.clientId,
      }),
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: "invalid_response", error_description: "Muse Code token response is not valid JSON" };
    }

    const pending =
      data?.error === "authorization_pending" ||
      data?.error === "slow_down";
    return { ok: response.ok || pending, data };
  },
  postExchange: async (tokens) => {
    // Mint the subscription API key; onboard:true enrolls the account on first
    // login. The endpoint is aggressively rate-limited (429) and the device code
    // is one-shot, so retry transient failures here instead of failing the login.
    let response;
    for (let attempt = 0; ; attempt++) {
      response = await fetchOAuth(MUSE_KEY_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${tokens.access_token}`,
          "Content-Type": "application/json",
          "x-api-version": API_VERSION,
        },
        body: JSON.stringify({ onboard: true }),
        redirect: "error",
      });
      const transient = response.status === 429 || response.status >= 500;
      if (!transient || attempt >= 2) break;
      await response.body?.cancel().catch(() => {});
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
    }

    const text = await response.text();
    if (!response.ok) {
      // Meta's error envelope (e.g. 403 code 4705002) carries the fix-it URL, but the
      // raw body must never reach the client or the log (pass6-oauth-safety).
      let msg = `HTTP ${response.status}; check your subscription at muse.ai`;
      try {
        const err = JSON.parse(text);
        if (err?.title || err?.detail) {
          msg = [err.title, err.detail].filter(Boolean).join(": ");
          if (err.action_url) msg += ` — ${err.action_url}`;
        }
      } catch { /* non-JSON error body: keep the sanitized status-only message */ }
      throw new Error(`Muse Code key mint failed: ${msg}`);
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("Muse Code key mint returned invalid JSON");
    }

    if (payload.is_subs_active === false) {
      throw new Error("Muse Code subscription is inactive — activate it on muse.ai first");
    }
    const actionUrl = payload.action_url || payload.require_payment_action_url;
    if (!payload.api_key && (payload.require_payment || actionUrl)) {
      throw new Error(`Muse Code subscription required${actionUrl ? `: ${actionUrl}` : ""}`);
    }
    if (!payload.api_key) {
      throw new Error("Muse Code key response is missing api_key");
    }

    return { key: payload };
  },
  mapTokens: (tokens, extra) => {
    const payload = extra?.key || {};
    // Chat requests carry the minted Model API key, not the Meta account token.
    // No expiry/refresh from Meta — a dead key means re-login.
    return {
      accessToken: payload.api_key,
      refreshToken: null,
      expiresIn: null,
      email: payload.user_email?.trim().toLowerCase() || undefined,
      providerSpecificData: {
        authMethod: "device_code",
        // Kept so a future re-mint can run without another device login
        oauthAccessToken: tokens.access_token,
        subscriptionTier: payload.subs_tier_name || null,
      },
    };
  },
};

export default muse;
