const BAN_RISK_PROVIDERS = new Set(["gemini-cli", "antigravity"]);

export function hasProviderBanRisk(providerId) {
  return BAN_RISK_PROVIDERS.has(providerId);
}

export const PROVIDER_BAN_RISK_NOTICE =
  "Unofficial OAuth usage may lead to account restrictions or suspension.";
