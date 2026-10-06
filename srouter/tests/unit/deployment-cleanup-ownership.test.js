import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createProxyPool } = vi.hoisted(() => ({ createProxyPool: vi.fn() }));
vi.mock("@/models", () => ({ createProxyPool }));

const dataDir = mkdtempSync(join(tmpdir(), "srouter-deployment-ownership-"));
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
const secret = "synthetic-secret-do-not-expose";
function request(controller = new AbortController()) {
  return new Request("http://localhost/api/deploy", {
    method: "POST", signal: controller.signal,
    body: JSON.stringify({
      vercelToken: secret, denoToken: secret, orgDomain: "owner.deno.net", projectName: "relay",
    }),
  });
}
const deletes = () => fetch.mock.calls.filter(([, options]) => options?.method === "DELETE");
function createResult(provider, extra = {}) {
  return provider === "vercel"
    ? { id: "deployment", projectId: "existing-project", ...extra }
    : { id: "existing-app", ...extra };
}
function ready(provider) {
  fetch.mockResolvedValueOnce(json(createResult(provider)));
  if (provider === "vercel") {
    fetch.mockResolvedValueOnce(json({}));
    fetch.mockResolvedValueOnce(json({ readyState: "READY", url: "relay.vercel.app" }));
  } else {
    fetch.mockResolvedValueOnce(json({ id: "revision", status: "succeeded" }));
  }
}

describe.each(["vercel", "deno"])("%s cleanup ownership", (provider) => {
  it.each([200, 201])("does not infer ownership from an ID or HTTP %s", async (status) => {
    fetch.mockResolvedValueOnce(json(createResult(provider), status));
    fetch.mockResolvedValueOnce(json({ error: secret }, 502));
    // An unauthorized DELETE would also fail, but must never be attempted.
    fetch.mockRejectedValue(new Error(secret));
    const response = await handlers[provider](request());
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain(secret);
    expect(deletes()).toHaveLength(0);
    expect(createProxyPool).not.toHaveBeenCalled();
  });

  it.each([
    { reused: true },
    { created: true },
    { labels: { "custom.kind": "srouter-relay" } },
    { projectId: "foreign-project", slug: "relay" },
  ])("does not treat unsupported response hints as an ownership receipt: %j", async (hints) => {
    fetch.mockResolvedValueOnce(json(createResult(provider, hints), 201));
    fetch.mockResolvedValueOnce(json({}, 403));
    // An unauthorized DELETE would hang indefinitely.
    fetch.mockImplementation(hanging);
    const response = await handlers[provider](request());
    expect(response.status).toBe(403);
    expect(deletes()).toHaveLength(0);
  });

  it("keeps resources on normal successful registration", async () => {
    ready(provider);
    const response = await handlers[provider](request());
    expect(response.status).toBe(201);
    expect(createProxyPool).toHaveBeenCalledOnce();
    expect(deletes()).toHaveLength(0);
  });

  it("preserves the registration error without deleting an ambiguously owned resource", async () => {
    ready(provider);
    createProxyPool.mockRejectedValue(new Error(secret));
    const response = await handlers[provider](request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: provider === "vercel" ? "Vercel deployment failed" : "Deno deployment failed",
    });
    expect(deletes()).toHaveLength(0);
  });

  it.each(["resolve", "reject"])("propagates cancellation during registration with late DB %s", async (outcome) => {
    ready(provider);
    let resolveWrite;
    let rejectWrite;
    createProxyPool.mockImplementation(() => new Promise((resolve, reject) => {
      resolveWrite = resolve;
      rejectWrite = reject;
    }));
    const controller = new AbortController();
    const pending = handlers[provider](request(controller));
    await vi.advanceTimersByTimeAsync(0);
    expect(createProxyPool).toHaveBeenCalledOnce();
    controller.abort(new Error(secret));
    // Let the original request race settle before the outstanding DB operation.
    let response;
    pending.then((value) => { response = value; });
    await vi.advanceTimersByTimeAsync(0);
    const canceledBeforeWriteSettled = response?.status;
    if (outcome === "resolve") resolveWrite({ id: "late-pool" });
    else rejectWrite(new Error(secret));
    response = await pending;
    expect(canceledBeforeWriteSettled).toBe(499);
    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({ error: "Deployment canceled" });
    expect(deletes()).toHaveLength(0);
  });

  it("bounds a stalled registration without claiming rollback or deleting remote state", async () => {
    ready(provider);
    createProxyPool.mockImplementation(hanging);
    const pending = handlers[provider](request());
    await vi.advanceTimersByTimeAsync(provider === "vercel" ? 120000 : 60000);
    let response;
    pending.then((value) => { response = value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(response?.status).toBe(504);
    expect(deletes()).toHaveLength(0);
  });

  it.each(["headers", "body"])("does not delete a late create %s response after cancellation", async (stage) => {
    let finish;
    const late = new Promise((resolve) => { finish = resolve; });
    if (stage === "headers") fetch.mockReturnValueOnce(late);
    else fetch.mockResolvedValueOnce({ ok: true, status: 201, json: () => late });
    const controller = new AbortController();
    const pending = handlers[provider](request(controller));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    const response = await pending;
    expect(response.status).toBe(499);
    finish(stage === "headers" ? json(createResult(provider), 201) : createResult(provider));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledOnce();
    expect(createProxyPool).not.toHaveBeenCalled();
    expect(deletes()).toHaveLength(0);
  });
});
