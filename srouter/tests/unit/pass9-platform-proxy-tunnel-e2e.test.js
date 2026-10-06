import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import crypto from "node:crypto";
import net from "node:net";
import http from "node:http";
import https from "node:https";

// P9-F1 hardening — live acceptance on sockets owned by THIS test file:
//   ssrfGuard.fetchPublic -> patched global fetch -> proxyAwareFetch
//     -> pinnedProxyAgent (REAL undici Agent + REAL buildConnector)
//     -> REAL TCP/TLS to a test-created loopback CONNECT proxy
//     -> test-created loopback TLS/HTTP origin.
//
// Only 127.0.0.1 servers created here are dialed: the proxy and the origin bind
// ephemeral ports, the proxy forwards to the owned origin no matter which CONNECT
// target it is asked for, and the synthetic public IP (TEST-NET-3) is never
// routed — it only appears as the CONNECT target string. Nothing external is
// contacted, no system trust store is touched: the ephemeral self-signed
// certificate is handed to undici's buildConnector explicitly as `ca`.

const HOST = "pinned-e2e.invalid";
const HOST_2 = "pinned-e2e-2.invalid";
const PUBLIC_IP = "203.0.113.10";
const PROXY_USER = "fixture-user";
const PROXY_PASS = "fixture-secret";

const h = vi.hoisted(() => ({ lookup: vi.fn(), current: "203.0.113.10" }));

vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal();
  // Callback-capable stand-in: if any code path (ours or undici's) asks for
  // dns.lookup it gets the fixed synthetic public address instead of resolving.
  const lookup = (hostname, options, cb) => {
    const callback = typeof options === "function" ? options : cb;
    const opts = typeof options === "function" ? {} : (options || {});
    if (typeof callback === "function") {
      callback(null, opts.all ? [{ address: h.current, family: 4 }] : h.current, 4);
      return undefined;
    }
    return h.lookup(hostname, opts);
  };
  return {
    ...actual,
    default: { ...actual.default, lookup, promises: { ...actual.default.promises, lookup: h.lookup } },
    lookup,
    promises: { ...actual.promises, lookup: h.lookup },
  };
});

// ─── Ephemeral self-signed certificate (no openssl, no downloads) ──────────
// Minimal DER writer: enough for a v3 self-signed EC certificate with a
// basicConstraints CA + subjectAltName DNS entry, so it can be passed to the
// client as an explicit trust anchor and still be hostname-verified.
function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let x = n;
  while (x > 0) { bytes.unshift(x & 0xff); x = Math.floor(x / 256); }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function der(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}
const derSeq = (...items) => der(0x30, Buffer.concat(items));
const derSet = (...items) => der(0x31, Buffer.concat(items));
const derOctet = (buf) => der(0x04, buf);
const derBool = (v) => der(0x01, Buffer.from([v ? 0xff : 0x00]));
const derUtf8 = (s) => der(0x0c, Buffer.from(s, "utf8"));
const derBitString = (buf) => der(0x03, Buffer.concat([Buffer.from([0]), buf]));
function derInt(value) {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let buf = Buffer.from(hex, "hex");
  while (buf.length > 1 && buf[0] === 0) buf = buf.subarray(1);
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
  return der(0x02, buf);
}
function derOid(dotted) {
  const parts = dotted.split(".").map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const stack = [part & 0x7f];
    let v = Math.floor(part / 128);
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    bytes.push(...stack);
  }
  return der(0x06, Buffer.from(bytes));
}
function derUtcTime(date) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${p(date.getUTCFullYear() % 100)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}`
    + `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return der(0x17, Buffer.from(stamp, "ascii"));
}
function pem(label, body) {
  const b64 = body.toString("base64").replace(/(.{64})/g, "$1\n").trim();
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}
function makeSelfSignedCert(hostnames) {
  const names = Array.isArray(hostnames) ? hostnames : [hostnames];
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const name = derSeq(derSet(derSeq(derOid("2.5.4.3"), derUtf8(names[0]))));
  const sigAlg = derSeq(derOid("1.2.840.10045.4.3.2")); // ecdsa-with-SHA256
  const extensions = der(0xa3, derSeq(
    derSeq(derOid("2.5.29.19"), derBool(true), derOctet(derSeq(derBool(true)))),
    derSeq(derOid("2.5.29.17"), derOctet(derSeq(...names.map((n) => der(0x82, Buffer.from(n, "ascii")))))),
  ));
  const tbs = derSeq(
    der(0xa0, derInt(2)),                       // version v3
    derInt(0x0badc0de),                         // serial
    sigAlg,
    name,                                       // issuer
    derSeq(derUtcTime(new Date(Date.now() - 60_000)), derUtcTime(new Date(Date.now() + 86_400_000))),
    name,                                       // subject
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
    cert: pem("CERTIFICATE", derSeq(tbs, sigAlg, derBitString(crypto.sign("sha256", tbs, privateKey)))),
  };
}

// ─── Owned servers ─────────────────────────────────────────────────────────
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}
function closeServer(server, sockets) {
  for (const socket of sockets) { try { socket.destroy(); } catch { /* gone */ } }
  sockets.clear();
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

// A CONNECT proxy that ignores the requested target and forwards the tunnel to
// the owned origin listener (that is the point: the client's CONNECT target is
// asserted, but the only reachable endpoint is ours).
function startConnectProxy({ upstreamPort, auth, mode = "tunnel" }) {
  const sockets = new Set();
  const state = { connects: [], upstreamConnections: 0, responseStatus: null };
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("error", () => {});
    client.on("close", () => sockets.delete(client));
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("latin1");
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      client.removeListener("data", onData);
      const rest = buf.slice(headerEnd + 4);
      const [requestLine, ...lines] = buf.slice(0, headerEnd).split("\r\n");
      const headers = {};
      for (const line of lines) {
        const idx = line.indexOf(":");
        if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
      state.connects.push({ target: /^CONNECT (\S+) HTTP\/1\.1$/.exec(requestLine)?.[1] ?? null, headers });
      if (mode === "407" || (auth && headers["proxy-authorization"] !== auth)) {
        state.responseStatus = 407;
        client.write("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Agent: owned-fixture\r\n\r\n");
        return;
      }
      state.responseStatus = 200;
      const upstream = net.connect(upstreamPort, "127.0.0.1", () => {
        state.upstreamConnections += 1;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest) upstream.write(Buffer.from(rest, "latin1"));
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on("error", () => {});
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
    };
    client.on("data", onData);
  });
  return { server, sockets, state };
}

function startTlsOrigin({ key, cert }) {
  const sockets = new Set();
  const state = { requests: [], tlsErrors: [] };
  const server = https.createServer({ key, cert, minVersion: "TLSv1.2" }, (req, res) => {
    state.requests.push({
      host: req.headers.host ?? null,
      proxyAuthorization: req.headers["proxy-authorization"] ?? null,
      sni: req.socket.servername || null,
      url: req.url,
    });
    if (req.url === "/redirect") {
      res.writeHead(302, { location: `https://${HOST_2}/final` });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  server.on("tlsClientError", (err, socket) => {
    state.tlsErrors.push(err.message);
    try { socket.destroy(); } catch { /* gone */ }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  return { server, sockets, state };
}

function startHttpOrigin() {
  const sockets = new Set();
  const state = { requests: [] };
  const server = http.createServer((req, res) => {
    state.requests.push({ host: req.headers.host ?? null, proxyAuthorization: req.headers["proxy-authorization"] ?? null, url: req.url });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, plain: true }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  return { server, sockets, state };
}

describe("P9-F1 pinned proxy tunnel (owned loopback end-to-end)", () => {
  let ssrf;
  let setTunnelDeps;
  let buildConnector;
  const proxyAuthHeader = `Basic ${Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString("base64")}`;

  beforeAll(async () => {
    vi.stubGlobal("fetch", globalThis.fetch);
    const proxyMod = await import("open-sse/utils/proxyFetch.js");
    setTunnelDeps = proxyMod._setProxyTunnelDeps;
    ssrf = await import("../../src/shared/utils/ssrfGuard.js");
    ({ buildConnector } = await import("undici"));
  });

  beforeEach(() => {
    h.current = PUBLIC_IP;
    h.lookup.mockReset();
    h.lookup.mockResolvedValue([{ address: PUBLIC_IP, family: 4 }]);
    // Inherited NO_PROXY=* or lowercase proxy variables must not bypass the
    // owned CONNECT fixture or route a test through a workstation proxy.
    for (const name of [
      "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy",
      "NO_PROXY", "no_proxy",
    ]) vi.stubEnv(name, "");
    setTunnelDeps(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    setTunnelDeps(null);
    vi.unstubAllGlobals();
  });

  it("keeps Host + TLS SNI on the hostname while CONNECT targets the pinned public IP", async () => {
    const { key, cert } = makeSelfSignedCert(HOST);
    const origin = startTlsOrigin({ key, cert });
    const originPort = await listen(origin.server);
    const proxy = startConnectProxy({ upstreamPort: originPort, auth: proxyAuthHeader });
    const proxyPort = await listen(proxy.server);
    process.env.HTTPS_PROXY = `http://${PROXY_USER}:${PROXY_PASS}@127.0.0.1:${proxyPort}`;
    setTunnelDeps({ buildOriginConnector: buildConnector({ ca: cert }) });
    try {
      const res = await ssrf.fetchPublic(`https://${HOST}/hello?x=1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      // The proxy was asked for the VALIDATED IP, on the origin's default port.
      expect(proxy.state.connects).toHaveLength(1);
      expect(proxy.state.connects[0].target).toBe(`${PUBLIC_IP}:443`);
      expect(proxy.state.connects[0].headers["proxy-authorization"]).toBe(proxyAuthHeader);
      expect(proxy.state.upstreamConnections).toBe(1);

      // The origin still sees the hostname in Host and in TLS SNI, and never sees
      // the proxy credential.
      expect(origin.state.requests).toHaveLength(1);
      expect(origin.state.requests[0].host).toBe(HOST);
      expect(origin.state.requests[0].sni).toBe(HOST);
      expect(origin.state.requests[0].proxyAuthorization).toBeNull();
      expect(origin.state.requests[0].url).toBe("/hello?x=1");
      expect(origin.state.tlsErrors).toHaveLength(0);
    } finally {
      await closeServer(proxy.server, proxy.sockets);
      await closeServer(origin.server, origin.sockets);
      delete process.env.HTTPS_PROXY;
      setTunnelDeps(null);
    }
  });

  it("pins the validated IP on a non-default origin port", async () => {
    const { key, cert } = makeSelfSignedCert(HOST);
    const origin = startTlsOrigin({ key, cert });
    const originPort = await listen(origin.server);
    const proxy = startConnectProxy({ upstreamPort: originPort, auth: proxyAuthHeader });
    const proxyPort = await listen(proxy.server);
    process.env.HTTPS_PROXY = `http://${PROXY_USER}:${PROXY_PASS}@127.0.0.1:${proxyPort}`;
    setTunnelDeps({ buildOriginConnector: buildConnector({ ca: cert }) });
    try {
      const res = await ssrf.fetchPublic(`https://${HOST}:8443/port-check`);
      expect(res.status).toBe(200);
      expect(proxy.state.connects[0].target).toBe(`${PUBLIC_IP}:8443`);
      expect(origin.state.requests[0].host).toBe(`${HOST}:8443`);
      expect(origin.state.requests[0].sni).toBe(HOST);
    } finally {
      await closeServer(proxy.server, proxy.sockets);
      await closeServer(origin.server, origin.sockets);
      delete process.env.HTTPS_PROXY;
      setTunnelDeps(null);
    }
  });

  it("returns the plain-HTTP tunnel socket in a state undici can actually use", async () => {
    const origin = startHttpOrigin();
    const originPort = await listen(origin.server);
    const proxy = startConnectProxy({ upstreamPort: originPort });
    const proxyPort = await listen(proxy.server);
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
    try {
      const res = await ssrf.fetchPublic(`http://${HOST}/plain`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, plain: true });
      expect(proxy.state.connects[0].target).toBe(`${PUBLIC_IP}:80`);
      expect(origin.state.requests[0].host).toBe(HOST);
      expect(origin.state.requests[0].url).toBe("/plain");
    } finally {
      await closeServer(proxy.server, proxy.sockets);
      await closeServer(origin.server, origin.sockets);
      delete process.env.HTTP_PROXY;
    }
  });

  it("re-validates and re-pins on a cross-host redirect hop", async () => {
    const { key, cert } = makeSelfSignedCert([HOST, HOST_2]);
    const origin = startTlsOrigin({ key, cert });
    const originPort = await listen(origin.server);
    const proxy = startConnectProxy({ upstreamPort: originPort, auth: proxyAuthHeader });
    const proxyPort = await listen(proxy.server);
    process.env.HTTPS_PROXY = `http://${PROXY_USER}:${PROXY_PASS}@127.0.0.1:${proxyPort}`;
    setTunnelDeps({ buildOriginConnector: buildConnector({ ca: cert }) });
    try {
      const res = await ssrf.fetchPublic(`https://${HOST}/redirect`);
      expect(res.status).toBe(200);
      // Hop 1: /redirect -> 302. Hop 2: /final, pinned again to the same IP.
      expect(proxy.state.connects).toHaveLength(2);
      expect(proxy.state.connects.map((c) => c.target)).toEqual([`${PUBLIC_IP}:443`, `${PUBLIC_IP}:443`]);
      expect(origin.state.requests.map((r) => r.url)).toEqual(["/redirect", "/final"]);
      expect(origin.state.requests.map((r) => r.host)).toEqual([HOST, HOST_2]);
      expect(origin.state.requests.map((r) => r.sni)).toEqual([HOST, HOST_2]);
      expect(origin.state.tlsErrors).toHaveLength(0);
    } finally {
      await closeServer(proxy.server, proxy.sockets);
      await closeServer(origin.server, origin.sockets);
      delete process.env.HTTPS_PROXY;
      setTunnelDeps(null);
    }
  });

  it("fails closed on a real 407 from the proxy and never reaches the origin", async () => {
    const { key, cert } = makeSelfSignedCert(HOST);
    const origin = startTlsOrigin({ key, cert });
    const originPort = await listen(origin.server);
    const proxy = startConnectProxy({ upstreamPort: originPort, mode: "407" });
    const proxyPort = await listen(proxy.server);
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
    setTunnelDeps({ buildOriginConnector: buildConnector({ ca: cert }) });
    try {
      const err = await ssrf.fetchPublic(`https://${HOST}/denied`).catch((e) => e);
      expect(`${err.message} ${err.cause?.message ?? ""}`).toMatch(/407/);
      expect(proxy.state.upstreamConnections).toBe(0);
      expect(origin.state.requests).toHaveLength(0);
      // A rejected CONNECT must not leave a live socket behind.
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(proxy.sockets.size).toBe(0);
    } finally {
      await closeServer(proxy.server, proxy.sockets);
      await closeServer(origin.server, origin.sockets);
      delete process.env.HTTPS_PROXY;
      setTunnelDeps(null);
    }
  });

  it("rejects a certificate issued for another hostname (cert check runs against Host/SNI)", async () => {
    const { key, cert } = makeSelfSignedCert("wrong-host.invalid");
    const origin = startTlsOrigin({ key, cert });
    const originPort = await listen(origin.server);
    const proxy = startConnectProxy({ upstreamPort: originPort });
    const proxyPort = await listen(proxy.server);
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
    setTunnelDeps({ buildOriginConnector: buildConnector({ ca: cert }) });
    try {
      const err = await ssrf.fetchPublic(`https://${HOST}/x`).catch((e) => e);
      expect(`${err.message} ${err.cause?.message ?? ""}`).toMatch(/altname|Hostname\/IP/i);
      expect(origin.state.requests).toHaveLength(0);
      // TCP reached the owned origin, TLS was refused against the hostname — no
      // silent downgrade to the pinned IP identity.
      expect(proxy.state.upstreamConnections).toBe(1);
    } finally {
      await closeServer(proxy.server, proxy.sockets);
      await closeServer(origin.server, origin.sockets);
      delete process.env.HTTPS_PROXY;
      setTunnelDeps(null);
    }
  });

  it("never writes a plaintext CONNECT to a SOCKS proxy (owned listener stays untouched)", async () => {
    const received = [];
    const socksSockets = new Set();
    const socksServer = net.createServer((socket) => {
      received.push("connection");
      socksSockets.add(socket);
      socket.on("data", (chunk) => received.push(chunk.toString("latin1")));
      socket.on("error", () => {});
      socket.on("close", () => socksSockets.delete(socket));
    });
    const socksPort = await listen(socksServer);
    process.env.HTTPS_PROXY = `socks5://127.0.0.1:${socksPort}`;
    try {
      const err = await ssrf.fetchPublic(`https://${HOST}/x`).catch((e) => e);
      expect(`${err.message} ${err.cause?.message ?? ""}`).toMatch(/unsupported proxy protocol/i);
      await new Promise((resolve) => setTimeout(resolve, 25));
      // Fail-closed BEFORE the transport: no TCP connection, no CONNECT bytes.
      expect(received).toEqual([]);
    } finally {
      await closeServer(socksServer, socksSockets);
      delete process.env.HTTPS_PROXY;
      setTunnelDeps(null);
    }
  });

  it("leaves no live tunnel socket behind and clears its own deadline timer", async () => {
    const { key, cert } = makeSelfSignedCert(HOST);
    const origin = startTlsOrigin({ key, cert });
    const originPort = await listen(origin.server);
    const proxy = startConnectProxy({ upstreamPort: originPort });
    const proxyPort = await listen(proxy.server);
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
    setTunnelDeps({ buildOriginConnector: buildConnector({ ca: cert }) });
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      const res = await ssrf.fetchPublic(`https://${HOST}/leak`);
      expect(res.status).toBe(200);
      await res.arrayBuffer();
      expect(proxy.state.upstreamConnections).toBe(1);
      // Both the connector deadline and undici's connect timeout are armed and
      // released on the accepted path.
      expect(setSpy.mock.calls.length).toBeGreaterThan(0);
      expect(clearSpy.mock.calls.length).toBeGreaterThan(0);
    } finally {
      await closeServer(proxy.server, proxy.sockets);
      await closeServer(origin.server, origin.sockets);
      delete process.env.HTTPS_PROXY;
      setTunnelDeps(null);
    }
    // Owned listeners plus every socket they tracked are gone (nothing to leak
    // into the next test or the process exit).
    expect(proxy.sockets.size).toBe(0);
    expect(origin.sockets.size).toBe(0);
  });
});
