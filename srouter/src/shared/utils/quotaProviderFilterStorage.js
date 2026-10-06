import { parseQuotaProviderFilter } from "./quotaProviderFilter";

export const QUOTA_PROVIDER_FILTER_KEY = "srouter.quota.providerFilter";
const CHANGE_EVENT = "srouter:quota-provider-filter";

export function resolveQuotaProviderFilter(urlValue, storedValue) {
  return parseQuotaProviderFilter(urlValue ?? storedValue).join(",") || "all";
}

export function readQuotaProviderFilter() {
  try {
    return resolveQuotaProviderFilter(null, window.localStorage.getItem(QUOTA_PROVIDER_FILTER_KEY));
  } catch {
    return "all";
  }
}

export function saveQuotaProviderFilter(value) {
  try {
    window.localStorage.setItem(QUOTA_PROVIDER_FILTER_KEY, resolveQuotaProviderFilter(value));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch { /* Storage may be unavailable; URL filtering still works. */ }
}

export function subscribeQuotaProviderFilter(onChange) {
  const onStorage = (event) => {
    if (event.key === QUOTA_PROVIDER_FILTER_KEY || event.key === null) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}
