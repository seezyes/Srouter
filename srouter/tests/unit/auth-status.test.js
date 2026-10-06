import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
  })),
  cookies: vi.fn(),
  getSettings: vi.fn(),
  isOidcConfigured: vi.fn(),
  getDashboardAuthSession: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: mocks.json },
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

vi.mock("@/lib/auth/oidc", () => ({
  isOidcConfigured: mocks.isOidcConfigured,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  getDashboardAuthSession: mocks.getDashboardAuthSession,
}));

const { GET } = await import("../../src/app/api/auth/status/route.js");

describe("GET /api/auth/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireLogin: true, authMode: "password" });
    mocks.cookies.mockResolvedValue({ get: vi.fn(() => ({ value: "session-token" })) });
    mocks.isOidcConfigured.mockReturnValue(false);
  });

  it("reports an authenticated session when the auth cookie is valid", async () => {
    mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true });

    const response = await GET();

    expect(response.body.authenticated).toBe(true);
    expect(mocks.getDashboardAuthSession).toHaveBeenCalledWith("session-token");
  });

  it("reports unauthenticated when the auth cookie is invalid", async () => {
    mocks.getDashboardAuthSession.mockResolvedValue(null);

    const response = await GET();

    expect(response.body.authenticated).toBe(false);
  });

  it("fails closed when status dependencies throw", async () => {
    mocks.getSettings.mockRejectedValue(new Error("database unavailable"));

    const response = await GET();

    expect(response.body.authenticated).toBe(false);
    expect(response.body.requireLogin).toBe(true);
    expect(response.body.loginPolicy).toBe("always");
    expect(response.body.originGuard).toBe(true);
  });

  it("reports the three-level login policy", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: "local", authMode: "password" });
    mocks.getDashboardAuthSession.mockResolvedValue(null);

    const response = await GET();

    expect(response.body.loginPolicy).toBe("local");
    // Legacy field stays true while some access still requires a password.
    expect(response.body.requireLogin).toBe(true);
    // No request object: the status endpoint cannot be a loopback bypass.
    expect(response.body.loginBypassed).toBe(false);
    expect(response.body.originGuard).toBe(true);
  });

  it("marks the no-login level in the legacy field", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false, authMode: "password" });
    mocks.getDashboardAuthSession.mockResolvedValue(null);

    const response = await GET();

    expect(response.body.loginPolicy).toBe("off");
    expect(response.body.requireLogin).toBe(false);
  });
});
