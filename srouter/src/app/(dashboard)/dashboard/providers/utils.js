export const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "none", label: "No connection" },
  { value: "wip", label: "WIP" },
];

// Providers still being worked on: they stay out of every regular section and
// out of the quick-access strip, and surface only while the WIP filter (next
// to the header search) is selected.
export const WIP_PROVIDER_IDS = ["factory"];

export function isWipProvider(providerId) {
  return WIP_PROVIDER_IDS.includes(providerId);
}

export function isWipFilter(statusFilter) {
  return statusFilter === "wip";
}

// noAuth providers (e.g. free proxies) are always usable even though they
// never have a stored connection record, so they never fall into "none".
export function getConnectionStatus(stats, isNoAuth = false) {
  if (isNoAuth) return "active";
  if (!stats || stats.total === 0) return "none";
  return stats.allDisabled ? "inactive" : "active";
}

export function matchesStatusFilter(statusFilter, stats, isNoAuth = false) {
  if (statusFilter === "all") return true;
  return getConnectionStatus(stats, isNoAuth) === statusFilter;
}
