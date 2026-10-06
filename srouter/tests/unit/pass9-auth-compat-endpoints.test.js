// Pass9 handler fixes — OIDC start prefetch/CSRF guard + upstream /api/auth/check
// and the middleware access rule that keeps the new endpoint non-public.
//
// Contract sources: VansRouter 0.91.51
//   src/app/api/auth/oidc/start/route.js  (pin-exact, was missing locally: -32 lines)
//   src/app/api/auth/check/route.js       (pin-exact JWT handler, absent locally)
//   src/dashboardGuard.js                 (pin does NOT list /api/auth/check as public)
//
// Everything is mocked: no OIDC provider, no DB, no cookies, no network.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  // next/headers
  cookieSet: vi.fn(),
  cookieGet: vi.fn(),
  cookieDelete: vi.fn(),
  // @/lib/auth/oidc
  getOidcRuntimeConfig: vi.fn(),
  fetchOidcDiscovery: vi.fn(),
  createOidcState: vi.fn(() => "FAKE-OIDC-STATE"),
  createOidcNonce: vi.fn(() => "FAKE-OIDC-NONCE"),
  createPkcePair: vi.fn(() => ({ verifier: "FAKE-PKCE-VERIFIER", challenge: "FAKE-PKCE-CHALLENGE" })),
  buildOidcAuthorizationUrl: vi.fn(() => "https://idp.example/authorize?state=FAKE-OIDC-STATE"),
  getPublicOrigin: vi.fn(() => "http://localhost:20127"),
  // @/lib/auth/dashboardSession
  shouldUseSecureCookie: vi.fn(() => false),
  verifyDashboardAuthToken: vi.fn(),
  // @/lib/localDb
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  // @/lib/auth/loginPolicy
  evaluateLoginGate: vi.fn(),
  // @/lib/auth/localRequest
  isLocalRequest: vi.fn(() => true),
  // @/sse/services/internalTrust
  isTrustedInternalRequest: vi.fn(async () => false),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    set: mocks.cookieSet,
    get: mocks.cookieGet,
    delete: mocks.cookieDelete,
  }),
}));
vi.mock("@/lib/auth/oidc", () => ({
  getOidcRuntimeConfig: mocks.getOidcRuntimeConfig,
  fetchOidcDiscovery: mocks.fetchOidcDiscovery,
  createOidcState: mocks.createOidcState,
  createOidcNonce: mocks.createOidcNonce,
  createPkcePair: mocks.createPkcePair,
  buildOidcAuthorizationUrl: mocks.buildOidcAuthorizationUrl,
  getPublicOrigin: mocks.getPublicOrigin,
}));
vi.mock("@/lib/auth/dashboardSession", () => ({
  shouldUseSecureCookie: mocks.shouldUseSecureCookie,
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));
vi.mock("@/lib/auth/loginPolicy", () => ({
  evaluateLoginGate: mocks.evaluateLoginGate,
}));
vi.mock("@/lib/auth/localRequest", () => ({
  isLocalRequest: mocks.isLocalRequest,
}));
vi.mock("@/sse/services/internalTrust.js", () => ({
  isTrustedInternalRequest: mocks.isTrustedInternalRequest,
}));

const { GET: oidcStart } = await import("@/app/api/auth/oidc/start/route.js");
const { GET: authCheck } = await import("@/app/api/auth/check/route.js");
const { proxy: dashboardGuard } = await import("@/dashboardGuard.js");

const oidcRequest = (headers = {}) =>
  new Request("http://localhost:20127/api/auth/oidc/start", { headers });

const guardRequest = (pathname) => ({
  nextUrl: { pathname },
  method: "GET",
  url: `http://localhost:20127${pathname}`,
  headers: new Headers({ host: "localhost:20127" }),
  cookies: { get: () => undefined },
});

const isPassthrough = (res) => res.headers.get("x-middleware-next") === "1";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({});
  mocks.evaluateLoginGate.mockReturnValue({ policy: "always", bypass: false, blocked: false });
  mocks.verifyDashboardAuthToken.mockResolvedValue(null);
  mocks.cookieGet.mockReturnValue(undefined);
  mocks.getOidcRuntimeConfig.mockResolvedValue(null);
  mocks.getPublicOrigin.mockReturnValue("http://localhost:20127");
  mocks.buildOidcAuthorizationUrl.mockReturnValue("https://idp.example/authorize?state=FAKE-OIDC-STATE");
  mocks.createPkcePair.mockReturnValue({ verifier: "FAKE-PKCE-VERIFIER", challenge: "FAKE-PKCE-CHALLENGE" });
});

describe("OIDC start — pinned prefetch/CSRF guard", () => {
  it("rejects Sec-Purpose: prefetch with 403 before any OIDC work", async () => {
    const res = await oidcStart(oidcRequest({ "sec-purpose": "prefetch" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Prefetch not allowed" });
    expect(mocks.getOidcRuntimeConfig).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("rejects Purpose: Prefetch case-insensitively", async () => {
    const res = await oidcStart(oidcRequest({ purpose: "Prefetch" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Prefetch not allowed" });
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("rejects a non-navigation Sec-Fetch-Mode with 403", async () => {
    const res = await oidcStart(oidcRequest({ "sec-fetch-mode": "cors", "sec-fetch-dest": "document" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Invalid request mode" });
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("rejects a non-document Sec-Fetch-Dest with 403", async () => {
    const res = await oidcStart(oidcRequest({ "sec-fetch-mode": "navigate", "sec-fetch-dest": "image" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Invalid request destination" });
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("still serves non-browser clients that send no fetch-metadata headers", async () => {
    const res = await oidcStart(oidcRequest());
    expect(res.status).toBe(307); // NextResponse.redirect default
    expect(res.headers.get("location")).toBe("http://localhost:20127/login?error=oidc_not_configured");
    expect(mocks.getOidcRuntimeConfig).toHaveBeenCalledTimes(1);
  });

  it("completes a genuine navigation and only then writes the three state cookies", async () => {
    mocks.getOidcRuntimeConfig.mockResolvedValue({
      issuerUrl: "https://idp.example",
      clientId: "client-1",
      scopes: "openid email",
    });
    mocks.fetchOidcDiscovery.mockResolvedValue({ authorization_endpoint: "https://idp.example/authorize" });

    const res = await oidcStart(oidcRequest({ "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }));

    expect(res.status).toBe(307); // NextResponse.redirect default
    expect(res.headers.get("location")).toBe("https://idp.example/authorize?state=FAKE-OIDC-STATE");
    expect(mocks.buildOidcAuthorizationUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationEndpoint: "https://idp.example/authorize",
        clientId: "client-1",
        codeChallenge: "FAKE-PKCE-CHALLENGE",
      }),
    );
    const names = mocks.cookieSet.mock.calls.map((c) => c[0]).sort();
    expect(names).toEqual(["oidc_code_verifier", "oidc_nonce", "oidc_state"]);
    for (const [, , options] of mocks.cookieSet.mock.calls) {
      expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    }
  });
});

describe("GET /api/auth/check — upstream compatibility contract", () => {
  it("answers 200 {authenticated:true} when the login policy bypasses the session", async () => {
    mocks.evaluateLoginGate.mockReturnValue({ policy: "local", bypass: true, blocked: false });
    const res = await authCheck(new Request("http://localhost:20127/api/auth/check"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ authenticated: true });
    expect(Object.keys(body)).toEqual(["authenticated"]);
    expect(mocks.verifyDashboardAuthToken).not.toHaveBeenCalled();
  });

  it("answers 401 {authenticated:false} without a session cookie", async () => {
    const res = await authCheck(new Request("http://localhost:20127/api/auth/check"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ authenticated: false });
    expect(Object.keys(body)).toEqual(["authenticated"]);
    expect(mocks.verifyDashboardAuthToken).not.toHaveBeenCalled();
  });

  it("verifies the local srouter_auth_token cookie and answers 200 when valid", async () => {
    mocks.cookieGet.mockReturnValue({ value: "FAKE-SESSION-JWT" });
    mocks.verifyDashboardAuthToken.mockResolvedValue({ iat: 1 });
    const res = await authCheck(new Request("http://localhost:20127/api/auth/check"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: true });
    expect(mocks.cookieGet).toHaveBeenCalledWith("srouter_auth_token");
    expect(mocks.verifyDashboardAuthToken).toHaveBeenCalledWith("FAKE-SESSION-JWT");
  });

  it("answers 401 when the cookie is present but invalid", async () => {
    mocks.cookieGet.mockReturnValue({ value: "FAKE-STALE-JWT" });
    mocks.verifyDashboardAuthToken.mockResolvedValue(null);
    const res = await authCheck(new Request("http://localhost:20127/api/auth/check"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ authenticated: false });
  });

  it("falls back to 401 {authenticated:false} when settings cannot be read", async () => {
    mocks.getSettings.mockRejectedValue(new Error("db down"));
    const res = await authCheck(new Request("http://localhost:20127/api/auth/check"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ authenticated: false });
  });
});

describe("middleware access rule for /api/auth/check (pin parity)", () => {
  it("is NOT public: no session and no policy bypass yields the guard 401", async () => {
    const res = await dashboardGuard(guardRequest("/api/auth/check"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("is reachable when the login policy bypasses the request (pin behavior)", async () => {
    mocks.evaluateLoginGate.mockReturnValue({ policy: "off", bypass: true, blocked: false });
    const res = await dashboardGuard(guardRequest("/api/auth/check"));
    expect(isPassthrough(res)).toBe(true);
  });

  it("keeps the harness honest: a public path passes and a protected path does not", async () => {
    const publicRes = await dashboardGuard(guardRequest("/api/auth/status"));
    expect(isPassthrough(publicRes)).toBe(true);

    const protectedRes = await dashboardGuard(guardRequest("/api/settings"));
    expect(protectedRes.status).toBe(401);
    expect(await protectedRes.json()).toEqual({ error: "Unauthorized" });
  });
});
