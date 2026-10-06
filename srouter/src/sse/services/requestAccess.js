import { extractApiKey, getApiKeyInfo } from "./auth.js";
import { getSettings } from "@/lib/localDb";
import { isTrustedInternalRequest } from "./internalTrust.js";
import { isKindAllowed, isComboAllowed, isProviderAllowed } from "./access.js";
import { isModelAllowed } from "./allowedModels.js";
import { errorResponse } from "open-sse/utils/error.js";

export async function authenticateRequest(request, settings = null) {
  settings ||= await getSettings();
  if (await isTrustedInternalRequest(request)) return { apiKeyInfo: null, settings };
  const apiKey = extractApiKey(request);
  const apiKeyInfo = apiKey ? await getApiKeyInfo(apiKey) : null;
  if (settings.requireApiKey && !apiKeyInfo) {
    return { error: errorResponse(401, apiKey ? "Invalid API key" : "Missing API key"), settings };
  }
  // Optional-key mode stays usable without a key, but known restricted keys
  // must not silently lose their restrictions when requireApiKey is disabled.
  return { apiKeyInfo, settings };
}

export function checkKindAccess(info, kind) {
  return isKindAllowed(info, kind) ? null : errorResponse(403, `Request kind '${kind}' is not allowed for this API key`);
}

export function checkComboAccess(info, name) {
  return isComboAllowed(info, name) ? null : errorResponse(403, `Combo '${name}' is not allowed for this API key`);
}

export async function checkTargetAccess(info, provider, model, kind) {
  const kindError = checkKindAccess(info, kind);
  if (kindError) return kindError;
  if (!await isProviderAllowed(info, provider)) {
    return errorResponse(403, `Provider '${provider}' is not allowed for this API key`);
  }
  if (model !== null && !await isModelAllowed(`${provider}/${model}`, info, kind)) {
    return errorResponse(404, "Model is not available or you do not have access to it");
  }
  return null;
}
