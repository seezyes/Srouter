export const DEFAULT_SROUTER_SEARCH = {
  enabled: false,
  searchEnabled: true,
  fetchEnabled: true,
  rawFetchEnabled: false,
  smartEnabled: false,
  deepEnabled: false,
  searchProvider: "",
  fetchProvider: "",
  smartModel: "",
  deepModel: "",
  maxResults: 10,
  maxCharacters: 20000,
  maxOutputTokens: 4096,
};

export function validateSrouterSearch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "SRouterSearch settings must be an object";
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(DEFAULT_SROUTER_SEARCH, key)) return `Unknown SRouterSearch setting: ${key}`;
  }
  for (const key of ["enabled", "searchEnabled", "fetchEnabled", "rawFetchEnabled", "smartEnabled", "deepEnabled"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") return `${key} must be boolean`;
  }
  for (const key of ["searchProvider", "fetchProvider", "smartModel", "deepModel"]) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length > 200 || /[\x00-\x1f]/.test(value[key]))) return `${key} must be a provider or combo name`;
  }
  for (const [key, min, max] of [["maxResults", 1, 100], ["maxCharacters", 1000, 200000], ["maxOutputTokens", 256, 32768]]) {
    if (value[key] !== undefined && (!Number.isInteger(value[key]) || value[key] < min || value[key] > max)) return `${key} must be an integer between ${min} and ${max}`;
  }
  return null;
}

export function normalizeSrouterSearch(value) {
  if (validateSrouterSearch(value)) return { ...DEFAULT_SROUTER_SEARCH };
  return { ...DEFAULT_SROUTER_SEARCH, ...value };
}
