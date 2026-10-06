// Secret masking for the "Import from 9router" feature.
// (Comments in this folder describe the sibling product by its real name; the
// only runtime string that must survive a brand rename is SOURCE_APP_DIR in
// nineRouterSource.js, which is assembled defensively for that reason.)
//
// Every secret that crosses the HTTP boundary (preview or import results) is
// reduced to a short, non-reversible hint through one of these helpers, so a
// full API key / OAuth token can never leave the server process.

const SECRET_KEY_PATTERN =
  /(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token|refresh|bearer|secret|password|passwd|cookie|authorization|credential|private[_-]?key)/i;

/**
 * True when a field name looks like it carries a credential.
 * Used by maskSecretsDeep so unknown/extra fields are masked too.
 */
export function isSecretKey(key) {
  if (typeof key !== "string" || !key) return false;
  return SECRET_KEY_PATTERN.test(key);
}

/**
 * Mask a single secret value: keep at most the first 4 characters so the UI can
 * show "this looks like sk-…/eyJ…", and replace the rest with asterisks.
 * Never returns more than 4 characters of the original value.
 */
export function maskSecret(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text.length === 0) return "";
  if (text.length <= 4) return "*".repeat(text.length);
  return `${text.slice(0, 4)}${"*".repeat(Math.min(16, text.length - 4))}`;
}

/**
 * Deep-clone a value with every credential-looking key masked.
 * Safety net for responses that echo nested third-party payloads
 * (e.g. providerSpecificData) whose key names we do not control.
 */
export function maskSecretsDeep(value, depth = 6) {
  if (depth <= 0) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => maskSecretsDeep(item, depth - 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = isSecretKey(key) ? maskSecret(item) : maskSecretsDeep(item, depth - 1);
    }
    return out;
  }
  return value;
}
