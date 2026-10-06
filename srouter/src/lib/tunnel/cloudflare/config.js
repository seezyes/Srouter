// Cloudflare quick tunnel: DNS propagates fast, short timeouts OK
export const HEALTH_CHECK = {
  intervalMs: 2000,
  timeoutMs: 60000,
  fetchTimeoutMs: 5000,
  dnsTimeoutMs: 2000,
};

export const WORKER_URL = process.env.TUNNEL_WORKER_URL || "https://abc-tunnel.us";

export const NAMED_TUNNEL_TOKEN = process.env.TUNNEL_TOKEN || "";
export const NAMED_TUNNEL_HOSTNAME = (process.env.TUNNEL_HOSTNAME || "").trim().toLowerCase();
export const NAMED_TUNNEL_CRED_FILE = process.env.TUNNEL_CRED_FILE || "";
export const NAMED_TUNNEL_ID = process.env.TUNNEL_ID || "";
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
export function isNamedTunnelConfigured() {
  // Partial configuration is an error, never silently downgraded to quick.
  return !!(NAMED_TUNNEL_HOSTNAME || NAMED_TUNNEL_TOKEN || NAMED_TUNNEL_CRED_FILE || NAMED_TUNNEL_ID);
}
export function validateNamedTunnelConfig({ hostname = NAMED_TUNNEL_HOSTNAME, token = NAMED_TUNNEL_TOKEN, credFile = NAMED_TUNNEL_CRED_FILE, id = NAMED_TUNNEL_ID } = {}) {
  const errors = [];
  if (!HOSTNAME_RE.test(hostname)) errors.push("TUNNEL_HOSTNAME must be a bare DNS hostname");
  if (!!token === !!credFile) errors.push("Exactly one of TUNNEL_TOKEN and TUNNEL_CRED_FILE is required");
  if (token && /[\r\n\0]/.test(token)) errors.push("Invalid tunnel token");
  if (id && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) errors.push("Invalid tunnel UUID");
  return errors.length ? { ok: false, errors } : { ok: true };
}
