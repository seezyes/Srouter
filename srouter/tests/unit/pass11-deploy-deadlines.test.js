import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createProxyPool } = vi.hoisted(() => ({ createProxyPool: vi.fn() }));
vi.mock("@/models", () => ({ createProxyPool }));

const dataDir = mkdtempSync(join(tmpdir(), "srouter-pass11-deploy-"));
let handlers;
beforeAll(async () => {
  vi.stubEnv("DATA_DIR", dataDir);
  handlers = {
    vercel: (await import("../../src/app/api/proxy-pools/vercel-deploy/route.js")).POST,
    deno: (await import("../../src/app/api/proxy-pools/deno-deploy/route.js")).POST,
  };
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  vi.useFakeTimers();
  createProxyPool.mockReset().mockResolvedValue({ id: "pool" });
  vi.stubGlobal("fetch", vi.fn());
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const hanging = () => new Promise(() => {});
const token = "private-token-do-not-expose";
function request(controller = new AbortController()) {
  return new Request("http://localhost/api/deploy", {
    method: "POST", signal: controller.signal,
    body: JSON.stringify({
      vercelToken: token, denoToken: token, orgDomain: "owner.deno.net", projectName: "relay",
    }),
  });
}
function setup(provider, stage, operation) {
  if (stage === "create") {
    fetch.mockImplementationOnce(operation);
    return;
  }
  fetch.mockResolvedValueOnce(json(provider === "vercel"
    ? { id: "deployment", projectId: "project" } : { id: "app" }));
  if (stage === "operation") {
    fetch.mockImplementationOnce(operation);
    return;
  }
  fetch.mockResolvedValueOnce(json(provider === "vercel" ? {} : { id: "revision", status: "building" }));
  if (stage === "poll") fetch.mockImplementationOnce(operation);
}
function cleanupCalls() {
  return fetch.mock.calls.filter(([, options]) => options?.method === "DELETE");
}

describe.each(["vercel", "deno"])("%s deployment deadline handler", (provider) => {
  const budget = provider === "vercel" ? 120000 : 60000;

  it.each(["create", "operation", "poll"])("bounds a hung %s fetch even if fetch ignores abort", async (stage) => {
    setup(provider, stage, hanging);
    fetch.mockResolvedValue(json({}));
    const pending = handlers[provider](request());
    await vi.advanceTimersByTimeAsync(budget);
    const response = await pending;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "Deployment timed out" });
    expect(createProxyPool).not.toHaveBeenCalled();
    expect(fetch.mock.calls.find(([, options]) => options?.signal.aborted)).toBeTruthy();
    // Returned ids do not supply an operation-bound ownership receipt.
    expect(cleanupCalls()).toHaveLength(0);
  });

  it.each(["create", "operation", "poll"])("propagates disconnect during %s without leaking its reason", async (stage) => {
    setup(provider, stage, hanging);
    fetch.mockResolvedValue(json({}));
    const controller = new AbortController();
    const pending = handlers[provider](request(controller));
    await vi.advanceTimersByTimeAsync(stage === "poll" && provider === "deno" ? 2000 : 0);
    controller.abort(new Error(token));
    const response = await pending;
    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({ error: "Deployment canceled" });
    expect(createProxyPool).not.toHaveBeenCalled();
    expect(cleanupCalls()).toHaveLength(0);
  });

  it("does not issue any remote call for an already disconnected request", async () => {
    const controller = new AbortController();
    controller.abort(token);
    expect((await handlers[provider](request(controller))).status).toBe(499);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds a hung successful create response body", async () => {
    fetch.mockResolvedValue({ ok: true, json: hanging });
    const pending = handlers[provider](request());
    await vi.advanceTimersByTimeAsync(budget);
    expect((await pending).status).toBe(504);
    expect(createProxyPool).not.toHaveBeenCalled();
    expect(cleanupCalls()).toHaveLength(0);
  });

  it.each(["create", "operation", "poll"])("checks non-ok %s status and sanitizes provider content", async (stage) => {
    setup(provider, stage, () => json({ error: { message: token }, status: token }, 403));
    fetch.mockResolvedValue(json({}));
    const pending = handlers[provider](request());
    await vi.advanceTimersByTimeAsync(provider === "deno" && stage === "poll" ? 2000 : 0);
    const response = await pending;
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toContain(token);
    expect(createProxyPool).not.toHaveBeenCalled();
    expect(cleanupCalls()).toHaveLength(0);
  });

  it("uses one total deadline rather than restarting it for each request", async () => {
    setup(provider, "create", () => new Promise((resolve) => setTimeout(() => resolve(json(
      provider === "vercel" ? { id: "deployment" } : { id: "app" }
    )), budget - 1000)));
    fetch.mockImplementationOnce(hanging).mockResolvedValue(json({}));
    const pending = handlers[provider](request());
    await vi.advanceTimersByTimeAsync(budget - 1);
    expect(createProxyPool).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(504);
  });

  it("bounds a stalled poll response body", async () => {
    setup(provider, "poll", () => ({ ok: true, json: hanging }));
    fetch.mockResolvedValue(json({}));
    const pending = handlers[provider](request());
    await vi.advanceTimersByTimeAsync(budget);
    expect((await pending).status).toBe(504);
    expect(cleanupCalls()).toHaveLength(0);
    expect(createProxyPool).not.toHaveBeenCalled();
  });

  it("ends persistent pending revisions at the total deadline", async () => {
    const pendingState = provider === "vercel" ? { readyState: "BUILDING" } : { status: "building" };
    setup(provider, "poll", () => json(pendingState));
    fetch.mockImplementation((_, options) => Promise.resolve(json(
      options.method === "DELETE" ? {} : pendingState
    )));
    const pending = handlers[provider](request());
    await vi.advanceTimersByTimeAsync(budget);
    expect((await pending).status).toBe(504);
    expect(createProxyPool).not.toHaveBeenCalled();
    expect(cleanupCalls()).toHaveLength(0);
  });

  it("sanitizes a failed terminal poll state", async () => {
    setup(provider, "poll", () => json(provider === "vercel"
      ? { readyState: "ERROR", error: token } : { status: token }));
    fetch.mockResolvedValue(json({}));
    const pending = handlers[provider](request());
    await vi.advanceTimersByTimeAsync(provider === "deno" ? 2000 : 0);
    const response = await pending;
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain(token);
    expect(createProxyPool).not.toHaveBeenCalled();
    expect(cleanupCalls()).toHaveLength(0);
  });

  it("cancels a polling sleep without performing another poll", async () => {
    setup(provider, "poll", () => json(provider === "vercel"
      ? { readyState: "BUILDING" } : { status: "building" }));
    fetch.mockResolvedValue(json({}));
    const controller = new AbortController();
    const pending = handlers[provider](request(controller));
    await vi.advanceTimersByTimeAsync(provider === "deno" ? 2000 : 0);
    const before = fetch.mock.calls.length;
    controller.abort();
    expect((await pending).status).toBe(499);
    expect(fetch).toHaveBeenCalledTimes(before);
    expect(createProxyPool).not.toHaveBeenCalled();
  });

  it("sanitizes thrown network errors", async () => {
    fetch.mockRejectedValue(new Error(`Authorization: Bearer ${token}`));
    const response = await handlers[provider](request());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain(token);
  });

  it("registers a successful polled deployment with the existing pool shape", async () => {
    setup(provider, "poll", () => json(provider === "vercel"
      ? { readyState: "READY", url: "relay.vercel.app" } : { status: "succeeded" }));
    const pending = handlers[provider](request());
    await vi.advanceTimersByTimeAsync(provider === "deno" ? 2000 : 0);
    const response = await pending;
    const deployUrl = provider === "vercel" ? "https://relay.vercel.app" : "https://relay.owner.deno.net";
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ proxyPool: { id: "pool" }, deployUrl });
    expect(createProxyPool).toHaveBeenCalledWith({
      name: "relay", proxyUrl: deployUrl, type: provider,
      noProxy: "", isActive: true, strictProxy: false,
    });
    expect(cleanupCalls()).toHaveLength(0);
    expect(fetch.mock.calls.every(([, options]) => options.signal instanceof AbortSignal)).toBe(true);
  });
});

describe("Deno failed-app cleanup ownership boundaries", () => {
  it.each(["timeout", "disconnect"])("blocks ambiguous cleanup after %s even if DELETE would hang", async (cause) => {
    setup("deno", "operation", hanging);
    fetch.mockImplementationOnce(hanging);
    const controller = new AbortController();
    const pending = handlers.deno(request(controller));
    await vi.advanceTimersByTimeAsync(cause === "timeout" ? 60000 : 0);
    if (cause === "disconnect") {
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect((await pending).status).toBe(cause === "timeout" ? 504 : 499);
    expect(cleanupCalls()).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("preserves the original error without attempting an unowned failing DELETE", async () => {
    setup("deno", "operation", () => json({ error: token }, 502));
    fetch.mockResolvedValue(json({ error: token }, 403));
    const response = await handlers.deno(request());
    expect(response.status).toBe(502);
    expect(cleanupCalls()).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(console.error).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain(token);
  });

  it("does not delete an ambiguously owned app after a failed terminal revision", async () => {
    setup("deno", "operation", () => json({ id: "revision", status: token }));
    fetch.mockResolvedValue(json({}));
    const response = await handlers.deno(request());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain(token);
    expect(cleanupCalls()).toHaveLength(0);
  });

  it("does not delete a successful deployment when local registration fails", async () => {
    setup("deno", "operation", () => json({ id: "revision", status: "succeeded" }));
    createProxyPool.mockRejectedValue(new Error(token));
    const response = await handlers.deno(request());
    expect(response.status).toBe(500);
    expect(cleanupCalls()).toHaveLength(0);
    expect(JSON.stringify(await response.json())).not.toContain(token);
  });

  it("never deletes a conflicting existing app", async () => {
    fetch.mockResolvedValue(json({ error: token }, 409));
    expect((await handlers.deno(request())).status).toBe(409);
    expect(cleanupCalls()).toHaveLength(0);
  });
});
