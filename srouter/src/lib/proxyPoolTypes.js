// Shared proxy-pool type whitelist.
//
// The collection route (POST /api/proxy-pools) and the per-pool route
// (PUT /api/proxy-pools/[id]) must accept the same set: when the PUT list was
// narrower, an unrelated edit that carried `type` silently rewrote a "deno"
// relay pool to "http" (the field is normalized, not rejected). Keep this the
// single source for both handlers.
export const VALID_PROXY_TYPES = ["http", "vercel", "cloudflare", "deno"];
