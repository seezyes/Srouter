// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" },
  520: { type: "server_error", code: "upstream_error" },
  524: { type: "server_error", code: "upstream_timeout" },
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout",
  520: "Upstream provider returned an unexpected response",
  524: "Upstream provider timed out, no response received",
};

export const GATEWAY_ERROR_LOG_MAX_BYTES = 20 * 1024 * 1024;
export const GATEWAY_ERROR_CLASSES = new Set([
  "POLICY", "PROVIDER", "STREAM", "TOOL_CALL", "TOKEN", "AUTH", "TIMEOUT", "PARSE", "UNKNOWN",
]);

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 1000;

// Semantic cooldown used by rules that have no provider-reported reset (e.g.
// the codex "model is not supported when using codex with a chatgpt account"
// rule). It NO LONGER clamps a provider-reported resets_at: that reset is now
// stored as-is in the informational modelResetAt_* field (see
// resolveProbeBlockMs in open-sse/services/accountFallback.js).
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// ── Retry-probe window ────────────────────────────────────────────────────
// How long a per-model LIMIT cooldown actually blocks a repeat attempt before
// the router makes a real upstream attempt again. A provider can lift a limit
// earlier than it announced, and a stale local lock must never outlive it, so
// the blocking window is short and self-healing: after it expires the account
// is tried for real; if the limit is still there, a new window is written.
export const RETRY_PROBE_BLOCK_MS = 60 * 1000;
// Longer cooldowns (hourly/monthly quotas, until-midnight daily quotas) get a
// wider probe window — a 60s probe for hours would hammer the upstream without
// learning anything new.
export const RETRY_PROBE_LONG_BLOCK_MS = 5 * 60 * 1000;
// Cooldowns up to this size use RETRY_PROBE_BLOCK_MS.
export const RETRY_PROBE_LONG_THRESHOLD_MS = 15 * 60 * 1000;

// ── Error visibility ──────────────────────────────────────────────────────
// How long lastError/testStatus stay visible on a connection before they are
// treated as stale. Without this an account could show "unavailable" until the
// next successful request (or a proxy restart) even though the error is long
// gone. Keyed by failure class: a broken credential is the only one that needs
// a human, so it is the slow one; a model-level or upstream error is only worth
// showing while the router is still holding the retry probe, and after that the
// gateway log is the record (owner policy 2026-10-05).
export const ERROR_VISIBILITY_TTL_MS = {
  credential: 24 * 60 * 60 * 1000,
  quota: 60 * 60 * 1000,
  transient: 10 * 60 * 1000,
  default: 60 * 60 * 1000,
};

// Statuses that describe the CREDENTIAL/account itself rather than one model.
// Only these keep an account-level error (the human has to replace the key);
// every other failure is attributed to the model that failed and disappears
// together with that model's blocking retry window, so one broken model never
// makes a working account read as "provider is down".
export const ACCOUNT_SCOPED_ERROR_STATUSES = new Set([401, 403]);

// Cooldown durations (ms)
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
  verification: 60 * 60 * 1000,
};

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, backoff? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit)
 */
export const ERROR_RULES = [
  // --- Text-based rules (checked first, order = priority) ---
  { text: "content-blocked",          shouldFallback: false, isContentFilter: true },
  { text: "content_blocked",          shouldFallback: false, isContentFilter: true },
  { text: "content exists risk",      shouldFallback: false, isContentFilter: true },
  { text: "sensitive words detected", shouldFallback: false, isContentFilter: true },
  { text: "sensitive content",        shouldFallback: false, isContentFilter: true },
  { text: "unapproved channel",       shouldFallback: false, isContentFilter: true },
  { text: "illegal api invocation",   shouldFallback: false, isContentFilter: true },
  { provider: "codex", text: "model is not supported when using codex with a chatgpt account", cooldownMs: MAX_RATE_LIMIT_COOLDOWN_MS },
  { text: "no credentials",           cooldownMs: COOLDOWN.long },
  { text: "request not allowed",      cooldownMs: COOLDOWN.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  { text: "validation_required",      cooldownMs: COOLDOWN.verification },
  { text: "verify your account",      cooldownMs: COOLDOWN.verification },
  { text: "rate limit",               backoff: true },
  { text: "too many requests",        backoff: true },
  { text: "quota exceeded",           backoff: true },
  { text: "capacity",                 backoff: true },
  { text: "overloaded",               backoff: true },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },
];

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};
