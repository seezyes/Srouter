export function parseQuotaProviderFilter(value) {
  const providers = [...new Set((value || "").split(",").map((id) => id.trim()).filter(Boolean))];
  return providers.includes("all") ? [] : providers;
}

export function toggleQuotaProviderFilter(value, provider) {
  const providers = parseQuotaProviderFilter(value);
  const next = providers.includes(provider)
    ? providers.filter((id) => id !== provider)
    : [...providers, provider];
  return next.length ? next.join(",") : "all";
}

export function matchesQuotaProviderFilter(value, provider) {
  const providers = parseQuotaProviderFilter(value);
  return !providers.length || providers.includes(provider);
}
