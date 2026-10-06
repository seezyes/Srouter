import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { TOOLS } = require("../../cli/src/cli/commands/connectTools.js");
const connect = require("../../cli/src/cli/commands/connect.js");
const ctx = { baseUrl: "https://gateway.example", apiKey: "fixture-key-never-log", model: "cc/model", claudeModels: {} };
let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-connect-safety-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); });
const tool = (id) => TOOLS.find((entry) => entry.id === id);
function write(file, doc) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(doc)); }
describe("remote connect isolation", () => {
  it("refuses linked directories without changing their target", async () => {
    const target = path.join(home, "foreign");
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(home, ".claude"), process.platform === "win32" ? "junction" : "dir");
    await expect(tool("claude").apply(ctx)).rejects.toThrow(/linked/);
    expect(fs.readdirSync(target)).toEqual([]);
    fs.unlinkSync(path.join(home, ".claude"));
  });
  it("rejects incomplete or duplicate ownership fields", async () => {
    const entry = tool("claude");
    await entry.apply(ctx);
    const file = entry.paths()[0];
    const sidecar = `${file}.srouter-connect.json`;
    const record = JSON.parse(fs.readFileSync(sidecar));
    const before = fs.readFileSync(file, "utf8");
    fs.writeFileSync(sidecar, JSON.stringify({ ...record, fields: [] }));
    await expect(entry.apply(ctx)).rejects.toThrow(/Incomplete/);
    fs.writeFileSync(sidecar, JSON.stringify({ ...record, fields: record.fields.map(() => record.fields[0]) }));
    await expect(entry.reset()).rejects.toThrow(/Incomplete/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
  it("does not write configs when model discovery fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}, { status: 503 }));
    await expect(connect.run(["https://gateway.example", "--api-key", ctx.apiKey])).rejects.toThrow(/catalog/);
    expect(fs.existsSync(tool("claude").paths()[0])).toBe(false);
  });
  it.each(TOOLS.map((entry) => entry.id))("%s reset leaves unmanaged documents byte-identical", async (id) => {
    const entry = tool(id);
    for (const file of entry.paths()) write(file, { keep: "foreign" });
    const before = entry.paths().map((file) => fs.readFileSync(file, "utf8"));
    // Codex is TOML: malformed input must refuse, never replace.
    if (id === "codex") await expect(entry.reset()).rejects.toThrow();
    else expect(await entry.reset()).toEqual([]);
    expect(entry.paths().map((file) => fs.readFileSync(file, "utf8"))).toEqual(before);
  });
  it("refuses official Claude credentials and sibling-router endpoints", async () => {
    const file = tool("claude").paths()[0];
    for (const env of [{ ANTHROPIC_API_KEY: "fixture-official" }, { ANTHROPIC_BASE_URL: "http://localhost:20128/v1" }]) {
      write(file, { env });
      const before = fs.readFileSync(file, "utf8");
      await expect(tool("claude").apply(ctx)).rejects.toThrow(/another router/);
      expect(fs.readFileSync(file, "utf8")).toBe(before);
    }
  });
  it("preserves OpenCode explorer and restores original model on reset", async () => {
    const file = tool("opencode").paths()[0];
    const original = { model: "other/model", provider: { other: { options: { apiKey: "fixture-other" } } }, agent: { explorer: { model: "other/model" } } };
    write(file, original);
    await tool("opencode").apply(ctx);
    expect(JSON.parse(fs.readFileSync(file)).agent).toEqual(original.agent);
    await tool("opencode").reset();
    expect(JSON.parse(fs.readFileSync(file))).toEqual(original);
  });
  it("repeat apply/reset restores pre-connect values and preserves unrelated edits", async () => {
    const file = tool("droid").paths()[0];
    const original = [{ id: "user", index: 12, model: "user/model" }];
    write(file, { customModels: original });
    await tool("droid").apply(ctx);
    await tool("droid").apply({ ...ctx, model: "cc/second" });
    const doc = JSON.parse(fs.readFileSync(file));
    expect(doc.customModels[0]).toEqual(original[0]);
    doc.keep = true;
    write(file, doc);
    await tool("droid").reset();
    expect(JSON.parse(fs.readFileSync(file))).toEqual({ customModels: original, keep: true });
  });
  it("does not reset user-modified managed fields", async () => {
    const file = tool("kilo").paths()[0];
    await tool("kilo").apply(ctx);
    const doc = JSON.parse(fs.readFileSync(file));
    doc["openai-compatible"].baseUrl = "https://foreign.example/v1";
    write(file, doc);
    await expect(tool("kilo").reset()).rejects.toThrow(/changed/);
    expect(JSON.parse(fs.readFileSync(file))).toEqual(doc);
  });
  it("preflights both Cline files before writing either", async () => {
    const [state, secrets] = tool("cline").paths();
    write(state, { actModeApiProvider: "cline", keep: true });
    fs.writeFileSync(secrets, "{");
    await expect(tool("cline").apply(ctx)).rejects.toThrow();
    expect(JSON.parse(fs.readFileSync(state))).toEqual({ actModeApiProvider: "cline", keep: true });
  });
  it("refuses remote HTTP, URL credentials and default password before network", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(connect.run(["http://foreign.example", "--api-key", ctx.apiKey])).rejects.toThrow(/HTTPS/);
    expect(() => connect.__test__.normalizeServerUrl("https://user:pw@example.com")).toThrow();
    await expect(connect.run(["https://gateway.example", "--password", "123456"])).rejects.toThrow(/default/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("prints only an env template, with bounded same-origin calls", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [] }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await connect.run(["https://gateway.example", "--api-key", ctx.apiKey, "--print-env"])).toBe(0);
    expect(log.mock.calls.flat().join("")).not.toContain(ctx.apiKey);
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
  });
});
