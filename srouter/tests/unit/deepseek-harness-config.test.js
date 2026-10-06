import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseYAML } from "confbox";

const state = vi.hoisted(() => ({ home: "" }));
vi.mock("os", async original => {
  const actual = await original();
  return { ...actual, default: { ...actual.default, homedir: () => state.home }, homedir: () => state.home };
});
vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => Response.json(body, init) } }));
vi.mock("@/lib/db", () => ({ getApiKeys: vi.fn(async () => { throw new Error("Fixture must not access database"); }) }));

import * as route from "@/app/api/cli-tools/deepseek-harness-settings/route.js";
import {
  applySrouterProvider, removeSrouterProvider, setCredentialRef, removeCredentialRef,
  findProviderEntry, DSH_KEY_REF, isOurProvider, normalizeModels,
} from "@/app/api/cli-tools/deepseek-harness-settings/dshConfig.js";
import {
  DSH_REASONING_LEVELS, FALLBACK_REASONING_LEVELS, dshReasoningLevels, dshModelLevels,
  DSH_INPUT_MODALITIES, dshModelInput, dshModelVision,
} from "@/app/api/cli-tools/deepseek-harness-settings/reasoningLevels.js";
import * as thinkingRegistry from "open-sse/providers/thinkingLevels.js";
import * as capabilityRegistry from "open-sse/providers/capabilities.js";
import { getApiKeys } from "@/lib/db";

const baseURL = "http://127.0.0.1:20129/v1";
const options = { baseURL, models: ["deepseek/deepseek-v4-pro"] };
const reasoningEfforts = { low: "low", medium: "medium", high: "high", max: "max" };
const levels = "            reasoningEfforts:\n              low: low\n              medium: medium\n              high: high\n              max: max\n";
const modelWithLevels = id => ({ id, reasoningEfforts });
const fixture = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: high
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: dark
`;
const otherProvider = `      other:
        baseURL: https://other.example/v1
        models:
          - id: other.model
`;
const entry = `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    keep: yes
    providers:
${otherProvider}`;
const records = `version: 1
# session comment
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: fixture-session-secret
  deepseek-account-platform/default:
    kind: grant
    payload:
      version: 1
      token: fixture-account-secret
`;
const provider = content => findProviderEntry(parseYAML(content)).providers.srouter;
const foreign = `- id: llm-pi-ai\n  config:\n    providers:\n      srouter:\n        baseURL: http://localhost:20128/v1\n`;
let priorHome;
beforeEach(async () => {
  state.home = await fs.mkdtemp(path.join(os.tmpdir(), "srouter-dsh-unit-"));
  priorHome = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(state.home, ".dsh");
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(state.home, { recursive: true, force: true });
  if (priorHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = priorHome;
});
const configPath = (profile = "desktop") => path.join(process.env.DSH_HOME, "profiles", profile, "cordis.patch.yml");
const credentialsPath = () => path.join(process.env.DSH_HOME, ".credentials.yaml");
async function write(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}
async function profile(name = "desktop") {
  await fs.mkdir(path.dirname(configPath(name)), { recursive: true });
}
function request(body = {}, origin) {
  return new Request("http://127.0.0.1:20129/api/cli-tools/deepseek-harness-settings", {
    method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify({ baseUrl: baseURL, apiKey: "fixture-srouter-key", models: options.models, ...body }),
  });
}
describe("DSH per-model reasoning registry", () => {
  it.each([
    ["cx/gpt-6.1-sol", ["low", "medium", "high", "xhigh", "max"]],
    ["cx/gpt-6-luna", ["low", "medium", "high", "xhigh", "max"]],
    ["burngate/deepseek/deepseek-v4.1-flash", ["low", "medium", "high", "xhigh", "max"]],
    ["deepseek/deepseek-v4-pro", ["high", "max"]],
    ["cx/gpt-5.6-luna", ["minimal", "low", "medium", "high", "xhigh", "max"]],
    ["unknown/model-x", false],
    ["just-a-combo", FALLBACK_REASONING_LEVELS],
    ["", FALLBACK_REASONING_LEVELS],
    [null, FALLBACK_REASONING_LEVELS],
    ["cx/", FALLBACK_REASONING_LEVELS],
    ["/model", FALLBACK_REASONING_LEVELS],
  ])("resolves DSH reasoning levels for %j", (id, expected) => {
    expect(dshReasoningLevels(id)).toEqual(expected);
  });
  it("trims model ids and resolves provider aliases", () => {
    expect(dshReasoningLevels("  cx/gpt-6.1-sol  ")).toEqual(dshReasoningLevels("codex/gpt-6.1-sol"));
  });
  it("filters unsupported registry levels and deduplicates in DSH order", () => {
    vi.spyOn(thinkingRegistry, "getThinkingLevels").mockReturnValue(["max", "none", "xhigh", "minimal", "thinking", "ultra", "xhigh"]);
    expect(dshReasoningLevels("cx/gpt-6.1-sol")).toEqual(["minimal", "xhigh", "max"]);
    expect(DSH_REASONING_LEVELS).not.toContain("off");
  });
  it.each([[["none", "thinking", "ultra"]], [[]], [undefined], ["high"]])("falls back for unusable registry levels %j", levels => {
    vi.spyOn(thinkingRegistry, "getThinkingLevels").mockReturnValue(levels);
    expect(dshReasoningLevels("cx/gpt-6.1-sol")).toEqual(FALLBACK_REASONING_LEVELS);
  });
  it("falls back when registry lookup or model string conversion throws", () => {
    vi.spyOn(thinkingRegistry, "getThinkingLevels").mockImplementation(() => { throw new Error("fixture registry failure"); });
    expect(dshReasoningLevels("cx/gpt-6.1-sol")).toEqual(FALLBACK_REASONING_LEVELS);
    expect(dshReasoningLevels({ toString() { throw new Error("fixture conversion failure"); } })).toEqual(FALLBACK_REASONING_LEVELS);
  });
  it("maps reasoning, nonreasoning and combo ids without losing special object keys", () => {
    expect(dshModelLevels(["cx/gpt-6.1-sol", "unknown/model-x", "combo", "__proto__"])).toEqual({
      "cx/gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max"],
      "unknown/model-x": false, combo: FALLBACK_REASONING_LEVELS, ["__proto__"]: FALLBACK_REASONING_LEVELS,
    });
  });
});
describe("DSH per-model input registry", () => {
  it.each([
    ["cx/gpt-6-luna", ["text", "image"]],
    ["cx/gpt-6.1-sol", ["text", "image"]],
    ["deepseek/deepseek-v4-pro", ["text"]],
    ["combo", undefined], ["alias", undefined], ["unknown/gpt-6.1-sol", undefined],
    ["", undefined], [null, undefined], ["cx/", undefined], ["/model", undefined],
  ])("resolves DSH input modalities for %j", (id, expected) => {
    expect(dshModelInput(id)).toEqual(expected);
  });
  it("trims input model ids and resolves provider aliases", () => {
    expect(dshModelInput("  codex/gpt-6.1-sol  ")).toEqual(["text", "image"]);
    expect(DSH_INPUT_MODALITIES).toEqual(["text", "image"]);
  });
  it("leaves input unmanaged when capability lookup or model string conversion throws", () => {
    vi.spyOn(capabilityRegistry, "getCapabilitiesForModel").mockImplementation(() => { throw new Error("fixture registry failure"); });
    expect(dshModelInput("cx/gpt-6.1-sol")).toBeUndefined();
    expect(dshModelInput({ toString() { throw new Error("fixture conversion failure"); } })).toBeUndefined();
    expect(dshModelVision(["cx/gpt-6.1-sol"])).toEqual({});
  });
  it.each([{}, { vision: null }, { vision: "true" }])("leaves input unmanaged without a boolean vision capability %j", caps => {
    vi.spyOn(capabilityRegistry, "getCapabilitiesForModel").mockReturnValue(caps);
    expect(dshModelInput("cx/gpt-6.1-sol")).toBeUndefined();
  });
  it("maps only resolvable vision and input declarations", () => {
    const models = ["cx/gpt-6-luna", "cx/gpt-6.1-sol", "deepseek/deepseek-v4-pro", "combo", "alias", "unknown/model"];
    expect(dshModelVision(models)).toEqual({
      "cx/gpt-6-luna": true, "cx/gpt-6.1-sol": true, "deepseek/deepseek-v4-pro": false,
    });
    const input = Object.fromEntries(models.flatMap(id => {
      const modalities = dshModelInput(id);
      return modalities ? [[id, modalities]] : [];
    }));
    expect(input).toEqual({
      "cx/gpt-6-luna": ["text", "image"], "cx/gpt-6.1-sol": ["text", "image"], "deepseek/deepseek-v4-pro": ["text"],
    });
  });
});
describe("Surgical DSH input and API editing", () => {
  const settings = { baseURL, models: ["kept"], modelInput: { kept: ["text", "image"] } };
  const own = entry + "      srouter:\n        apiKeyEnv: SROUTER_API_KEY\n        models:\n";
  const id = "          - id: kept # owner\n";
  it("writes known input immediately after each new id and before reasoning", () => {
    const selected = { ...settings, models: ["kept", "text-only", "combo"], modelInput: { kept: ["image", "text", "image"], "text-only": ["text"] } };
    const result = applySrouterProvider(fixture, selected);
    expect(result).toContain("          - id: kept\n            input: [text, image]\n" + levels);
    expect(result).toContain("          - id: text-only\n            input: [text]\n" + levels);
    expect(result).toContain("          - id: combo\n" + levels);
    expect(provider(result).models.map(model => model.input)).toEqual([["text", "image"], ["text"], undefined]);
    expect(applySrouterProvider(result, selected)).toBe(result);
  });
  it("backfills known input before existing metadata and reasoning", () => {
    const raw = own + id + "            name: Owner # keep\n" + levels;
    const result = applySrouterProvider(raw, settings);
    expect(result).toContain(id + "            input: [text, image]\n            name: Owner # keep\n" + levels);
    expect(applySrouterProvider(result, settings)).toBe(result);
  });
  it.each([
    ["[text]", ["text", "image"], "[text, image]"],
    ["[text, image]", ["text"], "[text]"],
    ["[]", ["text"], "[text]"],
  ])("rewrites differing inline input %s to %j without changing metadata", (initial, input, rendered) => {
    const raw = applySrouterProvider(own + id + `            input: ${initial} # owner input\n            name: Owner\n`, { baseURL, models: ["kept"] });
    const selected = { ...settings, modelInput: { kept: input } };
    const result = applySrouterProvider(raw, selected);
    expect(result).toBe(raw.replace(`input: ${initial}`, `input: ${rendered}`));
    expect(applySrouterProvider(result, selected)).toBe(result);
  });
  it.each([
    "            input: # owner input\n              - text\n",
    "            input: # owner input\n            - text\n",
    "            input: # owner input\n              - text\n              # keep sequence comment\n\n",
  ])("canonicalizes a block input sequence while retaining comments %j", declaration => {
    const raw = applySrouterProvider(own + id + declaration + "            name: Owner # metadata\n", { baseURL, models: ["kept"] });
    const result = applySrouterProvider(raw, settings);
    expect(result).toContain("            input: [text, image] # owner input\n");
    expect(result).toContain("            name: Owner # metadata\n");
    if (declaration.includes("# keep sequence comment")) expect(result).toContain("              # keep sequence comment\n\n");
    expect(provider(result).models[0].input).toEqual(["text", "image"]);
    expect(applySrouterProvider(result, settings)).toBe(result);
  });
  it.each([
    `            input: ["image", 'text'] # order and quotes\n`,
    "            input: [image, text, image] # duplicate\n",
    "            input:\n              - 'image' # image comment\n              - \"text\"\n",
  ])("preserves matching input sets byte-for-byte %j", declaration => {
    const raw = applySrouterProvider(own + id + declaration + levels, { baseURL, models: ["kept"] });
    expect(applySrouterProvider(raw, settings)).toBe(raw);
  });
  it.each([
    "            input: text\n",
    "            input:\n              kind: image\n",
    "             input: [text]\n",
    "            'input': [text]\n",
    "            input : [text]\n",
    "            ? input\n            : [text]\n",
    "            input: [[text]]\n",
    "            input:\n              - kind: image\n",
    "            input: [text]\n            input: [image]\n",
    '            notes: "owner text\n            input: [text]\n            continued text"\n',
  ])("fails closed for unsafe managed input without mutating the source %j", declaration => {
    const raw = own + "          - id: first\n" + levels + id + declaration + levels;
    const original = raw;
    expect(() => applySrouterProvider(raw, { ...settings, models: ["first", "kept"], modelInput: { first: ["text"], kept: ["text", "image"] } }))
      .toThrow(expect.objectContaining({ code: "DSH_CONFIG_CONFLICT" }));
    expect(raw).toBe(original);
  });
  it.each([
    "            input: text # unmanaged\n",
    "            input:\n              kind: image # unmanaged\n",
    "            'input': [image] # unmanaged\n",
  ])("preserves unusual input on unresolved models %j", declaration => {
    const raw = applySrouterProvider(own + id + declaration + levels, { baseURL, models: ["kept"] });
    expect(applySrouterProvider(raw, { ...settings, modelInput: {} })).toBe(raw);
  });
  it.each(["anthropic-messages", "openai-responses", "openai-completions"])("preserves owner API %s and its raw comment", api => {
    const raw = applySrouterProvider(own + id + levels, { baseURL, models: ["kept"] })
      .replace("        api: openai-completions\n", `        api: '${api}' # owner transport\n`);
    const result = applySrouterProvider(raw, settings);
    expect(result).toContain(`        api: '${api}' # owner transport\n`);
    expect(provider(result).api).toBe(api);
    expect(applySrouterProvider(result, settings)).toBe(result);
  });
  it.each(["null", "{owner: custom}"])("preserves an existing nonstring API declaration %s", api => {
    const raw = applySrouterProvider(own + id + levels, { baseURL, models: ["kept"] })
      .replace("        api: openai-completions\n", `        api: ${api} # owner transport\n`);
    expect(applySrouterProvider(raw, settings)).toContain(`        api: ${api} # owner transport\n`);
  });
  it("adds the default API only when the legacy provider has no API key", () => {
    const result = applySrouterProvider(own + id + levels, settings);
    expect(provider(result).api).toBe("openai-completions");
    expect(result.match(/        api:/g)).toHaveLength(1);
    expect(applySrouterProvider(result, settings)).toBe(result);
  });
  it("reorders two saved models preserving their raw blocks and repeated Apply bytes", () => {
    const first = "          - id: first # first owner\n            input: ['image', text] # first input\n            name: First\n" + levels;
    const second = "          - id: second # second owner\n            input: [text] # second input\n            contextWindow: 128000\n" + levels;
    const original = applySrouterProvider(own + first + second, { baseURL, models: ["first", "second"] });
    const selected = { baseURL, models: ["second", "first"], modelInput: { first: ["text", "image"], second: ["text"] } };
    const result = applySrouterProvider(original, selected);
    expect(result).toBe(original.replace(first + second, second + first));
    expect(provider(result).models.map(model => model.id)).toEqual(["second", "first"]);
    expect(applySrouterProvider(result, selected)).toBe(result);
  });
  it.each(["\n", "\r\n"])("backfills input while preserving %j and unterminated reasoning EOF", eol => {
    const raw = applySrouterProvider(own + id + levels, { baseURL, models: ["kept"] }).replaceAll("\n", eol).trimEnd();
    const result = applySrouterProvider(raw, settings);
    expect(result).toBe(raw.replace(id.replaceAll("\n", eol), id.replaceAll("\n", eol) + `            input: [text, image]${eol}`));
    expect(result.endsWith("\n")).toBe(false);
    expect(applySrouterProvider(result, settings)).toBe(result);
  });
  it.each(["\n", "\r\n"])("replaces final block input while preserving %j and unterminated EOF", eol => {
    const raw = applySrouterProvider(own + id + levels + "            input:\n              - text", { baseURL, models: ["kept"] }).replaceAll("\n", eol);
    const result = applySrouterProvider(raw, settings);
    expect(result).toBe(raw.replace(`            input:${eol}              - text`, "            input: [text, image]"));
    expect(result.endsWith("\n")).toBe(false);
    expect(applySrouterProvider(result, settings)).toBe(result);
  });
  it.each(["\n", "\r\n"])("backfills input and reasoning on an unterminated bare id with %j", eol => {
    const raw = (own + id).replaceAll("\n", eol).trimEnd();
    const result = applySrouterProvider(raw, settings);
    expect(result).toContain(id.replaceAll("\n", eol) + `            input: [text, image]${eol}` + levels.replaceAll("\n", eol));
    expect(applySrouterProvider(result, settings)).toBe(result);
  });
  it("removes our entire provider regardless of input shape or owner API", () => {
    const raw = applySrouterProvider(own + id + "            input: unusual\n" + levels, { baseURL, models: ["kept"] })
      .replace("api: openai-completions", "api: anthropic-messages");
    expect(removeSrouterProvider(raw).content).toBe(entry);
  });
});
describe("Surgical DSH patch editing", () => {
  it("writes fallback reasoning levels without modelLevels or compat", () => {
    const result = applySrouterProvider(fixture, { baseURL, models: ["cx/gpt-6-luna", "combo"] });
    expect(result).toContain("        models:\n          - id: cx/gpt-6-luna\n" + levels + "          - id: combo\n" + levels);
    expect(provider(result).models).toEqual([modelWithLevels("cx/gpt-6-luna"), modelWithLevels("combo")]);
    expect(provider(result)).not.toHaveProperty("compat");
    expect(applySrouterProvider(result, { baseURL, models: ["cx/gpt-6-luna", "combo"] })).toBe(result);
  });
  it.each([
    "            reasoningEfforts: # owner header\n              max: max\n              high: xhigh # owner value\n              low: low\n              medium: medium\n",
    "            reasoningEfforts: {max: max, high: xhigh, low: low, medium: medium} # owner mapping\n",
  ])("preserves matching reasoning keys and custom values verbatim %j", declaration => {
    const kept = "          - id: kept # owner\n            name: Kept\n" + declaration + "            contextWindow: 128000\n";
    const raw = entry + "      srouter:\n        apiKeyEnv: SROUTER_API_KEY\n        models:\n" + kept;
    const result = applySrouterProvider(raw, { ...options, models: ["kept"] });
    expect(result).toContain(kept);
    expect(provider(result).models).toEqual(provider(raw).models);
    expect(applySrouterProvider(result, { ...options, models: ["kept"] })).toBe(result);
  });
  it.each([
    "            reasoningEfforts:\n              off:\n              high: ultra # old value\n",
    "            reasoningEfforts: false # disabled\n",
    "            reasoningEfforts: {off: null, high: ultra}\n",
    "            reasoningEfforts: null\n",
  ])("rewrites differing canonical reasoning declarations in place %j", declaration => {
    const before = "          - id: kept # owner\n            name: Kept\n";
    const after = "            # owner metadata\n            contextWindow: 128000\n";
    const raw = entry + "      srouter:\n        apiKeyEnv: SROUTER_API_KEY\n        models:\n" + before + declaration + after;
    const result = applySrouterProvider(raw, { ...options, models: ["kept"], modelLevels: { kept: ["high", "max"] } });
    expect(result).toContain(before);
    expect(result).toContain(after);
    expect(result).toContain("              high: high\n              max: max\n");
    expect(provider(result).models).toEqual([{ id: "kept", name: "Kept", contextWindow: 128000, reasoningEfforts: { high: "high", max: "max" } }]);
    expect(applySrouterProvider(result, { ...options, models: ["kept"], modelLevels: { kept: ["max", "high"] } })).toBe(result);
  });
  it.each([
    "            'reasoningEfforts': {high: ultra}\n",
    '            "\\u0072easoningEfforts": {high: ultra}\n',
    "            reasoningEfforts : {high: ultra}\n",
    "            ? 'reasoningEfforts'\n            : {high: ultra}\n",
    '            ? "reasoning\\\n              Efforts"\n            : {high: ultra}\n',
    "            - reasoningEfforts: {high: ultra}\n",
    "             reasoningEfforts: {high: ultra}\n",
  ])("fails closed for a noncanonical raw reasoning key %j", declaration => {
    const raw = entry + "      srouter:\n        apiKeyEnv: SROUTER_API_KEY\n        models:\n          - id: kept\n" + declaration;
    expect(() => applySrouterProvider(raw, { ...options, models: ["kept"] }))
      .toThrow(expect.objectContaining({ code: "DSH_CONFIG_CONFLICT" }));
  });
  it("writes different registry levels for models in one provider including xhigh", () => {
    const models = ["cx/gpt-6.1-sol", "deepseek/deepseek-v4-pro"];
    const settings = { baseURL, models, modelLevels: dshModelLevels(models) };
    const result = applySrouterProvider(fixture, settings);
    expect(provider(result).models).toEqual([
      { id: models[0], reasoningEfforts: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } },
      { id: models[1], reasoningEfforts: { high: "high", max: "max" } },
    ]);
    expect(applySrouterProvider(result, settings)).toBe(result);
  });
  it("backfills a bare model with its per-model levels and adds a new nonreasoning model", () => {
    const kept = "          - id: deepseek/deepseek-v4-pro # owner\n            contextWindow: 128000\n";
    const raw = entry + "      srouter:\n        apiKeyEnv: SROUTER_API_KEY\n        models:\n" + kept;
    const models = ["deepseek/deepseek-v4-pro", "unknown/model-x"];
    const settings = { baseURL, models, modelLevels: dshModelLevels(models) };
    const result = applySrouterProvider(raw, settings);
    expect(result).toContain(kept + "            reasoningEfforts:\n              high: high\n              max: max\n");
    expect(result).toContain("          - id: unknown/model-x\n            reasoningEfforts: false\n");
    expect(provider(result).models[1]).toEqual({ id: "unknown/model-x", reasoningEfforts: false });
    expect(applySrouterProvider(result, settings)).toBe(result);
  });
  it("replaces a reasoning map with false while preserving adjacent metadata and comments", () => {
    const raw = applySrouterProvider(entry, options).replace(levels,
      "            name: Owner # name\n            reasoningEfforts: # declaration\n              low: low\n              high: high\n              # keep internal comment\n\n            contextWindow: 128000 # context\n");
    const settings = { ...options, modelLevels: { [options.models[0]]: false } };
    const result = applySrouterProvider(raw, settings);
    expect(result).toContain("            name: Owner # name\n            reasoningEfforts: false # declaration\n              # keep internal comment\n\n            contextWindow: 128000 # context\n");
    expect(provider(result).models[0].reasoningEfforts).toBe(false);
    expect(applySrouterProvider(result, settings)).toBe(result);
  });
  it("preserves an existing false declaration byte-for-byte for a nonreasoning model", () => {
    const raw = applySrouterProvider(entry, options).replace(levels, "            reasoningEfforts: false # keep\n");
    expect(applySrouterProvider(raw, { ...options, modelLevels: { [options.models[0]]: false } })).toBe(raw);
  });
  it.each([
    [["max", "xhigh", "minimal", "xhigh", "none", "off", "ultra"], { minimal: "minimal", xhigh: "xhigh", max: "max" }],
    [[], reasoningEfforts], [["none", "off", "thinking", "ultra"], reasoningEfforts],
    [null, reasoningEfforts], ["high", reasoningEfforts],
  ])("sanitizes writer modelLevels %j in canonical DSH order", (input, expected) => {
    const result = applySrouterProvider("", { ...options, modelLevels: { [options.models[0]]: input } });
    expect(provider(result).models[0].reasoningEfforts).toEqual(expected);
    expect(Object.keys(provider(result).models[0].reasoningEfforts)).toEqual(Object.keys(expected));
  });
  it("rewrites CRLF reasoning blocks without touching foreign bytes or EOF terminators", () => {
    const raw = applySrouterProvider(entry.replaceAll("\n", "\r\n"), options).trimEnd();
    const settings = { ...options, modelLevels: { [options.models[0]]: ["high", "xhigh", "max"] } };
    const result = applySrouterProvider(raw, settings);
    expect(result.startsWith(entry.replaceAll("\n", "\r\n"))).toBe(true);
    expect(result.endsWith("              max: max")).toBe(true);
    expect(result).toContain("              high: high\r\n              xhigh: xhigh\r\n");
    expect(result.replaceAll("\r\n", "")).not.toContain("\n");
    expect(applySrouterProvider(result, settings)).toBe(result);
  });
  it.each([[false], [["minimal", "xhigh"]]])("preserves unterminated LF EOF when switching reasoning representation to %j", target => {
    const initial = target === false ? levels : "            reasoningEfforts: false\n";
    const raw = applySrouterProvider(entry, options).replace(levels, initial).trimEnd();
    const settings = { ...options, modelLevels: { [options.models[0]]: target } };
    const result = applySrouterProvider(raw, settings);
    expect(result.endsWith("\n")).toBe(false);
    expect(provider(result).models[0].reasoningEfforts).toEqual(target === false ? false : { minimal: "minimal", xhigh: "xhigh" });
    expect(applySrouterProvider(result, settings)).toBe(result);
  });
  it("removes unselected models together with their reasoning levels", () => {
    const raw = applySrouterProvider(entry, { baseURL, models: ["removed", "kept"] })
      .replace("              high: high", "              high: unique-removed-value");
    const result = applySrouterProvider(raw, { baseURL, models: ["kept"] });
    expect(result).not.toContain("removed");
    expect(result).toContain("          - id: kept\n" + levels);
    expect(provider(result).models).toEqual([modelWithLevels("kept")]);
  });
  it.each([
    '            notes: "owner text\n            reasoningEfforts: high\n            continued text"\n',
    "            reasoningEfforts: {high: ultra}\n            reasoningEfforts: false\n",
  ])("fails closed for duplicate or misleading raw reasoning keys %j", metadata => {
    const raw = entry + "      srouter:\n        apiKeyEnv: SROUTER_API_KEY\n        models:\n          - id: kept\n" + metadata;
    expect(() => applySrouterProvider(raw, { ...options, models: ["kept"] }))
      .toThrow(expect.objectContaining({ code: "DSH_CONFIG_CONFLICT" }));
  });
  it.each([
    "          - name: Kept\n            id: kept\n",
    "         - id: kept\n",
    "          -  id: kept\n",
    "          - id: kept\n             name: Kept\n",
    "          - {id: kept, reasoningEfforts: {high: ultra}}\n",
    "          - name: Kept\n            id: kept\n            reasoningEfforts: {high: ultra}\n",
  ])("fails closed for a kept model without a safe raw id block %j", item => {
    const raw = entry + "      srouter:\n        apiKeyEnv: SROUTER_API_KEY\n        models:\n" + item;
    expect(() => applySrouterProvider(raw, { ...options, models: ["kept"] }))
      .toThrow(expect.objectContaining({ code: "DSH_CONFIG_CONFLICT" }));
  });
  it("upgrades CRLF models while preserving foreign content and raw metadata", () => {
    const kept = "          - id: kept # owner\n            name: Kept\n            contextWindow: 128000\n\n          # trailing owner comment\n".replaceAll("\n", "\r\n");
    const raw = entry.replaceAll("\n", "\r\n") + "      srouter:\r\n        apiKeyEnv: SROUTER_API_KEY\r\n        models:\r\n" + kept;
    const result = applySrouterProvider(raw, { baseURL, models: ["kept", "new"] });
    expect(result.startsWith(entry.replaceAll("\n", "\r\n"))).toBe(true);
    expect(result).toContain(kept + levels.replaceAll("\n", "\r\n") + "          - id: new\r\n" + levels.replaceAll("\n", "\r\n"));
    expect(result.replaceAll("\r\n", "")).not.toContain("\n");
    expect(provider(result).models).toEqual([{ id: "kept", name: "Kept", contextWindow: 128000, reasoningEfforts }, modelWithLevels("new")]);
    expect(applySrouterProvider(result, { baseURL, models: ["kept", "new"] })).toBe(result);
    expect(removeSrouterProvider(result).content).toBe(entry.replaceAll("\n", "\r\n") + "\r\n          # trailing owner comment\r\n");
  });
  it("normalizes and deduplicates model ids in selection order", () => {
    expect(normalizeModels([" a ", "b", "a"])).toEqual(["a", "b"]);
  });
  it("replaces the selection while preserving raw kept metadata", () => {
    const kept = "          - id: kept\n            name: Kept Model  # note\n            contextWindow: 128000\n";
    const raw = entry + "      srouter:\n        apiKeyEnv: SROUTER_API_KEY\n        models:\n"
      + "          - id: removed\n            name: Removed\n" + kept;
    const result = applySrouterProvider(raw, { ...options, models: ["kept", "new/model"] });
    expect(result).toContain(kept + levels + "          - id: new/model\n" + levels);
    expect(result).not.toContain("id: removed");
    expect(provider(result).models).toEqual([
      { id: "kept", name: "Kept Model", contextWindow: 128000, reasoningEfforts }, modelWithLevels("new/model"),
    ]);
    expect(applySrouterProvider(result, { ...options, models: ["kept", "new/model"] })).toBe(result);
  });
  it("replaces the previous model selection on re-apply", () => {
    const raw = applySrouterProvider(entry, options);
    const result = applySrouterProvider(raw, { ...options, models: ["second", "third"] });
    expect(provider(result).models).toEqual([modelWithLevels("second"), modelWithLevels("third")]);
    expect(result).not.toContain(options.models[0]);
  });
  it("inserts a missing models key even when scalars follow its insertion point", () => {
    const raw = entry + "      srouter:\n        apiKeyEnv: SROUTER_API_KEY\n        compat: {}\n";
    expect(provider(applySrouterProvider(raw, options)).models).toEqual([modelWithLevels(options.models[0])]);
  });
  it("rejects populated flow-style models and ambiguous raw entry counts", () => {
    for (const models of ["        models: [a, b]\n", "        models:\n        - id: a\n"]) {
      const raw = entry + "      srouter:\n        apiKeyEnv: SROUTER_API_KEY\n" + models;
      expect(() => applySrouterProvider(raw, options)).toThrow(expect.objectContaining({ code: "DSH_CONFIG_CONFLICT" }));
    }
  });
  it("fails closed when a kept plain-string model has no id key line", () => {
    const raw = entry + "      srouter:\n        apiKeyEnv: SROUTER_API_KEY\n        models:\n          - a # keep\n          - id: b\n";
    expect(() => applySrouterProvider(raw, { ...options, models: ["b", "a"] }))
      .toThrow(expect.objectContaining({ code: "DSH_CONFIG_CONFLICT" }));
  });
  it.each(["", "# keep\n", "[]", "# keep\n[] # empty array\n"])("appends an entry to fresh content %j", content => {
    const result = applySrouterProvider(content, options);
    expect(provider(result)).toEqual({
      displayName: "Srouter", apiKeyEnv: DSH_KEY_REF, api: "openai-completions", baseURL,
      models: [modelWithLevels(options.models[0])],
    });
  });
  it("preserves the observed real-format fixture byte-for-byte as a prefix", () => {
    const result = applySrouterProvider(fixture, options);
    expect(result.startsWith(fixture)).toBe(true);
    expect(parseYAML(result).slice(0, 2)).toEqual(parseYAML(fixture));
  });
  it("tolerates cordis !!js tags and preserves them verbatim", () => {
    const tagged = "- id: bash-sandbox\n  name: \"@deepseek-ai/dsh-bash-sandbox\"\n  disabled: !!js process.platform === 'win32'\n  config:\n    mode: !!js >-\n      process.env.DSH_TOOLS_MODE ??\n      'workspace-write'\n";
    const raw = fixture + tagged;
    const maskedProvider = content => findProviderEntry(parseYAML(content.replace(/!!js[^\s]*/g, ""))).providers.srouter;
    const applied = applySrouterProvider(raw, options);
    expect(applied.startsWith(raw)).toBe(true);
    expect(applied).toContain("disabled: !!js process.platform === 'win32'");
    expect(applied).toContain("mode: !!js >-\n      process.env.DSH_TOOLS_MODE ??");
    expect(maskedProvider(applied).baseURL).toBe(baseURL);
    const removed = removeSrouterProvider(applied);
    expect(removed.removed).toBe(true);
    expect(removed.content).toBe(raw);
  });
  it("preserves other providers and config while merging", () => {
    const result = applySrouterProvider(entry, options);
    expect(result).toContain(otherProvider);
    expect(parseYAML(result)[0].config.keep).toBe("yes");
  });
  it("preserves Harness-added models verbatim while updating canonical fields", () => {
    const models = `        models:
          - id: owner/model # owner comment
            name: Owner model
            contextWindow: 128000

          # keep this comment
          - id: second/model
            name: Second model
`;
    const first = applySrouterProvider(entry, options).replace(`        models:\n          - id: ${options.models[0]}\n${levels}`, models);
    const nextURL = "http://127.0.0.1:20127/v1";
    const second = applySrouterProvider(first, { baseURL: nextURL, models: ["owner/model", "second/model"] });
    expect(second.match(/srouter:/g)).toHaveLength(1);
    const upgraded = models.replace("          - id: second/model", levels + "          - id: second/model") + levels;
    expect(second).toContain(upgraded);
    expect(provider(second).models).toEqual(provider(first).models.map(model => ({ ...model, reasoningEfforts })));
    expect(provider(second).baseURL).toBe(nextURL);
    expect(second).toBe(first.replace(models, upgraded).replace(`baseURL: '${baseURL}'`, `baseURL: '${nextURL}'`));
    expect(second).toContain(otherProvider);
  });
  it("preserves unknown provider keys and blank lines during re-apply", () => {
    const extras = "        compat:\n          supportsStore: false # keep\n\n        reasoningEfforts:\n          - high\n";
    const raw = applySrouterProvider(entry, options) + extras;
    const result = applySrouterProvider(raw, { ...options, baseURL: "http://127.0.0.1:20127/v1" });
    expect(result.endsWith(extras)).toBe(true);
    expect(provider(result).compat).toEqual(provider(raw).compat);
    expect(provider(result).reasoningEfforts).toEqual(provider(raw).reasoningEfforts);
  });
  it("leaves a second identical apply byte-identical", () => {
    const first = applySrouterProvider(entry, options);
    expect(applySrouterProvider(first, options)).toBe(first);
  });
  it("inserts missing canonical fields after the last existing canonical field", () => {
    const raw = entry + "      srouter: # owned\n        apiKeyEnv: SROUTER_API_KEY\n        models: [] # keep\n";
    const result = applySrouterProvider(raw, options);
    expect(result).toContain("        apiKeyEnv: SROUTER_API_KEY\n        displayName: Srouter\n        api: openai-completions\n");
    expect(result).toContain(`        models: # keep\n          - id: ${options.models[0]}\n`);
    expect(applySrouterProvider(result, options)).toBe(result);
  });
  it("refuses a populated provider without ownership fields", () => {
    const raw = entry + `      srouter:\n        models: [] # keep\n        compat: {}\n`;
    // Endpoint ownership is required when canonical fields are absent.
    expect(() => applySrouterProvider(raw, options)).toThrow();
  });
  it("fails closed for a flow-style owned provider", () => {
    const raw = entry + `      srouter: {apiKeyEnv: SROUTER_API_KEY, baseURL: '${baseURL}', models: []}\n`;
    expect(() => applySrouterProvider(raw, options)).toThrow(expect.objectContaining({ code: "DSH_CONFIG_CONFLICT" }));
  });
  it("refuses a foreign provider on apply and remove", () => {
    for (const operation of [() => applySrouterProvider(foreign, options), () => removeSrouterProvider(foreign)]) {
      expect(operation).toThrow(expect.objectContaining({ code: "DSH_CONFIG_CONFLICT" }));
    }
  });
  it.each([
    "- id: llm-pi-ai\n", "- name: '@deepseek-ai/dsh-llm-pi-ai'\n",
    "- id: llm-pi-ai\n  config: {}\n",
    "- id: llm-pi-ai\n  config:\n    keep: true\n",
    "- id: llm-pi-ai\n  config:\n    providers: {}\n",
    "- id: llm-pi-ai\n  config:\n    providers:\n      srouter:\n",
    "- id: llm-pi-ai\n  config:\n    providers:\n      srouter: # empty provider\n",
  ])("inserts missing config/providers in %j", content => {
    expect(provider(applySrouterProvider(content, options)).baseURL).toBe(baseURL);
  });
  it("preserves CRLF and all untouched bytes", () => {
    const raw = entry.replaceAll("\n", "\r\n");
    expect(applySrouterProvider(raw, options).startsWith(raw)).toBe(true);
  });
  it("preserves mixed terminators during field surgery and identical re-apply", () => {
    const raw = applySrouterProvider(entry, options)
      .replace(`        models:\n          - id: ${options.models[0]}\n`, "        models:\r\n          - id: owner/model # keep\n            contextWindow: 128000\r\n");
    const nextURL = "http://127.0.0.1:20127/v1";
    const result = applySrouterProvider(raw, { baseURL: nextURL, models: ["owner/model"] });
    expect(result).toBe(raw.replace(`baseURL: '${baseURL}'`, `baseURL: '${nextURL}'`));
    expect(applySrouterProvider(result, { baseURL: nextURL, models: ["owner/model"] })).toBe(result);
    expect(removeSrouterProvider(result).content).toBe(entry);
  });
  it("removes only the owned provider when siblings exist", () => {
    const result = removeSrouterProvider(applySrouterProvider(entry, options));
    expect(result.removed).toBe(true);
    expect(result.content).toBe(entry);
  });
  it("removes providers but retains other config keys", () => {
    const raw = applySrouterProvider("- id: llm-pi-ai\n  config:\n    keep: true\n", options);
    expect(parseYAML(removeSrouterProvider(raw).content)).toEqual([{ id: "llm-pi-ai", config: { keep: true } }]);
  });
  it("removes the entire entry when config is otherwise empty, retaining comments", () => {
    const raw = applySrouterProvider("# keep comment\n", options);
    const result = removeSrouterProvider(raw).content;
    expect(result).toContain("# keep comment\n");
    expect(parseYAML(result)).toEqual([]);
  });
  it.each(["- id: llm-pi-ai\n  config: []\n", "- id: llm-pi-ai\n  config:\n    providers: []\n", "{}",
    "- id: llm-pi-ai\n- id: llm-pi-ai\n", "[malformed {"])("refuses unsafe patch structure %j", raw => {
    expect(() => applySrouterProvider(raw, options)).toThrow();
  });
  it("fails closed for non-surgical flow-style providers", () => {
    expect(() => applySrouterProvider('- id: llm-pi-ai\n  config: {providers: {other: {baseURL: "https://example.com"}}}\n', options)).toThrow();
  });
  it("recognizes key-reference ownership independently of URL", () => {
    expect(isOurProvider({ apiKeyEnv: DSH_KEY_REF, baseURL: "https://example.com" })).toBe(true);
  });
  it("rejects even a null foreign provider rather than overwriting it", () => {
    const raw = "- id: llm-pi-ai\n  config:\n    providers:\n      srouter: null\n";
    expect(() => applySrouterProvider(raw, options)).toThrow();
    expect(() => removeSrouterProvider(raw)).toThrow();
  });
  it("preserves root-indented comments embedded in an owned block", () => {
    const raw = applySrouterProvider(entry, options).replace("        apiKeyEnv:", "# keep embedded comment\n        apiKeyEnv:");
    const result = removeSrouterProvider(raw).content;
    expect(result).toContain("# keep embedded comment\n");
    expect(parseYAML(result)).toEqual(parseYAML(entry));
  });
});
describe("Surgical DSH credential editing", () => {
  it("creates refs without rewriting records or comments", () => {
    const result = setCredentialRef(records, DSH_KEY_REF, "secret-value");
    expect(result.startsWith(records)).toBe(true);
    expect(parseYAML(result).refs[DSH_KEY_REF]).toBe("secret-value");
  });
  it("updates an existing ref and preserves sibling refs and records", () => {
    const raw = records + "refs:\n  KEEP: other-secret\n  SROUTER_API_KEY: old\n# tail\n";
    const result = setCredentialRef(raw, DSH_KEY_REF, "secret ' with spaces");
    expect(result.startsWith(records)).toBe(true);
    expect(result).toContain("  KEEP: other-secret\n");
    expect(result).toContain("# tail\n");
    expect(parseYAML(result).refs).toEqual({ KEEP: "other-secret", SROUTER_API_KEY: "secret ' with spaces" });
  });
  it("inserts at the end of refs without modifying later records", () => {
    const raw = "version: 1\nrefs:\n  KEEP: other\n" + records.slice("version: 1\n".length);
    const result = setCredentialRef(raw, DSH_KEY_REF, "new");
    expect(result.endsWith(records.slice("version: 1\n".length))).toBe(true);
    expect(parseYAML(result).refs[DSH_KEY_REF]).toBe("new");
  });
  it("removes ref while keeping other refs, records and comments", () => {
    const raw = records + "refs:\n  KEEP: other\n  SROUTER_API_KEY: old\n# tail\n";
    const result = removeCredentialRef(raw, DSH_KEY_REF);
    expect(result).toBe(records + "refs:\n  KEEP: other\n# tail\n");
  });
  it("removes the last ref leaving a valid empty mapping", () => {
    expect(parseYAML(removeCredentialRef("version: 1\nrefs:\n  SROUTER_API_KEY: old\n", DSH_KEY_REF))).toEqual({ version: 1, refs: {} });
  });
  it.each(["", "# keep\n"])("creates a versioned document from empty %j", raw => {
    expect(parseYAML(setCredentialRef(raw, DSH_KEY_REF, "key"))).toEqual({ version: 1, refs: { SROUTER_API_KEY: "key" } });
  });
  it.each(["", "x\ny", "x\ry"])("refuses invalid credential values %j", value => {
    expect(() => setCredentialRef(records, DSH_KEY_REF, value)).toThrow();
  });
  it.each(["[]", "[malformed {", "unknown: true\n", "version: 2\n", "refs: []\n", "records: []\n", "refs:\n  OTHER: ''\n"])("refuses malformed or invalid credentials %j", raw => {
    expect(() => setCredentialRef(raw, DSH_KEY_REF, "key")).toThrow();
    expect(() => removeCredentialRef(raw, DSH_KEY_REF)).toThrow();
  });
  it("no-ops when ref is absent", () => {
    expect(removeCredentialRef(records, DSH_KEY_REF)).toBe(records);
  });
});
describe("DeepSeek Harness settings route", () => {
  it.each([
    "          - name: Kept\n            id: kept\n",
    "         - id: kept\n",
    "          - kept # no id line\n",
  ])("preflights an unsafe kept model before either file write %j", item => {
    return (async () => {
      const raw = entry + "      srouter:\n        apiKeyEnv: SROUTER_API_KEY\n        models:\n" + item;
      await write(configPath(), raw);
      await write(credentialsPath(), records);
      const rename = vi.spyOn(fs, "rename");
      expect((await route.POST(request({ models: ["kept"] }))).status).toBe(409);
      expect(await fs.readFile(configPath(), "utf8")).toBe(raw);
      expect(await fs.readFile(credentialsPath(), "utf8")).toBe(records);
      expect(rename).not.toHaveBeenCalled();
    })();
  });
  it("GET reports absent profiles", async () => {
    const status = await (await route.GET()).json();
    expect(status).toMatchObject({ hasSrouter: false, profile: null, configPath: null, configReadable: true, authenticationVerified: false, models: [], levelsDeclared: false, modelLevels: {} });
  });
  it("GET reports no levels when the patch has no srouter provider", async () => {
    await write(configPath(), entry);
    expect(await (await route.GET()).json()).toMatchObject({ hasSrouter: false, models: [], levelsDeclared: false, modelLevels: {} });
  });
  it("GET reports no levels for models without declarations", async () => {
    await write(configPath(), entry + "      srouter:\n        apiKeyEnv: SROUTER_API_KEY\n        models:\n"
      + "          - id: first\n          - id: second\n");
    expect(await (await route.GET()).json()).toMatchObject({ hasSrouter: true, models: ["first", "second"], levelsDeclared: false });
  });
  it("GET reports levels when every model declares them", async () => {
    await write(configPath(), applySrouterProvider(entry, { baseURL, models: ["first", "second"] }));
    expect(await (await route.GET()).json()).toMatchObject({ hasSrouter: true, models: ["first", "second"], levelsDeclared: true });
  });
  it("GET reports no levels for mixed model declarations", async () => {
    const raw = applySrouterProvider(entry, { baseURL, models: ["first", "second"] }).replace(levels, "");
    await write(configPath(), raw);
    expect(await (await route.GET()).json()).toMatchObject({ hasSrouter: true, models: ["first", "second"], levelsDeclared: false });
  });
  it.each(["false", "null", "{}"])("GET treats reasoningEfforts %s as a declared field", async value => {
    await write(configPath(), entry + "      srouter:\n        apiKeyEnv: SROUTER_API_KEY\n        models:\n"
      + `          - id: first\n            reasoningEfforts: ${value}\n`);
    expect(await (await route.GET()).json()).toMatchObject({ hasSrouter: true, models: ["first"], levelsDeclared: true });
  });
  it("GET reports no levels when the config cannot be read", async () => {
    await write(configPath(), applySrouterProvider(entry, options));
    const read = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation((file, ...args) => {
      if (file === configPath()) return Promise.reject(Object.assign(new Error("fixture-sensitive-detail"), { code: "EACCES" }));
      return read(file, ...args);
    });
    const response = await route.GET();
    expect(response.status).toBe(200);
    const status = await response.json();
    expect(status).toMatchObject({ configReadable: false, hasSrouter: false, models: [], levelsDeclared: false, modelLevels: {} });
    expect(JSON.stringify(status)).not.toContain("fixture-sensitive-detail");
  });
  it("POST writes both files, GET reports config without revealing secrets", async () => {
    await profile();
    await write(configPath(), fixture);
    await write(credentialsPath(), records);
    const response = await route.POST(request());
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ success: true, profile: "desktop", baseUrl: baseURL, configPath: configPath(),
      message: "Srouter was added to DeepSeek Harness. Restart DeepSeek Harness to see it in Settings → Models.", models: options.models });
    expect(parseYAML(await fs.readFile(credentialsPath(), "utf8")).refs.SROUTER_API_KEY).toBe("fixture-srouter-key");
    expect(provider(await fs.readFile(configPath(), "utf8")).baseURL).toBe(baseURL);
    const status = await (await route.GET()).json();
    expect(status).toMatchObject({ hasSrouter: true, configurationVerified: true, profile: "desktop", configPath: configPath(), baseUrl: baseURL, configReadable: true, models: options.models, levelsDeclared: true });
    expect(JSON.stringify(status)).not.toContain("fixture-");
    expect(getApiKeys).not.toHaveBeenCalled();
  });
  it("round-trips a patch whose other entries use !!js", async () => {
    const raw = fixture + "- id: web-server\n  config:\n    port: !!js ctx.webStartup.port ?? 3080\n";
    await write(configPath(), raw);
    await write(credentialsPath(), records);
    expect(await (await route.GET()).json()).toMatchObject({ configReadable: true, hasSrouter: false, foreignRoute: false });
    expect((await route.POST(request())).status).toBe(200);
    const applied = await fs.readFile(configPath(), "utf8");
    expect(applied.startsWith(raw)).toBe(true);
    expect(applied).toContain("port: !!js ctx.webStartup.port ?? 3080");
    expect(await (await route.GET()).json()).toMatchObject({ hasSrouter: true, baseUrl: baseURL });
    expect((await route.DELETE()).status).toBe(200);
    expect(await fs.readFile(configPath(), "utf8")).toBe(raw);
  });
  it("GET does not even open malformed credentials", async () => {
    await profile();
    await write(configPath(), applySrouterProvider("", options));
    await write(credentialsPath(), "[malformed {");
    expect((await (await route.GET()).json()).hasSrouter).toBe(true);
  });
  it("GET reports a foreign route", async () => {
    await write(configPath(), foreign);
    expect(await (await route.GET()).json()).toMatchObject({ hasSrouter: false, foreignRoute: true, baseUrl: null, models: [], levelsDeclared: false, modelLevels: {} });
  });
  it("POST returns normalized selections and GET reads ids in file order", async () => {
    await profile();
    const response = await route.POST(request({ models: [" b ", "a", "b"] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ models: ["b", "a"] });
    expect(await (await route.GET()).json()).toMatchObject({ models: ["b", "a"] });
  });
  it("GET accepts string entries and skips entries without string ids", async () => {
    await write(configPath(), entry + "      srouter:\n        apiKeyEnv: SROUTER_API_KEY\n        models:\n"
      + "          - id: first\n          - second\n          - name: No id\n          - id: 123\n          - null\n          - id: last\n");
    expect(await (await route.GET()).json()).toMatchObject({ models: ["first", "second", "last"], levelsDeclared: false });
  });
  it("GET treats malformed patch as unreadable, not a detection error", async () => {
    await write(configPath(), "[malformed {");
    const response = await route.GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ configReadable: false, hasSrouter: false, models: [], levelsDeclared: false });
  });
  it("GET exposes a future config path for an existing profile", async () => {
    await profile();
    expect(await (await route.GET()).json()).toMatchObject({ configReadable: true, configPath: configPath(), profile: "desktop", hasSrouter: false });
  });
  it("GET sanitizes executable detection failures", async () => {
    vi.spyOn(fs, "stat").mockRejectedValueOnce(Object.assign(new Error("fixture-sensitive-detail"), { code: "EACCES" }));
    const response = await route.GET();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to detect DeepSeek Harness installation" });
  });
  it("GET still detects an executable at a candidate path", async () => {
    vi.spyOn(fs, "stat").mockResolvedValueOnce({ isFile: () => true });
    expect((await (await route.GET()).json()).installed).toBe(true);
  });
  it("GET recognizes a null srouter provider as foreign", async () => {
    await write(configPath(), "- id: llm-pi-ai\n  config:\n    providers:\n      srouter: null\n");
    expect(await (await route.GET()).json()).toMatchObject({ foreignRoute: true, hasSrouter: false });
    expect((await route.DELETE()).status).toBe(409);
  });
  it.each([
    { baseUrl: "https://foreign.example/v1" }, { baseUrl: "http://user:password@localhost:20129" },
    { baseUrl: "file:///tmp/config" }, { apiKey: "a\nb" }, { apiKey: 123 },
    { models: undefined }, { models: [] }, { models: [""] }, { models: ["   "] },
    { models: Array.from({ length: 21 }, (_, index) => `model${index}`) },
    { models: ["a\nb"] }, { models: ["a\u0000b"] }, { models: ["a\tb"] },
    { models: ["x".repeat(201)] }, { models: [123] },
  ])("rejects invalid input without writes %j", body => {
    return (async () => {
      await write(configPath(), fixture); await write(credentialsPath(), records);
      expect((await route.POST(request(body))).status).toBe(400);
      expect(await fs.readFile(configPath(), "utf8")).toBe(fixture);
      expect(await fs.readFile(credentialsPath(), "utf8")).toBe(records);
    })();
  });
  it("accepts matching Origin and normalizes URL", async () => {
    await profile();
    const response = await route.POST(request({ baseUrl: "https://gateway.example/custom///" }, "https://gateway.example"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ baseUrl: "https://gateway.example/custom/v1" });
  });
  it("accepts the specified loopback Origin Request", async () => {
    await profile();
    const response = await route.POST(request({ baseUrl: "http://127.0.0.1:20129/" }, "http://127.0.0.1:20129"));
    expect(response.status).toBe(200);
    expect((await response.json()).baseUrl).toBe(baseURL);
  });
  it("requires an existing profile and creates no directories", async () => {
    expect((await route.POST(request())).status).toBe(409);
    await expect(fs.stat(process.env.DSH_HOME)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("uses web as fallback and prefers desktop", async () => {
    await profile("web");
    expect(await (await route.POST(request())).json()).toMatchObject({ profile: "web" });
    await profile();
    expect(await (await route.POST(request())).json()).toMatchObject({ profile: "desktop" });
  });
  it("honors homedir fallback when DSH_HOME is unset", async () => {
    await profile();
    delete process.env.DSH_HOME;
    expect(await (await route.POST(request())).json()).toMatchObject({ profile: "desktop" });
  });
  it.each(["foreign", "flow", "models-flow", "patch", "credentials"])("preflights %s conflict before either write", async kind => {
    const flow = entry + `      srouter: {apiKeyEnv: SROUTER_API_KEY, baseURL: '${baseURL}'}\n`;
    const modelsFlow = entry + "      srouter:\n        apiKeyEnv: SROUTER_API_KEY\n        models: [a, b]\n";
    const rawPatch = kind === "foreign" ? foreign : kind === "flow" ? flow : kind === "models-flow" ? modelsFlow : kind === "patch" ? "[malformed {" : fixture;
    const rawCredentials = kind === "credentials" ? "[malformed {" : records;
    await write(configPath(), rawPatch); await write(credentialsPath(), rawCredentials);
    expect((await route.POST(request())).status).toBe(409);
    expect(await fs.readFile(configPath(), "utf8")).toBe(rawPatch);
    expect(await fs.readFile(credentialsPath(), "utf8")).toBe(rawCredentials);
  });
  it("returns the frozen missing-key error without writes", async () => {
    getApiKeys.mockResolvedValueOnce([]);
    await profile();
    const response = await route.POST(request({ apiKey: "" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "No Srouter API key available" });
    await expect(fs.stat(configPath())).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["patch", "credentials"])("returns sanitized 500 for unreadable %s before writes", async kind => {
    await write(configPath(), fixture);
    await write(credentialsPath(), records);
    const read = fs.readFile.bind(fs);
    const blocked = kind === "patch" ? configPath() : credentialsPath();
    vi.spyOn(fs, "readFile").mockImplementation((file, ...args) => {
      if (file === blocked) return Promise.reject(Object.assign(new Error("fixture-secret-detail"), { code: "EACCES" }));
      return read(file, ...args);
    });
    const response = await route.POST(request());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("fixture-secret-detail");
    expect(await read(configPath(), "utf8")).toBe(fixture);
    expect(await read(credentialsPath(), "utf8")).toBe(records);
  });
  it("writes credentials first and leaves no temporary files", async () => {
    await profile();
    const rename = vi.spyOn(fs, "rename");
    expect((await route.POST(request())).status).toBe(200);
    expect(rename.mock.calls.map(([, target]) => target)).toEqual([credentialsPath(), configPath()]);
    expect(await fs.readdir(path.dirname(configPath()))).toEqual(["cordis.patch.yml"]);
    expect((await fs.readdir(process.env.DSH_HOME)).sort()).toEqual([".credentials.yaml", "profiles"]);
  });
  it.skipIf(process.platform === "win32")("uses 0600 for new files and preserves existing file modes", async () => {
    await profile();
    await route.POST(request());
    expect((await fs.stat(credentialsPath())).mode & 0o777).toBe(0o600);
    expect((await fs.stat(configPath())).mode & 0o777).toBe(0o600);
    await fs.chmod(configPath(), 0o640);
    await route.POST(request());
    expect((await fs.stat(configPath())).mode & 0o777).toBe(0o640);
  });
  it("DELETE removes our provider/ref preserving sibling providers and credentials", async () => {
    await write(configPath(), entry); await write(credentialsPath(), records);
    await route.POST(request());
    expect((await route.DELETE()).status).toBe(200);
    expect(await fs.readFile(configPath(), "utf8")).toBe(entry);
    const credentials = await fs.readFile(credentialsPath(), "utf8");
    expect(credentials.startsWith(records)).toBe(true);
    expect(parseYAML(credentials).refs).toEqual({});
    expect((await (await route.GET()).json()).hasSrouter).toBe(false);
  });
  it("DELETE skips when no profile or provider exists", async () => {
    expect(await (await route.DELETE()).json()).toEqual({ success: true, skipped: true });
    await write(configPath(), fixture);
    expect(await (await route.DELETE()).json()).toEqual({ success: true, skipped: true });
    expect(await fs.readFile(configPath(), "utf8")).toBe(fixture);
  });
  it("DELETE does not create an empty credential file when no ref ever existed", async () => {
    await write(configPath(), applySrouterProvider(fixture, options));
    expect((await route.DELETE()).status).toBe(200);
    await expect(fs.stat(credentialsPath())).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("DELETE refuses foreign providers without touching either file", async () => {
    await write(configPath(), foreign); await write(credentialsPath(), records);
    expect((await route.DELETE()).status).toBe(409);
    expect(await fs.readFile(configPath(), "utf8")).toBe(foreign);
    expect(await fs.readFile(credentialsPath(), "utf8")).toBe(records);
  });
  it.each(["patch", "credentials"])("DELETE preflights malformed %s", async kind => {
    const rawPatch = kind === "patch" ? "[malformed {" : applySrouterProvider(fixture, options);
    const rawCredentials = kind === "credentials" ? "[malformed {" : records;
    await write(configPath(), rawPatch); await write(credentialsPath(), rawCredentials);
    expect((await route.DELETE()).status).toBe(409);
    expect(await fs.readFile(configPath(), "utf8")).toBe(rawPatch);
    expect(await fs.readFile(credentialsPath(), "utf8")).toBe(rawCredentials);
  });
  it("serializes concurrent writes without duplicate provider entries", async () => {
    await profile();
    const responses = await Promise.all([
      route.POST(request({ baseUrl: "http://127.0.0.1:20127/v1" })),
      route.POST(request({ baseUrl: "http://127.0.0.1:20129/v1" })),
    ]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    const content = await fs.readFile(configPath(), "utf8");
    expect(provider(content).baseURL).toBe("http://127.0.0.1:20129/v1");
    expect(provider(content).models).toEqual([{ id: options.models[0], input: ["text"], reasoningEfforts: { high: "high", max: "max" } }]);
    expect(content.match(/srouter:/g)).toHaveLength(1);
  });
  it("POST writes xhigh for a single cx/gpt-6.1-sol selection", async () => {
    await profile();
    expect((await route.POST(request({ models: ["cx/gpt-6.1-sol"] }))).status).toBe(200);
    expect(await fs.readFile(configPath(), "utf8")).toContain("              xhigh: xhigh\n");
    expect(await (await route.GET()).json()).toMatchObject({
      modelLevels: { "cx/gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max"] },
    });
  });
  it("POST writes xhigh for Codex and GET exposes per-model registry levels without reading credentials", async () => {
    const models = ["cx/gpt-6.1-sol", "deepseek/deepseek-v4-pro", "unknown/model-x", "combo"];
    await profile();
    expect((await route.POST(request({ models }))).status).toBe(200);
    const content = await fs.readFile(configPath(), "utf8");
    expect(content).toContain("              xhigh: xhigh\n");
    expect(provider(content).models.map(model => model.reasoningEfforts)).toEqual([
      { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
      { high: "high", max: "max" }, false, reasoningEfforts,
    ]);
    const read = vi.spyOn(fs, "readFile");
    expect(await (await route.GET()).json()).toMatchObject({ models, modelLevels: dshModelLevels(models), levelsDeclared: true });
    expect(read.mock.calls.every(([file]) => file !== credentialsPath())).toBe(true);
  });
  it("GET resolves expected registry levels even when saved declarations are stale", async () => {
    const models = ["cx/gpt-6.1-sol"];
    await write(configPath(), applySrouterProvider(entry, { baseURL, models }));
    expect(await (await route.GET()).json()).toMatchObject({
      models, levelsDeclared: true, modelLevels: { "cx/gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max"] },
    });
  });
  it("POST preflights an unsafe reasoning declaration before writing either file", async () => {
    const raw = entry + "      srouter:\n        apiKeyEnv: SROUTER_API_KEY\n        models:\n"
      + "          - id: cx/gpt-6.1-sol\n            'reasoningEfforts': {high: high}\n";
    await write(configPath(), raw);
    await write(credentialsPath(), records);
    const rename = vi.spyOn(fs, "rename");
    expect((await route.POST(request({ models: ["cx/gpt-6.1-sol"] }))).status).toBe(409);
    expect(await fs.readFile(configPath(), "utf8")).toBe(raw);
    expect(await fs.readFile(credentialsPath(), "utf8")).toBe(records);
    expect(rename).not.toHaveBeenCalled();
  });
  it.each(["anthropic-messages", "openai-responses"])("POST declares vision input and preserves owner API %s", async api => {
    const raw = applySrouterProvider(entry, { baseURL, models: ["cx/gpt-6.1-sol"] }).replace("api: openai-completions", `api: ${api} # owner API`);
    await write(configPath(), raw);
    await write(credentialsPath(), records);
    expect((await route.POST(request({ models: ["cx/gpt-6.1-sol"] }))).status).toBe(200);
    const result = await fs.readFile(configPath(), "utf8");
    expect(result).toContain("          - id: cx/gpt-6.1-sol\n            input: [text, image]\n");
    expect(result).toContain(`        api: ${api} # owner API\n`);
    expect(provider(result).api).toBe(api);
    expect(await (await route.GET()).json()).toMatchObject({ api, modelVision: { "cx/gpt-6.1-sol": true } });
    expect((await route.POST(request({ models: ["cx/gpt-6.1-sol"] }))).status).toBe(200);
    expect(await fs.readFile(configPath(), "utf8")).toBe(result);
  });
  it("POST leaves unknown vision input absent and GET omits unresolved vision keys", async () => {
    const models = ["cx/gpt-6.1-sol", "deepseek/deepseek-v4-pro", "combo", "unknown/model"];
    await profile();
    expect((await route.POST(request({ models }))).status).toBe(200);
    const saved = provider(await fs.readFile(configPath(), "utf8"));
    expect(saved.models.map(model => model.input)).toEqual([["text", "image"], ["text"], undefined, undefined]);
    const read = vi.spyOn(fs, "readFile");
    const status = await (await route.GET()).json();
    expect(status.modelVision).toEqual({ "cx/gpt-6.1-sol": true, "deepseek/deepseek-v4-pro": false });
    expect(status.api).toBe("openai-completions");
    expect(read.mock.calls.every(([file]) => file !== credentialsPath())).toBe(true);
  });
  it.each(["combo", "unknown/model"])("POST preserves unusual unmanaged input for %s", async model => {
    const raw = applySrouterProvider(entry, { baseURL, models: [model] })
      .replace(`          - id: ${model}\n`, `          - id: ${model}\n            input: unusual # owner input\n`);
    await write(configPath(), raw);
    await write(credentialsPath(), records);
    expect((await route.POST(request({ models: [model] }))).status).toBe(200);
    expect(await fs.readFile(configPath(), "utf8")).toBe(model === "combo" ? raw : raw.replace(levels, "            reasoningEfforts: false\n"));
  });
  it.each([
    "            input: text\n", "            input:\n              kind: image\n",
    "             input: [text]\n", "            'input': [text]\n",
  ])("POST preflights unsafe managed input before either file write %j", declaration => {
    return (async () => {
      const raw = entry + "      srouter:\n        apiKeyEnv: SROUTER_API_KEY\n        models:\n          - id: cx/gpt-6.1-sol\n" + declaration;
      await write(configPath(), raw);
      await write(credentialsPath(), records);
      const rename = vi.spyOn(fs, "rename");
      expect((await route.POST(request({ models: ["cx/gpt-6.1-sol"] }))).status).toBe(409);
      expect(await fs.readFile(configPath(), "utf8")).toBe(raw);
      expect(await fs.readFile(credentialsPath(), "utf8")).toBe(records);
      expect(rename).not.toHaveBeenCalled();
    })();
  });
  it.each(["absent", "missing", "nonstring", "foreign"])("GET reports a null API for %s route API", async kind => {
    if (kind === "foreign") await write(configPath(), foreign);
    else if (kind !== "absent") {
      const raw = applySrouterProvider(entry, options).replace("        api: openai-completions\n", kind === "missing" ? "" : "        api: null\n");
      await write(configPath(), raw);
    }
    expect((await (await route.GET()).json()).api).toBeNull();
  });
});
