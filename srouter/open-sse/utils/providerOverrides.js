// Shared by the dashboard trust boundary and dispatch (including imported settings).
export const BLOCKED_OVERRIDE_HEADERS = new Set([
  "host", "content-length", "content-type", "connection", "transfer-encoding",
  "authorization", "proxy-authorization", "cookie", "set-cookie", "upgrade",
  "te", "trailer", "accept-encoding", "x-api-key", "api-key", "x-goog-api-key",
  "chatgpt-account-id", "x-kilocode-organizationid",
  "x-aliyun-captcha-verify-param", "x-aliyun-captcha-verify-region",
]);

export function isBlockedOverrideHeader(name) {
  const lower = name.toLowerCase();
  return BLOCKED_OVERRIDE_HEADERS.has(lower) ||
    /(?:^|[-_])(?:auth|authorization|apikey|api-key|token|secret|signature|credential)(?:$|[-_])/.test(lower) ||
    lower.startsWith("x-forwarded-") || lower.startsWith("x-relay-");
}

export function normalizeProviderOverride(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Override must be an object");
  }
  const headers = payload.headers;
  if (headers == null) return null;
  if (typeof headers !== "object" || Array.isArray(headers)) throw new Error("headers must be an object");
  const entries = Object.entries(headers).filter(([, value]) => value !== "" && value != null);
  if (entries.length > 20) throw new Error("Too many headers (max 20)");
  const clean = {};
  for (const [name, value] of entries) {
    if (!/^[A-Za-z0-9-]+$/.test(name)) throw new Error("Invalid header name");
    if (isBlockedOverrideHeader(name)) throw new Error(`Header ${name} cannot be overridden`);
    if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value) || value.length > 8192) {
      throw new Error(`Invalid value for header ${name}`);
    }
    const lower = name.toLowerCase();
    if (Object.hasOwn(clean, lower)) throw new Error(`Duplicate header ${name}`);
    clean[lower] = value;
  }
  return Object.keys(clean).length ? { headers: clean } : null;
}

export function applyProviderOverride(headers, payload) {
  let override;
  try { override = normalizeProviderOverride(payload); } catch { return headers; }
  // Case-insensitive replacement, without mutating registry or caller objects.
  const out = { ...headers };
  for (const [name, value] of Object.entries(override?.headers || {})) {
    for (const existing of Object.keys(out)) if (existing.toLowerCase() === name) delete out[existing];
    out[name] = value;
  }
  return out;
}
