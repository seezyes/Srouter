import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTOML } from "confbox";

const require = createRequire(import.meta.url);
const connect = require("../../cli/src/cli/commands/connect.js");
const { TOOLS, CLAUDE_MODELS } = require("../../cli/src/cli/commands/connectTools.js");
const { MultiSelect } = createRequire(new URL("../../cli/src/cli/commands/connect.js", import.meta.url))("enquirer");
const ctx = { baseUrl: "https://fixture.example", apiKey: "fixture-secret", model: "cc/fixture", claudeModels: {} };
const tool = id => TOOLS.find(entry => entry.id === id);
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, doc) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(doc)); };
let home, tty;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-cli-expansion-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
  else delete process.stdin.isTTY;
  fs.rmSync(home, { recursive: true, force: true });
});
const terminal = () => Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });

describe("connect selection and diagnostics", () => {
  it("keeps explicit tools and non-TTY Claude default without prompting", async () => {
    const prompt = vi.spyOn(MultiSelect.prototype, "run");
    expect((await connect.__test__.selectTools({})).map(t => t.id)).toEqual(["claude"]);
    terminal();
    expect((await connect.__test__.selectTools({ tools: ["codex"] })).map(t => t.id)).toEqual(["codex"]);
    expect(prompt).not.toHaveBeenCalled();
  });
  it("TTY cancellation returns 130 before network or config writes", async () => {
    terminal();
    vi.spyOn(MultiSelect.prototype, "run").mockRejectedValue(undefined);
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
    expect(await connect.run([ctx.baseUrl, "--password", "fixture-strong-password"])).toBe(130);
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.readdirSync(home)).toEqual([]);
  });
  it("TTY empty selection fails before network", async () => {
    terminal();
    vi.spyOn(MultiSelect.prototype, "run").mockResolvedValue([]);
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(connect.run([ctx.baseUrl, "--api-key", ctx.apiKey])).rejects.toThrow(/at least one/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("TTY multi-selection applies only selected tools and warns without blocking", async () => {
    terminal();
    vi.spyOn(MultiSelect.prototype, "run").mockResolvedValue(["codex", "opencode"]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [] }));
    expect(await connect.run([ctx.baseUrl, "--api-key", ctx.apiKey, "--model", ctx.model])).toBe(0);
    expect(fs.existsSync(tool("claude").paths()[0])).toBe(false);
    expect(fs.existsSync(tool("codex").paths()[0])).toBe(true);
    expect(read(tool("opencode").paths()[0]).agent.explorer.model).toBe(`srouter/${ctx.model}`);
    expect(console.log.mock.calls.flat().join("\n")).toContain("--model");
    expect(console.log.mock.calls.flat().join("\n")).not.toContain(ctx.apiKey);
  });
  it("warns for each missing selected Claude mapping, not present models or unselected tools", () => {
    const mappings = Object.fromEntries(CLAUDE_MODELS.map(m => [m.envKey, m.defaultValue]));
    connect.__test__.warnMissingModels([tool("claude")], { ...ctx, claudeModels: mappings }, [{ id: mappings[CLAUDE_MODELS[0].envKey] }]);
    const text = console.log.mock.calls.flat().join("\n");
    expect(console.log).toHaveBeenCalledTimes(CLAUDE_MODELS.length - 1);
    expect(text).not.toContain("--fable");
    for (const m of CLAUDE_MODELS.slice(1)) expect(text).toContain(`--${m.flag}`);
    expect(text).not.toContain("--model");
  });
  it("sanitizes terminal control characters in warning model IDs", () => {
    connect.__test__.warnMissingModels([tool("codex")], { ...ctx, model: "\x1b[31mBAD\nMODEL\x9b" }, []);
    expect(console.log.mock.calls[0][0]).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });
  it("still fails closed when the catalog is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [] }, { status: 503 }));
    await expect(connect.run([ctx.baseUrl, "--tools", "codex,opencode", "--api-key", ctx.apiKey])).rejects.toThrow(/catalog/);
    expect(fs.readdirSync(home)).toEqual([]);
  });
});

describe("auxiliary-agent ownership and migration", () => {
  it("Codex restores previous subagent model and preserves other agent settings", async () => {
    const file = tool("codex").paths()[0];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[agents]\ndefault_subagent_model = "foreign/model"\n[agents.subagent]\nkeep = true\n');
    await tool("codex").apply(ctx);
    expect(parseTOML(fs.readFileSync(file, "utf8")).agents).toEqual({ default_subagent_model: ctx.model, subagent: { keep: true } });
    await tool("codex").apply({ ...ctx, model: "cc/second" });
    await tool("codex").reset();
    expect(parseTOML(fs.readFileSync(file, "utf8")).agents).toEqual({ default_subagent_model: "foreign/model", subagent: { keep: true } });
  });
  it("OpenCode adds an owned explorer, repeat apply updates it, reset preserves siblings", async () => {
    const file = tool("opencode").paths()[0];
    write(file, { agent: { writer: { model: "foreign/writer" } } });
    await tool("opencode").apply(ctx);
    await tool("opencode").apply({ ...ctx, model: "cc/second" });
    expect(read(file).agent.explorer.model).toBe("srouter/cc/second");
    await tool("opencode").reset();
    expect(read(file)).toEqual({ agent: { writer: { model: "foreign/writer" } } });
  });
  it("preserves a foreign explorer through apply/reapply/reset", async () => {
    const file = tool("opencode").paths()[0];
    const original = { agent: { explorer: { model: "foreign/model", prompt: "keep" } } };
    write(file, original);
    await tool("opencode").apply(ctx);
    await tool("opencode").apply({ ...ctx, model: "cc/second" });
    expect(read(file).agent).toEqual(original.agent);
    await tool("opencode").reset();
    expect(read(file)).toEqual(original);
  });
  it.each(["codex", "opencode"])("%s refuses user changes to its new managed field", async id => {
    const entry = tool(id);
    await entry.apply(ctx);
    const file = entry.paths()[0];
    if (id === "codex") fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(`default_subagent_model = "${ctx.model}"`, 'default_subagent_model = "user/edit"'));
    else { const doc = read(file); doc.agent.explorer.model = "user/edit"; write(file, doc); }
    const before = fs.readFileSync(file, "utf8");
    await expect(entry.apply(ctx)).rejects.toThrow(/changed/);
    await expect(entry.reset()).rejects.toThrow(/changed/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
  it.each(["codex", "opencode"])("%s upgrades an exact old sidecar, preserving new-field before values", async id => {
    const entry = tool(id), file = entry.paths()[0];
    await entry.apply(ctx);
    const sidecar = `${file}.srouter-connect.json`;
    const record = read(sidecar);
    delete record.version;
    delete record.explorerManaged;
    record.fields = record.fields.filter(f => !["agents", "agent"].includes(f.keys[0]));
    write(sidecar, record);
    if (id === "codex") fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(`default_subagent_model = "${ctx.model}"`, 'default_subagent_model = "pre-upgrade"'));
    else { const doc = read(file); delete doc.agent; write(file, doc); }
    await entry.apply(ctx);
    expect(read(sidecar).version).toBe(2);
    await entry.reset();
    if (id === "codex") expect(parseTOML(fs.readFileSync(file, "utf8")).agents.default_subagent_model).toBe("pre-upgrade");
    else expect(read(file).agent).toBeUndefined();
  });
  it.each(["codex", "opencode"])("%s rejects an incomplete new sidecar instead of treating it as legacy", async id => {
    const entry = tool(id), file = entry.paths()[0];
    await entry.apply(ctx);
    const sidecar = `${file}.srouter-connect.json`, record = read(sidecar);
    record.fields.pop();
    write(sidecar, record);
    await expect(entry.reset()).rejects.toThrow(/Incomplete/);
  });
  it.each(["codex", "opencode"])("%s resets old sidecars without claiming new fields", async id => {
    const entry = tool(id), file = entry.paths()[0];
    await entry.apply(ctx);
    const sidecar = `${file}.srouter-connect.json`, record = read(sidecar);
    delete record.version;
    delete record.explorerManaged;
    record.fields = record.fields.filter(f => !["agents", "agent"].includes(f.keys[0]));
    write(sidecar, record);
    await entry.reset();
    if (id === "codex") expect(parseTOML(fs.readFileSync(file, "utf8")).agents.default_subagent_model).toBe(ctx.model);
    else expect(read(file).agent.explorer.model).toBe(`srouter/${ctx.model}`);
  });
  it.each(["codex", "opencode"])("%s checks legacy fields before migration, with no writes on conflict", async id => {
    const entry = tool(id), file = entry.paths()[0];
    await entry.apply(ctx);
    const sidecar = `${file}.srouter-connect.json`, record = read(sidecar);
    delete record.version;
    delete record.explorerManaged;
    record.fields = record.fields.filter(f => !["agents", "agent"].includes(f.keys[0]));
    record.fields[0].after = "unexpected";
    write(sidecar, record);
    const before = fs.readFileSync(file, "utf8"), beforeRecord = fs.readFileSync(sidecar, "utf8");
    await expect(entry.apply(ctx)).rejects.toThrow(/changed/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readFileSync(sidecar, "utf8")).toBe(beforeRecord);
  });
  it("preflights new agent path shapes before key creation or any write", async () => {
    const file = tool("opencode").paths()[0];
    write(file, { agent: "unsupported-shape" });
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(connect.run([ctx.baseUrl, "--tools", "codex,opencode", "--password", "fixture-strong-password"])).rejects.toThrow(/Invalid config section/);
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(tool("codex").paths()[0])).toBe(false);
    expect(read(file)).toEqual({ agent: "unsupported-shape" });
  });
});
