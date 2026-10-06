/**
 * Wiring tests for the proxy-pool fitness management API.
 *
 * The three routes are thin adapters: dashboard auth → service call → JSON shape.
 * The fitness service itself is covered by proxy-pool-fitness-db.test.js (real
 * SQLite), so it is mocked here — these tests only prove the routes are wired to
 * the right service function with the right arguments.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireDashboardAuth: vi.fn(async () => true),
  poolFitnessSnapshot: vi.fn(async () => [
    { poolId: "pool-1", scope: "openai::gpt-4o", until: 1, reason: "limited_ip" },
  ]),
  clearAllPoolUnfit: vi.fn(async () => true),
  clearPoolUnfit: vi.fn(async () => true),
}));

vi.mock("@/lib/auth/routeAuth.js", () => ({
  requireDashboardAuth: mocks.requireDashboardAuth,
  isAuthorizedDashboardRequest: mocks.requireDashboardAuth,
}));
vi.mock("open-sse/services/proxyPoolFitness.js", () => ({
  poolFitnessSnapshot: mocks.poolFitnessSnapshot,
  clearAllPoolUnfit: mocks.clearAllPoolUnfit,
  clearPoolUnfit: mocks.clearPoolUnfit,
}));

import { GET as getFitness } from "../../src/app/api/proxy-pools/fitness/route.js";
import { POST as clearAll } from "../../src/app/api/proxy-pools/fitness/clear-all/route.js";
import { POST as clearOneRoute } from "../../src/app/api/proxy-pools/[id]/fitness/clear/route.js";

const post = (body) =>
  new Request("http://localhost/api/proxy-pools/fitness", {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const paramsFor = (id) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireDashboardAuth.mockResolvedValue(true);
  mocks.poolFitnessSnapshot.mockResolvedValue([
    { poolId: "pool-1", scope: "openai::gpt-4o", until: 1, reason: "limited_ip" },
  ]);
  mocks.clearAllPoolUnfit.mockResolvedValue(true);
  mocks.clearPoolUnfit.mockResolvedValue(true);
});

describe("GET /api/proxy-pools/fitness", () => {
  it("returns the pool fitness snapshot", async () => {
    const res = await getFitness(new Request("http://localhost/api/proxy-pools/fitness"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pools: [{ poolId: "pool-1", scope: "openai::gpt-4o", until: 1, reason: "limited_ip" }],
    });
    expect(mocks.poolFitnessSnapshot).toHaveBeenCalledTimes(1);
  });

  it("returns 401 without dashboard auth", async () => {
    mocks.requireDashboardAuth.mockResolvedValue(false);
    const res = await getFitness(new Request("http://localhost/api/proxy-pools/fitness"));
    expect(res.status).toBe(401);
    expect(mocks.poolFitnessSnapshot).not.toHaveBeenCalled();
  });

  it("returns 500 when the snapshot fails", async () => {
    mocks.poolFitnessSnapshot.mockRejectedValue(new Error("db down"));
    const res = await getFitness(new Request("http://localhost/api/proxy-pools/fitness"));
    expect(res.status).toBe(500);
  });
});

describe("POST /api/proxy-pools/fitness/clear-all", () => {
  it("clears all pools and reports no provider when the body is missing", async () => {
    const res = await clearAll(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, provider: null });
    expect(mocks.clearAllPoolUnfit).toHaveBeenCalledWith(null);
  });

  it("passes a trimmed provider filter through to the service", async () => {
    const res = await clearAll(post({ provider: "  openai  " }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, provider: "openai" });
    expect(mocks.clearAllPoolUnfit).toHaveBeenCalledWith("openai");
  });

  it("returns 500 when the service reports failure", async () => {
    mocks.clearAllPoolUnfit.mockResolvedValue(false);
    const res = await clearAll(post());
    expect(res.status).toBe(500);
  });

  it("returns 401 without dashboard auth", async () => {
    mocks.requireDashboardAuth.mockResolvedValue(false);
    const res = await clearAll(post());
    expect(res.status).toBe(401);
    expect(mocks.clearAllPoolUnfit).not.toHaveBeenCalled();
  });
});

describe("POST /api/proxy-pools/[id]/fitness/clear", () => {
  it("clears a single pool scope", async () => {
    const res = await clearOneRoute(post({ scope: "openai::gpt-4o" }), paramsFor("pool-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, poolId: "pool-1", scope: "openai::gpt-4o" });
    expect(mocks.clearPoolUnfit).toHaveBeenCalledWith("pool-1", "openai::gpt-4o");
  });

  it("requires a scope", async () => {
    const res = await clearOneRoute(post({}), paramsFor("pool-1"));
    expect(res.status).toBe(400);
    expect(mocks.clearPoolUnfit).not.toHaveBeenCalled();
  });

  it("returns 500 when the service reports failure", async () => {
    mocks.clearPoolUnfit.mockResolvedValue(false);
    const res = await clearOneRoute(post({ scope: "openai::gpt-4o" }), paramsFor("pool-2"));
    expect(res.status).toBe(500);
  });

  it("returns 401 without dashboard auth", async () => {
    mocks.requireDashboardAuth.mockResolvedValue(false);
    const res = await clearOneRoute(post({ scope: "openai::gpt-4o" }), paramsFor("pool-1"));
    expect(res.status).toBe(401);
    expect(mocks.clearPoolUnfit).not.toHaveBeenCalled();
  });
});
