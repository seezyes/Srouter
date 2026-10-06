import { Readable } from "stream";
import net from "node:net";
import tls from "node:tls";
import { MEMORY_CONFIG, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { dbg } from "./debugLog.js";

const originalFetch = globalThis.fetch;
const proxyDispatchers = new Map();

// Same well-known key as src/shared/utils/ssrfGuard.js PINNED_DISPATCHER. A
// dispatcher carrying it has already bound a validated IP; a proxy/relay cannot
// preserve that binding and must not silently replace it.
const PINNED_DISPATCHER = Symbol.for("srouter.ssrf.pinned-target");

// ─── TLS fingerprinting via got-scraping (browser-like JA3) ───────────────
// Disabled: not in use. Kept commented for future re-enable.
// Restore the original block to re-enable per-host JA3 spoofing.
/*
let _gotScraping = null;
let _gotScrapingChecked = false;
const _gotScrapingLoggedHosts = new Set();

async function getGotScraping() {
  if (_gotScrapingChecked) return _gotScraping;
  _gotScrapingChecked = true;
  try {
    const mod = await import("got-scraping");
    _gotScraping = typeof mod.gotScraping === "function" ? mod.gotScraping : null;
    if (_gotScraping) dbg("TLS", "got-scraping loaded (browser-like JA3 enabled)");
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping unavailable, falling back to native fetch: ${e.message}`);
    _gotScraping = null;
  }
  return _gotScraping;
}

async function gotScrapingFetch(url, options) {
  const gs = await getGotScraping();
  if (!gs) return null;

  const method = (options.method || "GET").toUpperCase();
  const headersInit = options.headers || {};
  const headers = headersInit instanceof Headers
    ? Object.fromEntries(headersInit.entries())
    : { ...headersInit };

  return new Promise((resolve, reject) => {
    let settled = false;
    const stream = gs.stream({
      url,
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : options.body,
      throwHttpErrors: false,
      retry: { limit: 0 },
      timeout: { request: undefined },
      followRedirect: false,
      decompress: true,
    });

    if (options.signal) {
      const onAbort = () => { try { stream.destroy(new Error("aborted")); } catch { } };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    stream.once("response", (res) => {
      if (settled) return;
      settled = true;
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers || {})) {
        if (Array.isArray(v)) v.forEach((x) => resHeaders.append(k, String(x)));
        else if (v != null) resHeaders.set(k, String(v));
      }
      const body = Readable.toWeb(stream);
      resolve(new Response(body, { status: res.statusCode, statusText: res.statusMessage || "", headers: resHeaders }));
    });

    stream.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function tryGotScrapingFetch(url, options) {
  try {
    const res = await gotScrapingFetch(url, options);
    if (res) {
      try {
        const host = new URL(typeof url === "string" ? url : url.toString()).hostname;
        if (!_gotScrapingLoggedHosts.has(host)) {
          _gotScrapingLoggedHosts.add(host);
          dbg("TLS", `using got-scraping for ${host}`);
        }
      } catch { }
    }
    return res;
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping request failed, fallback to native fetch: ${e.message}`);
    return null;
  }
}
*/

// DNS cache — use Map to avoid prototype pollution via malformed hostnames
const DNS_CACHE = new Map();
const MITM_BYPASS_HOSTS = [
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "api.individual.githubcopilot.com",
  "q.us-east-1.amazonaws.com",
  "codewhisperer.us-east-1.amazonaws.com",
  "api2.cursor.sh",
];
const GOOGLE_DNS_SERVERS = ["8.8.8.8", "8.8.4.4"];
const HTTPS_PORT = 443;
const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX = 300;

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/**
 * Resolve real IP using Google DNS (bypass system DNS)
 */
async function resolveRealIP(hostname) {
  const cached = DNS_CACHE.get(hostname);
  if (cached && Date.now() < cached.expiry) return cached.ip;

  try {
    const dns = await import("dns");
    const { promisify } = await import("util");
    const resolver = new dns.Resolver();
    resolver.setServers(GOOGLE_DNS_SERVERS);
    const resolve4 = promisify(resolver.resolve4.bind(resolver));
    const addresses = await resolve4(hostname);
    DNS_CACHE.set(hostname, { ip: addresses[0], expiry: Date.now() + MEMORY_CONFIG.dnsCacheTtlMs });
    return addresses[0];
  } catch (error) {
    console.warn(`[ProxyFetch] DNS resolve failed for ${hostname}:`, error.message);
    return null;
  }
}

/**
 * Check if request should bypass MITM DNS redirect
 */
function shouldBypassMitmDns(url) {
  try {
    const hostname = new URL(url).hostname;
    return MITM_BYPASS_HOSTS.some(host => hostname.includes(host));
  } catch { return false; }
}

function shouldBypassByNoProxy(targetUrl, noProxyValue) {
  const noProxy = normalizeString(noProxyValue);
  if (!noProxy) return false;

  let hostname;
  try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch { return false; }
  const patterns = noProxy.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);

  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  });
}

/**
 * Get proxy URL from environment
 */
function getEnvProxyUrl(targetUrl) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  let protocol;
  try { protocol = new URL(targetUrl).protocol; } catch { return null; }

  if (protocol === "https:") {
    return process.env.HTTPS_PROXY || process.env.https_proxy ||
      process.env.ALL_PROXY || process.env.all_proxy;
  }

  return process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy;
}

/**
 * Normalize proxy URL (allow host:port)
 */
function normalizeProxyUrl(proxyUrl) {
  const normalizedInput = normalizeString(proxyUrl);
  if (!normalizedInput) return null;

  try {

    new URL(normalizedInput);
    return normalizedInput;
  } catch {
    // Allow "127.0.0.1:7890" style values
    return `http://${normalizedInput}`;
  }
}

function resolveConnectionProxyUrl(targetUrl, proxyOptions) {
  const enabled = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true;
  if (!enabled) return null;

  const proxyUrlRaw = normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl);
  if (!proxyUrlRaw) return null;

  const noProxy = normalizeString(proxyOptions?.noProxy ?? proxyOptions?.connectionNoProxy);
  if (noProxy && shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  return normalizeProxyUrl(proxyUrlRaw);
}

/**
 * Create proxy dispatcher lazily (undici-compatible)
 */
async function getDispatcher(proxyUrl) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return null;

  if (!proxyDispatchers.has(normalized)) {
    // Evict oldest entry if max size reached
    if (proxyDispatchers.size >= MEMORY_CONFIG.proxyDispatchersMaxSize) {
      proxyDispatchers.delete(proxyDispatchers.keys().next().value);
    }
    const { ProxyAgent } = await import("undici");
    proxyDispatchers.set(normalized, new ProxyAgent({ uri: normalized }));
  }

  return proxyDispatchers.get(normalized);
}

/**
 * Create HTTPS request with manual socket connection (bypass DNS)
 */
async function createBypassRequest(parsedUrl, realIP, options) {
  const httpsModule = await import("https");
  const netModule = await import("net");
  // CJS modules expose exports via .default in ESM dynamic import context
  const https = httpsModule.default ?? httpsModule;
  const net = netModule.default ?? netModule;

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();

    socket.connect(HTTPS_PORT, realIP, () => {
      const reqOptions = {
        socket,
        // SNI + cert hostname are validated against the hostname the caller
        // asked for, not the IP we connected to. This keeps the DNS-bypass
        // (avoiding /etc/hosts MITM) while still rejecting on-path attackers
        // that present a different cert. The MITM_BYPASS_HOSTS targets are
        // all public-CA-issued (Google / GitHub / AWS / Cursor) so default
        // verification works without any extra trust store.
        servername: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || "POST",
        headers: {
          ...options.headers,
          Host: parsedUrl.hostname,
        },
      };

      const req = https.request(reqOptions, (res) => {
        const response = {
          ok: res.statusCode >= HTTP_SUCCESS_MIN && res.statusCode < HTTP_SUCCESS_MAX,
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: new Map(Object.entries(res.headers)),
          body: Readable.toWeb(res),
          text: async () => {
            const chunks = [];
            for await (const chunk of res) chunks.push(chunk);
            return Buffer.concat(chunks).toString();
          },
          json: async () => JSON.parse(await response.text()),
        };
        resolve(response);
      });

      req.on("error", reject);
      if (options.body) {
        req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });

    socket.on("error", reject);
  });
}

// ─── Pinned proxy transport (SSRF-guarded requests through a proxy) ───────
//
// A guarded request (src/shared/utils/ssrfGuard fetchPublic) has already
// validated a specific public IP and pinned it into options.dispatcher. When a
// proxy is configured the pin must be preserved THROUGH the proxy without losing
// the origin identity.
//
// Why not ProxyAgent with a URL rewritten to the IP: undici fetch strips any
// caller-supplied Host header (lib/web/fetch/index.js deletes 'host'), and
// ProxyAgent derives the CONNECT target from the request URL host
// (lib/dispatcher/proxy-agent.js `requestedPath = opts.host`). So rewriting the
// URL to the IP would connect to the validated IP but send Host=<ip>, and
// requestTls.servername would only fix TLS SNI — breaking virtual-hosted
// origins. Keeping the origin as the hostname and overriding ONLY the tunnel
// target keeps Host, TLS SNI and certificate verification all on the hostname.
//
// The connector below tunnels through the proxy to the pinned IP and upgrades the
// tunnel socket to TLS via undici's own buildConnector, so certificate
// verification runs against `opts.servername` (the hostname), never the IP.

const pinnedProxyAgents = new Map();

const noop = () => {};

// Hard upper bound for the CONNECT response header block. A broken or hostile
// proxy must not be able to grow the receive buffer without limit before it
// sends the CRLFCRLF terminator.
export const MAX_CONNECT_HEADER_BYTES = 16 * 1024;

// Only HTTP(S) proxies speak the HTTP CONNECT tunnel implemented here. SOCKS*
// is a different protocol: a plaintext CONNECT request must never be written to
// a SOCKS listener, so those configurations fail closed before any byte is sent.
const SUPPORTED_PROXY_PROTOCOLS = new Set(["http:", "https:"]);

// Test-only seam: lets deterministic tests inject fake net/tls sockets and a fake
// origin-TLS connector without opening real connections. Never set in production.
let _proxyTunnelDeps = null;
export function _setProxyTunnelDeps(deps) { _proxyTunnelDeps = deps || null; }

function formatConnectAuthority(address, port) {
  const host = String(address).includes(":") ? `[${address}]` : String(address);
  return `${host}:${port}`;
}

// A URL hostname is bracketed for IPv6 ("[::1]"); net.connect/tls.connect want
// the bare address.
function bareHostname(hostname) {
  const host = String(hostname || "").trim();
  if (!host.startsWith("[")) return host;
  const end = host.indexOf("]");
  return end === -1 ? host.slice(1) : host.slice(1, end);
}

// TLS servername must be a bare DNS name: never "host:port" and never a
// bracketed/bare IP literal (RFC 6066 forbids IP literals in SNI, and a port
// suffix is an invalid SNI value). Returns undefined when no valid name remains;
// undici's buildConnector then falls back to its own host-derived name.
function toTlsServername(value) {
  let name = String(value || "").trim();
  if (!name) return undefined;
  if (name.startsWith("[")) {
    const end = name.indexOf("]");
    name = end === -1 ? name.slice(1) : name.slice(1, end);
  } else {
    const colon = name.lastIndexOf(":");
    // Strip a single trailing ":port", never the colons of a bare IPv6 literal.
    if (colon > 0 && name.indexOf(":") === colon) name = name.slice(0, colon);
  }
  if (!name || name.includes(":") || name.includes("[") || name.includes("]")) return undefined;
  return name;
}

export function createPinnedProxyConnect(proxyUrl, pinned, deps = {}) {
  const proxy = new URL(normalizeProxyUrl(proxyUrl));
  if (!SUPPORTED_PROXY_PROTOCOLS.has(proxy.protocol)) {
    throw new Error(`[ProxyFetch] unsupported proxy protocol for pinned tunnel: ${proxy.protocol.replace(/:$/, "")}`);
  }
  const proxyTls = proxy.protocol === "https:";
  const proxyHost = bareHostname(proxy.hostname);
  const proxyPort = Number(proxy.port) || (proxyTls ? 443 : 80);
  const proxyServername = toTlsServername(proxyHost);
  // Finite tunnel deadline covering proxy TCP/TLS connect AND the CONNECT
  // response, taken from the project's existing fetch connect budget.
  const tunnelTimeoutMs = Number.isFinite(FETCH_CONNECT_TIMEOUT_MS) && FETCH_CONNECT_TIMEOUT_MS > 0
    ? FETCH_CONNECT_TIMEOUT_MS
    : 60 * 1000;
  // Proxy credentials stay on the proxy hop only (CONNECT), never forwarded to
  // the origin and never logged.
  const proxyAuth = (proxy.username || proxy.password)
    ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`
    : null;
  const netConnect = deps.netConnect || ((opts) => net.connect(opts));
  const tlsConnect = deps.tlsConnect || ((opts) => tls.connect(opts));

  return function connect(opts, callback) {
    const originPort = Number(opts.port) || (opts.protocol === "https:" ? 443 : 80);
    const authority = formatConnectAuthority(pinned.address, originPort);
    // Origin TLS identity comes from undici's connection options (derived from
    // the request URL) — never from the request body or arbitrary headers.
    const originServername = toTlsServername(opts.servername)
      || toTlsServername(opts.hostname)
      || toTlsServername(opts.host);
    const signal = opts.signal;
    let settled = false;
    let socket = null;
    let timer = null;
    let onAbort = null;
    let onData = null;
    let onSocketError = null;
    let onSocketClose = null;
    let sendConnect = null;

    // A dead socket must never emit an unhandled 'error' after we release it.
    const destroySocket = (target) => {
      if (!target) return;
      try { target.on("error", noop); } catch { /* not an emitter */ }
      try { target.destroy(); } catch { /* already gone */ }
    };
    const detach = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (signal && onAbort) { try { signal.removeEventListener("abort", onAbort); } catch { /* ignore */ } }
      if (!socket) return;
      if (onSocketError) { try { socket.removeListener("error", onSocketError); } catch { /* ignore */ } }
      if (onSocketClose) { try { socket.removeListener("close", onSocketClose); } catch { /* ignore */ } }
      if (onData) { try { socket.removeListener("data", onData); } catch { /* ignore */ } }
      if (sendConnect) {
        try { socket.removeListener("connect", sendConnect); } catch { /* ignore */ }
        try { socket.removeListener("secureConnect", sendConnect); } catch { /* ignore */ }
      }
    };
    // Exactly one callback invocation per connect(), on every path.
    const settle = (err, result) => {
      if (settled) return;
      settled = true;
      detach();
      callback(err, result);
    };
    const fail = (err) => {
      if (settled) return;
      const doomed = socket;
      settled = true;
      detach();
      destroySocket(doomed);
      callback(err);
    };
    const armTimeout = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fail(new Error(`[ProxyFetch] pinned proxy tunnel to ${authority} timed out after ${tunnelTimeoutMs}ms`)), tunnelTimeoutMs);
      // Never hold the event loop open for a timeout nobody is waiting on.
      if (typeof timer?.unref === "function") timer.unref();
    };

    onAbort = () => fail(new Error("[ProxyFetch] pinned proxy connect aborted"));

    socket = netConnect({ host: proxyHost, port: proxyPort });
    if (proxyTls) socket = tlsConnect({ socket, servername: proxyServername, host: proxyHost });

    onSocketError = (err) => fail(err instanceof Error ? err : new Error(`[ProxyFetch] proxy socket error: ${String(err)}`));
    onSocketClose = () => fail(new Error("[ProxyFetch] proxy closed the connection before CONNECT completed"));
    armTimeout();
    socket.once("error", onSocketError);
    socket.once("close", onSocketClose);
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    sendConnect = () => {
      const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
      if (proxyAuth) lines.push(`Proxy-Authorization: ${proxyAuth}`);
      lines.push("Proxy-Connection: keep-alive", "", "");
      socket.write(lines.join("\r\n"));

      let buf = "";
      onData = (chunk) => {
        buf += chunk.toString("latin1");
        const headerEnd = buf.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          if (buf.length > MAX_CONNECT_HEADER_BYTES) {
            fail(new Error(`[ProxyFetch] proxy CONNECT response headers exceeded ${MAX_CONNECT_HEADER_BYTES} bytes`));
          }
          return;
        }
        if (headerEnd + 4 > MAX_CONNECT_HEADER_BYTES) {
          fail(new Error(`[ProxyFetch] proxy CONNECT response headers exceeded ${MAX_CONNECT_HEADER_BYTES} bytes`));
          return;
        }
        socket.removeListener("data", onData);
        onData = null;
        // Stay paused across the hand-off: undici's dispatcher consumes the
        // tunnel socket through the 'readable' event and socket.read()
        // (client-h1.js), so it resumes on its own and nothing is dropped.
        socket.pause();
        const statusLine = buf.slice(0, buf.indexOf("\r\n"));
        const match = /^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine);
        const status = match ? Number(match[1]) : 0;
        if (status !== 200) {
          fail(new Error(`[ProxyFetch] proxy CONNECT to ${authority} failed (status ${status})`));
          return;
        }
        // Bytes past the header block belong to the tunnel stream: hand them to
        // the next reader instead of dropping them.
        const rest = buf.slice(headerEnd + 4);
        if (rest) { try { socket.unshift(Buffer.from(rest, "latin1")); } catch { /* best effort */ } }
        // Tunnel established. Remaining phases have their own deadlines (undici's
        // buildConnector timeout covers the origin TLS upgrade).
        if (timer) { clearTimeout(timer); timer = null; }
        if (onSocketError) { socket.removeListener("error", onSocketError); onSocketError = null; }
        if (opts.protocol !== "https:") { settle(null, socket); return; }
        try {
          deps.buildOriginConnector(
            { ...opts, protocol: "https:", port: originPort, servername: originServername, httpSocket: socket },
            (err, tlsSocket) => { if (err) fail(err); else settle(null, tlsSocket); }
          );
        } catch (err) { fail(err); }
      };
      socket.on("data", onData);
    };

    if (proxyTls) socket.once("secureConnect", sendConnect);
    else socket.once("connect", sendConnect);
  };
}

async function pinnedProxyAgent(proxyUrl, pinned) {
  const normalized = normalizeProxyUrl(proxyUrl);
  const key = `${normalized}|${pinned.address}|${pinned.family || ""}`;
  const cached = pinnedProxyAgents.get(key);
  if (cached) return cached;
  if (pinnedProxyAgents.size >= MEMORY_CONFIG.proxyDispatchersMaxSize) {
    pinnedProxyAgents.delete(pinnedProxyAgents.keys().next().value);
  }
  const { Agent, buildConnector } = await import("undici");
  const deps = _proxyTunnelDeps;
  const connect = createPinnedProxyConnect(normalized, pinned, {
    netConnect: deps?.netConnect,
    tlsConnect: deps?.tlsConnect,
    buildOriginConnector: deps?.buildOriginConnector || buildConnector({}),
  });
  const agent = new Agent({ connect });
  pinnedProxyAgents.set(key, agent);
  return agent;
}

export async function proxyAwareFetch(url, options = {}, proxyOptions = null) {
  const targetUrl = typeof url === "string" ? url : url.toString();

  const vercelRelayUrl = normalizeString(proxyOptions?.vercelRelayUrl);
  const connectionProxyUrl = resolveConnectionProxyUrl(targetUrl, proxyOptions);
  const envProxyUrl = connectionProxyUrl ? null : normalizeProxyUrl(getEnvProxyUrl(targetUrl));
  const proxyUrl = connectionProxyUrl || envProxyUrl;

  // strictProxy alone also means "no direct replay" for Qoder, not required proxy.
  const proxyIntended = proxyOptions?.proxyPoolId || proxyOptions?.connectionProxyPoolId ||
    proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true ||
    !!normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl);

  // SSRF-guarded request (search path: src/shared/utils/ssrfGuard fetchPublic →
  // global fetch): the guard already validated a public IP and pinned it into
  // options.dispatcher. Preserve that pin THROUGH the configured proxy (custom
  // tunnel-to-validated-IP connector, origin identity kept as the hostname) and
  // never fall back to a direct connection or an unbound proxy hop.
  const pinnedTarget = options.dispatcher?.[PINNED_DISPATCHER];
  if (pinnedTarget) {
    // Vercel relay is opaque (the request is replayed by the relay, which owns
    // DNS/target selection) — no bound-target contract exists, so fail closed.
    if (vercelRelayUrl) {
      throw new Error(`[ProxyFetch] SSRF-guarded request to ${pinnedTarget.host || targetUrl} refused: opaque relay has no bound-target contract`);
    }
    if (proxyUrl) {
      const dispatcher = await pinnedProxyAgent(proxyUrl, pinnedTarget);
      return originalFetch(url, { ...options, dispatcher });
    }
    if (proxyOptions?.strictProxy === true && proxyIntended) {
      throw new Error("[ProxyFetch] Proxy required but none resolved (strictProxy=true)");
    }
    // No proxy involved: the pinned dispatcher passes straight through. This also
    // intentionally skips the /etc/hosts MITM manual-socket bypass below — the
    // pin is the stronger guarantee and avoids an unpinned socket.
    return originalFetch(url, options);
  }

  // Vercel relay: forward request via relay headers
  if (vercelRelayUrl) {
    const parsed = new URL(targetUrl);
    const baseHeaders = options.headers instanceof Headers
      ? Object.fromEntries(options.headers.entries())
      : { ...(options.headers || {}) };
    const relayHeaders = {
      ...baseHeaders,
      "x-relay-target": `${parsed.protocol}//${parsed.host}`,
      "x-relay-path": `${parsed.pathname}${parsed.search}`,
    };
    return originalFetch(vercelRelayUrl, { ...options, headers: relayHeaders });
  }

  if (proxyOptions?.strictProxy === true && proxyIntended && !proxyUrl) {
    throw new Error("[ProxyFetch] Proxy required but none resolved (strictProxy=true)");
  }

  // MITM DNS bypass: for known MITM-intercepted hosts, resolve real IP to avoid DNS spoof
  if (shouldBypassMitmDns(targetUrl)) {
    if (proxyUrl) {
      // Proxy resolves DNS externally (not affected by /etc/hosts) — use proxy directly
      try {
        const dispatcher = await getDispatcher(proxyUrl);
        return await originalFetch(url, { ...options, dispatcher });
      } catch (proxyError) {
        if (proxyOptions?.strictProxy === true) {
          throw new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`);
        }
        console.warn(`[ProxyFetch] Proxy failed, falling back to direct bypass: ${proxyError.message}`);
      }
    }
    // No proxy — manually resolve real IP to bypass DNS spoof
    try {
      const parsedUrl = new URL(targetUrl);
      const realIP = await resolveRealIP(parsedUrl.hostname);
      if (realIP) return await createBypassRequest(parsedUrl, realIP, options);
    } catch (error) {
      console.warn(`[ProxyFetch] MITM bypass failed: ${error.message}`);
    }
  }

  if (proxyUrl) {
    try {
      const dispatcher = await getDispatcher(proxyUrl);
      return await originalFetch(url, { ...options, dispatcher });
    } catch (proxyError) {
      // If strictProxy is enabled, fail hard instead of falling back to direct
      if (proxyOptions?.strictProxy === true) {
        throw new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`);
      }
      console.warn(`[ProxyFetch] Proxy failed, falling back to direct: ${proxyError.message}`);
      return originalFetch(url, options);
    }
  }

  // got-scraping disabled — use native fetch directly
  // (Re-enable per-host by wrapping with tryGotScrapingFetch when needed)
  return originalFetch(url, options);
}

/**
 * Patched global fetch with env-proxy support and MITM DNS bypass
 */
async function patchedFetch(url, options = {}) {
  return proxyAwareFetch(url, options, null);
}

// Idempotency guard — only patch once to avoid wrapping multiple times
if (globalThis.fetch !== patchedFetch) {
  globalThis.fetch = patchedFetch;
}

export default patchedFetch;
