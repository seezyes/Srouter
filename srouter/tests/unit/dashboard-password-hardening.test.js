import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { getInitialPassword, isStrongInitialPassword } from "@/lib/auth/password.js";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(), updateSettings: vi.fn(), local: vi.fn(),
  setCookie: vi.fn(), cookies: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings, updateSettings: mocks.updateSettings }));
vi.mock("@/dashboardGuard", () => ({ isLocalRequest: mocks.local }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/lib/auth/dashboardSession", () => ({ setDashboardAuthCookie: mocks.setCookie }));
vi.mock("@/lib/auth/oidc", () => ({ isOidcConfigured: () => false }));
vi.mock("@/lib/auth/saml.js", () => ({ isSamlConfigured: () => false }));
vi.mock("@/lib/auth/loginLimiter", () => ({
  checkLock: () => ({ locked: false }),
  recordFail: () => ({ remainingBeforeLock: 5 }),
  recordSuccess: vi.fn(), getClientIp: () => "fixture",
}));
import { POST as reset } from "@/app/api/auth/reset-password/route.js";
import { POST as login } from "@/app/api/auth/login/route.js";

const request = (body) => new Request("http://localhost/api/auth/login", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({});
  mocks.updateSettings.mockResolvedValue({});
  mocks.local.mockReturnValue(false);
  mocks.cookies.mockResolvedValue({});
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("INITIAL_PASSWORD", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("Dashboard password hardening", () => {
  it.each([null, {}, [], "", "123456", "change-me-in-production", "short"])("rejects weak replacement %j", async (value) => {
    expect(isStrongInitialPassword(value)).toBe(false);
    expect((await reset(request({ newPassword: value }))).status).toBe(400);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("rejects malformed or null JSON without writing settings", async () => {
    const invalid = new Request("http://localhost/api/auth/reset-password", { method: "POST", body: "{" });
    expect((await reset(invalid)).status).toBe(400);
    expect((await reset(request(null))).status).toBe(400);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("stores a bcrypt hash instead of clearing the password or returning it", async () => {
    const replacement = "fixture-strong-replacement";
    const response = await reset(request({ newPassword: replacement }));
    expect(response.status).toBe(200);
    const { password } = mocks.updateSettings.mock.calls[0][0];
    expect(password).not.toBe(replacement);
    expect(await bcrypt.compare(replacement, password)).toBe(true);
    expect(await response.json()).toEqual({ success: true });
  });

  it("rejects weak production env but keeps local compatibility default", () => {
    expect(getInitialPassword({ NODE_ENV: "production", INITIAL_PASSWORD: "short" })).toBeNull();
    expect(getInitialPassword({ NODE_ENV: "production" })).toBe("123456");
    expect(getInitialPassword({ NODE_ENV: "development", INITIAL_PASSWORD: "short" })).toBe("short");
  });

  it("does not issue any remote grant for an explicitly configured default password", async () => {
    vi.stubEnv("INITIAL_PASSWORD", "123456");
    expect((await login(request({ password: "123456" }))).status).toBe(403);
    expect(mocks.setCookie).not.toHaveBeenCalled();
    expect(mocks.cookies).not.toHaveBeenCalled();
  });

  it("keeps loopback login with the compatibility default", async () => {
    mocks.local.mockReturnValue(true);
    expect((await login(request({ password: "123456" }))).status).toBe(200);
    expect(mocks.setCookie).toHaveBeenCalledOnce();
  });

  it("fails closed when production INITIAL_PASSWORD is weak", async () => {
    vi.stubEnv("INITIAL_PASSWORD", "short");
    expect((await login(request({ password: "short" }))).status).toBe(503);
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });
});
