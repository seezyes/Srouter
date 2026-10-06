import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTOML, parseYAML } from "confbox";

const state = vi.hoisted(() => ({ home: "" }));
vi.mock("os", async original => {
  const actual = await original();
  return { ...actual, default: { ...actual.default, homedir: () => state.home }, homedir: () => state.home };
});
vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => Response.json(body, init) },
}));
vi.mock("child_process", () => ({
  exec: (_command, _options, callback) => { callback(new Error("fixture CLI unavailable")); return {}; },
}));
vi.mock("better-sqlite3", () => { throw new Error("No harness database in this fixture"); });
vi.mock("@/lib/db", () => ({ getApiKeys: vi.fn(async () => [{ key: "fixture-active-key", isActive: true }]) }));

import * as smelt from "@/app/api/cli-tools/smelt-settings/route.js";
import * as forge from "@/app/api/cli-tools/forge-settings/route.js";
import * as codewhale from "@/app/api/cli-tools/codewhale-settings/route.js";
import * as pi from "@/app/api/cli-tools/pi-settings/route.js";
import * as crush from "@/app/api/cli-tools/crush-settings/route.js";
import * as omp from "@/app/api/cli-tools/omp-settings/route.js";
import * as claude from "@/app/api/cli-tools/claude-settings/route.js";
import * as cline from "@/app/api/cli-tools/cline-settings/route.js";
import * as kilo from "@/app/api/cli-tools/kilo-settings/route.js";
import * as opencode from "@/app/api/cli-tools/opencode-settings/route.js";
import * as hermes from "@/app/api/cli-tools/hermes-settings/route.js";
import * as droid from "@/app/api/cli-tools/droid-settings/route.js";
import * as openclaw from "@/app/api/cli-tools/openclaw-settings/route.js";
import * as deepseek from "@/app/api/cli-tools/deepseek-tui-settings/route.js";
import { isSrouterEndpoint } from "@/app/api/cli-tools/_shared/managedConfig.js";
import { editOmpProvider } from "@/app/api/cli-tools/_shared/ompConfig.js";

const foreignUrl = "http://localhost:20128/v1";
const ownUrl = "http://127.0.0.1:20129/v1";
const cases = [
  ["Smelt", smelt, ".smelt/config.json", JSON.stringify({ baseUrl: foreignUrl, apiKey: "fixture", keep: true }), JSON.parse],
  ["Forge", forge, ".forge/config.toml", `[openai]\nbase_url = "${foreignUrl}"\napi_key = "fixture"\n`, parseTOML],
  ["CodeWhale", codewhale, ".codewhale/config.toml", `[openai]\nbase_url = "${foreignUrl}"\napi_key = "fixture"\n`, parseTOML],
  ["Pi", pi, ".pi/agent/models.json", JSON.stringify({ providers: { srouter: { baseUrl: foreignUrl } } }), JSON.parse],
  ["Crush", crush, ".config/crush/crush.json", JSON.stringify({ providers: { srouter: { base_url: foreignUrl } } }), JSON.parse],
  ["OMP", omp, ".omp/agent/models.yml", `providers:\n  srouter:\n    baseUrl: ${foreignUrl}\n`, parseYAML],
  ["Droid", droid, ".factory/settings.json", JSON.stringify({ customModels: [{ id: "custom:Srouter-0", baseUrl: foreignUrl }] }), JSON.parse],
  ["OpenClaw", openclaw, ".openclaw/openclaw.json", JSON.stringify({ models: { providers: { srouter: { baseUrl: foreignUrl } } } }), JSON.parse],
  ["DeepSeek TUI", deepseek, ".deepseek/config.toml", `provider = "openai"\n[providers.openai]\nbase_url = "${foreignUrl}"\n`, parseTOML],
];
let previousXdg;
beforeEach(async () => {
  state.home = await fs.mkdtemp(path.join(os.tmpdir(), "srouter-harness-isolation-"));
  previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(state.home, ".config");
});
afterEach(async () => {
  await fs.rm(state.home, { recursive: true, force: true });
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
});

async function write(relative, content) {
  const file = path.join(state.home, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}
function request(body) {
  return new Request("http://localhost/api/cli-tools", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("Harness config isolation", () => {
  it.each(cases)("%s neither claims nor edits a sibling router config", async (_name, route, relative, raw) => {
    const file = await write(relative, raw);
    expect((await (await route.GET()).json()).hasSrouter).toBe(false);
    expect((await route.POST(request({ baseUrl: ownUrl, apiKey: "fixture-new", model: "fixture/model" }))).status).toBe(409);
    expect((await route.DELETE()).status).toBe(409);
    expect(await fs.readFile(file, "utf8")).toBe(raw);
  });

  it.each(cases)("%s fails closed on a malformed existing file", async (_name, route, relative) => {
    const raw = "[malformed {";
    const file = await write(relative, raw);
    expect((await route.POST(request({ baseUrl: ownUrl, model: "fixture/model" }))).status).toBe(409);
    expect((await route.DELETE()).status).toBe(409);
    expect(await fs.readFile(file, "utf8")).toBe(raw);
  });

  it.each(cases)("%s applies and resets only its managed config", async (_name, route, relative, _raw, parse) => {
    expect((await route.POST(request({ baseUrl: ownUrl, model: "fixture/model" }))).status).toBe(200);
    expect((await (await route.GET()).json()).hasSrouter).toBe(true);
    const file = path.join(state.home, relative);
    expect(parse(await fs.readFile(file, "utf8"))).toBeTruthy();
    expect((await route.DELETE()).status).toBe(200);
  });

  it("Pi preserves other provider entries on apply/reset", async () => {
    const sibling = { baseUrl: foreignUrl, apiKey: "fixture-other" };
    const file = await write(".pi/agent/models.json", JSON.stringify({ keep: true, providers: { "9router": sibling } }));
    await pi.POST(request({ baseUrl: ownUrl }));
    expect(JSON.parse(await fs.readFile(file, "utf8")).providers["9router"]).toEqual(sibling);
    await pi.DELETE();
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ keep: true, providers: { "9router": sibling } });
  });

  it("OMP removes the full nested owned block without touching other YAML/comments", () => {
    const foreign = `  other:\n    baseUrl: ${foreignUrl}\n    discovery:\n      type: proxy\n`;
    const raw = `# keep\nproviders:\n  srouter:\n    baseUrl: ${ownUrl}\n    discovery:\n      type: proxy\n${foreign}ui:\n  theme: dark\n`;
    expect(editOmpProvider(raw).content).toBe(`# keep\nproviders:\n${foreign}ui:\n  theme: dark\n`);
    expect(() => editOmpProvider("providers: {}\nother:\n  srouter:\n    keep: true\n", "  srouter:\n    baseUrl: x"))
      .toThrow("Unsupported providers YAML layout");
  });

  it("OMP does not stop an owned block at a root-indented comment", () => {
    const raw = `providers:\n  srouter:\n    baseUrl: ${ownUrl}\n# keep comment\n    discovery:\n      type: proxy\n  other:\n    baseUrl: ${foreignUrl}\n`;
    const edited = editOmpProvider(raw).content;
    expect(edited).toContain("# keep comment");
    expect(parseYAML(edited)).toEqual({ providers: { other: { baseUrl: foreignUrl } } });
  });

  it("Claude preserves foreign or absent-base credentials and resets the owned Fable default", async () => {
    const foreign = JSON.stringify({ env: { ANTHROPIC_BASE_URL: foreignUrl, ANTHROPIC_AUTH_TOKEN: "fixture" } });
    const file = await write(".claude/settings.json", foreign);
    expect((await claude.POST(request({ env: { ANTHROPIC_BASE_URL: ownUrl } }))).status).toBe(409);
    expect((await (await claude.DELETE()).json()).skipped).toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe(foreign);
    const noBase = JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "fixture-official" } });
    await fs.writeFile(file, noBase);
    await claude.DELETE();
    expect(await fs.readFile(file, "utf8")).toBe(noBase);
    await fs.writeFile(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: ownUrl, ANTHROPIC_DEFAULT_FABLE_MODEL: "fixture", KEEP: "yes" } }));
    await claude.DELETE();
    expect(JSON.parse(await fs.readFile(file, "utf8")).env).toEqual({ KEEP: "yes" });
  });

  it("Cline preserves foreign settings/secrets and refuses malformed secrets before any write", async () => {
    const foreign = JSON.stringify({ actModeApiProvider: "openai", openAiBaseUrl: foreignUrl });
    const file = await write(".cline/data/globalState.json", foreign);
    const secrets = await write(".cline/data/secrets.json", '{"openAiApiKey":"fixture-other"}');
    expect((await (await cline.GET()).json()).hasSrouter).toBe(false);
    expect((await cline.POST(request({ baseUrl: ownUrl, apiKey: "fixture-new", model: "fixture/model" }))).status).toBe(409);
    expect((await (await cline.DELETE()).json()).skipped).toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe(foreign);
    const owned = JSON.stringify({ actModeApiProvider: "openai", planModeApiProvider: "anthropic", openAiBaseUrl: ownUrl, keep: true });
    await fs.writeFile(file, owned);
    await fs.writeFile(secrets, "{malformed");
    expect((await cline.DELETE()).status).toBe(409);
    expect(await fs.readFile(file, "utf8")).toBe(owned);
    await fs.writeFile(secrets, '{"openAiApiKey":"fixture","keep":"yes"}');
    expect((await cline.DELETE()).status).toBe(200);
    expect(JSON.parse(await fs.readFile(file, "utf8")).planModeApiProvider).toBe("anthropic");
    expect(JSON.parse(await fs.readFile(secrets, "utf8"))).toEqual({ keep: "yes" });
  });

  it("Kilo protects both foreign CLI and VS Code settings before modifying either file", async () => {
    const foreign = JSON.stringify({ "openai-compatible": { baseUrl: foreignUrl, apiKey: "fixture-other" } });
    const file = await write(".local/share/kilo/auth.json", foreign);
    expect((await (await kilo.GET()).json()).hasSrouter).toBe(false);
    expect((await kilo.POST(request({ baseUrl: ownUrl, apiKey: "fixture", model: "fixture/model" }))).status).toBe(409);
    expect((await kilo.DELETE()).status).toBe(409);
    expect(await fs.readFile(file, "utf8")).toBe(foreign);
    const owned = JSON.stringify({ "openai-compatible": { baseUrl: ownUrl }, other: { keep: true } });
    await fs.writeFile(file, owned);
    const editor = JSON.stringify({ "kilocode.customProvider": { baseURL: foreignUrl } });
    const editorFile = await write(".config/Code/User/settings.json", editor);
    expect((await kilo.DELETE()).status).toBe(409);
    expect(await fs.readFile(file, "utf8")).toBe(owned);
    expect(await fs.readFile(editorFile, "utf8")).toBe(editor);
  });

  it("OpenCode refuses foreign ownership on every write operation", async () => {
    const raw = JSON.stringify({ provider: { srouter: { options: { baseURL: foreignUrl } } }, model: "srouter/keep" });
    const file = await write(".config/opencode/opencode.json", raw);
    expect((await (await opencode.GET()).json()).hasSrouter).toBe(false);
    expect((await opencode.POST(request({ baseUrl: ownUrl, model: "new" }))).status).toBe(409);
    expect((await opencode.PATCH(request({ clearActiveModel: true }))).status).toBe(409);
    expect((await opencode.DELETE(request({}))).status).toBe(409);
    expect(await fs.readFile(file, "utf8")).toBe(raw);
  });

  it.each(["{malformed", "[]", '{"provider":[]}', '{"provider":{"srouter":{"options":[]}}}'])(
    "OpenCode preserves malformed or unsupported config %s", async raw => {
      const file = await write(".config/opencode/opencode.json", raw);
      expect((await opencode.POST(request({ baseUrl: ownUrl, model: "new" }))).status).toBe(409);
      expect((await opencode.PATCH(request({ clearActiveModel: true }))).status).toBe(409);
      expect((await opencode.DELETE(request({}))).status).toBe(409);
      expect(await fs.readFile(file, "utf8")).toBe(raw);
    });

  it("OpenCode accepts valid JSONC and preserves foreign providers and owned explorer on a single-model removal", async () => {
    const other = { options: { baseURL: foreignUrl } };
    const file = await write(".config/opencode/opencode.json", `// fixture comment\n${JSON.stringify({ provider: { other }, keep: "literal,}" })}`);
    expect((await opencode.POST(request({ baseUrl: ownUrl, models: ["a", "b"], subagentModel: "b" }))).status).toBe(200);
    const remove = new Request("http://localhost/api/cli-tools?model=a", { method: "DELETE" });
    expect((await opencode.DELETE(remove)).status).toBe(200);
    let config = JSON.parse(await fs.readFile(file, "utf8"));
    expect(config.provider.other).toEqual(other);
    expect(config.agent.explorer.model).toBe("srouter/b");
    expect(config.keep).toBe("literal,}");
    expect((await opencode.DELETE(request({}))).status).toBe(200);
    config = JSON.parse(await fs.readFile(file, "utf8"));
    expect(config.provider).toEqual({ other });
    expect(config.agent).toBeUndefined();
  });

  it("OpenCode does not replace an existing foreign explorer", async () => {
    const raw = JSON.stringify({ agent: { explorer: { model: "other/model" } } });
    const file = await write(".config/opencode/opencode.json", raw);
    expect((await opencode.POST(request({ baseUrl: ownUrl, model: "new" }))).status).toBe(409);
    expect(await fs.readFile(file, "utf8")).toBe(raw);
  });

  it("Hermes preserves foreign primary/delegation/auxiliary blocks and credentials", async () => {
    const raw = `model:\n  default: foreign\n  provider: custom\n  base_url: ${foreignUrl}\ndelegation:\n  provider: custom\n  base_url: ${foreignUrl}\nauxiliary:\n  vision:\n    provider: custom\n    base_url: ${foreignUrl}\n`;
    const file = await write(".hermes/config.yaml", raw);
    const env = await write(".hermes/.env", "OPENAI_API_KEY=fixture-other\n");
    expect((await (await hermes.GET()).json()).hasSrouter).toBe(false);
    expect((await hermes.POST(request({ baseUrl: ownUrl, model: "new", apiKey: "fixture-new" }))).status).toBe(409);
    expect((await (await hermes.DELETE()).json()).skipped).toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe(raw);
    expect(await fs.readFile(env, "utf8")).toBe("OPENAI_API_KEY=fixture-other\n");
  });

  it.each(["model: [", "model: {provider: custom}", "model: official", "auxiliary:\n  vision: [x]"])(
    "Hermes refuses malformed or unsupported YAML %s", async raw => {
      const file = await write(".hermes/config.yaml", raw);
      expect((await hermes.POST(request({ baseUrl: ownUrl, model: "new" }))).status).toBe(409);
      expect((await hermes.DELETE()).status).toBe(409);
      expect(await fs.readFile(file, "utf8")).toBe(raw);
    });

  it("Hermes resets only owned roles and leaves foreign roles, comments and env intact", async () => {
    const raw = `# keep\nauxiliary:\n  foreign:\n    provider: custom\n    base_url: ${foreignUrl}\nui:\n  theme: dark\n`;
    const file = await write(".hermes/config.yaml", raw);
    expect((await hermes.POST(request({ baseUrl: ownUrl, apiKey: "fixture", selections: [
      { role: "default", model: 'model"quoted' }, { role: "delegation", model: "delegate" }, { role: "vision", model: "vision" },
    ] }))).status).toBe(200);
    const configured = parseYAML(await fs.readFile(file, "utf8"));
    expect(configured.model.default).toBe('model"quoted');
    expect((await hermes.DELETE()).status).toBe(200);
    expect(await fs.readFile(file, "utf8")).toBe(raw);
    expect(await fs.readFile(path.join(state.home, ".hermes/.env"), "utf8")).toBe("OPENAI_API_KEY=fixture\n");
  });

  it("Hermes preflights shared credentials and does not change foreign auxiliary use", async () => {
    const raw = `auxiliary:\n  foreign:\n    provider: custom\n    base_url: ${foreignUrl}\n    api_key: \${OPENAI_API_KEY}\n`;
    const file = await write(".hermes/config.yaml", raw);
    const env = await write(".hermes/.env", "OPENAI_API_KEY=fixture-other\n");
    expect((await hermes.POST(request({ baseUrl: ownUrl, model: "new", apiKey: "fixture-new" }))).status).toBe(409);
    expect(await fs.readFile(file, "utf8")).toBe(raw);
    expect(await fs.readFile(env, "utf8")).toBe("OPENAI_API_KEY=fixture-other\n");
  });

  it("Hermes refuses a comment-interrupted block rather than leaving orphaned fields", async () => {
    const raw = `model:\n  provider: custom\n  base_url: ${ownUrl}\n# keep\n  extra: true\n`;
    const file = await write(".hermes/config.yaml", raw);
    expect((await hermes.POST(request({ baseUrl: ownUrl, model: "new" }))).status).toBe(409);
    expect((await hermes.DELETE()).status).toBe(409);
    expect(await fs.readFile(file, "utf8")).toBe(raw);
  });

  it("Hermes rejects role or env-line injection before creating a config", async () => {
    expect((await hermes.POST(request({ baseUrl: ownUrl, selections: [
      { role: "default", model: "new" }, { role: "vision:\ninjected", model: "new" },
    ] }))).status).toBe(400);
    expect((await hermes.POST(request({ baseUrl: ownUrl, model: "new", apiKey: "fixture\nOTHER=value" }))).status).toBe(400);
    await expect(fs.access(path.join(state.home, ".hermes/config.yaml"))).rejects.toThrow();
  });

  it("Droid preserves foreign custom models while selecting only the requested managed entry", async () => {
    const foreign = [{ id: "custom:Other", baseUrl: foreignUrl, index: 7 },
      { id: "custom:SrouterOther", baseUrl: foreignUrl, index: 8 }];
    const file = await write(".factory/settings.json", JSON.stringify({ keep: true, customModels: foreign }));
    expect((await droid.POST(request({ baseUrl: ownUrl, models: ["a", "b"], activeModel: "b" }))).status).toBe(200);
    const applied = JSON.parse(await fs.readFile(file, "utf8"));
    expect(applied.customModels.slice(0, 2)).toEqual(foreign);
    expect(applied.customModels.slice(2).map(model => model.model)).toEqual(["b", "a"]);
    expect((await droid.DELETE()).status).toBe(200);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ keep: true, customModels: foreign });
  });

  it("DeepSeek TUI preserves unrelated TOML sections across apply/reset", async () => {
    const file = await write(".deepseek/config.toml", 'provider = "deepseek"\n[ui]\ntheme = "dark"\n[providers.deepseek]\napi_key = "fixture-official"\n');
    expect((await deepseek.POST(request({ baseUrl: ownUrl, model: 'model"quoted' }))).status).toBe(200);
    expect(parseTOML(await fs.readFile(file, "utf8")).providers.openai.model).toBe('model"quoted');
    expect((await deepseek.DELETE()).status).toBe(200);
    expect(parseTOML(await fs.readFile(file, "utf8"))).toEqual({
      provider: "deepseek", ui: { theme: "dark" }, providers: { deepseek: { api_key: "fixture-official" } },
    });
  });

  it.each(["{malformed", JSON.stringify({ providers: { srouter: { baseUrl: foreignUrl } } })])(
    "OpenClaw preflights every agent file before changing main or earlier agents (%s)", async badAgent => {
      const firstDir = path.join(state.home, ".openclaw/agents/first");
      const secondDir = path.join(state.home, ".openclaw/agents/second");
      const mainRaw = JSON.stringify({ models: { providers: { srouter: { baseUrl: ownUrl } } },
        agents: { list: [{ id: "first", agentDir: firstDir }, { id: "second", agentDir: secondDir }] } });
      const main = await write(".openclaw/openclaw.json", mainRaw);
      const first = await write(".openclaw/agents/first/models.json", '{"providers":{"other":{"keep":true}}}');
      const second = await write(".openclaw/agents/second/models.json", badAgent);
      expect((await openclaw.POST(request({ baseUrl: ownUrl, model: "new" }))).status).toBe(409);
      expect((await openclaw.DELETE()).status).toBe(409);
      expect(await fs.readFile(main, "utf8")).toBe(mainRaw);
      expect(await fs.readFile(first, "utf8")).toBe('{"providers":{"other":{"keep":true}}}');
      expect(await fs.readFile(second, "utf8")).toBe(badAgent);
    });

  it("OpenClaw handles legacy primary strings and resets per-agent models without losing foreign fallbacks", async () => {
    const agentDir = path.join(state.home, ".openclaw/agents/first");
    const other = { baseUrl: foreignUrl, keep: true };
    const file = await write(".openclaw/openclaw.json", JSON.stringify({
      models: { providers: { other } },
      agents: { defaults: { model: "other/model" },
        list: [{ id: "first", agentDir, model: { primary: "other/model", fallbacks: ["other/fallback"] }, keep: true }] },
    }));
    const agent = await write(".openclaw/agents/first/models.json", JSON.stringify({ providers: { other }, keep: true }));
    expect((await openclaw.POST(request({ baseUrl: ownUrl, model: "default", agentModels: { first: "special" } }))).status).toBe(200);
    const applied = JSON.parse(await fs.readFile(file, "utf8"));
    expect(applied.agents.defaults.model.primary).toBe("srouter/default");
    expect(applied.agents.list[0].model).toEqual({ primary: "srouter/special", fallbacks: ["other/fallback"] });
    expect((await openclaw.DELETE()).status).toBe(200);
    const reset = JSON.parse(await fs.readFile(file, "utf8"));
    expect(reset.models.providers).toEqual({ other });
    expect(reset.agents.list[0]).toMatchObject({ model: { fallbacks: ["other/fallback"] }, keep: true });
    expect(JSON.parse(await fs.readFile(agent, "utf8"))).toEqual({ providers: { other }, keep: true });
  });

  it.each([
    "https://example.com/path/20127", "https://srouter.example/v1", "http://localhost:20128/v1",
    "http://localhost:201270/v1", "http://user:pass@localhost:20127/v1", "not-a-url",
  ])("does not infer ownership from lookalike URL %s", value => {
    expect(isSrouterEndpoint(value)).toBe(false);
  });
  it.each(["http://localhost:20127/v1", ownUrl, "http://[::1]:20129/v1", "https://srouter.local/v1"])(
    "recognizes exact Srouter endpoint %s", value => { expect(isSrouterEndpoint(value)).toBe(true); });
});
