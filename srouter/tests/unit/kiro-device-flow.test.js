import { describe, it, expect, vi, afterEach } from "vitest";

const originalFetch = global.fetch;

function makeJwt(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.signature`;
}

function jsonRequest(url, body) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  global.fetch = originalFetch;
  vi.resetModules();
  vi.doUnmock("@/models");
});

describe("Kiro social device flow wiring", () => {
  it("KIRO_CONFIG exposes the device endpoints and CLI clientId", async () => {
    const { KIRO_CONFIG } = await import("@/lib/oauth/constants/oauth");

    expect(KIRO_CONFIG.socialDeviceAuthorizeUrl).toBe(
      "https://prod.us-east-1.auth.desktop.kiro.dev/oauth/device/authorization"
    );
    expect(KIRO_CONFIG.socialDevicePollUrl).toBe(
      "https://prod.us-east-1.auth.desktop.kiro.dev/oauth/device/poll"
    );
    expect(KIRO_CONFIG.socialClientId).toBe(process.env.KIRO_OAUTH_CLIENT_ID || "kiro-cli");
  });

  it("social-authorize starts a device authorization and returns the user code", async () => {
    const { KIRO_CONFIG } = await import("@/lib/oauth/constants/oauth");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        verificationUriComplete: "https://example.test/device?code=ABCD-EFGH",
        deviceCode: "device-code-1",
        userCode: "ABCD-EFGH",
        expiresInMilliseconds: 600000,
        intervalInMilliseconds: 7000,
      }),
    });
    global.fetch = fetchMock;

    const { GET } = await import("../../src/app/api/oauth/kiro/social-authorize/route.js");
    const res = await GET(new Request("http://localhost/api/oauth/kiro/social-authorize?provider=google"));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toMatchObject({
      authUrl: "https://example.test/device?code=ABCD-EFGH",
      deviceCode: "device-code-1",
      userCode: "ABCD-EFGH",
      expiresIn: 600,
      interval: 7,
      provider: "google",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(KIRO_CONFIG.socialDeviceAuthorizeUrl);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      clientId: KIRO_CONFIG.socialClientId,
      loginProvider: "Google",
    });
  });

  it("social-authorize rejects an unknown provider without calling upstream", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    const { GET } = await import("../../src/app/api/oauth/kiro/social-authorize/route.js");
    const res = await GET(new Request("http://localhost/api/oauth/kiro/social-authorize?provider=gitlab"));

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("social-exchange reports pending while the device is unauthorized", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: "authorization_pending" }),
    });
    global.fetch = fetchMock;

    const { POST } = await import("../../src/app/api/oauth/kiro/social-exchange/route.js");
    const res = await POST(jsonRequest("http://localhost/api/oauth/kiro/social-exchange", {
      deviceCode: "device-code-1",
      provider: "github",
    }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ success: false, pending: true, error: "authorization_pending" });
  });

  it("social-exchange updates the matching connection instead of duplicating it", async () => {
    const updateProviderConnection = vi.fn().mockResolvedValue({
      id: "conn-1",
      provider: "kiro",
      email: "dev@example.com",
    });
    const createProviderConnection = vi.fn().mockResolvedValue({
      id: "conn-new",
      provider: "kiro",
      email: null,
    });
    const getProviderConnections = vi.fn().mockResolvedValue([
      {
        id: "conn-1",
        authType: "oauth",
        email: null,
        providerSpecificData: { profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/ABC" },
      },
    ]);
    vi.doMock("@/models", () => ({
      createProviderConnection,
      getProviderConnections,
      updateProviderConnection,
    }));

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        accessToken: makeJwt({ email: "dev@example.com" }),
        refreshToken: "refresh-token-1",
        expiresIn: 3600,
        profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/ABC",
      }),
    });

    const { POST } = await import("../../src/app/api/oauth/kiro/social-exchange/route.js");
    const res = await POST(jsonRequest("http://localhost/api/oauth/kiro/social-exchange", {
      deviceCode: "device-code-1",
      provider: "google",
      targetProvider: "kiro",
    }));
    const data = await res.json();

    expect(getProviderConnections).toHaveBeenCalledWith({ provider: "kiro" });
    expect(createProviderConnection).not.toHaveBeenCalled();
    expect(updateProviderConnection).toHaveBeenCalledWith(
      "conn-1",
      expect.objectContaining({
        accessToken: expect.any(String),
        refreshToken: "refresh-token-1",
        email: "dev@example.com",
        testStatus: "active",
      })
    );
    expect(data).toMatchObject({ success: true, connection: { id: "conn-1" } });
  });

  it("social-exchange coerces a foreign targetProvider to kiro", async () => {
    const createProviderConnection = vi.fn().mockResolvedValue({
      id: "conn-9",
      provider: "kiro",
      email: null,
    });
    const getProviderConnections = vi.fn().mockResolvedValue([]);
    const updateProviderConnection = vi.fn();
    vi.doMock("@/models", () => ({
      createProviderConnection,
      getProviderConnections,
      updateProviderConnection,
    }));

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ accessToken: "opaque-token", refreshToken: "refresh-token-2" }),
    });

    const { POST } = await import("../../src/app/api/oauth/kiro/social-exchange/route.js");
    const res = await POST(jsonRequest("http://localhost/api/oauth/kiro/social-exchange", {
      deviceCode: "device-code-1",
      provider: "google",
      targetProvider: "openai",
    }));

    expect(res.status).toBe(200);
    expect(getProviderConnections).toHaveBeenCalledWith({ provider: "kiro" });
    expect(createProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "kiro", authType: "oauth" })
    );
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });
});
