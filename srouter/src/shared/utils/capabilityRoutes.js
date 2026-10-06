import { AI_PROVIDERS, MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import { getProviderIconSrc } from "./providerIcon";

export const isWebCapability = (kind) => kind === "webSearch" || kind === "webFetch";
export const isCapabilityKind = (kind) => MEDIA_PROVIDER_KINDS.some((entry) => entry.id === kind);

export function getCapabilityBaseHref(kind) {
  if (!isCapabilityKind(kind)) return null;
  return isWebCapability(kind) ? `/dashboard/search/${kind}` : `/dashboard/${kind}`;
}

export function getCapabilityListingHref(kind) {
  return isWebCapability(kind) ? "/dashboard/search" : getCapabilityBaseHref(kind);
}

export function getCapabilityProviderHref(kind, id) {
  const base = getCapabilityBaseHref(kind);
  return base ? `${base}/${encodeURIComponent(id)}` : null;
}

export function getCapabilityComboHref(kind, id) {
  const base = getCapabilityBaseHref(kind);
  return base ? `${base}/combo/${encodeURIComponent(id)}` : null;
}

export function getCapabilityComboListingHref(kind) {
  return isWebCapability(kind) ? "/dashboard/search/workflows" : getCapabilityListingHref(kind);
}

export function isCapabilityPathActive(pathname, kind) {
  const base = getCapabilityBaseHref(kind);
  return !!base && (pathname === base || pathname?.startsWith(`${base}/`));
}

export function getCapabilityPageInfo(pathname) {
  if (pathname === "/dashboard/search/workflows") {
    return {
      title: "Search Workflow", description: "Manage search and page extraction workflows",
      icon: "account_tree",
      breadcrumbs: [{ label: "Web Search", href: "/dashboard/search" }, { label: "Search Workflow" }],
    };
  }
  if (pathname === "/dashboard/search/srouter-search") {
    return {
      title: "SrouterSearch", description: "MCP web search and fetch tools",
      icon: "travel_explore",
      breadcrumbs: [{ label: "Web Search", href: "/dashboard/search" }, { label: "SrouterSearch" }],
    };
  }
  if (pathname === "/dashboard/search" || pathname === "/dashboard/media-providers/web") {
    return {
      title: "Web Search", description: "Manage your web fetch and search providers",
      icon: "travel_explore", breadcrumbs: [],
    };
  }
  const parts = pathname?.replace(/\/$/, "").split("/") || [];
  if (parts[1] !== "dashboard") return null;
  const nested = parts[2] === "search" || parts[2] === "media-providers";
  const kind = parts[nested ? 3 : 2];
  if (!isCapabilityKind(kind) || (parts[2] === "search" && !isWebCapability(kind))) return null;
  const tail = parts.slice(nested ? 4 : 3);
  const config = MEDIA_PROVIDER_KINDS.find((entry) => entry.id === kind);
  if (tail.length === 0) {
    return {
      title: config.label, description: `Manage your ${config.label} providers`,
      icon: config.icon, breadcrumbs: [],
    };
  }
  const isCombo = tail.length === 2 && tail[0] === "combo";
  if (!isCombo && tail.length !== 1) return null;
  const providerId = tail[0];
  const provider = AI_PROVIDERS[providerId];
  const title = isCombo ? "Combo" : provider?.name || providerId;
  return {
    title, description: "",
    breadcrumbs: [
      isCombo && isWebCapability(kind)
        ? { label: "Search Workflow", href: getCapabilityComboListingHref(kind) }
        : { label: config.label, href: getCapabilityListingHref(kind) },
      isCombo ? { label: title } : { label: title, image: getProviderIconSrc(providerId) },
    ],
  };
}
