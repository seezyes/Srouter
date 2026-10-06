import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateDashboardLoginGate, isUserDashboardNavigation } from "../../src/lib/auth/dashboardNavigation.js";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(), verifyToken: vi.fn(), next: Symbol("next"),
}));
vi.mock("next/server", () => ({
  NextResponse: {
    next: () => mocks.next,
    json: (body, init) => ({ status: init.status, body }),
    redirect: url => ({ status: 307, url: String(url) }),
  },
}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings, validateApiKey: async () => false }));
vi.mock("@/lib/auth/dashboardSession", () => ({ verifyDashboardAuthToken: mocks.verifyToken }));
vi.mock("@/sse/services/internalTrust.js", () => ({ isTrustedInternalRequest: () => false }));
const { proxy } = await import("../../src/dashboardGuard.js");

function navigation({ path = "/dashboard/quota", method = "GET", headers = {}, cookie = null } = {}) {
  return {
    method, nextUrl: { pathname: path, searchParams: new URLSearchParams() },
    url: `http://127.0.0.1:20129${path}`,
    headers: new Headers({
      host: "127.0.0.1:20129", "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-user": "?1",
      ...headers,
    }),
    cookies: { get: () => cookie ? { value: cookie } : undefined },
  };
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  mocks.getSettings.mockResolvedValue({ requireLogin: "local" });
  mocks.verifyToken.mockResolvedValue(false);
});

describe("narrow dashboard navigation exception", () => {
  it("allows a clicked top-level dashboard GET, including deep links", async () => {
    expect(isUserDashboardNavigation(navigation())).toBe(true);
    expect(evaluateDashboardLoginGate(navigation(), { requireLogin: "local" }))
      .toMatchObject({ bypass: true, blocked: false });
    expect(await proxy(navigation())).toBe(mocks.next);
  });

  it("does not mutate headers and preserves the original API guard", async () => {
    const request = navigation();
    evaluateDashboardLoginGate(request, { requireLogin: "local" });
    expect(request.headers.get("sec-fetch-site")).toBe("cross-site");
    const response = await proxy(navigation({ path: "/api/settings" }));
    expect(response.status).toBe(403);
  });

  it.each([
    { method: "POST" },
    { method: "HEAD" },
    { headers: { "sec-fetch-user": "" } },
    { headers: { "sec-fetch-user": "?0" } },
    { headers: { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" } },
    { headers: { "sec-fetch-dest": "iframe" } },
    { headers: { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" } },
    { headers: { origin: "https://foreign.example" } },
    { headers: { origin: "null" } },
  ])("blocks non-qualifying requests %j", async changes => {
    const request = navigation(changes);
    expect(isUserDashboardNavigation(request)).toBe(false);
    expect((await proxy(request)).status).toBe(403);
  });

  it.each(["/api/settings", "/api/providers", "/dashboardish", "/v1/chat/completions", "/"])(
    "never grants the navigation exception to %s", path => {
      expect(isUserDashboardNavigation(navigation({ path }))).toBe(false);
    },
  );

  it("retains trusted Host and remote/local password checks", async () => {
    const request = navigation({ headers: { host: "evil.example:20129" } });
    expect(evaluateDashboardLoginGate(request, { requireLogin: false })).toMatchObject({ bypass: false });
    expect((await proxy(request)).url).toContain("/login");
  });

  it("retains always-password policy", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    expect((await proxy(navigation())).url).toContain("/login");
  });

  it("retains tunnel dashboard restrictions", async () => {
    mocks.getSettings.mockResolvedValue({
      requireLogin: false, tunnelDashboardAccess: false, tunnelUrl: "https://tunnel.example",
    });
    const request = navigation({ headers: { host: "tunnel.example" } });
    expect((await proxy(request)).url).toContain("/login");
  });

  it("retains actual authenticated-session access", async () => {
    mocks.verifyToken.mockResolvedValue(true);
    expect(await proxy(navigation({ cookie: "synthetic", headers: { "sec-fetch-user": "" } }))).toBe(mocks.next);
  });
});
