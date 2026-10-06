// Pass9 handler fixes — the three generated relay artifacts, executed offline.
//
// What this suite proves (not a `contains`-string check): each deploy route is
// called with its platform API mocked, the relay source it *would actually
// deploy* is captured out of the request payload, evaluated in a `node:vm`
// sandbox with platform bindings (global fetch / Deno.serve / edge handler) and
// then driven with real requests:
//
//   * a supported public target succeeds and is forwarded verbatim (no silent
//     brand or path rewriting), with credentials reaching only that hop;
//   * loopback / private / link-local / multicast / userinfo / non-http(s) /
//     malformed targets are rejected with the pinned 400 body and zero upstream
//     fetches, so nothing (credentials included) leaves the relay;
//   * the pinned guard's two documented limitations are asserted as behavior:
//     it is literal-only (a public name resolving to loopback still passes) and
//     its `fc`/`fd` IPv6 prefix test also catches hostnames with that prefix.
//
// No network, no platform API, no deploy, no process, no DB.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import vm from "node:vm";

const mocks = vi.hoisted(() => ({
  createProxyPool: vi.fn(async (input) => ({ id: "pool-new", ...input })),
}));

vi.mock("@/models", () => ({ createProxyPool: mocks.createProxyPool }));

const { POST: cloudflareDeploy } = await import("@/app/api/proxy-pools/cloudflare-deploy/route.js");
const { POST: denoDeploy } = await import("@/app/api/proxy-pools/deno-deploy/route.js");
const { POST: vercelDeploy } = await import("@/app/api/proxy-pools/vercel-deploy/route.js");

const jsonPost = (url, body) => new Request(url, { method: "POST", body: JSON.stringify(body) });

/**
 * Deploy-phase fetch stub: records calls, answers by matcher, throws on
 * anything unexpected so a test cannot silently skip the capture step.
 */
function deployFetch(routes) {
  const calls = [];
  const spy = vi.fn(async (input, init = {}) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    calls.push({ url, init });
    const route = routes.find((r) => r.match(url, init));
    if (!route) throw new Error(`unexpected deploy-phase fetch: ${url}`);
    return route.respond(url, init);
  });
  spy.calls = calls;
  return spy;
}

const ok = (payload) =>
  new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });

/** Cloudflare: PUT worker script (multipart) -> enable subdomain -> read subdomain. */
async function buildCloudflareArtifact() {
  const spy = deployFetch([
    {
      match: (url) => url.includes("/workers/scripts/"),
      respond: () => ok({ success: true }),
    },
    {
      match: (url) => url.endsWith("/subdomain") && url.includes("/workers/scripts/"),
      respond: () => ok({ success: true }),
    },
    {
      match: (url) => url.endsWith("/workers/subdomain"),
      respond: () => ok({ result: { subdomain: "acct" } }),
    },
  ]);
  vi.stubGlobal("fetch", spy);
  const res = await cloudflareDeploy(
    jsonPost("http://localhost/api/proxy-pools/cloudflare-deploy", {
      accountId: "acct-1",
      apiToken: "FAKE-CF-TOKEN",
      projectName: "relay-cf",
    }),
  );
  expect(res.status).toBe(201);
  const upload = spy.calls.find((c) => c.url.includes("/workers/scripts/"));
  const form = upload.init.body;
  const source = await form.get("index.js").text();
  expect(source).toContain("assertTrustedTarget");
  return source;
}

/** Deno: POST /apps -> POST /apps/{id}/deploy (assets["main.ts"].content). */
async function buildDenoArtifact() {
  const spy = deployFetch([
    { match: (url) => url.endsWith("/apps"), respond: () => ok({ id: "app-1" }) },
    { match: (url) => url.endsWith("/apps/app-1/deploy"), respond: () => ok({ id: "rev-1", status: "succeeded" }) },
  ]);
  vi.stubGlobal("fetch", spy);
  const res = await denoDeploy(
    jsonPost("http://localhost/api/proxy-pools/deno-deploy", {
      denoToken: "FAKE-DENO-TOKEN",
      orgDomain: "org.deno.net",
      projectName: "relay-deno",
    }),
  );
  expect(res.status).toBe(201);
  const deploy = spy.calls.find((c) => c.url.endsWith("/apps/app-1/deploy"));
  const payload = JSON.parse(deploy.init.body);
  const source = payload.assets["main.ts"].content;
  expect(source).toContain("assertTrustedTarget");
  return source;
}

/** Vercel: POST /v13/deployments (files[].data) -> PATCH project -> poll ready. */
async function buildVercelArtifact() {
  const spy = deployFetch([
    {
      match: (url, init) => url.endsWith("/v13/deployments") && init.method === "POST",
      respond: () => ok({ id: "dep-1", projectId: "proj-1", url: "relay-vercel.vercel.app" }),
    },
    { match: (url) => url.includes("/v9/projects/"), respond: () => ok({}) },
    {
      match: (url) => url.includes("/v13/deployments/dep-1"),
      respond: () => ok({ readyState: "READY", url: "relay-vercel.vercel.app" }),
    },
  ]);
  vi.stubGlobal("fetch", spy);
  const res = await vercelDeploy(
    jsonPost("http://localhost/api/proxy-pools/vercel-deploy", {
      vercelToken: "FAKE-VERCEL-TOKEN",
      projectName: "relay-vercel",
    }),
  );
  expect(res.status).toBe(201);
  const deploy = spy.calls.find((c) => c.url.endsWith("/v13/deployments") && c.init.method === "POST");
  const payload = JSON.parse(deploy.init.body);
  const source = payload.files.find((f) => f.file === "api/relay.js").data;
  expect(source).toContain("assertTrustedTarget");
  return source;
}

/**
 * Evaluate a deployed relay artifact in an isolated vm context and return the
 * entry point plus the upstream fetch spy the artifact will use.
 */
function evaluateArtifact(kind, source) {
  const upstream = vi.fn(async () => new Response("upstream-body", { status: 200 }));
  let code = source;
  const sandbox = {
    fetch: (...args) => upstream(...args),
    Response,
    Headers,
    Request,
    URL,
    URLSearchParams,
    console,
    TextEncoder,
    TextDecoder,
    ReadableStream,
    AbortController,
    queueMicrotask,
    setTimeout,
    clearTimeout,
  };

  if (kind === "cloudflare") {
    if (!code.includes("export default {")) throw new Error("cloudflare artifact shape changed");
    code = code.replace("export default {", "globalThis.__relay = {");
  } else if (kind === "vercel") {
    if (!code.includes("export const config")) throw new Error("vercel artifact shape changed");
    if (!code.includes("export default async function handler(req) {")) throw new Error("vercel handler shape changed");
    code = code.replace("export const config", "const config");
    code = code.replace("export default async function handler(req) {", "globalThis.__relay = async function handler(req) {");
  } else if (kind === "deno") {
    sandbox.Deno = { serve: (handler) => { sandbox.__relay = handler; } };
  }

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: `${kind}-relay.js` });
  if (typeof sandbox.__relay !== "function" && typeof sandbox.__relay !== "object") {
    throw new Error(`${kind} relay entrypoint not captured`);
  }
  return { entry: sandbox.__relay, upstream };
}

async function invoke(kind, entry, request) {
  if (kind === "cloudflare") return entry.fetch(request, {}, {});
  return entry(request);
}

const relayRequest = ({ target, path = "/v1/models", headers = {} }) =>
  new Request("https://relay.example.workers.dev/", {
    method: "GET",
    headers: {
      ...(target ? { "x-relay-target": target } : {}),
      ...(path ? { "x-relay-path": path } : {}),
      ...headers,
    },
  });

const KINDS = ["cloudflare", "deno", "vercel"];
const BUILDERS = {
  cloudflare: buildCloudflareArtifact,
  deno: buildDenoArtifact,
  vercel: buildVercelArtifact,
};

beforeEach(() => {
  mocks.createProxyPool.mockImplementation(async (input) => ({ id: "pool-new", ...input }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(KINDS)("generated %s relay artifact", (kind) => {
  let entry;
  let upstream;
  let source;

  beforeEach(async () => {
    source = await BUILDERS[kind]();
    ({ entry, upstream } = evaluateArtifact(kind, source));
  });

  it("forwards a supported public target verbatim and keeps credentials on that hop only", async () => {
    const res = await invoke(
      kind,
      entry,
      relayRequest({
        target: "https://api.openai.com",
        path: "/v1/models",
        headers: { authorization: "Bearer FAKE-UPSTREAM-KEY", "x-api-key": "FAKE-X-API-KEY" },
      }),
    );

    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/models");
    const forwarded = new Headers(init.headers);
    expect(forwarded.get("authorization")).toBe("Bearer FAKE-UPSTREAM-KEY");
    expect(forwarded.get("x-api-key")).toBe("FAKE-X-API-KEY");
    // Relay control headers and the caller's Host must not reach the target hop.
    expect(forwarded.get("x-relay-target")).toBeNull();
    expect(forwarded.get("x-relay-path")).toBeNull();
    expect(forwarded.get("host")).toBeNull();
  });

  it("normalizes trailing-slash base and bare path (pin semantics)", async () => {
    await invoke(kind, entry, relayRequest({ target: "https://api.openai.com/", path: "v1/models" }));
    expect(upstream.mock.calls[0][0]).toBe("https://api.openai.com/v1/models");
  });

  it("does not rewrite the target host, even when it carries a router brand name", async () => {
    const target = "https://9router-upstream.example.com";
    await invoke(kind, entry, relayRequest({ target, path: "/ok" }));
    expect(upstream.mock.calls[0][0]).toBe("https://9router-upstream.example.com/ok");
    // The embedded guard is the pinned source verbatim — its message strings are
    // untouched by any brand substitution.
    expect(source).toContain("function assertTrustedTarget(rawUrl)");
    expect(source).toContain("Blocked URL: unsupported target");
    expect(source).toContain("Blocked URL: private IP");
    expect(source).toContain("[4026531840, 4]");
  });

  it("rejects a request without x-relay-target and never fetches", async () => {
    const res = await invoke(kind, entry, relayRequest({ target: null }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing x-relay-target header" });
    expect(upstream).not.toHaveBeenCalled();
  });

  const REJECTED = [
    ["loopback IPv4", "http://127.0.0.1:8080/x", "Blocked URL: private IP"],
    ["loopback alias", "http://127.42.0.1/", "Blocked URL: private IP"],
    ["localhost name", "http://localhost/", "Blocked URL: internal host"],
    ["private 10/8", "http://10.11.12.13/", "Blocked URL: private IP"],
    ["private 172.16/12", "http://172.20.5.5/", "Blocked URL: private IP"],
    ["private 192.168/16", "http://192.168.1.1/", "Blocked URL: private IP"],
    ["link-local metadata", "http://169.254.169.254/latest/meta-data/", "Blocked URL: private IP"],
    ["CGNAT 100.64/10", "http://100.64.0.1/", "Blocked URL: private IP"],
    ["multicast 224/4", "http://224.0.0.1/", "Blocked URL: private IP"],
    ["reserved 240/4", "http://240.1.1.1/", "Blocked URL: private IP"],
    ["this-network 0/8", "http://0.0.0.0/", "Blocked URL: private IP"],
    [".internal suffix", "http://metadata.google.internal/", "Blocked URL: internal host"],
    [".local suffix", "http://service.local/", "Blocked URL: internal host"],
    [".localhost suffix", "http://box.localhost/", "Blocked URL: internal host"],
    ["IPv6 loopback", "http://[::1]/", "Blocked URL: private IP"],
    ["IPv6 unspecified", "http://[::]/", "Blocked URL: private IP"],
    ["IPv6 link-local", "http://[fe80::1]/", "Blocked URL: private IP"],
    ["IPv6 ULA fc00::/7 (fc)", "http://[fc00::1]/", "Blocked URL: private IP"],
    ["IPv6 ULA fc00::/7 (fd)", "http://[fd12::1]/", "Blocked URL: private IP"],
    ["IPv4-mapped IPv6 loopback", "http://[::ffff:127.0.0.1]/", "Blocked URL: private IP"],
    ["file scheme", "file:///etc/passwd", "Blocked URL: unsupported target"],
    ["javascript scheme", "javascript:alert(1)", "Blocked URL: unsupported target"],
    ["embedded credentials", "https://user:pass@example.com/models", "Blocked URL: unsupported target"],
    ["malformed target", "not a URL", "Invalid URL"],
    ["protocol-relative target", "//example.com/path", "Invalid URL"],
  ];

  it.each(REJECTED)("rejects %s with 400 and zero upstream fetches", async (_label, target, expected) => {
    const res = await invoke(kind, entry, relayRequest({ target, path: "/leak" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain(expected);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("documented limitation: the pinned guard is literal-only, so a public name resolving to loopback passes", async () => {
    // Same class of gap the pin ships: no DNS resolution inside the relay, so
    // `127.0.0.1.nip.io` (an A record pointing at loopback) is not rejected.
    // Reported as a limitation in the fix report — never claimed rebind-safe.
    const res = await invoke(kind, entry, relayRequest({ target: "http://127.0.0.1.nip.io", path: "/x" }));
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0][0]).toBe("http://127.0.0.1.nip.io/x");
    expect(res.status).toBe(200);
  });

  it("documented limitation: the IPv6 prefix test also rejects hostnames starting with fc/fd", async () => {
    const res = await invoke(kind, entry, relayRequest({ target: "http://fcm.example.com", path: "/x" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Blocked URL: private IP");
    expect(upstream).not.toHaveBeenCalled();
  });
});
