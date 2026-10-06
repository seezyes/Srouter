import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";

// P9-F1 (transport coupling): end-to-end through the REAL wrapper chain
//   ssrfGuard.fetchPublic -> global fetch (patched) -> proxyAwareFetch -> transport
// with `undici` mocked and global fetch replaced by a spy. No live socket, proxy,
// DNS, or config is used. The pinned-proxy connector logic (CONNECT tunnel + TLS
// upgrade decision) is exercised with injected fake sockets, so the actual
// connector bytes/options are validated, not just "a fake Agent saw an option".

const h = vi.hoisted(() => ({ lookup: vi.fn(), agents: [], proxyAgents: [], transport: null }));

vi.mock("node:dns", () => ({
  default: { promises: { lookup: h.lookup } },
  promises: { lookup: h.lookup },
}));

vi.mock("undici", () => {
  class Agent {
    constructor(options) { this.options = options; this.closed = 0; h.agents.push(this); }
    close() { this.closed += 1; return Promise.resolve(); }
  }
  class ProxyAgent {
    constructor(options) { this.options = options; h.proxyAgents.push(this); }
  }
  return { Agent, ProxyAgent, buildConnector: () => () => { throw new Error("real buildConnector not expected in tests"); } };
});

class FakeSocket extends EventEmitter {
  constructor() { super(); this.written = ""; this.destroyed = false; this.paused = false; this.unshifted = []; }
  write(d) { this.written += d; return true; }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  unshift(buf) { this.unshifted.push(Buffer.from(buf)); }
  destroy(err) { if (!this.destroyed) { this.destroyed = true; if (err) this.emit("error", err); } }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
}

const realGlobalFetch = globalThis.fetch;
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
let ssrf, proxyAwareFetch, createPinnedProxyConnect, setTunnelDeps, maxConnectHeaderBytes, tunnelTimeoutMs;
let proxyPort = 9100;

beforeAll(async () => {
  globalThis.fetch = (...args) => h.transport(...args);
  const mod = await import("open-sse/utils/proxyFetch.js");
  proxyAwareFetch = mod.proxyAwareFetch;
  createPinnedProxyConnect = mod.createPinnedProxyConnect;
  setTunnelDeps = mod._setProxyTunnelDeps;
  maxConnectHeaderBytes = mod.MAX_CONNECT_HEADER_BYTES;
  const rc = await import("open-sse/config/runtimeConfig.js");
  tunnelTimeoutMs = rc.FETCH_CONNECT_TIMEOUT_MS;
  ssrf = await import("../../src/shared/utils/ssrfGuard.js");
});

afterAll(() => {
  globalThis.fetch = realGlobalFetch;
  setTunnelDeps(null);
});

beforeEach(() => {
  h.lookup.mockReset();
  h.agents.length = 0;
  h.proxyAgents.length = 0;
  h.transport = vi.fn(async () => new Response("ok", { status: 200 }));
  for (const k of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"]) {
    delete process.env[k];
  }
  setTunnelDeps(null);
});

const resolvePinned = (dispatcher) =>
  new Promise((resolve, reject) =>
    dispatcher.options.connect.lookup("fixture.example", {}, (err, address) => (err ? reject(err) : resolve(address)))
  );

function proxiedFetchSpy() {
  let captured = null;
  h.transport = vi.fn(async (url, init) => { captured = { url: String(url), init }; return new Response("body"); });
  return () => captured;
}

describe("P9-F1 direct pinned transport (unchanged)", () => {
  it("uses the pinned dispatcher, keeps the body, closes the agent", async () => {
    h.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    const getCaptured = proxiedFetchSpy();

    const res = await ssrf.fetchPublic("https://fixture.example/x");
    expect(await res.text()).toBe("body");
    const captured = getCaptured();
    expect(captured.init.redirect).toBe("manual");
    expect(await resolvePinned(captured.init.dispatcher)).toBe("8.8.8.8");
    expect(h.proxyAgents).toHaveLength(0);
    expect(h.agents).toHaveLength(1);
    expect(h.agents[0].closed).toBe(1);
  });
});

describe("P9-F1 pinned proxy connector (unit)", () => {
  function driveConnector(proxyUrl, pinned, requestOpts, script) {
    const sock = new FakeSocket();
    const netConnect = vi.fn(() => sock);
    const tlsConnect = vi.fn(() => { const s = new FakeSocket(); s.tlsProxy = true; return s; });
    const buildOriginConnector = vi.fn((opts, cb) => cb(null, { marker: "origin-tls", opts }));
    const connect = createPinnedProxyConnect(proxyUrl, pinned, { netConnect, tlsConnect, buildOriginConnector });
    let outcome = null;
    connect(requestOpts, (err, socket) => { outcome = { err, socket }; });
    return { sock, netConnect, tlsConnect, buildOriginConnector, outcome: () => outcome };
  }

  it("CONNECTs to the pinned IP:port while the origin servername stays the hostname (https)", () => {
    const d = driveConnector(
      "http://127.0.0.1:7890",
      { host: "fixture.example", address: "8.8.8.8", family: 4 },
      { hostname: "fixture.example", host: "fixture.example", protocol: "https:", port: 443, servername: "fixture.example" },
    );
    d.sock.emit("connect");
    expect(d.sock.written).toContain("CONNECT 8.8.8.8:443 HTTP/1.1");
    expect(d.sock.written).toContain("Host: 8.8.8.8:443");
    d.sock.emit("data", "HTTP/1.1 200 Connection Established\r\n\r\n");
    const call = d.buildOriginConnector.mock.calls[0][0];
    expect(call.servername).toBe("fixture.example"); // SNI + cert verify = hostname
    expect(call.protocol).toBe("https:");
    expect(call.httpSocket).toBe(d.sock);
    expect(d.outcome().err).toBeNull();
    expect(d.outcome().socket.marker).toBe("origin-tls");
  });

  it("formats non-default ports and IPv6 pinned addresses correctly", () => {
    const v4 = driveConnector("http://127.0.0.1:7890", { address: "8.8.8.8" }, { protocol: "https:", port: 8443, servername: "h" });
    v4.sock.emit("connect");
    expect(v4.sock.written).toContain("CONNECT 8.8.8.8:8443 HTTP/1.1");

    const v6 = driveConnector("http://127.0.0.1:7890", { address: "2606:4700:4700::1111" }, { protocol: "https:", port: 443, servername: "h" });
    v6.sock.emit("connect");
    expect(v6.sock.written).toContain("CONNECT [2606:4700:4700::1111]:443 HTTP/1.1");
    expect(v6.sock.written).toContain("Host: [2606:4700:4700::1111]:443");
  });

  it("sends proxy credentials only on the proxy hop", () => {
    const d = driveConnector(
      "http://user:secret@127.0.0.1:7890",
      { address: "8.8.8.8" },
      { protocol: "https:", port: 443, servername: "fixture.example" },
    );
    d.sock.emit("connect");
    expect(d.sock.written).toContain(`Proxy-Authorization: Basic ${Buffer.from("user:secret").toString("base64")}`);
    d.sock.emit("data", "HTTP/1.1 200 Connection Established\r\n\r\n");
    expect(JSON.stringify(d.buildOriginConnector.mock.calls[0][0])).not.toContain("secret");
  });

  it("plain HTTP origin returns the tunnel socket without TLS upgrade", () => {
    const d = driveConnector("http://127.0.0.1:7890", { address: "8.8.8.8" }, { protocol: "http:", port: 80, servername: "fixture.example" });
    d.sock.emit("connect");
    d.sock.emit("data", "HTTP/1.1 200 OK\r\n\r\n");
    expect(d.buildOriginConnector).not.toHaveBeenCalled();
    expect(d.outcome().socket).toBe(d.sock);
  });

  it("rejects a non-200 proxy response and proxy socket errors", () => {
    const denied = driveConnector("http://127.0.0.1:7890", { address: "8.8.8.8" }, { protocol: "https:", port: 443, servername: "h" });
    denied.sock.emit("connect");
    denied.sock.emit("data", "HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
    expect(denied.outcome().err).toBeTruthy();
    expect(denied.sock.destroyed).toBe(true);

    const broken = driveConnector("http://127.0.0.1:7890", { address: "8.8.8.8" }, { protocol: "https:", port: 443, servername: "h" });
    broken.sock.emit("connect");
    broken.sock.emit("error", new Error("tunnel boom"));
    expect(broken.outcome().err?.message).toBe("tunnel boom");
  });

  it("honors an already-aborted signal", () => {
    const controller = new AbortController();
    controller.abort();
    const d = driveConnector("http://127.0.0.1:7890", { address: "8.8.8.8" }, { protocol: "https:", port: 443, servername: "h", signal: controller.signal });
    expect(d.outcome().err).toBeTruthy();
    expect(d.sock.destroyed).toBe(true);
  });

  it("upgrades an https proxy before CONNECT", () => {
    const d = driveConnector("https://proxy.example:8443", { address: "8.8.8.8" }, { protocol: "https:", port: 443, servername: "fixture.example" });
    expect(d.tlsConnect).toHaveBeenCalledTimes(1);
    expect(d.tlsConnect.mock.calls[0][0]).toMatchObject({ servername: "proxy.example", host: "proxy.example" });
    const proxySocket = d.tlsConnect.mock.results[0].value;
    proxySocket.emit("secureConnect");
    expect(proxySocket.written).toContain("CONNECT 8.8.8.8:443 HTTP/1.1");
  });
});

describe("P9-F1 guarded request routing through a proxy", () => {
  it("routes a guarded fetch through the pinned proxy connector without rewriting the URL", async () => {
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort++}`;
    h.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);

    // Inject fake I/O so the ACTUAL connector built by the wrapper can be driven.
    const sock = new FakeSocket();
    const buildOriginConnector = vi.fn((opts, cb) => cb(null, { marker: "tls" }));
    setTunnelDeps({ netConnect: () => sock, tlsConnect: vi.fn(), buildOriginConnector });

    const getCaptured = proxiedFetchSpy();
    const res = await ssrf.fetchPublic("https://fixture.example/x");
    await res.body?.cancel();

    const captured = getCaptured();
    // Origin URL is NOT rewritten (Host header + TLS identity stay the hostname).
    expect(captured.url).toBe("https://fixture.example/x");
    expect(h.proxyAgents).toHaveLength(0);
    // dispatcher is an Agent (our connector), not the ssrf pinned agent.
    const proxyAgent = captured.init.dispatcher;
    expect(typeof proxyAgent.options.connect).toBe("function");

    // Drive the actual connector to prove it tunnels to the validated IP.
    let outcome = null;
    proxyAgent.options.connect(
      { hostname: "fixture.example", host: "fixture.example", protocol: "https:", port: 443, servername: "fixture.example" },
      (err, s) => { outcome = { err, s }; },
    );
    sock.emit("connect");
    expect(sock.written).toContain("CONNECT 8.8.8.8:443 HTTP/1.1");
    sock.emit("data", "HTTP/1.1 200 Connection Established\r\n\r\n");
    expect(buildOriginConnector.mock.calls[0][0].servername).toBe("fixture.example");
    expect(outcome.err).toBeNull();
  });

  it("fails closed for an opaque Vercel relay on a guarded dispatcher", async () => {
    h.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    const getCaptured = proxiedFetchSpy();
    const first = await ssrf.fetchPublic("https://fixture.example/x");
    await first.body?.cancel();
    const pinnedDispatcher = getCaptured().init.dispatcher;

    h.transport = vi.fn();
    await expect(
      proxyAwareFetch("https://fixture.example/y", { dispatcher: pinnedDispatcher }, { vercelRelayUrl: "https://relay.example" })
    ).rejects.toThrow(/opaque relay/);
    expect(h.transport).not.toHaveBeenCalled();
  });

  it("does not fall back to direct for a guarded strictProxy request with no proxy", async () => {
    h.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    const getCaptured = proxiedFetchSpy();
    const first = await ssrf.fetchPublic("https://fixture.example/x");
    await first.body?.cancel();
    const pinnedDispatcher = getCaptured().init.dispatcher;

    h.transport = vi.fn();
    await expect(
      proxyAwareFetch("https://fixture.example/y", { dispatcher: pinnedDispatcher }, { strictProxy: true, enabled: true, url: "" })
    ).rejects.toThrow(/strictProxy/);
    expect(h.transport).not.toHaveBeenCalled();
  });

  it("still routes non-guarded requests through the configured proxy", async () => {
    const getCaptured = proxiedFetchSpy();
    await proxyAwareFetch("https://plain.example/x", {}, { enabled: true, url: `http://127.0.0.1:${proxyPort++}` });
    expect(h.proxyAgents).toHaveLength(1);
    expect(getCaptured().init.dispatcher).toBe(h.proxyAgents[0]);
  });

  it("rejects a forbidden host before any transport even with a proxy configured", async () => {
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort++}`;
    h.transport = vi.fn();
    await expect(ssrf.fetchPublic("http://127.0.0.1/")).rejects.toThrow(/Blocked URL/);
    expect(h.transport).not.toHaveBeenCalled();
  });
});

// P9-F1 hardening: the connector must be bounded in time and bytes, must clean up
// every socket/timer/listener on each terminal path, must not corrupt the tunnel
// stream, and must never send a plaintext CONNECT to a non-HTTP proxy protocol.
describe("P9-F1 connector hardening (bounded, timed, leak-free)", () => {
  // Real-timer leak probe: records the handle the connector arms and asserts the
  // terminal path cleared it. Disabled while fake timers are installed (the
  // timeout test asserts the pending-timer count directly instead).
  const timersAreFaked = () => {
    try { return typeof vi.isFakeTimers === "function" ? vi.isFakeTimers() : false; } catch { return false; }
  };
  const activeProbes = [];
  afterEach(() => { while (activeProbes.length) activeProbes.pop().restore(); });

  function timerProbe() {
    if (timersAreFaked()) return { expectCleared: () => {}, restore: () => {} };
    // One probe per test: spies are process-global, so nested wrapping would
    // recurse into ourselves.
    const existing = activeProbes[activeProbes.length - 1];
    if (existing) return existing;
    const handles = [];
    const cleared = [];
    const setSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms, ...rest) => {
      const handle = nativeSetTimeout(fn, ms, ...rest);
      handles.push(handle);
      return handle;
    });
    const clearSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
      cleared.push(handle);
      return nativeClearTimeout(handle);
    });
    return {
      // Every tunnel deadline armed during the test must be cleared on its
      // terminal path (success, error, abort, timeout, overflow).
      expectCleared: () => {
        expect(handles.length).toBeGreaterThan(0);
        for (const handle of handles) expect(cleared).toContain(handle);
      },
      restore: () => { setSpy.mockRestore(); clearSpy.mockRestore(); },
    };
  }

  function drive(proxyUrl, pinned, requestOpts, deps = {}) {
    const sock = new FakeSocket();
    const proxySock = new FakeSocket();
    const netConnect = deps.netConnect || vi.fn(() => sock);
    const tlsConnect = deps.tlsConnect || vi.fn(() => { proxySock.tlsProxy = true; return proxySock; });
    const buildOriginConnector = deps.buildOriginConnector || vi.fn((opts, cb) => cb(null, { marker: "origin-tls", opts }));
    const connect = deps.connect || createPinnedProxyConnect(proxyUrl, pinned, { netConnect, tlsConnect, buildOriginConnector });
    const probe = timerProbe();
    activeProbes.push(probe);
    const calls = [];
    connect(requestOpts, (err, result) => calls.push({ err, result }));
    return {
      sock, proxySock, netConnect, tlsConnect, buildOriginConnector, calls,
      last: () => calls[calls.length - 1],
      expectTimersCleared: probe.expectCleared,
    };
  }

  const httpsOpts = { protocol: "https:", port: 443, servername: "fixture.example" };

  it("bounds the CONNECT response header buffer (unterminated flood)", () => {
    const d = drive("http://127.0.0.1:7890", { address: "8.8.8.8" }, httpsOpts);
    d.sock.emit("connect");
    d.sock.emit("data", "X".repeat(maxConnectHeaderBytes + 1));
    expect(d.last().err?.message).toMatch(/headers exceeded/);
    expect(d.sock.destroyed).toBe(true);
    expect(d.calls).toHaveLength(1);
    d.expectTimersCleared();
  });

  it("bounds the header buffer when the terminator arrives past the limit", () => {
    const d = drive("http://127.0.0.1:7890", { address: "8.8.8.8" }, httpsOpts);
    d.sock.emit("connect");
    d.sock.emit("data", `HTTP/1.1 200 OK\r\nX-Pad: ${"a".repeat(maxConnectHeaderBytes)}\r\n\r\n`);
    expect(d.last().err?.message).toMatch(/headers exceeded/);
    expect(d.sock.destroyed).toBe(true);
  });

  it("fails a proxy that closes before any CONNECT response (no header, no hang)", () => {
    const d = drive("http://127.0.0.1:7890", { address: "8.8.8.8" }, httpsOpts);
    d.sock.emit("connect");
    d.sock.emit("close");
    expect(d.last().err?.message).toMatch(/closed the connection before CONNECT completed/);
    expect(d.calls).toHaveLength(1);
    d.expectTimersCleared();
  });

  it("times out a silent proxy and tears the socket down (finite deadline)", () => {
    vi.useFakeTimers();
    try {
      const d = drive("http://127.0.0.1:7890", { address: "8.8.8.8" }, httpsOpts);
      d.sock.emit("connect");
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(tunnelTimeoutMs - 1);
      expect(d.last()).toBeUndefined();
      vi.advanceTimersByTime(1);
      expect(d.last().err?.message).toMatch(new RegExp(`timed out after ${tunnelTimeoutMs}ms`));
      expect(d.sock.destroyed).toBe(true);
      expect(d.calls).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts a byte-split CONNECT response and re-pauses without dropping the socket", () => {
    const raw = "HTTP/1.1 200 Connection Established\r\nX-Proxy: fixture\r\n\r\n";
    const d = drive("http://127.0.0.1:7890", { address: "8.8.8.8" }, httpsOpts);
    d.sock.emit("connect");
    for (const ch of raw.slice(0, raw.length - 1)) d.sock.emit("data", ch);
    expect(d.buildOriginConnector).not.toHaveBeenCalled();
    d.sock.emit("data", raw.slice(-1));
    expect(d.last().err).toBeNull();
    expect(d.buildOriginConnector).toHaveBeenCalledTimes(1);
    expect(d.buildOriginConnector.mock.calls[0][0].servername).toBe("fixture.example");
    expect(d.sock.paused).toBe(true);
  });

  it("returns a usable paused plain-HTTP tunnel socket and re-inserts trailing bytes", () => {
    const d = drive("http://127.0.0.1:7890", { address: "8.8.8.8" }, { protocol: "http:", port: 80, servername: "fixture.example" });
    d.sock.emit("connect");
    d.sock.emit("data", "HTTP/1.1 200 OK\r\n\r\nEARLY-BYTES");
    expect(d.last().err).toBeNull();
    expect(d.last().result).toBe(d.sock);
    expect(d.sock.destroyed).toBe(false);
    // Hand-off state undici expects: paused, with the surplus bytes readable again.
    expect(d.sock.paused).toBe(true);
    expect(Buffer.concat(d.sock.unshifted).toString("latin1")).toBe("EARLY-BYTES");
    expect(d.sock.listenerCount("data")).toBe(0);
    expect(d.sock.listenerCount("error")).toBe(0);
    expect(d.sock.listenerCount("close")).toBe(0);
    d.expectTimersCleared();
  });

  it("surfaces origin-TLS failures and destroys the tunnel", () => {
    let originCb = null;
    const d = drive("http://127.0.0.1:7890", { address: "8.8.8.8" }, httpsOpts, {
      buildOriginConnector: vi.fn((opts, cb) => { originCb = cb; }),
    });
    d.sock.emit("connect");
    d.sock.emit("data", "HTTP/1.1 200 Connection Established\r\n\r\n");
    // Still pending the origin TLS handshake: no caller callback yet.
    expect(d.calls).toHaveLength(0);
    originCb(new Error("certificate hostname mismatch"));
    expect(d.last().err?.message).toBe("certificate hostname mismatch");
    expect(d.sock.destroyed).toBe(true);
    d.expectTimersCleared();
  });

  it("surfaces a synchronous throw from the origin-TLS step", () => {
    const d = drive("http://127.0.0.1:7890", { address: "8.8.8.8" }, httpsOpts, {
      buildOriginConnector: vi.fn(() => { throw new Error("tls options rejected"); }),
    });
    d.sock.emit("connect");
    d.sock.emit("data", "HTTP/1.1 200 Connection Established\r\n\r\n");
    expect(d.last().err?.message).toBe("tls options rejected");
    expect(d.sock.destroyed).toBe(true);
  });

  it("fails once and cleans up on raw proxy socket errors (no double callback)", () => {
    const d = drive("http://127.0.0.1:7890", { address: "8.8.8.8" }, httpsOpts);
    d.sock.emit("error", new Error("ECONNREFUSED"));
    expect(d.last().err?.message).toBe("ECONNREFUSED");
    expect(d.sock.destroyed).toBe(true);
    // Late/duplicate events after settlement must not re-enter the callback.
    d.sock.emit("error", new Error("second"));
    d.sock.emit("close");
    d.sock.emit("connect");
    expect(d.calls).toHaveLength(1);
    d.expectTimersCleared();
  });

  it("releases the abort listener and stays single-shot when aborted", () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const d = drive("http://127.0.0.1:7890", { address: "8.8.8.8" }, { ...httpsOpts, signal: controller.signal });
    d.sock.emit("connect");
    controller.abort();
    expect(d.last().err?.message).toMatch(/aborted/);
    expect(d.sock.destroyed).toBe(true);
    expect(d.calls).toHaveLength(1);
    controller.abort();
    expect(d.calls).toHaveLength(1);
    // Our abort listener is deregistered on the terminal path.
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    d.expectTimersCleared();
  });

  it("uses a bare IPv6 proxy host for net.connect/tls.connect (no URL brackets)", () => {
    const plain = drive("http://[::1]:7890", { address: "2606:4700:4700::1111" }, httpsOpts);
    expect(plain.netConnect.mock.calls[0][0]).toMatchObject({ host: "::1", port: 7890 });
    plain.sock.emit("connect");
    expect(plain.sock.written).toContain("CONNECT [2606:4700:4700::1111]:443 HTTP/1.1");

    const secure = drive("https://[::1]:8443", { address: "2606:4700:4700::1111" }, httpsOpts);
    expect(secure.tlsConnect.mock.calls[0][0]).toMatchObject({ host: "::1" });
    // IP-literal proxies must not receive an SNI value that is not a DNS name.
    expect(secure.tlsConnect.mock.calls[0][0].servername).toBeUndefined();
  });

  it("sanitizes the origin servername: strips :port and bracketed literals, keeps DNS names", () => {
    const cases = [
      [{ host: "fixture.example:443" }, "fixture.example"],
      [{ hostname: "fixture.example:8443" }, "fixture.example"],
      [{ host: "fixture.example:8443", hostname: "fixture.example" }, "fixture.example"],
      [{ servername: "[2606:4700::1111]:443", hostname: "fixture.example" }, "fixture.example"],
      [{ servername: "2606:4700::1111" }, undefined],
      [{ host: "[2606:4700::1111]:443" }, undefined],
      [{ servername: "" , hostname: "[::1]" }, undefined],
    ];
    for (const [opts, expected] of cases) {
      const d = drive("http://127.0.0.1:7890", { address: "8.8.8.8" }, { protocol: "https:", port: 443, ...opts });
      d.sock.emit("connect");
      d.sock.emit("data", "HTTP/1.1 200 Connection Established\r\n\r\n");
      const passed = d.buildOriginConnector.mock.calls[0][0];
      expect(passed.servername).toBe(expected);
      if (expected) expect(passed.servername).not.toContain(":");
      expect(passed.servername ?? "").not.toContain("[");
    }
  });

  it("fails closed for non-HTTP(S) proxy protocols before writing any byte", () => {
    for (const url of ["socks5://127.0.0.1:1080", "socks4://127.0.0.1:1080", "socks5h://user:pass@127.0.0.1:1080"]) {
      const netConnect = vi.fn();
      const tlsConnect = vi.fn();
      expect(() => createPinnedProxyConnect(url, { address: "8.8.8.8" }, { netConnect, tlsConnect }))
        .toThrow(/unsupported proxy protocol/);
      expect(netConnect).not.toHaveBeenCalled();
      expect(tlsConnect).not.toHaveBeenCalled();
    }
  });

  it("refuses a SOCKS proxy end-to-end for a guarded fetch without touching the socket layer", async () => {
    process.env.HTTPS_PROXY = "socks5://user:secret@127.0.0.1:1080";
    h.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    const netConnect = vi.fn();
    setTunnelDeps({ netConnect, tlsConnect: vi.fn(), buildOriginConnector: vi.fn() });
    h.transport = vi.fn();
    await expect(ssrf.fetchPublic("https://fixture.example/x")).rejects.toThrow(/unsupported proxy protocol/);
    expect(netConnect).not.toHaveBeenCalled();
    expect(h.transport).not.toHaveBeenCalled();
  });
});
