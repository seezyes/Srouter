// Per-provider models that start disabled even on a fresh database.
// Derived from the provider registry (entries declare `defaultDisabledModels`)
// so the model ids stay in one place next to the catalog.
//
// Semantics: while the provider has no row in the disabledModels store, reads
// fall back to these defaults. The first explicit enable/disable from the
// dashboard materializes the resolved list into the store, and from then on
// the stored list is authoritative (an explicit "Active All" stores an empty
// list so the defaults do not come back).
import REGISTRY from "open-sse/providers/registry/index.js";

export const DEFAULT_DISABLED_MODELS = Object.fromEntries(
  REGISTRY
    .filter((provider) => Array.isArray(provider.defaultDisabledModels) && provider.defaultDisabledModels.length > 0)
    .map((provider) => [provider.alias || provider.id, [...provider.defaultDisabledModels]])
);

export function getDefaultDisabledModels(providerAlias) {
  return DEFAULT_DISABLED_MODELS[providerAlias] || [];
}
