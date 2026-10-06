import { resolveProviderAlias } from "open-sse/services/model.js";

// Keep settings portable across provider aliases (cmc/...) and ids (commandcode/...).
export function visionAdvisorModelKey(value) {
  if (typeof value !== "string") return "";
  const model = value.trim();
  const slash = model.indexOf("/");
  if (slash < 1 || slash === model.length - 1) return "";
  return `${resolveProviderAlias(model.slice(0, slash))}/${model.slice(slash + 1)}`;
}

export function normalizeAdvisorModels(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.filter((model) => {
    const key = visionAdvisorModelKey(model);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((model) => model.trim());
}

export function normalizeVisionAdvisor(value) {
  const config = value && typeof value === "object" ? value : {};
  const overrides = {};
  if (config.overrides && typeof config.overrides === "object" && !Array.isArray(config.overrides)) {
    for (const [model, chain] of Object.entries(config.overrides)) {
      const key = visionAdvisorModelKey(model);
      if (key && Array.isArray(chain)) overrides[key] = normalizeAdvisorModels(chain);
    }
  }
  return {
    enabled: config.enabled === true,
    models: normalizeAdvisorModels(Array.isArray(config.models) ? config.models : [config.model]),
    overrides,
  };
}

// Reject malformed writes rather than silently erasing an existing chain.
export function validateVisionAdvisor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Vision Advisor must be an object";
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return "Vision Advisor enabled must be a boolean";
  const validChain = (chain) => Array.isArray(chain) && chain.every((model) => !!visionAdvisorModelKey(model));
  if (value.models !== undefined && !validChain(value.models)) return "Advisor models must be a list of provider/model IDs";
  if (value.model !== undefined && value.model !== "" && !visionAdvisorModelKey(value.model)) return "Advisor model must be a provider/model ID";
  if (value.overrides !== undefined) {
    if (!value.overrides || typeof value.overrides !== "object" || Array.isArray(value.overrides)) return "Advisor overrides must be an object";
    if (Object.entries(value.overrides).some(([model, chain]) => !visionAdvisorModelKey(model) || !validChain(chain))) {
      return "Each model override must contain a list of advisor provider/model IDs";
    }
  }
  return null;
}
