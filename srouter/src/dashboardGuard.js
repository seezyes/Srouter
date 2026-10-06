import { NextResponse } from "next/server";
import { getSettings, validateApiKey } from "@/lib/localDb";
import { isTrustedInternalRequest } from "@/sse/services/internalTrust.js";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { isLocalRequest } from "@/lib/auth/localRequest";
import { evaluateLoginGate } from "@/lib/auth/loginPolicy";
import { evaluateDashboardLoginGate } from "@/lib/auth/dashboardNavigation.js";

export { isLocalRequest };

async function hasValidCliToken(request) {
  return isTrustedInternalRequest(request);
}

// Public API paths — no auth required (LLM API has its own key auth inside handler).
const PUBLIC_API_PATHS = [
  "/api/health",
  "/api/init",
  "/api/locale",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/status",
  "/api/auth/first-run",
  "/api/auth/oidc",
  "/api/auth/saml",
  "/api/version",
  "/api/settings/require-login",
];

// Public top-level prefixes (LLM API endpoints with their own API key auth).
// Keep root-level rewrites here too: middleware runs before Next.js rewrites.
const PUBLIC_PREFIXES = ["/v1", "/v1beta", "/api/v1", "/api/v1beta", "/codex", "/responses"];

// Always require JWT token regardless of requireLogin setting
const ALWAYS_PROTECTED = [
  "/api/shutdown",
  "/api/settings/database",
  "/api/version/shutdown",
  "/api/version/update",
  "/api/oauth/cursor/auto-import",
  "/api/oauth/kiro/auto-import",
  "/api/oauth/zed/auto-import",
];

// Require auth, but allow through when the login policy bypasses this request
const PROTECTED_API_PATHS = [
  "/api/settings",
  "/api/keys",
  "/api/providers",
  "/api/provider-nodes",
  "/api/proxy-pools",
  "/api/combos",
  "/api/models",
  "/api/usage",
  "/api/oauth",
  "/api/cloud",
  "/api/media-providers",
  "/api/pricing",
  "/api/tags",
  "/api/cli-tools",
  "/api/mcp",
  "/api/translator",
  "/api/tunnel",
];

// Routes that spawn child processes or read host secrets — restrict to localhost.
const LOCAL_ONLY_PATHS = [
  "/api/cli-tools/cowork-settings",
  "/api/cli-tools/antigravity-mitm",
  "/api/mcp/",
  "/api/tunnel/tailscale-install",
  "/api/tunnel/tailscale-enable",
  "/api/tunnel/tailscale-disable",
  "/api/tunnel/tailscale-check",
  "/api/tunnel/enable",
  "/api/tunnel/disable",
  "/api/oauth/cursor/auto-import",
  "/api/oauth/kiro/auto-import",
  "/api/oauth/zed/auto-import",
  "/api/auth/reset-password",
  "/api/headroom/start",
  "/api/headroom/stop",
  "/api/headroom/proxy",
];

function isPublicLlmApi(pathname) {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function extractApiKey(request) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  const apiKeyHeader = request.headers.get("x-api-key");
  if (apiKeyHeader) return apiKeyHeader;
  const googleApiKeyHeader = request.headers.get("x-goog-api-key");
  if (googleApiKeyHeader) return googleApiKeyHeader;
  return request.nextUrl.searchParams?.get("key") || null;
}

async function hasValidApiKey(request) {
  const apiKey = extractApiKey(request);
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}

async function canAccessPublicLlmApi(request) {
  if (isLocalRequest(request)) return true;
  if (await hasValidCliToken(request)) return true;
  return await hasValidApiKey(request);
}

async function canAccessLocalOnlyRoute(request) {
  if (await hasValidCliToken(request)) return true;
  // Browser on host: loopback peer + Origin (blocks tunnel/CSRF) + auth
  // (JWT, or a login policy that bypasses this request).
  if (isLocalRequest(request) && await isAuthenticated(request)) return true;
  return false;
}

async function hasValidToken(request) {
  const token = request.cookies.get("srouter_auth_token")?.value;
  return await verifyDashboardAuthToken(token);
}

// Read settings directly from DB to avoid self-fetch deadlock in proxy
async function loadSettings() {
  try {
    return await getSettings();
  } catch {
    return null;
  }
}

// Login-policy decision for a request that may not carry a session.
// blocked = a browser page on a foreign origin (CSRF / DNS rebinding): deny
// explicitly instead of falling through to the generic 401 / login redirect.
async function authDecision(request) {
  if (await hasValidToken(request)) return { allow: true, blocked: false };
  const settings = (await loadSettings()) || {};
  const gate = evaluateLoginGate(request, settings);
  return { allow: gate.bypass, blocked: gate.blocked };
}

async function isAuthenticated(request) {
  return (await authDecision(request)).allow;
}

function isPublicApi(pathname) {
  if (isPublicLlmApi(pathname)) return true;
  return PUBLIC_API_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

// Shared with src/proxy.js — the mimo login branch must respect dashboard auth.
export { isAuthenticated };

export const __test__ = {
  isLocalRequest,
  isPublicLlmApi,
  extractApiKey,
  canAccessPublicLlmApi,
  canAccessLocalOnlyRoute,
};

export async function proxy(request) {
  const { pathname } = request.nextUrl;

  // Local-only gate for spawn-capable / host-secret routes.
  if (LOCAL_ONLY_PATHS.some((p) => pathname.startsWith(p))) {
    if (!(await canAccessLocalOnlyRoute(request))) {
      return NextResponse.json({ error: "Local only: CLI token required" }, { status: 403 });
    }
  }

  // Always protected - require valid JWT or local CLI token (machineId-based)
  if (ALWAYS_PROTECTED.some((p) => pathname.startsWith(p))) {
    if (await hasValidCliToken(request) || await hasValidToken(request))
      return NextResponse.next();
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (isPublicLlmApi(pathname)) {
    if (await canAccessPublicLlmApi(request)) return NextResponse.next();
    return NextResponse.json({ error: "API key required for remote API access" }, { status: 401 });
  }

  // Deny-by-default for /api/* — public allow-list bypasses, everything else requires auth.
  if (pathname.startsWith("/api/")) {
    if (isPublicApi(pathname)) return NextResponse.next();
    if (await hasValidCliToken(request)) return NextResponse.next();
    const decision = await authDecision(request);
    if (decision.blocked) {
      return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403 });
    }
    if (decision.allow) return NextResponse.next();
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Protect all dashboard routes
  if (pathname.startsWith("/dashboard")) {
    let settings = null;

    try {
      settings = await loadSettings();
      if (settings) {
        // Block tunnel/tailscale access if disabled (redirect to login)
        if (settings.tunnelDashboardAccess === true) {
          // access via tunnel allowed; fall through to the login policy
        } else {
          const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
          const tunnelHost = settings.tunnelUrl ? new URL(settings.tunnelUrl).hostname.toLowerCase() : "";
          const tailscaleHost = settings.tailscaleUrl ? new URL(settings.tailscaleUrl).hostname.toLowerCase() : "";
          if ((tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost)) {
            return NextResponse.redirect(new URL("/login", request.url));
          }
        }
      }
    } catch {
      // On error, keep fail-closed defaults (login required, block tunnel)
      settings = null;
    }

    // A valid session wins over the origin guard: the user may legitimately reach the
    // dashboard through a reverse proxy or tunnel name. The cookie is host-scoped,
    // HttpOnly and SameSite=Lax. Without a valid session the guard decides.
    const token = request.cookies.get("srouter_auth_token")?.value;
    if (token && await verifyDashboardAuthToken(token)) {
      return NextResponse.next();
    }

    const gate = evaluateDashboardLoginGate(request, settings || {});
    if (gate.blocked) {
      return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403 });
    }
    // Login policy bypasses the session check for this request
    if (gate.bypass) return NextResponse.next();

    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Redirect / to /dashboard if logged in, or /dashboard if it's the root
  if (pathname === "/") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}
