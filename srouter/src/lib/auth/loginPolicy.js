// Login policy: the single place that decides whether a request must carry a
// dashboard session. Three levels, persisted in settings.requireLogin:
//
//   true     → "always": the dashboard always requires a password (default);
//   "local"  → "local":  requests from this machine skip the login window,
//                         LAN / tunnel / other devices still require it;
//   false    → "off":    no login anywhere.
//
// In both bypass levels the browser threat model still applies: a page on a foreign
// origin (CSRF) or a DNS-rebound hostname must not reach the local API just because
// the login window is gone. That is the origin guard, on by default
// (settings.originGuard !== false) and switchable in Profile → Security.
import net from "node:net";
import os from "node:os";
import { isLocalRequest, isLoopbackHostname, normalizeHostname } from "@/lib/auth/localRequest";

export const LOGIN_POLICY = { ALWAYS: "always", LOCAL: "local", OFF: "off" };

export function resolveLoginPolicy(settings) {
  const raw = settings?.requireLogin;
  if (raw === false || raw === "off") return LOGIN_POLICY.OFF;
  if (raw === "local") return LOGIN_POLICY.LOCAL;
  return LOGIN_POLICY.ALWAYS;
}

// Persisted-value validator: anything unknown falls back to the safe default.
export function normalizeRequireLogin(raw) {
  if (raw === false || raw === "off") return false;
  if (raw === "local") return "local";
  return true;
}

export function originGuardEnabled(settings) {
  return settings?.originGuard !== false;
}

// Suffixes no public DNS name can use, so they cannot be DNS-rebound: `.localhost`
// (RFC 6761) and `.local` (RFC 6762, mDNS) — a dashboard reached as `my-pc.local`
// keeps working.
const LOCAL_NAME_SUFFIXES = [".localhost", ".local"];

// Hostnames a browser may legitimately use in bypass modes: the configured public
// endpoints plus the machine's own names. Everything else is treated as a
// DNS-rebinding candidate.
function allowedHostnames(settings) {
  const names = new Set();
  for (const value of [settings?.tunnelUrl, settings?.tailscaleUrl]) {
    if (!value) continue;
    try {
      names.add(new URL(value).hostname.toLowerCase());
    } catch {
      /* ignore malformed setting */
    }
  }
  for (const value of [os.hostname(), process.env.COMPUTERNAME, process.env.HOSTNAME]) {
    const name = normalizeHostname(value);
    if (name) names.add(name);
  }
  return names;
}

function isTrustedHostname(hostname, settings) {
  const name = normalizeHostname(hostname);
  if (!name) return false;
  if (isLoopbackHostname(name)) return true;
  if (LOCAL_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  if (net.isIP(name)) return true; // literal addresses cannot be DNS-rebound
  return allowedHostnames(settings).has(name);
}

/**
 * True when a browser page on a foreign origin is calling us: the request carries an
 * Origin we do not own (or a sandboxed/malformed one), or the browser reports it as
 * cross-site. This is the signal that must be denied outright.
 */
export function isCrossSiteBrowserCall(request, settings) {
  const headers = request?.headers;
  if (!headers?.get) return false;

  const origin = headers.get("origin");
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).hostname;
    } catch {
      return true; // "null" / malformed origin — sandboxed or file:// page
    }
    if (!isTrustedHostname(originHost, settings)) return true;
  }

  const site = headers.get("sec-fetch-site");
  return !!site && site.toLowerCase() === "cross-site";
}

/**
 * True when the Host header names a host we do not serve. A DNS-rebound page keeps
 * Origin and Host self-consistent, so this check must stay separate from the Origin
 * one: such a request may not receive the unauthenticated bypass even though nothing
 * proves it is cross-site.
 */
export function hasUntrustedHost(request, settings) {
  const host = request?.headers?.get?.("host");
  if (!host) return false;
  const name = normalizeHostname(host);
  return !!name && !isTrustedHostname(name, settings);
}

/**
 * True when the request looks like a browser page on a foreign origin (CSRF /
 * DNS rebinding) rather than the dashboard, a local app or curl.
 */
export function isForeignBrowserRequest(request, settings) {
  return isCrossSiteBrowserCall(request, settings) || hasUntrustedHost(request, settings);
}

/**
 * How the login gate treats this request.
 * @returns {{ policy: "always"|"local"|"off", bypass: boolean, blocked: boolean }}
 *   bypass  — serve the request without a session;
 *   blocked — request came from a browser page that must not bypass the login.
 */
export function evaluateLoginGate(request, settings) {
  const policy = resolveLoginPolicy(settings);
  if (policy === LOGIN_POLICY.ALWAYS) return { policy, bypass: false, blocked: false };

  if (!originGuardEnabled(settings)) {
    return { policy, bypass: policy === LOGIN_POLICY.OFF || isLocalRequest(request), blocked: false };
  }

  // A foreign Origin / cross-site call is a CSRF attempt, and at these levels there is
  // no session to fall back on, so it is answered with an explicit denial instead of a
  // bare 401. An untrusted Host only loses the bypass: a user who reaches the dashboard
  // through another DNS name still has to log in.
  const blocked = isCrossSiteBrowserCall(request, settings);
  const untrustedHost = hasUntrustedHost(request, settings);

  if (policy === LOGIN_POLICY.LOCAL) {
    return { policy, bypass: isLocalRequest(request) && !blocked && !untrustedHost, blocked };
  }

  // off
  return { policy, bypass: !blocked && !untrustedHost, blocked };
}
