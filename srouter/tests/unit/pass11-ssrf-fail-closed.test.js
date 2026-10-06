import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Offline actual guard -> actual proxy wrapper -> mocked transport. No sockets,
// credentials or DB imports. DATA_DIR is isolated before application imports.
const h = vi.hoisted(() => ({ lookup: vi.fn(), agents: [], transport: vi.fn() }));
vi.mock("node:dns", () => ({
  default: { promises: { lookup: h.lookup } },
  promises: { lookup: h.lookup },
}));

const originalFetch = globalThis.fetch;
const originalDataDir = process.env.DATA_DIR;
const proxyKeys = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];
const originalProxyEnv = Object.fromEntries(proxyKeys.map((key) => [key, process.env[key]]));
let dataDir, guard, proxyAwareFetch;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "srouter-pass11-ssrf-"));
  process.env.DATA_DIR = dataDir;
});

beforeEach(async () => {
  vi.resetModules();
  h.lookup.mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  h.agents.length = 0;
  h.transport.mockReset().mockImplementation(async () => new Response("ok"));
  for (const key of proxyKeys) delete process.env[key];
  vi.doMock("undici", () => ({
    Agent: class {
      constructor(options) {
        this.options = options;
        this.close = vi.fn(() => Promise.resolve());
        h.agents.push(this);
      }
    },
    ProxyAgent: class {
      constructor() { throw new Error("unbound proxy must never be used"); }
    },
    buildConnector: () => () => { throw new Error("socket must never be opened"); },
  }));
  globalThis.fetch = (...args) => h.transport(...args);
  ({ proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js"));
  guard = await import("../../src/shared/utils/ssrfGuard.js");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.doUnmock("undici");
  for (const key of proxyKeys) {
    if (originalProxyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalProxyEnv[key];
  }
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  rmdirSync(dataDir);
});

function routeThrough(options) {
  const wrapper = vi.fn((url, init) => proxyAwareFetch(url, init, options));
  globalThis.fetch = wrapper;
  return wrapper;
}

describe("Pass11 DNS failures stop before any fetch/proxy/relay dispatch", () => {
  const failures = [
    ["lookup rejection", () => h.lookup.mockRejectedValue(new Error("offline DNS failure"))],
    ["empty answers", () => h.lookup.mockResolvedValue([])],
    ["missing answers", () => h.lookup.mockResolvedValue(undefined)],
    ["non-array answers", () => h.lookup.mockResolvedValue({ address: "8.8.8.8", family: 4 })],
    ["null answer", () => h.lookup.mockResolvedValue([null])],
    ["missing address", () => h.lookup.mockResolvedValue([{ family: 4 }])],
    ["invalid IPv4", () => h.lookup.mockResolvedValue([{ address: "999.1.1.1", family: 4 }])],
    ["invalid IPv6", () => h.lookup.mockResolvedValue([{ address: "2001:::1", family: 6 }])],
    ["hostname answer", () => h.lookup.mockResolvedValue([{ address: "other.example", family: 4 }])],
    ["unknown family", () => h.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 0 }])],
    ["family mismatch", () => h.lookup.mockResolvedValue([{ address: "::1", family: 4 }])],
    ["invalid second answer", () => h.lookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 }, { address: "bad", family: 6 },
    ])],
    ["private second answer", () => h.lookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 },
    ])],
  ];
  for (const [name, arrange] of failures) {
    for (const [route, options] of [
      ["direct", null],
      ["strict proxy", { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.example:7890", strictProxy: true }],
      ["opaque relay", { vercelRelayUrl: "https://relay.example" }],
    ]) {
      it(`${name}: ${route} rejects without invoking fetch`, async () => {
        arrange();
        const wrapper = routeThrough(options);
        await expect(guard.assertPublicUrlResolved("https://fixture.example/")).rejects.toThrow(/Blocked URL/);
        await expect(guard.fetchPublic("https://fixture.example/")).rejects.toThrow(/Blocked URL/);
        expect(wrapper).not.toHaveBeenCalled();
        expect(h.transport).not.toHaveBeenCalled();
        expect(h.agents).toHaveLength(0);
      });
    }
  }
});

describe("Pass11 pin availability and preserved compatibility", () => {
  for (const unavailable of ["import rejection", "missing Agent", "constructor rejection"]) {
    for (const options of [null, { strictProxy: true, connectionProxyEnabled: true }, { vercelRelayUrl: "https://relay.example" }]) {
      it(`rejects ${unavailable} before dispatch (${JSON.stringify(options)})`, async () => {
        vi.doMock("undici", () => {
          if (unavailable === "import rejection") throw new Error("undici unavailable");
          if (unavailable === "missing Agent") return { Agent: undefined };
          return { Agent: class { constructor() { throw new Error("Agent failed"); } } };
        });
        const wrapper = routeThrough(options);
        await expect(guard.fetchPublic("https://fixture.example/")).rejects.toThrow();
        expect(wrapper).not.toHaveBeenCalled();
        expect(h.transport).not.toHaveBeenCalled();
      });
    }
  }

  it.each(["http://8.8.8.8/", "https://[2001:4860:4860::8888]/"])("preserves public literal %s without DNS or undici", async (url) => {
    h.lookup.mockRejectedValue(new Error("DNS must not run"));
    vi.doMock("undici", () => { throw new Error("undici must not load"); });
    expect(await (await guard.fetchPublic(url)).text()).toBe("ok");
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.agents).toHaveLength(0);
    expect(h.transport.mock.calls[0][1].redirect).toBe("manual");
  });

  it.each([
    { address: "8.8.8.8", family: 4 },
    { address: "2001:4860:4860::8888", family: 6 },
  ])("pins validated $address, overrides caller dispatcher and cleans up", async (answer) => {
    h.lookup.mockResolvedValue([answer]);
    const init = { dispatcher: { unsafe: true }, redirect: "follow", headers: { "x-test": "kept" } };
    expect(await (await guard.fetchPublic("https://Fixture.Example./path", init)).text()).toBe("ok");
    const sent = h.transport.mock.calls[0][1];
    expect(sent).toMatchObject({ redirect: "manual", headers: init.headers });
    expect(guard.isPinnedDispatcher(sent.dispatcher)).toBe(true);
    expect(sent.dispatcher[guard.PINNED_DISPATCHER]).toEqual({ host: "fixture.example", ...answer });
    const callback = vi.fn();
    sent.dispatcher.options.connect.lookup("fixture.example", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, answer.address, answer.family);
    expect(h.lookup).toHaveBeenCalledTimes(1);
    expect(sent.dispatcher.close).toHaveBeenCalledTimes(1);
    expect(init.redirect).toBe("follow");
  });

  it("closes the pinned agent when transport rejects, without direct replay", async () => {
    h.transport.mockRejectedValue(new Error("transport failed"));
    await expect(guard.fetchPublic("https://fixture.example/")).rejects.toThrow("transport failed");
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(h.agents[0].close).toHaveBeenCalledTimes(1);
  });

  it("revalidates redirect DNS and closes the previous hop before rejecting", async () => {
    h.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]).mockRejectedValueOnce(new Error("second hop DNS failed"));
    h.transport.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://next.example/" } }));
    await expect(guard.fetchPublic("https://fixture.example/")).rejects.toThrow(/DNS resolution failed/);
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(h.agents[0].close).toHaveBeenCalledTimes(1);
    expect(h.lookup.mock.calls[1][0]).toBe("next.example");
  });

  it.each([
    [{ vercelRelayUrl: "https://relay.example" }, /opaque relay/],
    [{ connectionProxyEnabled: true, strictProxy: true }, /Proxy required/],
  ])("preserves guarded refusal and cleanup for %j", async (options, error) => {
    routeThrough(options);
    await expect(guard.fetchPublic("https://fixture.example/")).rejects.toThrow(error);
    expect(h.transport).not.toHaveBeenCalled();
    expect(h.agents[0].close).toHaveBeenCalledTimes(1);
  });
});
