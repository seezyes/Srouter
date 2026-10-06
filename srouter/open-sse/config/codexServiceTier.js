// Account defaults are deliberately narrower than the upstream request surface.
export const CODEX_ACCOUNT_SERVICE_TIERS = Object.freeze(["default", "fast", "ultrafast"]);

export function isCodexAccountServiceTier(value) {
  return value === null || CODEX_ACCOUNT_SERVICE_TIERS.includes(value);
}

export function applyCodexServiceTier(body, credentials) {
  // Presence, not truthiness: even null/empty/invalid explicit values belong to
  // the caller. Let upstream validate them rather than selecting a paid tier.
  if (!Object.prototype.hasOwnProperty.call(body, "service_tier") &&
    credentials?.providerSpecificData?.serviceTierEnabled !== false) {
    const tier = credentials?.providerSpecificData?.serviceTier;
    // Standard means no speed opt-in on the subscription-backed Codex endpoint.
    if (tier === "fast" || tier === "ultrafast") body.service_tier = tier;
  }
  if (body.service_tier === "fast") body.service_tier = "priority";
}
