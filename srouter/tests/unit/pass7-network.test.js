import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateFile, jsonResponse } from "./pass7-source-fixtures.js";

afterEach(() => vi.restoreAllMocks());
describe("HR-09 MCP remote SSRF boundary", () => {
  function fixture(fetch, addresses = [{ address: "93.184.216.34", family: 4 }]) {
    const guard = evaluateFile("src/shared/utils/ssrfGuard.js", {
      dns: { promises: { lookup: async () => addresses } }, fetch,
    });
    return evaluateFile("src/app/api/cli-tools/cowork-mcp-tools/route.js", {
      NextResponse: jsonResponse, isLocalRequest: () => false,
      assertPublicUrlResolved: guard.assertPublicUrlResolved, fetchPublic: guard.fetchPublic,
    });
  }
  it("HR-09 checks resolved public hosts and uses manual redirects on all three calls", async () => {
    const fetch = vi.fn(async (_url, init) => {
      expect(init.redirect).toBe("manual");
      return Response.json({ result: { tools: [{ name: "fixture" }] } });
    });
    const response = await fixture(fetch).POST({ json: async () => ({ url: "https://public.example/mcp" }) });
    expect((await response.json()).tools).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("HR-09 rejects public DNS names resolving to private addresses before fetch", async () => {
    const fetch = vi.fn();
    expect((await fixture(fetch, [{ address: "127.0.0.1", family: 4 }]).POST({
      json: async () => ({ url: "https://public.example/mcp" }),
    })).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("HR-09 never follows a public redirect to internal MCP", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 307, headers: { location: "http://127.0.0.1/private" } }));
    const result = await fixture(fetch).POST({ json: async () => ({ url: "https://public.example/mcp" }) });
    expect((await result.json()).error).toMatch(/Blocked/);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("HR-11/24/25 tunnel instance, cancellation and named mode", () => {
  function manager(overrides = {}) {
    let saved = {}, settings = {};
    const quick = vi.fn(async () => ({ tunnelUrl: "https://fixture.trycloudflare.com" }));
    const named = vi.fn(async () => ({ tunnelUrl: "https://fixture.example" }));
    const context = evaluateFile("src/lib/tunnel/cloudflare/manager.js", {
      process: { env: { PORT: "20129" } },
      loadState: () => saved, saveState: value => { saved = value; }, generateShortId: () => "fixture",
      isCloudflaredRunning: () => false, killCloudflared() {}, clearPid() {}, setUnexpectedExitHandler() {},
      spawnQuickTunnel: quick, spawnNamedTunnel: named,
      getSettings: async () => settings,
      updateSettings: async values => { settings = { ...settings, ...values }; return settings; },
      waitForHealth: async () => {}, probeUrlAlive: async () => true, WORKER_URL: "https://fixture.invalid",
      isNamedTunnelConfigured: () => false, validateNamedTunnelConfig: () => ({ ok: true }),
      NAMED_TUNNEL_HOSTNAME: "fixture.example",
      fetch: async () => new Response(""), ...overrides,
    });
    return { context, quick, named, saved: () => saved, settings: () => settings };
  }
  it("HR-11 defaults to running PORT, never the frozen instance port", async () => {
    const { context, quick } = manager();
    await context.enableTunnel();
    expect(quick.mock.calls[0][0]).toBe(20129);
    expect(quick.mock.calls[0][2]).toBeInstanceOf(AbortSignal);
    await expect(context.enableTunnel(20128)).rejects.toThrow(/Invalid/);
  });
  it("HR-24 disable wins while initial registration awaits", async () => {
    let release, started;
    const registration = new Promise(r => { release = r; });
    const begin = new Promise(r => { started = r; });
    const fixture = manager({ fetch: async () => { started(); await registration; return new Response(""); } });
    const enable = fixture.context.enableTunnel();
    const rejected = expect(enable).rejects.toThrow(/cancelled/);
    await begin;
    await fixture.context.disableTunnel();
    release();
    await rejected;
    expect(fixture.settings().tunnelEnabled).toBe(false);
    expect(fixture.saved().tunnelUrl ?? null).toBeNull();
  });
  it("HR-24 disable wins while an URL-update callback awaits registration", async () => {
    let callback, release, started;
    const registration = new Promise(r => { release = r; });
    const begin = new Promise(r => { started = r; });
    let count = 0;
    const fixture = manager({
      spawnQuickTunnel: async (_port, cb) => { callback = cb; return { tunnelUrl: "https://fixture.trycloudflare.com" }; },
      fetch: async () => { if (++count > 1) { started(); await registration; } return new Response(""); },
    });
    await fixture.context.enableTunnel();
    const update = callback("https://second.trycloudflare.com");
    const rejected = expect(update).rejects.toThrow(/cancelled/);
    await begin; await fixture.context.disableTunnel(); release(); await rejected;
    expect(fixture.settings().tunnelEnabled).toBe(false);
    expect(fixture.saved().tunnelUrl).toBeNull();
  });
  it("HR-25 selects named spawn and stable public hostname without worker registration", async () => {
    const fetch = vi.fn();
    const fixture = manager({ isNamedTunnelConfigured: () => true, fetch });
    const result = await fixture.context.enableTunnel();
    expect(result).toMatchObject({ named: true, publicUrl: "https://fixture.example" });
    expect(fixture.quick).not.toHaveBeenCalled();
    expect(fixture.named.mock.calls[0].slice(0, 2)).toEqual([20129, "fixture.example"]);
    expect(fetch).not.toHaveBeenCalled();
    expect((await fixture.context.getTunnelStatus()).publicUrl).toBe("https://fixture.example");
  });
  it("HR-25 rejects partial/conflicting named configuration instead of quick fallback", () => {
    const config = evaluateFile("src/lib/tunnel/cloudflare/config.js", { process: { env: { TUNNEL_HOSTNAME: "https://bad.example/path" } } });
    expect(config.isNamedTunnelConfigured()).toBe(true);
    expect(config.validateNamedTunnelConfig().ok).toBe(false);
    expect(config.validateNamedTunnelConfig({ hostname: "valid.example", token: "fixture", credFile: "fixture.json" }).ok).toBe(false);
    expect(config.validateNamedTunnelConfig({ hostname: "valid.example", token: "fixture", credFile: "" }).ok).toBe(true);
  });
  it("HR-25 named cloudflared receives validated ingress and keeps token out of argv/config", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-pass7-named-"));
    const child = Object.assign(new EventEmitter(), { pid: 98765, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
    const spawn = vi.fn((_file, _args, opts) => {
      expect(opts.env.TUNNEL_TOKEN).toBe("fixture-token-never-log");
      queueMicrotask(() => child.stderr.emit("data", Buffer.from("Registered tunnel connection")));
      return child;
    });
    const config = evaluateFile("src/lib/tunnel/cloudflare/config.js", { process: { env: { TUNNEL_HOSTNAME: "fixture.example", TUNNEL_TOKEN: "fixture-token-never-log" } } });
    const cloud = evaluateFile("src/lib/tunnel/cloudflare/cloudflared.js", {
      fs, path, os: { platform: () => "win32", tmpdir: () => root }, DATA_DIR: root,
      spawn, savePid() {}, loadPid: () => null, clearPid() {},
      NAMED_TUNNEL_TOKEN: "fixture-token-never-log", NAMED_TUNNEL_CRED_FILE: "", NAMED_TUNNEL_ID: "",
      validateNamedTunnelConfig: config.validateNamedTunnelConfig,
    });
    cloud.ensureCloudflared = async () => path.join(root, "fixture-cloudflared.exe");
    try {
      expect((await cloud.spawnNamedTunnel(20129, "fixture.example")).tunnelUrl).toBe("https://fixture.example");
      const args = spawn.mock.calls[0][1];
      expect(args.join(" ")).not.toContain("fixture-token-never-log");
      const text = fs.readFileSync(args[args.indexOf("--config") + 1], "utf8");
      expect(text).toContain("http://127.0.0.1:20129");
      expect(text).not.toContain("fixture-token-never-log");
    } finally {
      child.emit("exit", 0);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
