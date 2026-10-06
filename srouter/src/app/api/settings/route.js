import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import { resolveLoginPolicy } from "@/lib/auth/loginPolicy";
import { isStrongInitialPassword } from "@/lib/auth/password";
import { normalizeVisionAdvisor, validateVisionAdvisor } from "@/shared/utils/visionAdvisorConfig.js";
import { normalizeCustomSystemPrompts, validateCustomSystemPrompts } from "@/shared/utils/customSystemPrompts.js";
import bcrypt from "bcryptjs";
import { normalizeSrouterSearch, validateSrouterSearch } from "@/shared/utils/srouterSearchConfig";
import { developerSettingsAvailable } from "@/lib/developerSettings";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store"
};

// Secrets must never be mass-assigned from request body (CWE-915)
const PROTECTED_SETTING_KEYS = ["password", "mitmSudoEncrypted", "developerSettingsAvailable"];

export async function GET() {
  try {
    const settings = await getSettings();
    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    safeSettings.loginPolicy = resolveLoginPolicy(settings);
    
    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";
    
    return NextResponse.json({ 
      ...safeSettings, 
      enableRequestLogs,
      enableTranslator,
      developerSettingsAvailable: developerSettingsAvailable(),
      hasPassword: !!password
    }, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error getting settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Settings must be an object" }, { status: 400 });
    }

    // Strip protected secrets before any internal handling sets them
    for (const key of PROTECTED_SETTING_KEYS) delete body[key];
    if (Object.hasOwn(body, "srouterSearch")) {
      const error = validateSrouterSearch(body.srouterSearch);
      if (error) return NextResponse.json({ error }, { status: 400 });
      body.srouterSearch = normalizeSrouterSearch(body.srouterSearch);
    }

    if (Object.hasOwn(body, "visionAdvisor")) {
      const error = validateVisionAdvisor(body.visionAdvisor);
      if (error) return NextResponse.json({ error }, { status: 400 });
      body.visionAdvisor = normalizeVisionAdvisor(body.visionAdvisor);
    }
    if (Object.hasOwn(body, "customSystemPrompts")) {
      const error = validateCustomSystemPrompts(body.customSystemPrompts);
      if (error) return NextResponse.json({ error }, { status: 400 });
      body.customSystemPrompts = normalizeCustomSystemPrompts(body.customSystemPrompts);
    }

    // If updating password, hash it
    if (Object.hasOwn(body, "newPassword")) {
      if (!isStrongInitialPassword(body.newPassword)) {
        return NextResponse.json({ error: "Password must be at least 12 characters and not a known placeholder" }, { status: 400 });
      }
      const settings = await getSettings();
      const currentHash = settings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(body.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      } else {
        // First time setting password, no current password needed
        // Allow empty currentPassword or default "123456"
        if (body.currentPassword && body.currentPassword !== "123456") {
           return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      }

      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(body.newPassword, salt);
      delete body.newPassword;
      delete body.currentPassword;
    }
    delete body.currentPassword;

    if (Object.prototype.hasOwnProperty.call(body, "oidcClientSecret")) {
      if (!body.oidcClientSecret || !String(body.oidcClientSecret).trim()) {
        delete body.oidcClientSecret;
      }
    }

    const settings = await updateSettings(body);

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.prototype.hasOwnProperty.call(body, "outboundProxyEnabled") ||
      Object.prototype.hasOwnProperty.call(body, "outboundProxyUrl") ||
      Object.prototype.hasOwnProperty.call(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    // Invalidate combo rotation state when strategy settings change
    if (
      Object.prototype.hasOwnProperty.call(body, "comboStrategy") ||
      Object.prototype.hasOwnProperty.call(body, "comboStickyRoundRobinLimit") ||
      Object.prototype.hasOwnProperty.call(body, "comboStrategies")
    ) {
      resetComboRotation();
    }

    if (
      Object.prototype.hasOwnProperty.call(body, "claudeAutoPing") ||
      Object.prototype.hasOwnProperty.call(body, "codexAutoPing")
    ) {
      // Keep the scheduler absent when no account opted in; load its provider graph only on demand.
      import("@/shared/services/quotaAutoPing")
        .then(({ configureQuotaAutoPing }) => {
          configureQuotaAutoPing(settings);
        })
        .catch((error) => console.warn("[AutoPing] settings update failed:", error.message));
    }

    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    safeSettings.loginPolicy = resolveLoginPolicy(settings);
    safeSettings.developerSettingsAvailable = developerSettingsAvailable();
    return NextResponse.json(safeSettings, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
