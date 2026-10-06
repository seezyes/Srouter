// Pass9 handler-semantics closure — route-level contract anchors.
//
// One test per externally observable branch that the operation ledger in
// docs/work/T-0030-upstream-parity/pass9-api-handler-semantics.md records as
// either a verified local behavior or a verified divergence from the pinned
// upstream trees. Handlers are the REAL route modules; only their data/service
// dependencies are mocked, so these pin the actual status/shape contracts.
//
// Update (Pass9 handler-fix round): the three assertions that pinned *defective*
// local behavior (PUT deno coercion, DELETE/GET ignoring the array
// `proxyPoolIds` form) were converted to the corrected behavior after the
// preimage was captured in
// evidence/pass9-handler-fixes/preimages/contracts-test.preimage.txt. Pass8
// evidence is untouched. Nothing else in this file was weakened.
//
// No DB, no network, no process, no credential: every dependency is a mock.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  // @/models
  getProxyPools: vi.fn(async () => []),
  getProxyPoolById: vi.fn(async () => null),
  createProxyPool: vi.fn(async (input) => ({ id: "pool-new", ...input })),
  updateProxyPool: vi.fn(async (id, updates) => ({ id, ...updates })),
  deleteProxyPool: vi.fn(async () => true),
  getProviderConnections: vi.fn(async () => []),
  // @/lib/localDb
  getSettings: vi.fn(async () => ({})),
  updateSettings: vi.fn(async (body) => ({ ...body })),
  // services
  enableTunnel: vi.fn(async () => ({ success: true, url: "https://fake.trycloudflare.com" })),
  configureTunnelMonitoring: vi.fn(async () => ({})),
  // headroom
  startHeadroomProxy: vi.fn(async ({ port }) => ({ managedPid: 4242, port })),
  // pxpipe
  getInstallInfo: vi.fn(() => ({ installed: true, version: "1.0.0" })),
  installPxpipe: vi.fn(async () => ({ installed: true })),
  loadPxpipe: vi.fn(async () => ({ loaded: true })),
  getPxpipeStatus: vi.fn(() => ({ installed: true, loaded: true, mode: "library" })),
}));

vi.mock("@/models", () => ({
  getProxyPools: mocks.getProxyPools,
  getProxyPoolById: mocks.getProxyPoolById,
  createProxyPool: mocks.createProxyPool,
  updateProxyPool: mocks.updateProxyPool,
  deleteProxyPool: mocks.deleteProxyPool,
  getProviderConnections: mocks.getProviderConnections,
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
}));
vi.mock("@/lib/tunnel", () => ({ enableTunnel: mocks.enableTunnel }));
vi.mock("@/shared/services/initializeApp", () => ({
  configureTunnelMonitoring: mocks.configureTunnelMonitoring,
}));
vi.mock("@/lib/headroom/process", () => ({ startHeadroomProxy: mocks.startHeadroomProxy }));
vi.mock("@/lib/pxpipe/install.js", () => ({
  getInstallInfo: mocks.getInstallInfo,
  installPxpipe: mocks.installPxpipe,
}));
vi.mock("@/lib/pxpipe/loader.js", () => ({ loadPxpipe: mocks.loadPxpipe }));
vi.mock("@/lib/pxpipe/service.js", () => ({ getPxpipeStatus: mocks.getPxpipeStatus }));

const { POST: createPool, GET: listPools } = await import("@/app/api/proxy-pools/route.js");
const { PUT: updatePool, DELETE: deletePool } = await import("@/app/api/proxy-pools/[id]/route.js");
const { POST: enableTunnelRoute } = await import("@/app/api/tunnel/enable/route.js");
const { POST: startHeadroom } = await import("@/app/api/headroom/start/route.js");
const { POST: startPxpipe } = await import("@/app/api/pxpipe/start/route.js");
const { GET: requireLoginRoute } = await import("@/app/api/settings/require-login/route.js");
const { PATCH: patchSettings } = await import("@/app/api/settings/route.js");

const jsonRequest = (url, body, method = "POST") =>
  new Request(url, { method, body: JSON.stringify(body) });
const paramsFor = (id) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProxyPools.mockResolvedValue([]);
  mocks.getProxyPoolById.mockResolvedValue(null);
  mocks.createProxyPool.mockImplementation(async (input) => ({ id: "pool-new", ...input }));
  mocks.updateProxyPool.mockImplementation(async (id, updates) => ({ id, ...updates }));
  mocks.deleteProxyPool.mockResolvedValue(true);
  mocks.getProviderConnections.mockResolvedValue([]);
  mocks.getSettings.mockResolvedValue({});
  mocks.updateSettings.mockImplementation(async (body) => ({ ...body }));
  mocks.enableTunnel.mockResolvedValue({ success: true, url: "https://fake.trycloudflare.com" });
  mocks.startHeadroomProxy.mockImplementation(async ({ port }) => ({ managedPid: 4242, port }));
  mocks.getInstallInfo.mockReturnValue({ installed: true, version: "1.0.0" });
  mocks.getPxpipeStatus.mockReturnValue({ installed: true, loaded: true, mode: "library" });
});

describe("proxy-pools create/update type whitelist (ledger: proxy-pools-index#POST, proxy-pools-id#PUT)", () => {
  it('POST /api/proxy-pools accepts the pinned "deno" type', async () => {
    const res = await createPool(
      jsonRequest("http://localhost/api/proxy-pools", {
        name: "cf-worker",
        proxyUrl: "https://worker.example.workers.dev",
        type: "deno",
      }),
    );
    expect(res.status).toBe(201);
    expect(mocks.createProxyPool).toHaveBeenCalledWith(
      expect.objectContaining({ type: "deno", isActive: true, strictProxy: false }),
    );
  });

  it('PUT /api/proxy-pools/[id] preserves the pinned "deno" type (FIXED, was a verified divergence)', async () => {
    mocks.getProxyPoolById.mockResolvedValue({ id: "p1", name: "cf", proxyUrl: "https://x", type: "deno" });
    const res = await updatePool(
      jsonRequest("http://localhost/api/proxy-pools/p1", { name: "cf-renamed" }, "PUT"),
      paramsFor("p1"),
    );
    expect(res.status).toBe(200);
    expect(mocks.updateProxyPool).toHaveBeenCalledWith("p1", { name: "cf-renamed" });
    const withType = await updatePool(
      jsonRequest("http://localhost/api/proxy-pools/p1", { type: "deno" }, "PUT"),
      paramsFor("p1"),
    );
    expect(withType.status).toBe(200);
    // Both index POST and [id] PUT now consume the same VALID_PROXY_TYPES
    // whitelist (src/lib/proxyPoolTypes.js), so the pinned "deno" type survives
    // an update instead of being silently rewritten to "http".
    // Preimage of the previous (defective) assertion: evidence/pass9-handler-fixes/preimages/contracts-test.preimage.txt
    expect(mocks.updateProxyPool).toHaveBeenLastCalledWith("p1", { type: "deno" });
  });

  it("PUT still normalizes an unknown type to http (guarded, not blind passthrough)", async () => {
    mocks.getProxyPoolById.mockResolvedValue({ id: "p1", type: "deno" });
    const res = await updatePool(
      jsonRequest("http://localhost/api/proxy-pools/p1", { type: "socks9" }, "PUT"),
      paramsFor("p1"),
    );
    expect(res.status).toBe(200);
    expect(mocks.updateProxyPool).toHaveBeenLastCalledWith("p1", { type: "http" });
  });

  it("PUT rejects an empty name and a missing pool", async () => {
    mocks.getProxyPoolById.mockResolvedValue({ id: "p1" });
    const empty = await updatePool(
      jsonRequest("http://localhost/api/proxy-pools/p1", { name: "   " }, "PUT"),
      paramsFor("p1"),
    );
    expect(empty.status).toBe(400);

    mocks.getProxyPoolById.mockResolvedValue(null);
    const missing = await updatePool(
      jsonRequest("http://localhost/api/proxy-pools/p1", { name: "x" }, "PUT"),
      paramsFor("p1"),
    );
    expect(missing.status).toBe(404);
  });
});

describe("proxy-pools delete usage counting (ledger: proxy-pools-id#DELETE)", () => {
  it("409s when a connection is bound through providerSpecificData.proxyPoolId", async () => {
    mocks.getProxyPoolById.mockResolvedValue({ id: "p1" });
    mocks.getProviderConnections.mockResolvedValue([
      { id: "c1", providerSpecificData: { proxyPoolId: "p1" } },
    ]);
    const res = await deletePool(new Request("http://localhost/api/proxy-pools/p1", { method: "DELETE" }), paramsFor("p1"));
    expect(res.status).toBe(409);
    expect((await res.json()).boundConnectionCount).toBe(1);
    expect(mocks.deleteProxyPool).not.toHaveBeenCalled();
  });

  it("409s when a connection is bound through the array form proxyPoolIds (FIXED, was a verified divergence)", async () => {
    mocks.getProxyPoolById.mockResolvedValue({ id: "p1" });
    mocks.getProviderConnections.mockResolvedValue([
      { id: "c1", providerSpecificData: { proxyPoolIds: ["p1"] } },
    ]);
    const res = await deletePool(new Request("http://localhost/api/proxy-pools/p1", { method: "DELETE" }), paramsFor("p1"));
    expect(res.status).toBe(409);
    expect((await res.json()).boundConnectionCount).toBe(1);
    expect(mocks.deleteProxyPool).not.toHaveBeenCalled();
  });

  it("counts each connection once when scalar and array both reference the pool", async () => {
    mocks.getProxyPoolById.mockResolvedValue({ id: "p1" });
    mocks.getProviderConnections.mockResolvedValue([
      { id: "c1", providerSpecificData: { proxyPoolId: "p1", proxyPoolIds: ["p1", "p2"] } },
      { id: "c2", providerSpecificData: { proxyPoolId: "p2" } },
    ]);
    const res = await deletePool(new Request("http://localhost/api/proxy-pools/p1", { method: "DELETE" }), paramsFor("p1"));
    expect(res.status).toBe(409);
    expect((await res.json()).boundConnectionCount).toBe(1);
  });

  it("GET ?includeUsage=true reports the deduped union of scalar and array references (FIXED)", async () => {
    mocks.getProxyPools.mockResolvedValue([{ id: "p1" }]);
    mocks.getProviderConnections.mockResolvedValue([
      { providerSpecificData: { proxyPoolId: "p1" } },
      { providerSpecificData: { proxyPoolIds: ["p1"] } },
      { providerSpecificData: { proxyPoolId: "p1", proxyPoolIds: ["p1"] } },
      { providerSpecificData: { proxyPoolIds: ["p2"] } },
    ]);
    const body = await (
      await listPools(new Request("http://localhost/api/proxy-pools?includeUsage=true"))
    ).json();
    // Three connections reference p1; the doubly-referencing one counts once.
    expect(body.proxyPools).toEqual([{ id: "p1", boundConnectionCount: 3 }]);
  });
});

describe("tunnel enable security gate (ledger: tunnel-enable#POST)", () => {
  it("403s and never starts cloudflared while no dashboard password is set", async () => {
    mocks.getSettings.mockResolvedValue({ password: null, requireLogin: true });
    const res = await enableTunnelRoute();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Security required");
    expect(mocks.enableTunnel).not.toHaveBeenCalled();
  });

  it("403s while the login policy is off, even with a password set", async () => {
    mocks.getSettings.mockResolvedValue({ password: "hash", requireLogin: false });
    const res = await enableTunnelRoute();
    expect(res.status).toBe(403);
    expect(mocks.enableTunnel).not.toHaveBeenCalled();
  });
});

describe("headroom start loopback-only contract (ledger: headroom-start#POST)", () => {
  it("400s with code EXTERNAL_PROXY for a non-loopback headroomUrl", async () => {
    mocks.getSettings.mockResolvedValue({ headroomUrl: "https://proxy.example.com:443" });
    const res = await startHeadroom();
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("EXTERNAL_PROXY");
    expect(mocks.startHeadroomProxy).not.toHaveBeenCalled();
  });

  it("starts a managed proxy for a loopback url, passing port and flags", async () => {
    mocks.getSettings.mockResolvedValue({
      headroomUrl: "http://127.0.0.1:9911",
      headroomCodeAware: true,
      headroomKompress: false,
    });
    const res = await startHeadroom();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, managedPid: 4242, port: 9911 });
    expect(mocks.startHeadroomProxy).toHaveBeenCalledWith({ port: 9911, codeAware: true, kompress: false });
  });

  it("maps a NOT_INSTALLED failure to 400 with the code preserved", async () => {
    mocks.getSettings.mockResolvedValue({ headroomUrl: "http://localhost:8787" });
    const err = Object.assign(new Error("headroom is not installed"), { code: "NOT_INSTALLED" });
    mocks.startHeadroomProxy.mockRejectedValue(err);
    const res = await startHeadroom();
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("NOT_INSTALLED");
  });
});

describe("pxpipe library-mode start (ledger: pxpipe-start#POST)", () => {
  it("409s with NOT_INSTALLED when the module is missing and auto-install is off", async () => {
    mocks.getInstallInfo.mockReturnValue({ installed: false });
    mocks.getSettings.mockResolvedValue({ pxpipeAutoInstall: false });
    const res = await startPxpipe();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NOT_INSTALLED");
    expect(mocks.installPxpipe).not.toHaveBeenCalled();
    expect(mocks.loadPxpipe).not.toHaveBeenCalled();
  });

  it("installs then loads when auto-install is on, and returns the status payload", async () => {
    mocks.getInstallInfo.mockReturnValue({ installed: false });
    mocks.getSettings.mockResolvedValue({ pxpipeAutoInstall: true });
    const res = await startPxpipe();
    expect(res.status).toBe(200);
    expect(mocks.installPxpipe).toHaveBeenCalledTimes(1);
    expect(mocks.loadPxpipe).toHaveBeenCalledTimes(1);
    expect(await res.json()).toEqual({ installed: true, loaded: true, mode: "library" });
  });
});

describe("settings login-policy surface (ledger: settings-require-login#GET)", () => {
  it("returns the local loginPolicy/originGuard contract", async () => {
    mocks.getSettings.mockResolvedValue({
      password: "hash",
      requireLogin: "local",
      originGuard: true,
      tunnelDashboardAccess: false,
      tunnelUrl: "https://t.example",
    });
    const body = await (await requireLoginRoute()).json();
    expect(body).toEqual({
      requireLogin: true,
      loginPolicy: "local",
      originGuard: true,
      tunnelDashboardAccess: false,
      tunnelUrl: "https://t.example",
      tailscaleUrl: "",
    });
  });

  it("falls back to the strict shape when settings cannot be read", async () => {
    mocks.getSettings.mockRejectedValue(new Error("db down"));
    const res = await requireLoginRoute();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requireLogin: true, loginPolicy: "always", originGuard: true });
  });
});

describe("settings PATCH secret handling (ledger: settings#PATCH)", () => {
  it("never persists a currentPassword field that was submitted alone", async () => {
    const res = await patchSettings(
      jsonRequest("http://localhost/api/settings", { currentPassword: "FAKE-CURRENT-PW" }, "PATCH"),
    );
    expect(res.status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalledTimes(1);
    const persisted = mocks.updateSettings.mock.calls[0][0];
    expect(persisted).toEqual({});
    expect(JSON.stringify(persisted)).not.toContain("FAKE-CURRENT-PW");
  });

  it("strips protected settings keys before persisting", async () => {
    await patchSettings(
      jsonRequest(
        "http://localhost/api/settings",
        { password: "FAKE-INJECTED-HASH", mitmSudoEncrypted: "FAKE-BLOB", theme: "dark" },
        "PATCH",
      ),
    );
    expect(mocks.updateSettings).toHaveBeenCalledWith({ theme: "dark" });
  });

  it("rejects a weak newPassword before any hashing", async () => {
    const res = await patchSettings(
      jsonRequest("http://localhost/api/settings", { newPassword: "short" }, "PATCH"),
    );
    expect(res.status).toBe(400);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });
});
