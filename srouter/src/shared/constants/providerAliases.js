// Registry-derived alias canonicalization.
//
// The open-sse registry declares several alias forms per provider (`id`,
// `alias`, `uiAlias`, and transport `aliases[]`). The app-side alias map in
// `src/shared/constants/providers.js` only surfaced `uiAlias`/`id`, so ACL
// checks and provider look-ups disagreed with routing for tokens such as
// grok-cli's `gb` / `grok-build`. This module derives the canonical mappings
// once from the registry and is shared by the provider constants and the ACL
// service, so both agree without duplicating the derivation.
import REGISTRY from "open-sse/providers/registry/index.js";

// Canonical token → provider id, only for tokens with a single owner. Tokens
// genuinely claimed by several providers (`mmf`, `tr`) stay unmapped so
// their existing resolution order is preserved.
const ALIAS_TO_ID = (() => {
  const claims = new Map();
  const add = (token, id) => {
    if (!token) return;
    if (!claims.has(token)) claims.set(token, new Set());
    claims.get(token).add(id);
  };
  for (const r of REGISTRY) {
    add(r.id, r.id);
    add(r.alias, r.id);
    add(r.uiAlias, r.id);
    for (const a of r.aliases || []) add(a, r.id);
  }
  const map = {};
  for (const [token, ids] of claims) if (ids.size === 1) map[token] = [...ids][0];
  return map;
})();

// Every alias form a canonical provider id is addressable by. Used for
// reciprocal ACL grants: a persisted grant under `gb` and one under
// `grok-cli` must both authorize the same canonical target.
const TOKENS_BY_ID = (() => {
  const map = {};
  for (const r of REGISTRY) {
    const set = (map[r.id] ||= new Set());
    set.add(r.id);
    if (r.alias) set.add(r.alias);
    if (r.uiAlias) set.add(r.uiAlias);
    for (const a of r.aliases || []) set.add(a);
  }
  return map;
})();

export const REGISTRY_ALIAS_TO_ID = ALIAS_TO_ID;

// Resolve any alias form to its canonical id plus the full reciprocal token set.
export function getProviderAliases(aliasOrId) {
  const id = ALIAS_TO_ID[aliasOrId] || aliasOrId;
  const tokens = TOKENS_BY_ID[id];
  return { id, aliases: tokens ? [...tokens] : [id] };
}
