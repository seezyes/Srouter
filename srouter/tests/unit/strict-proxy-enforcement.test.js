// #4333: "Strict Proxy" did not hold. With a strict pool assigned and every
// proxy in it dead, requests still went out over the direct IP — the exact
// leak the setting exists to prevent.
//
// Two halves, one per layer:
//
// 1. resolveConnectionProxyConfig drops strictProxy whenever the pool is not
//    usable (inactive, or saved with an empty proxyUrl). isValidPool gates the
//    only two returns that carry strictProxy, so an unusable strict pool falls
//    through to the legacy/none branches, which report strictProxy:false.
//
// 2. proxyAwareFetch only honours strictProxy inside the catch of a proxy
//    attempt. When no proxy URL resolves there is nothing to try, so it
//    reaches the trailing `return originalFetch(url, options)` and connects
//    directly.
import { createServer } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/models", () => ({
  getProxyPoolById: vi.fn(),
}));

const { getProxyPoolById } = await import("@/models");
const { resolveConnectionProxyConfig } = await import("../../src/lib/network/connectionProxy.js");
vi.stubGlobal("fetch", globalThis.fetch);
const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

const PROXY_ENV_NAMES = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
  "NO_PROXY", "no_proxy",
];
let origin;
let proxy;
let originUrl;
let proxyUrl;
let originRequests = [];
let proxyConnects = [];

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

beforeAll(async () => {
  // Both endpoints belong to this suite. No public DNS, credentials or
  // workstation proxy is needed to prove whether direct egress is allowed.
  origin = createServer((req, res) => {
    originRequests.push({ method: req.method, url: req.url });
    req.resume();
    res.end("owned origin");
  });
  proxy = createServer((_req, res) => {
    res.writeHead(502);
    res.end();
  });
  proxy.on("connect", (req, socket) => {
    proxyConnects.push(req.url);
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  originUrl = await listen(origin);
  proxyUrl = await listen(proxy);
});

beforeEach(() => {
  for (const name of PROXY_ENV_NAMES) vi.stubEnv(name, "");
  originRequests = [];
  proxyConnects = [];
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  try {
    await Promise.all([close(origin), close(proxy)]);
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("strict pool keeps strictProxy when the pool is unusable (#4333)", () => {
  it("keeps strictProxy for an inactive strict pool", async () => {
    getProxyPoolById.mockResolvedValue({
      id: "p1", isActive: false, proxyUrl: "http://127.0.0.1:7890", strictProxy: true,
    });
    const cfg = await resolveConnectionProxyConfig({ proxyPoolId: "p1" });
    expect(cfg.strictProxy).toBe(true);
  });

  it("keeps strictProxy for a strict pool saved without a proxy url", async () => {
    getProxyPoolById.mockResolvedValue({
      id: "p2", isActive: true, proxyUrl: "", strictProxy: true,
    });
    const cfg = await resolveConnectionProxyConfig({ proxyPoolId: "p2" });
    expect(cfg.strictProxy).toBe(true);
  });

  it("still reports strictProxy:false for a non-strict pool", async () => {
    getProxyPoolById.mockResolvedValue({
      id: "p3", isActive: false, proxyUrl: "http://127.0.0.1:7890", strictProxy: false,
    });
    const cfg = await resolveConnectionProxyConfig({ proxyPoolId: "p3" });
    expect(cfg.strictProxy).toBe(false);
  });

  it("still reports strictProxy:false when no pool is assigned", async () => {
    const cfg = await resolveConnectionProxyConfig({});
    expect(cfg.strictProxy).toBe(false);
  });
});

describe("strictProxy refuses a direct connection (#4333)", () => {
  it("throws when a pool is assigned but no proxy url resolved", async () => {
    await expect(
      proxyAwareFetch("https://api.example.com/v1/chat", {}, { proxyPoolId: "p1", strictProxy: true }),
    ).rejects.toThrow(/strictProxy/);
  });

  it("throws when the pool is enabled but carries an empty url", async () => {
    await expect(
      proxyAwareFetch("https://api.example.com/v1/chat", {}, { enabled: true, url: "", strictProxy: true }),
    ).rejects.toThrow(/strictProxy/);
  });

  it("does not block a caller that sets strictProxy with no proxy configured", async () => {
    // The Qoder executor passes strictProxy:true to mean "do not replay this
    // request directly if the proxy fails" — a replayed COSY signature gets a
    // 403. With nothing configured it must still reach the owned origin.
    const response = await proxyAwareFetch(
      `${originUrl}/v1/chat`, { signal: AbortSignal.timeout(2000) }, { strictProxy: true },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("owned origin");
    expect(originRequests).toEqual([{ method: "GET", url: "/v1/chat" }]);
  });

  it("does not block a request when strictProxy is off", async () => {
    const response = await proxyAwareFetch(
      `${originUrl}/v1/chat`, { signal: AbortSignal.timeout(2000) }, { strictProxy: false },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("owned origin");
    expect(originRequests).toEqual([{ method: "GET", url: "/v1/chat" }]);
  });

  it("does not replay a strict POST directly when the owned proxy refuses CONNECT", async () => {
    await expect(proxyAwareFetch(
      `${originUrl}/v1/chat`,
      { method: "POST", body: "synthetic request", signal: AbortSignal.timeout(2000) },
      { enabled: true, url: proxyUrl, strictProxy: true },
    )).rejects.toThrow(/Proxy required but failed \(strictProxy=true\)/);
    expect(proxyConnects).toEqual([new URL(originUrl).host]);
    expect(originRequests).toEqual([]);
  });

  it("refuses a required proxy excluded by noProxy rather than sending directly", async () => {
    await expect(proxyAwareFetch(
      `${originUrl}/v1/chat`, { signal: AbortSignal.timeout(2000) },
      { enabled: true, url: proxyUrl, noProxy: "127.0.0.1", strictProxy: true },
    )).rejects.toThrow(/Proxy required but none resolved \(strictProxy=true\)/);
    expect(proxyConnects).toEqual([]);
    expect(originRequests).toEqual([]);
  });
});
