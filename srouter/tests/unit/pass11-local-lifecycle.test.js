import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  files: new Map(),
  spawn: vi.fn(),
  close: vi.fn(),
  entry: "",
  settings: vi.fn(async () => ({ headroomUrl: "http://localhost:8787" })),
}));
vi.mock("fs", () => ({ default: {
  existsSync: (file) => mocks.files.has(file),
  mkdirSync: vi.fn(),
  readFileSync: (file) => mocks.files.get(file),
  writeFileSync: (file, content) => mocks.files.set(file, content),
  unlinkSync: (file) => mocks.files.delete(file),
  openSync: () => 42,
  closeSync: mocks.close,
} }));
vi.mock("child_process", () => ({ spawn: mocks.spawn }));
vi.mock("@/lib/dataDir.js", () => ({ DATA_DIR: "pass11-mocked-data" }));
vi.mock("@/lib/headroom/detect.js", () => ({
  findHeadroomBinary: () => "mock-headroom",
  DEFAULT_HEADROOM_URL: "http://localhost:8787",
}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.settings }));
vi.mock("@/lib/pxpipe/install.js", () => ({
  getInstallInfo: () => ({ installed: true, version: "test" }),
  libraryEntry: () => mocks.entry,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("managed Headroom lifecycle", () => {
  let manager;
  let children;
  let alive;
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    mocks.files.clear();
    mocks.close.mockClear();
    children = [];
    alive = new Set();
    mocks.spawn.mockReset().mockImplementation(() => {
      const child = new EventEmitter();
      child.pid = 40000 + children.length;
      child.unref = vi.fn();
      children.push(child);
      alive.add(child.pid);
      return child;
    });
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (!alive.has(pid)) throw new Error("not alive");
      if (signal !== 0) {
        alive.delete(pid);
        children.find((child) => child.pid === pid)?.emit("exit", 0);
      }
      return true;
    });
    manager = await import("@/lib/headroom/process.js");
  });

  it("coalesces concurrent starts without duplicate child processes", async () => {
    const first = manager.startHeadroomProxy();
    const second = manager.startHeadroomProxy();
    await vi.advanceTimersByTimeAsync(8000);
    expect(await first).toEqual({ pid: 40000, alreadyRunning: false });
    expect(await second).toEqual({ pid: 40000, alreadyRunning: true });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("queues restart behind startup without recursively acquiring the lock", async () => {
    const first = manager.startHeadroomProxy();
    const restarted = manager.restartHeadroomProxy({ codeAware: true });
    await vi.advanceTimersByTimeAsync(16000);
    expect((await first).pid).toBe(40000);
    expect((await restarted).pid).toBe(40001);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(mocks.spawn.mock.calls[1][1]).toContain("--code-aware");
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });

  it("keeps stop synchronous and cancels queued startup and restart", async () => {
    const first = manager.startHeadroomProxy().catch((error) => error);
    const restart = manager.restartHeadroomProxy().catch((error) => error);
    expect(manager.stopHeadroomProxy()).toEqual({ stopped: false, reason: "not_running" });
    expect((await first).code).toBe("STOPPED");
    expect((await restart).code).toBe("STOPPED");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("stop during startup cannot be undone by the queued restart", async () => {
    const first = manager.startHeadroomProxy().catch((error) => error);
    const restart = manager.restartHeadroomProxy().catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.stopHeadroomProxy()).toEqual({ stopped: true, pid: 40000 });
    expect((await first).code).toBe("EARLY_EXIT");
    expect((await restart).code).toBe("STOPPED");
    const next = manager.startHeadroomProxy();
    await vi.advanceTimersByTimeAsync(8000);
    expect((await next).pid).toBe(40001);
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });

  it("does not double-close the log fd or clear a replacement pid on late exit", async () => {
    const first = manager.startHeadroomProxy();
    await vi.advanceTimersByTimeAsync(8000);
    await first;
    const pidFile = [...mocks.files.keys()].find((file) => file.endsWith("proxy.pid"));
    mocks.files.set(pidFile, "49999");
    children[0].emit("exit", 0);
    expect(mocks.files.get(pidFile)).toBe("49999");
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("releases the lifecycle queue and descriptor after spawn error", async () => {
    const first = manager.startHeadroomProxy().catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    children[0].emit("error", new Error("mock spawn error"));
    expect((await first).message).toBe("mock spawn error");
    const next = manager.startHeadroomProxy();
    await vi.advanceTimersByTimeAsync(8000);
    expect((await next).pid).toBe(40001);
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });

  it("closes the descriptor when spawn throws or returns no pid", async () => {
    mocks.spawn.mockImplementationOnce(() => { throw new Error("invalid spawn"); });
    await expect(manager.startHeadroomProxy()).rejects.toThrow("invalid spawn");
    const child = new EventEmitter();
    mocks.spawn.mockImplementationOnce(() => child);
    await expect(manager.startHeadroomProxy()).rejects.toMatchObject({ code: "SPAWN_FAILED" });
    expect(() => child.emit("error", new Error("not found"))).not.toThrow();
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });

  it("holds a new start behind the stop grace period and force-kill", async () => {
    const first = manager.startHeadroomProxy();
    await vi.advanceTimersByTimeAsync(8000);
    await first;
    process.kill.mockImplementation((pid, signal) => {
      if (!alive.has(pid)) throw new Error("not alive");
      if (signal === "SIGKILL") {
        alive.delete(pid);
        children.find((child) => child.pid === pid)?.emit("exit", 0);
      }
      return true;
    });
    manager.stopHeadroomProxy();
    const next = manager.startHeadroomProxy();
    await vi.advanceTimersByTimeAsync(1999);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(301);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(8000);
    expect((await next).pid).toBe(40001);
    expect(process.kill).toHaveBeenCalledWith(40000, "SIGKILL");
    expect(process.kill).not.toHaveBeenCalledWith(40001, "SIGKILL");
  });

  it("a delayed stop callback does not kill a replacement owner", async () => {
    const first = manager.startHeadroomProxy();
    await vi.advanceTimersByTimeAsync(8000);
    await first;
    process.kill.mockImplementation((pid) => {
      if (!alive.has(pid)) throw new Error("not alive");
      return true;
    });
    manager.stopHeadroomProxy();
    const pidFile = [...mocks.files.keys()].find((file) => file.endsWith("proxy.pid"));
    mocks.files.set(pidFile, "49999");
    await vi.advanceTimersByTimeAsync(2500);
    expect(process.kill.mock.calls.filter(([, signal]) => signal === "SIGKILL")).toEqual([]);
    expect(mocks.files.get(pidFile)).toBe("49999");
  });
});

describe("PXPIPE pending import invalidation", () => {
  it("does not publish an unloaded import and allows a later explicit load", async () => {
    const fs = await vi.importActual("fs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pass11-pxpipe-"));
    let enter;
    let release;
    globalThis.__pass11Entered = new Promise((resolve) => { enter = resolve; });
    globalThis.__pass11Enter = enter;
    globalThis.__pass11Wait = new Promise((resolve) => { release = resolve; });
    mocks.entry = path.join(dir, "module.mjs");
    fs.writeFileSync(mocks.entry,
      "globalThis.__pass11Enter(); await globalThis.__pass11Wait; export function transformAnthropicMessages() {}");
    try {
      vi.resetModules();
      const loader = await import("@/lib/pxpipe/loader.js");
      const first = loader.loadPxpipe();
      await globalThis.__pass11Entered;
      loader.unloadPxpipe();
      release();
      await first;
      expect(loader.getLoadedInfo()).toEqual({ loaded: false });
      expect(await loader.getTransform({ autoLoad: false })).toBeNull();
      await loader.loadPxpipe();
      expect(loader.getLoadedInfo().loaded).toBe(true);
    } finally {
      release();
      delete globalThis.__pass11Entered;
      delete globalThis.__pass11Enter;
      delete globalThis.__pass11Wait;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an old import finalizer cannot clear the newer in-flight import", async () => {
    const fs = await vi.importActual("fs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pass11-pxpipe-overlap-"));
    const gates = [0, 1].map(() => {
      let enter;
      let release;
      const entered = new Promise((resolve) => { enter = resolve; });
      const wait = new Promise((resolve) => { release = resolve; });
      return { enter, release, entered, wait };
    });
    globalThis.__pass11Gates = gates;
    for (const index of [0, 1]) {
      fs.writeFileSync(path.join(dir, `${index}.mjs`),
        `globalThis.__pass11Gates[${index}].enter(); await globalThis.__pass11Gates[${index}].wait; export function transformAnthropicMessages() { return ${index}; }`);
    }
    try {
      vi.resetModules();
      const loader = await import("@/lib/pxpipe/loader.js");
      mocks.entry = path.join(dir, "0.mjs");
      const old = loader.loadPxpipe();
      await gates[0].entered;
      loader.unloadPxpipe();
      mocks.entry = path.join(dir, "1.mjs");
      const newer = loader.loadPxpipe();
      await gates[1].entered;
      gates[0].release();
      await old;
      expect(loader.getLoadedInfo().loaded).toBe(false);
      const joined = loader.loadPxpipe();
      gates[1].release();
      const [a, b] = await Promise.all([newer, joined]);
      expect(a).toBe(b);
      expect(a.module.transformAnthropicMessages()).toBe(1);
      expect(loader.getLoadedInfo().loaded).toBe(true);
    } finally {
      for (const gate of gates) gate.release();
      delete globalThis.__pass11Gates;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Headroom proxy disconnect forwarding", () => {
  it("preserves a successful stream and removes the abort listener on completion", async () => {
    vi.resetModules();
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unchanged", {
      status: 201, headers: { "x-test": "preserved" },
    })));
    const { GET } = await import("@/app/api/headroom/proxy/[...path]/route.js");
    const request = new Request("http://router/api/headroom/proxy/stats", { signal: controller.signal });
    const remove = vi.spyOn(request.signal, "removeEventListener");
    const response = await GET(request, { params: Promise.resolve({ path: ["stats"] }) });
    expect(response.status).toBe(201);
    expect(response.headers.get("x-test")).toBe("preserved");
    expect(await response.text()).toBe("unchanged");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    controller.abort();
  });

  it("forwards request abort and cancels the upstream body after headers", async () => {
    vi.resetModules();
    const cancel = vi.fn();
    const controller = new AbortController();
    const upstream = new ReadableStream({ cancel });
    const fetchMock = vi.fn(async () => new Response(upstream));
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("@/app/api/headroom/proxy/[...path]/route.js");
    const request = new Request("http://router/api/headroom/proxy/stats", { signal: controller.signal });
    const response = await GET(request, { params: Promise.resolve({ path: ["stats"] }) });
    expect(fetchMock.mock.calls[0][1].signal).toBe(request.signal);
    controller.abort(new Error("disconnect"));
    expect(cancel).toHaveBeenCalledTimes(1);
    await expect(response.text()).rejects.toThrow("disconnect");
  });

  it("propagates downstream stream cancellation", async () => {
    vi.resetModules();
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }))));
    const { GET } = await import("@/app/api/headroom/proxy/[...path]/route.js");
    const response = await GET(new Request("http://router/api/headroom/proxy/stats"),
      { params: Promise.resolve({ path: ["stats"] }) });
    await response.body.cancel("viewer stopped reading");
    expect(cancel).toHaveBeenCalledWith("viewer stopped reading");
  });

  it("cancels an HTML body while dashboard rewriting is pending", async () => {
    vi.resetModules();
    const cancel = vi.fn();
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }),
      { headers: { "content-type": "text/html" } })));
    const { GET } = await import("@/app/api/headroom/proxy/[...path]/route.js");
    const pending = GET(new Request("http://router/api/headroom/proxy/dashboard", { signal: controller.signal }),
      { params: Promise.resolve({ path: ["dashboard"] }) });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort(new Error("disconnect"));
    expect((await pending).status).toBe(500);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
