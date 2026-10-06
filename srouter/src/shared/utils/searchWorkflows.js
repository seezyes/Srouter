import { getCapabilityComboHref } from "./capabilityRoutes";

// Unified management helpers for the Search Workflow page. These helpers never
// touch storage or the network: they only classify combos, count them and pick a
// collision-free name across every existing combo.
export const SEARCH_WORKFLOW_NAME = "search-workflow";

export const SEARCH_WORKFLOW_KINDS = Object.freeze([
  Object.freeze({
    id: "webSearch",
    label: "Web Search",
    icon: "search",
    description: "Find URLs, titles and snippets through a single search request.",
  }),
  Object.freeze({
    id: "webFetch",
    label: "Web Fetch",
    icon: "article",
    description: "Extract one public page as text or Markdown through a single fetch request.",
  }),
]);

// Same contract as POST /api/combos and the combo detail page.
const COMBO_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

export function getSearchWorkflowKind(kind) {
  return SEARCH_WORKFLOW_KINDS.find((entry) => entry.id === kind) || null;
}

export function isSearchWorkflowKind(kind) {
  return getSearchWorkflowKind(kind) !== null;
}

export function listSearchWorkflows(combos) {
  if (!Array.isArray(combos)) return [];
  return combos.filter((combo) => (
    combo
    && typeof combo.id === "string"
    && combo.id.length > 0
    && typeof combo.name === "string"
    && isSearchWorkflowKind(combo.kind)
  ));
}

export function summarizeSearchWorkflows(combos) {
  const workflows = listSearchWorkflows(combos);
  return {
    total: workflows.length,
    webSearch: workflows.filter((combo) => combo.kind === "webSearch").length,
    webFetch: workflows.filter((combo) => combo.kind === "webFetch").length,
  };
}

// The generated base name is intentionally shared by both kinds. Uniqueness is
// checked against the names of all combos, not only Search/Fetch ones, because
// POST /api/combos enforces uniqueness across the whole combos table.
export function generateSearchWorkflowName(existingNames, base = SEARCH_WORKFLOW_NAME) {
  const taken = existingNames instanceof Set
    ? existingNames
    : new Set(Array.isArray(existingNames) ? existingNames.filter((name) => typeof name === "string") : []);
  if (!taken.has(base)) return base;
  let suffix = 1;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function isValidSearchWorkflowName(name) {
  return typeof name === "string" && COMBO_NAME_REGEX.test(name);
}

export function getSearchWorkflowComboHref(combo) {
  if (!combo || typeof combo.id !== "string" || !isSearchWorkflowKind(combo.kind)) return null;
  return getCapabilityComboHref(combo.kind, combo.id);
}
