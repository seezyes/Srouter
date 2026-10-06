export function redactRequestDetail(detail) {
  const redacted = { ...detail };
  for (const key of ["request", "providerRequest", "providerResponse", "response"]) {
    if (redacted[key] !== undefined) redacted[key] = { redacted: true };
  }
  if (typeof redacted.apiKey === "string" && redacted.apiKey) {
    redacted.apiKey = redacted.apiKey.length <= 12
      ? `${redacted.apiKey.charAt(0)}***`
      : `${redacted.apiKey.slice(0, 8)}***${redacted.apiKey.slice(-4)}`;
  }
  return redacted;
}

// --- Text-level redaction (log lines, diagnostics) ---------------------------
//
// Same secrecy contract as redactRequestDetail, applied to free-form text that
// is merged into diagnostic endpoints (PM2 / Docker log tails). Credentials must
// never be returned even to an authenticated caller; everything else in the line
// (timestamps, provider names, error text, status codes) is preserved verbatim.

export const REDACTED_PLACEHOLDER = "[REDACTED]";

const SECRET_KEY_NAMES =
  "authorization|cookie|set-cookie|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|srouter_auth_token|client[_-]?secret|password|secret";

const TEXT_PATTERNS = {
  // JSON-ish pairs: "access_token": "…", "apiKey":"…", "password": "…"
  json: new RegExp(`"([A-Za-z0-9_-]*(?:${SECRET_KEY_NAMES})[A-Za-z0-9_-]*)"\\s*:\\s*"[^"]*"`, "gi"),
  // Authorization schemes (first, so the token — not the scheme word — is the
  // thing that gets masked)
  scheme: /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/=]{6,}/gi,
  // name=value / name: value in headers, query strings, cookies, env dumps.
  // Skips values that are a scheme word or already redacted.
  pair: new RegExp(
    `\\b(${SECRET_KEY_NAMES})\\s*([=:])\\s*("?)(?!Bearer\\b|Basic\\b|\\[REDACTED\\])([^"\\s,;&]+)\\3`,
    "gi",
  ),
  // Well-known standalone key shapes (OpenAI/Anthropic, GitHub, Slack, Google)
  shapes: [
    /\b(?:sk-ant-|sk-)[A-Za-z0-9_-]{8,}\b/g,
    /\bghp_[A-Za-z0-9]{20,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    /\bAIza[A-Za-z0-9_-]{20,}\b/g,
    // JWTs (access/id tokens, session cookies)
    /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
  ],
};

/**
 * Redact credentials from a single log/diagnostic line. Non-string input
 * returns "" (the caller decides how to render it).
 *
 * @param {string} line
 * @returns {string}
 */
export function redactLogLine(line) {
  if (typeof line !== "string" || line.length === 0) return typeof line === "string" ? line : "";
  let out = line;
  out = out.replace(TEXT_PATTERNS.json, (_m, name) => `"${name}":"${REDACTED_PLACEHOLDER}"`);
  out = out.replace(TEXT_PATTERNS.scheme, (_m, scheme) => `${scheme} ${REDACTED_PLACEHOLDER}`);
  out = out.replace(TEXT_PATTERNS.pair, (_m, name, sep, quote) => `${name}${sep}${quote}${REDACTED_PLACEHOLDER}${quote}`);
  for (const pattern of TEXT_PATTERNS.shapes) {
    out = out.replace(pattern, REDACTED_PLACEHOLDER);
  }
  return out;
}

/**
 * Redact credentials from an array of log lines. Non-array input returns [].
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
export function redactLogLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => redactLogLine(line));
}
