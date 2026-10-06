// Loopback detection shared by the dashboard guard and the login-policy module.
//
// Two things are deliberately strict here:
//  - the TCP peer must be loopback (custom-server.js stamps it as x-9r-real-ip and
//    proves it with a per-process token) — a spoofable Host header is never enough;
//  - a browser request must not carry a non-loopback Origin (CSRF block).
import { hasTrustedPeerHeaders } from "@/lib/auth/trustedPeer";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// Accepts a Host header, a URL hostname or a raw socket address. Splitting on the first
// colon only works for IPv4 and would reduce every IPv6 form to "", so a dual-stack
// listener handing back ::ffff:127.0.0.1 would not read as loopback.
export function normalizeHostname(h) {
  if (!h) return "";
  let name = String(h).trim().toLowerCase();
  if (name.startsWith("[")) {
    const end = name.indexOf("]");
    if (end === -1) return "";
    name = name.slice(1, end);
  } else if (name.indexOf(":") !== -1 && name.indexOf(":") === name.lastIndexOf(":")) {
    name = name.slice(0, name.indexOf(":"));
  }
  if (name.startsWith("::ffff:")) name = name.slice(7);
  return name;
}

export function isLoopbackHostname(h) {
  return LOOPBACK_HOSTS.has(normalizeHostname(h));
}

function isLoopbackPeer(request) {
  if (hasTrustedPeerHeaders(request)) {
    return isLoopbackHostname(request.headers.get("x-9r-real-ip"));
  }
  // Bare `next dev` forks its server, so the wrapper never loads and no peer address
  // reaches us. Host is spoofable, so this stays confined to development.
  if (process.env.NODE_ENV === "development") {
    return isLoopbackHostname(request.headers.get("host"));
  }
  return false;
}

export function isLocalRequest(request) {
  if (!request?.headers?.get) return false;
  // Stamped by custom-server.js when forwarding headers exist: request came through
  // a reverse proxy, so the loopback socket is the proxy hop, not the end-user.
  if (request.headers.get("x-9r-via-proxy")) return false;
  if (!isLoopbackPeer(request)) return false;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (!isLoopbackHostname(new URL(origin).hostname)) return false;
    } catch {
      return false;
    }
  }
  return true;
}
