import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// P9-F1 positive regressions: the SSRF guard must (a) keep the VansRouter
// HTTP(S)-only / no-userinfo / multicast+reserved boundary and (b) pin the
// validated DNS address into the actual transport so a second attacker-controlled
// lookup cannot redirect the socket (TOCTOU rebinding).
//
// No real network: DNS and undici are mocked, global fetch is stubbed.

const { lookupMock, agents } = vi.hoisted(() => ({ lookupMock: vi.fn(), agents: [] }));

vi.mock("node:dns", () => ({
  default: { promises: { lookup: lookupMock } },
  promises: { lookup: lookupMock },
}));

vi.mock("undici", () => {
  class Agent {
    constructor(options) {
      this.options = options;
      this.closed = 0;
      agents.push(this);
    }
    async close() { this.closed += 1; }
  }
  return { Agent };
});

const { assertPublicUrl, assertPublicUrlResolved, fetchPublic } = await import(
  "../../src/shared/utils/ssrfGuard.js"
);

const originalFetch = global.fetch;
beforeEach(() => {
  lookupMock.mockReset();
  agents.length = 0;
});
afterEach(() => { global.fetch = originalFetch; });

describe("P9-F1 unsupported-target guard boundary", () => {
  const denied = [
    "https://user:password@example.com/path", // userinfo
    "ftp://example.com/file",                  // non-HTTP(S)
    "http://224.0.0.1/",                       // multicast
    "http://240.0.0.1/",                       // reserved
    "http://255.255.255.255/",                 // broadcast (reserved)
  ];
  for (const url of denied) {
    it(`sync guard rejects ${url}`, () => {
      expect(() => assertPublicUrl(url)).toThrow(/Blocked URL/);
    });
    it(`resolved guard rejects ${url}`, async () => {
      await expect(assertPublicUrlResolved(url)).rejects.toThrow(/Blocked URL/);
    });
  }

  it("still allows plain public http(s) targets", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    expect(() => assertPublicUrl("https://example.com/")).not.toThrow();
    await expect(assertPublicUrlResolved("https://example.com/")).resolves.toBeUndefined();
  });
});

describe("P9-F1 DNS address pinning", () => {
  it("passes the validated address to the transport and closes the agent", async () => {
    lookupMock.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    let captured = null;
    global.fetch = vi.fn(async (url, init) => {
      captured = { url, init };
      return new Response("ok", { status: 200 });
    });

    const res = await fetchPublic("https://fixture.example/path");
    expect(await res.text()).toBe("ok");
    expect(lookupMock).toHaveBeenCalledTimes(1);
    expect(captured.init.redirect).toBe("manual");
    const dispatcher = captured.init.dispatcher;
    expect(dispatcher).toBeTruthy();
    expect(typeof dispatcher.options.connect.lookup).toBe("function");

    const pinned = await new Promise((resolve, reject) => {
      dispatcher.options.connect.lookup("fixture.example", {}, (err, address) =>
        err ? reject(err) : resolve(address)
      );
    });
    expect(pinned).toBe("8.8.8.8");
    // close() is initiated without blocking the streaming caller.
    await Promise.resolve();
    expect(agents[agents.length - 1].closed).toBe(1);
  });

  it("does not perform a second DNS lookup after validation (rebinding)", async () => {
    let calls = 0;
    lookupMock.mockImplementation(async () => {
      calls += 1;
      return [{ address: calls === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }];
    });
    let pinned = null;
    global.fetch = vi.fn(async (_url, init) => {
      pinned = await new Promise((resolve, reject) =>
        init.dispatcher.options.connect.lookup("fixture.example", {}, (e, a) =>
          e ? reject(e) : resolve(a)
        )
      );
      return new Response("ok", { status: 200 });
    });

    const res = await fetchPublic("https://fixture.example/x");
    await res.body?.cancel();
    expect(calls).toBe(1);
    expect(pinned).toBe("8.8.8.8");
  });

  it("fails closed before dispatch when DNS resolution rejects", async () => {
    lookupMock.mockRejectedValue(new Error("dns unavailable"));
    global.fetch = vi.fn();

    await expect(fetchPublic("https://fixture.example/y")).rejects.toThrow(/Blocked URL: DNS resolution failed/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("never dispatches when the resolved address is internal", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    global.fetch = vi.fn();
    await expect(fetchPublic("https://rebind.example/z")).rejects.toThrow(/Blocked URL/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
