// Web Search capability icons.
//
// The Web Search listing (WebProvidersPage) renders brand marks that are kept
// separate from the shared /public/providers registry: the refreshed marks live
// under /public/providers/web so existing registry assets — and the dark-theme
// CSS rules keyed to their paths in globals.css — stay untouched.
//
// Ollama Search deliberately keeps its registry icon. The collapsed "Ollama"
// group header uses a composed mark that matches the Ollama Cloud card as
// rendered in the listing (white tile + registry llama), per the owner's
// 2026-10-03 follow-up request.
//
// Evidence and asset provenance: docs/work/T-0041-srouter-search-mcp/evidence/web-icons.md

import { getProviderIconSrc } from "./providerIcon";

const WEB_PROVIDER_ICONS = {
  exa: "/providers/web/exa.svg",
  "brave-search": "/providers/web/brave-search.svg",
  "vercel-ai-gateway": "/providers/web/vercel-ai-gateway.svg",
  serper: "/providers/web/serper.svg",
};

const WEB_GROUP_ICONS = {
  ollama: "/providers/web/ollama-cloud.png",
};

function normalizeKey(value) {
  if (!value || typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

/**
 * Icon for a Web Search provider card. Overridden ids use the namespaced web
 * asset; every other id falls back to the shared registry icon (including its
 * aliases and session 404 cache).
 */
export function getWebProviderIconSrc(providerId) {
  const id = normalizeKey(providerId);
  return (id && WEB_PROVIDER_ICONS[id]) || getProviderIconSrc(providerId);
}

/**
 * Icon for a collapsed capability group header. Returns null when the group
 * has no override so the caller keeps the first entry's registry icon.
 */
export function getWebGroupIconSrc(groupName) {
  const name = normalizeKey(groupName);
  return (name && WEB_GROUP_ICONS[name]) || null;
}
