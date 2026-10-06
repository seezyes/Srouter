export const PROVIDER_FEATURE_KEYS = Object.freeze(["accountPools", "serviceTier", "customHeaders"]);

export function getProviderFeatures(provider, settings = {}) {
  const stored = settings.providerFeatures?.[provider] || {};
  const defaults = {
    accountPools: provider === "openai" || provider === "codex" ||
      (Array.isArray(settings.accountPools?.[provider]) && settings.accountPools[provider].length > 0),
    serviceTier: provider === "openai" || provider === "codex",
    customHeaders: true,
  };
  return Object.fromEntries(PROVIDER_FEATURE_KEYS.map((key) => [
    key, typeof stored[key] === "boolean" ? stored[key] : defaults[key],
  ]));
}

export function getEffectiveProviderOverride(provider, settings = {}) {
  return getProviderFeatures(provider, settings).customHeaders
    ? settings.providerOverrides?.[provider] || null
    : null;
}
