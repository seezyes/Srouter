import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  evaluateLoginGate,
  isForeignBrowserRequest,
  normalizeRequireLogin,
  originGuardEnabled,
  resolveLoginPolicy,
} from "../../src/lib/auth/loginPolicy.js";

const PEER_TOKEN = "peer-token-fixture";

function request(headers = {}) {
  return { headers: new Headers(headers) };
}

// A request that actually came through custom-server.js: peer IP stamped from the
// TCP socket and proven by the per-process secret.
function localRequest(headers = {}) {
  return request({ "x-9r-peer-token": PEER_TOKEN, "x-9r-real-ip": "127.0.0.1", ...headers });
}

const originalNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
  process.env.NODE_ENV = "production";
});

afterEach(() => {
  delete process.env.NINEROUTER_PEER_TOKEN;
  process.env.NODE_ENV = originalNodeEnv;
});

describe("login policy resolution", () => {
  it("maps persisted values to the three levels", () => {
    expect(resolveLoginPolicy({ requireLogin: true })).toBe("always");
    expect(resolveLoginPolicy({ requireLogin: "local" })).toBe("local");
    expect(resolveLoginPolicy({ requireLogin: false })).toBe("off");
    expect(resolveLoginPolicy({ requireLogin: "off" })).toBe("off");
    expect(resolveLoginPolicy({})).toBe("always");
    expect(resolveLoginPolicy(null)).toBe("always");
    expect(resolveLoginPolicy({ requireLogin: "garbage" })).toBe("always");
  });

  it("normalizes stored values back to the safe set", () => {
    expect(normalizeRequireLogin("local")).toBe("local");
    expect(normalizeRequireLogin(false)).toBe(false);
    expect(normalizeRequireLogin("off")).toBe(false);
    expect(normalizeRequireLogin(undefined)).toBe(true);
    expect(normalizeRequireLogin("weird")).toBe(true);
  });

  it("treats the origin guard as on unless explicitly disabled", () => {
    expect(originGuardEnabled({})).toBe(true);
    expect(originGuardEnabled({ originGuard: true })).toBe(true);
    expect(originGuardEnabled({ originGuard: false })).toBe(false);
  });
});

describe("origin guard", () => {
  it("accepts requests without any browser headers (curl, local apps)", () => {
    expect(isForeignBrowserRequest(request(), {})).toBe(false);
  });

  it("flags a browser page on a foreign origin", () => {
    expect(isForeignBrowserRequest(request({ origin: "http://evil.example.com" }), {})).toBe(true);
  });

  it("flags a sandboxed page (Origin: null)", () => {
    expect(isForeignBrowserRequest(request({ origin: "null" }), {})).toBe(true);
  });

  it("flags cross-site fetch metadata", () => {
    expect(
      isForeignBrowserRequest(request({ host: "localhost:20127", "sec-fetch-site": "cross-site" }), {})
    ).toBe(true);
  });

  it("flags a foreign Host header (DNS rebinding) even without Origin", () => {
    expect(isForeignBrowserRequest(request({ host: "evil.example.com:20127" }), {})).toBe(true);
  });

  it("accepts loopback names, IP literals and the configured tunnel host", () => {
    expect(isForeignBrowserRequest(request({ host: "localhost:20127" }), {})).toBe(false);
    expect(isForeignBrowserRequest(request({ host: "127.0.0.1:20127" }), {})).toBe(false);
    expect(isForeignBrowserRequest(request({ host: "[::1]:20127" }), {})).toBe(false);
    expect(isForeignBrowserRequest(request({ host: "192.168.1.5:20127" }), {})).toBe(false);
    expect(isForeignBrowserRequest(request({ host: "my-pc.local:20127" }), {})).toBe(false);
    expect(
      isForeignBrowserRequest(request({ host: "router.trycloudflare.com" }), {
        tunnelUrl: "https://router.trycloudflare.com",
      })
    ).toBe(false);
  });

  it("accepts the dashboard talking to itself through its own origin", () => {
    expect(
      isForeignBrowserRequest(
        request({ host: "localhost:20127", origin: "http://localhost:20127" }),
        {}
      )
    ).toBe(false);
  });
});

describe("login gate decisions", () => {
  it("always: requires a session for local and remote requests", () => {
    expect(evaluateLoginGate(localRequest({ host: "localhost:20127" }), { requireLogin: true }))
      .toMatchObject({ policy: "always", bypass: false, blocked: false });
    expect(evaluateLoginGate(request({ host: "router.example.com" }), { requireLogin: true }))
      .toMatchObject({ policy: "always", bypass: false, blocked: false });
  });

  it("local: bypasses loopback requests from this machine", () => {
    const gate = evaluateLoginGate(
      localRequest({ host: "localhost:20127", origin: "http://localhost:20127" }),
      { requireLogin: "local" }
    );
    expect(gate).toMatchObject({ policy: "local", bypass: true, blocked: false });
  });

  it("local: keeps the password requirement for other devices", () => {
    const gate = evaluateLoginGate(request({ host: "router.example.com" }), { requireLogin: "local" });
    expect(gate).toMatchObject({ policy: "local", bypass: false, blocked: false });
  });

  it("local: a foreign-origin call from the host is denied, not just unbypassed", () => {
    const gate = evaluateLoginGate(
      localRequest({ host: "localhost:20127", origin: "http://evil.example.com" }),
      { requireLogin: "local" }
    );
    expect(gate).toMatchObject({ policy: "local", bypass: false, blocked: true });
  });

  it("local: a DNS-rebinding host loses the bypass without being reported as cross-site", () => {
    const gate = evaluateLoginGate(
      localRequest({ host: "evil.example.com:20127" }),
      { requireLogin: "local" }
    );
    expect(gate).toMatchObject({ policy: "local", bypass: false, blocked: false });
  });

  it("off: bypasses remote requests that carry no browser origin", () => {
    const gate = evaluateLoginGate(request({ host: "192.168.1.5:20127" }), { requireLogin: false });
    expect(gate).toMatchObject({ policy: "off", bypass: true, blocked: false });
  });

  it("off: still blocks a foreign-origin browser request", () => {
    const gate = evaluateLoginGate(
      request({ host: "192.168.1.5:20127", origin: "http://evil.example.com" }),
      { requireLogin: false }
    );
    expect(gate).toMatchObject({ policy: "off", bypass: false, blocked: true });
  });

  it("off: a rebinding host loses the bypass, and its own Origin is the proof", () => {
    // The page keeps Origin and Host consistent (both on the attacker's domain), so
    // the Host check alone must not be the only defence — the Origin is what catches it.
    const hostOnly = evaluateLoginGate(request({ host: "evil.example.com:20127" }), {
      requireLogin: false,
    });
    expect(hostOnly).toMatchObject({ policy: "off", bypass: false, blocked: false });

    const withOrigin = evaluateLoginGate(
      request({ host: "evil.example.com:20127", origin: "http://evil.example.com" }),
      { requireLogin: false }
    );
    expect(withOrigin).toMatchObject({ policy: "off", bypass: false, blocked: true });
  });

  it("off: blocks cross-site fetch metadata", () => {
    const gate = evaluateLoginGate(
      request({ host: "127.0.0.1:20127", "sec-fetch-site": "cross-site" }),
      { requireLogin: false }
    );
    expect(gate).toMatchObject({ policy: "off", bypass: false, blocked: true });
  });

  it("off: the guard can be switched off in settings", () => {
    const gate = evaluateLoginGate(
      request({ host: "192.168.1.5:20127", origin: "http://evil.example.com" }),
      { requireLogin: false, originGuard: false }
    );
    expect(gate).toMatchObject({ policy: "off", bypass: true, blocked: false });
  });

  it("local: switching the guard off still does not make a foreign page local", () => {
    // Bypass at the local level needs a loopback Origin regardless of the guard: the
    // request is answered 401 instead of 403, but it is never let through.
    const gate = evaluateLoginGate(
      localRequest({ host: "localhost:20127", origin: "http://evil.example.com" }),
      { requireLogin: "local", originGuard: false }
    );
    expect(gate).toMatchObject({ policy: "local", bypass: false, blocked: false });
  });

  it("off: loopback requests keep working", () => {
    const gate = evaluateLoginGate(
      localRequest({ host: "localhost:20127", origin: "http://localhost:20127" }),
      { requireLogin: false }
    );
    expect(gate).toMatchObject({ policy: "off", bypass: true, blocked: false });
  });
});
