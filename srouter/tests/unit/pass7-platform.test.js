import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateFile, evaluateSource, jsonResponse, readSource } from "./pass7-source-fixtures.js";
import { isStrongInitialPassword } from "@/lib/auth/password.js";
import { parseTOML } from "confbox";

const require = createRequire(import.meta.url);
let home;
afterEach(() => {
  vi.restoreAllMocks();
  if (home) { fs.rmSync(home, { recursive: true, force: true }); home = null; }
});
const newHome = () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-pass7-codex-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  fs.mkdirSync(path.join(home, ".codex"));
  return path.join(home, ".codex", "config.toml");
};
const codexRequest = () => new Request("http://localhost/api/cli-tools/codex-settings", {
  method: "POST", body: JSON.stringify({ baseUrl: "https://owned.example", apiKey: "fixture-key", model: "test/model" }),
});

describe("HR-05/07/08/10 dashboard safety", () => {
  it("HR-05 uses the branded login cookie for password-based connect", async () => {
    const connect = require("../../cli/src/cli/commands/connect.js");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (url.endsWith("/api/auth/login")) return Response.json({ success: true }, { headers: { "set-cookie": "srouter_auth_token=fixture-session; HttpOnly" } });
      if (url.endsWith("/api/keys")) {
        expect(init.headers.Cookie).toBe("srouter_auth_token=fixture-session");
        return Response.json({ keys: [{ key: "fixture-key", name: "Claude Code", isActive: true }] });
      }
      return Response.json({ data: [] });
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await connect.run(["https://gateway.example", "--password", "fixture-strong-password", "--key-name", "Claude Code", "--print-env"])).toBe(0);
    expect(fetch).toHaveBeenCalled();
    expect(log.mock.calls.flat().join("")).not.toContain("fixture-key");
    expect(log.mock.calls.flat().join("")).not.toContain("fixture-session");
  });
  it("HR-07 refuses malformed TOML without any config/sidecar write", async () => {
    const config = newHome();
    const malformed = "[profiles.foreign\nmodel='foreign'\n";
    fs.writeFileSync(config, malformed);
    const codex = await import("@/app/api/cli-tools/codex-settings/route.js");
    expect((await codex.POST(codexRequest())).status).toBe(409);
    expect((await codex.DELETE()).status).toBe(409);
    expect(fs.readFileSync(config, "utf8")).toBe(malformed);
    expect(fs.readdirSync(path.dirname(config))).toEqual(["config.toml"]);
  });
  it("HR-08 restores owned fields and never alters auth or foreign agents", async () => {
    const config = newHome();
    const original = 'model="foreign"\nmodel_provider="openai"\n[agents]\ndefault_subagent_model="foreign-mini"\n[agents.subagent]\nmodel="foreign-role"\n';
    fs.writeFileSync(config, original);
    const authPath = path.join(home, ".codex", "auth.json");
    const auth = '{"OPENAI_API_KEY":"foreign-key","auth_mode":"apikey"}';
    fs.writeFileSync(authPath, auth);
    const codex = await import("@/app/api/cli-tools/codex-settings/route.js");
    expect((await codex.POST(codexRequest())).status).toBe(200);
    expect((await codex.POST(codexRequest())).status).toBe(200);
    fs.appendFileSync(config, '\n[foreign]\nkeep=true\n');
    expect((await codex.DELETE()).status).toBe(200);
    const reset = parseTOML(fs.readFileSync(config, "utf8"));
    expect(reset).toMatchObject({ model: "foreign", model_provider: "openai", agents: { default_subagent_model: "foreign-mini", subagent: { model: "foreign-role" } }, foreign: { keep: true } });
    expect(reset.model_providers?.srouter).toBeUndefined();
    expect(fs.readFileSync(authPath, "utf8")).toBe(auth);
    expect(fs.readFileSync(`${config}.bak-srouter`, "utf8")).toBe(original);
  });
  it("HR-08 refuses changed managed fields and partial ownership", async () => {
    const config = newHome();
    const codex = await import("@/app/api/cli-tools/codex-settings/route.js");
    expect((await codex.POST(codexRequest())).status).toBe(200);
    const text = fs.readFileSync(config, "utf8").replace("test/model", "user/model");
    fs.writeFileSync(config, text);
    expect((await codex.DELETE()).status).toBe(409);
    expect(fs.readFileSync(config, "utf8")).toBe(text);
    fs.writeFileSync(path.join(home, ".codex", ".srouter-dashboard.json"), "{}");
    expect((await codex.DELETE()).status).toBe(409);
  });
  it.each(["123456", "change-me-in-production", "short", "", 42])("HR-10 rejects weak replacement %s before hashing", async password => {
    const save = vi.fn();
    const hash = vi.fn();
    const route = evaluateFile("src/app/api/settings/route.js", {
      NextResponse: jsonResponse, isStrongInitialPassword, getSettings: async () => ({}),
      updateSettings: save, bcrypt: { hash, genSalt: vi.fn() },
    });
    expect((await route.PATCH({ json: async () => ({ newPassword: password }) })).status).toBe(400);
    expect(hash).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});

describe("HR-02/03/04/22 launcher isolation", () => {
  const cli = readSource("cli/cli.js");
  it("HR-02 resolves PID files under selected DATA_DIR", () => {
    const context = evaluateSource(cli.slice(cli.indexOf("function getAppDataDir()"), cli.indexOf("// Kill PID from file")), {
      path, os, process: { platform: "win32", env: { DATA_DIR: path.resolve("fixture-isolated"), APPDATA: "default-home" } },
    });
    expect(context.getAppDataDir()).toBe(path.resolve("fixture-isolated"));
  });
  it("HR-03 refuses a foreign occupied port without executing any kill", async () => {
    const exec = vi.fn();
    const server = new EventEmitter();
    server.listen = () => { queueMicrotask(() => server.emit("error", new Error("EADDRINUSE"))); };
    const start = cli.indexOf("function killProcessOnPort(");
    const context = evaluateSource(cli.slice(start, cli.indexOf("\n//", start)), {
      net: { createServer: () => server }, host: "127.0.0.1", execSync: exec,
    });
    await expect(context.killProcessOnPort(20128)).rejects.toThrow(/unavailable/);
    expect(exec).not.toHaveBeenCalled();
  });
  it("HR-03 rejects PID-file ownership without an owned ancestor", () => {
    const start = cli.indexOf("const ownedChildPids");
    const end = cli.indexOf("// Compare semver", start);
    const context = evaluateSource(cli.slice(start, end), {
      process: { pid: 1, platform: "linux" }, execFileSync: () => "1",
    });
    expect(context.isOwnedProcess(777)).toBe(false);
  });
  it("HR-04 forwards the exact bind host to detached tray", () => {
    const start = cli.indexOf("const bgProcess = spawn");
    const spawn = vi.fn(() => ({ unref() {} }));
    evaluateSource(cli.slice(start, cli.indexOf("bgProcess.unref()", start) + "bgProcess.unref();".length), {
      spawn, port: 20231, host: "127.0.0.1", __filename: "fixture-cli",
      process: { execPath: "fixture-node", env: { DATA_DIR: "fixture-data" } },
    });
    expect(spawn.mock.calls[0][1]).toContain("--host");
    expect(spawn.mock.calls[0][1]).toContain("127.0.0.1");
    expect(spawn.mock.calls[0][2].env.DATA_DIR).toBe("fixture-data");
  });
  it.each(["--help", "--version"])("HR-22 metadata %s never provisions runtime", flag => {
    const heal = vi.fn();
    const exit = new Error("fixture-exit");
    expect(() => evaluateSource(`(function(){\n${cli.replace(/^#![^\n]*\n/, "")}\n})();`, {
      require: name => {
        if (name === "./package.json") return { name: "srouter", version: "0.16.0" };
        if (name.includes("sqliteRuntime")) return { ensureSqliteRuntime: heal };
        if (name.includes("trayRuntime")) return { ensureTrayRuntime: heal };
        return require(name);
      },
      process: { argv: ["node", "cli", flag], env: {}, exit: () => { throw exit; } },
      console: { log() {} },
    })).toThrow(exit);
    expect(heal).not.toHaveBeenCalled();
  });
});

describe("HR-06/23 bounded h2c downgrade", () => {
  function wrapper() {
    class Incoming extends Readable { constructor(socket) { super(); this.socket = socket; } _read() {} }
    class ServerResponse extends EventEmitter { assignSocket() {} }
    const http = { IncomingMessage: Incoming, ServerResponse, createServer: () => new EventEmitter() };
    evaluateSource(readSource("custom-server.js"), {
      require: name => name === "http" ? http : name === "crypto" ? { randomBytes: () => Buffer.alloc(24) } : require(name),
      module: {}, __dirname: "fixture", process: { env: {} },
    });
    const handle = vi.fn(async req => {
      const chunks = [];
      for await (const bytes of req) chunks.push(bytes);
      return Buffer.concat(chunks).toString();
    });
    const server = http.createServer(handle);
    const socket = () => Object.assign(new EventEmitter(), {
      remoteAddress: "127.0.0.1", destroy: vi.fn(), end() {}, resume() {},
    });
    const upgrade = (headers, s, head = Buffer.alloc(0)) => server.emit("upgrade", { method: "POST", url: "/v1/chat/completions", headers: { upgrade: "h2c", ...headers } }, s, head);
    return { socket, handle, upgrade };
  }
  it("HR-06 rejects oversized declaration before handler and buffer allocation", () => {
    const { socket, handle, upgrade } = wrapper();
    const s = socket();
    upgrade({ "content-length": String(128 * 1024 * 1024) }, s);
    expect(s.destroy).toHaveBeenCalled();
    expect(s.listenerCount("data")).toBe(0);
    expect(handle).not.toHaveBeenCalled();
  });
  it("HR-23 decodes chunked JSON across arbitrary TCP boundaries", async () => {
    const { socket, handle, upgrade } = wrapper();
    const s = socket();
    upgrade({ "transfer-encoding": "chunked" }, s, Buffer.from("3\r\n{"));
    for (const bytes of ['"a', '\r', '\n4\r\n":1}', '\r\n0\r\n\r\n']) s.emit("data", Buffer.from(bytes));
    await new Promise(resolve => setImmediate(resolve));
    expect(await handle.mock.results[0].value).toBe('{"a":1}');
    expect(handle.mock.calls[0][0].headers["transfer-encoding"]).toBeUndefined();
    expect(handle.mock.calls[0][0].headers["content-length"]).toBe("7");
    expect(s.listenerCount("data")).toBe(0);
  });
  it("HR-06 refuses oversized chunk and ambiguous framing without dispatch", () => {
    const { socket, handle, upgrade } = wrapper();
    const a = socket(), b = socket();
    upgrade({ "transfer-encoding": "chunked" }, a, Buffer.from("8000000\r\n"));
    upgrade({ "transfer-encoding": "chunked", "content-length": "1" }, b);
    expect(a.destroy).toHaveBeenCalled(); expect(b.destroy).toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });
});
