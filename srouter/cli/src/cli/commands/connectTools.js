// Remote endpoint ownership cannot be inferred from localhost/name. Keep scoped
// before/after fields in an owner-only sidecar and restore only unchanged fields.
const fs = require("fs");
const path = require("path");
const os = require("os");
const home = () => os.homedir();
const v1 = (base) => base.endsWith("/v1") ? base : `${base}/v1`;
const SECRET_MODE = 0o600;
const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const stripTrailingCommas = (text) => text.replace(/("(?:\\.|[^"\\])*")|,(\s*[}\]])/g, (m, str, tail) => str ?? tail);

function assertUnlinkedPath(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Refusing linked config path");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (path.dirname(current) === current) break;
  }
}

async function read(file, format = "json") {
  assertUnlinkedPath(file);
  let text;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Refusing linked config");
    text = fs.readFileSync(file, "utf8");
  } catch (error) { if (error.code === "ENOENT") return {}; throw error; }
  const { parseTOML, parseJSONC } = await import("confbox");
  const errors = [];
  const data = format === "toml" ? parseTOML(text) : parseJSONC(text, { errors, allowTrailingComma: true });
  if (errors.length || !isObject(data)) throw new Error(`Cannot parse config safely: ${file}`);
  return data;
}
const get = (doc, keys) => keys.reduce((value, key) => value?.[key], doc);
function set(doc, keys, value) {
  let target = doc;
  for (const key of keys.slice(0, -1)) {
    if (target[key] !== undefined && !isObject(target[key])) throw new Error("Invalid config section");
    target[key] ||= {};
    target = target[key];
  }
  const last = keys[keys.length - 1];
  if (value === undefined) delete target[last];
  else target[last] = clone(value);
  // Remove newly empty tables, not unrelated siblings.
  for (let i = keys.length - 1; i > 0; i--) {
    const section = get(doc, keys.slice(0, i));
    if (isObject(section) && !Object.keys(section).length) delete get(doc, keys.slice(0, i - 1))[keys[i - 1]];
  }
}
function write(file, content, backup = false) {
  assertUnlinkedPath(file);
  assertUnlinkedPath(`${file}.bak-srouter`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (backup && fs.existsSync(file) && !fs.existsSync(`${file}.bak-srouter`)) {
    fs.copyFileSync(file, `${file}.bak-srouter`);
    fs.chmodSync(`${file}.bak-srouter`, SECRET_MODE);
  }
  fs.writeFileSync(file, content, { mode: SECRET_MODE });
  fs.chmodSync(file, SECRET_MODE);
}
async function serialize(doc, format) {
  if (format === "toml") return (await import("confbox")).stringifyTOML(doc);
  return JSON.stringify(doc, null, 2);
}
const CLAUDE_MODELS = [
  { flag: "fable", envKey: "ANTHROPIC_DEFAULT_FABLE_MODEL", defaultValue: "cc/claude-fable-5" },
  { flag: "opus", envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL", defaultValue: "cc/claude-opus-5" },
  { flag: "sonnet", envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL", defaultValue: "cc/claude-sonnet-5" },
  { flag: "haiku", envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL", defaultValue: "cc/claude-haiku-4-5-20251001" },
];
const json = (file, fields, foreign) => ({ file, format: "json", fields, foreign });
const field = (keys, value) => ({ keys, value });

function tool(id, name, specs) {
  async function prepare(ctx, reset = false) {
    const plans = [];
    for (const spec of specs(ctx)) {
      assertUnlinkedPath(`${spec.file}.bak-srouter`);
      const doc = await read(spec.file, spec.format);
      const sidecar = `${spec.file}.srouter-connect.json`;
      const record = await read(sidecar);
      const managed = record.tool === id && Array.isArray(record.fields);
      if (Object.keys(record).length && !managed) throw new Error("Invalid ownership record");
      if (managed && record.version !== undefined && record.version !== 2) throw new Error("Invalid ownership version");
      if (spec.optionalField) {
        // An existing explorer is foreign unless our sidecar proves ownership.
        if (managed && record.version === 2 && typeof record.explorerManaged !== "boolean") throw new Error("Invalid explorer ownership");
        const ownsExplorer = managed && record.version === 2 && record.explorerManaged;
        spec.explorerManaged = ownsExplorer || (!reset && get(doc, spec.optionalField.keys) === undefined);
        if (spec.explorerManaged) spec.fields.push(spec.optionalField);
      }
      if (managed) {
        const expected = id === "droid" ? [["customModels"]] : spec.fields.map((entry) => entry.keys);
        // Only the exact old field set is a valid migration, never arbitrary subsets.
        const allowed = record.version === undefined && spec.legacyKeys
          ? spec.legacyKeys : spec.optionalField && (record.version === undefined || !record.explorerManaged)
            ? expected.filter((keys) => !equal(keys, spec.optionalField.keys)) : expected;
        if (record.fields.length !== allowed.length ||
            new Set(record.fields.map(saved => JSON.stringify(saved?.keys))).size !== allowed.length) {
          throw new Error("Incomplete ownership record");
        }
        for (const saved of record.fields) {
          if (!isObject(saved) || !Object.hasOwn(saved, "after") ||
              !Array.isArray(saved.keys) || !allowed.some((keys) => equal(keys, saved.keys)) ||
              saved.keys.some((key) => ["__proto__", "constructor", "prototype"].includes(key)) ||
              !equal(get(doc, saved.keys), saved.after)) throw new Error("Managed config changed, refusing overwrite/reset");
        }
      } else if (!reset && spec.foreign(doc)) throw new Error("Config belongs to another router");
      if (id === "droid") {
        if (doc.customModels !== undefined && !Array.isArray(doc.customModels)) throw new Error("Invalid customModels");
        const entries = (doc.customModels || []).filter((entry) => !/^custom:Srouter(?:-\d+)?$/.test(entry?.id));
        const index = Math.max(-1, ...entries.map((entry) => Number.isInteger(entry.index) ? entry.index : -1)) + 1;
        spec.fields = [field(["customModels"], [...entries, {
          id: "custom:Srouter-0", index, model: ctx.model, displayName: ctx.model,
          baseUrl: v1(ctx.baseUrl), apiKey: ctx.apiKey, provider: "openai",
          maxOutputTokens: 131072, noImageSupport: false,
        }])];
      }
      // Validate path shapes before login/first write, even when values are absent.
      const probe = clone(doc);
      for (const entry of spec.fields) set(probe, entry.keys, entry.value);
      plans.push({ spec, doc, record, managed, sidecar });
    }
    return plans;
  }
  return {
    id, name, paths: () => specs({ baseUrl: "", claudeModels: {} }).map((spec) => spec.file),
    preflight: (ctx) => prepare(ctx),
    async apply(ctx) {
      const plans = await prepare(ctx);
      for (const { spec, doc, record, managed, sidecar } of plans) {
        const fields = spec.fields.map((entry) => ({
          keys: entry.keys, before: managed && record.fields.some((saved) => equal(saved.keys, entry.keys))
            ? record.fields.find((saved) => equal(saved.keys, entry.keys)).before : get(doc, entry.keys),
          after: entry.value,
        }));
        for (const entry of fields) set(doc, entry.keys, entry.after);
        write(spec.file, await serialize(doc, spec.format), true);
        write(sidecar, JSON.stringify({ tool: id, version: 2, fields,
          ...(spec.optionalField ? { explorerManaged: spec.explorerManaged } : {}) }, null, 2));
      }
      return plans.map(({ spec }) => spec.file);
    },
    async reset() {
      const plans = await prepare({ baseUrl: "", claudeModels: {} }, true);
      const touched = [];
      for (const { spec, doc, record, managed, sidecar } of plans) {
        if (!managed) continue;
        for (const entry of record.fields) set(doc, entry.keys, entry.before);
        write(spec.file, await serialize(doc, spec.format));
        write(sidecar, "{}");
        touched.push(spec.file);
      }
      return touched;
    },
  };
}

const TOOLS = [
  tool("claude", "Claude Code", (ctx) => [json(path.join(home(), ".claude", "settings.json"), [
    field(["env", "ANTHROPIC_BASE_URL"], v1(ctx.baseUrl)), field(["env", "ANTHROPIC_AUTH_TOKEN"], ctx.apiKey),
    ...CLAUDE_MODELS.map((model) => field(["env", model.envKey], ctx.claudeModels?.[model.envKey] || model.defaultValue)),
    field(["hasCompletedOnboarding"], true),
  ], (doc) => !!(doc.env?.ANTHROPIC_BASE_URL || doc.env?.ANTHROPIC_AUTH_TOKEN || doc.env?.ANTHROPIC_API_KEY))]),
  tool("codex", "OpenAI Codex CLI", (ctx) => [{
    file: path.join(home(), ".codex", "config.toml"), format: "toml",
    fields: [field(["model"], ctx.model), field(["model_provider"], "srouter"),
      field(["model_providers", "srouter"], { name: "Srouter", base_url: v1(ctx.baseUrl), wire_api: "responses", http_headers: { Authorization: `Bearer ${ctx.apiKey}` } }),
      field(["agents", "default_subagent_model"], ctx.model)],
    legacyKeys: [["model"], ["model_provider"], ["model_providers", "srouter"]],
    foreign: (doc) => !!doc.model_providers?.srouter || (!!doc.model_provider && doc.model_provider !== "openai"),
  }]),
  tool("opencode", "OpenCode", (ctx) => [{ ...json(path.join(home(), ".config", "opencode", "opencode.json"), [
    field(["provider", "srouter"], { npm: "@ai-sdk/openai-compatible", options: { baseURL: v1(ctx.baseUrl), apiKey: ctx.apiKey },
      models: { [ctx.model || ""]: { name: ctx.model, modalities: { input: ["text", "image"], output: ["text"] } } } }),
    field(["model"], `srouter/${ctx.model}`),
  ], (doc) => !!doc.provider?.srouter),
    optionalField: field(["agent", "explorer"], {
      description: "Fast explorer subagent for codebase exploration",
      mode: "subagent", model: `srouter/${ctx.model}`,
    }),
  }]),
  tool("droid", "Factory Droid", (ctx) => [json(path.join(home(), ".factory", "settings.json"), [], (doc) => {
    if (doc.customModels !== undefined && !Array.isArray(doc.customModels)) throw new Error("Invalid customModels");
    return (doc.customModels || []).some((model) => /^custom:Srouter(?:-\d+)?$/.test(model?.id));
  })]),
  tool("crush", "Crush", (ctx) => [json(path.join(process.env.XDG_CONFIG_HOME || path.join(home(), ".config"), "crush", "crush.json"), [
    field(["providers", "srouter"], { type: "openai-compat", base_url: v1(ctx.baseUrl), api_key: ctx.apiKey, models: [{ id: ctx.model, name: ctx.model, context_window: 128000 }] }),
  ], (doc) => !!doc.providers?.srouter)]),
  tool("kilo", "Kilo Code CLI", (ctx) => [json(path.join(home(), ".local", "share", "kilo", "auth.json"), [
    field(["openai-compatible"], { type: "api-key", apiKey: ctx.apiKey, baseUrl: v1(ctx.baseUrl), model: ctx.model }),
  ], (doc) => !!doc["openai-compatible"])]),
  tool("cline", "Cline CLI", (ctx) => [
    json(path.join(home(), ".cline", "data", "globalState.json"), [
      field(["actModeApiProvider"], "openai"), field(["planModeApiProvider"], "openai"),
      field(["openAiBaseUrl"], ctx.baseUrl), field(["openAiModelId"], ctx.model), field(["planModeOpenAiModelId"], ctx.model),
    ], (doc) => !!doc.openAiBaseUrl || ["actModeApiProvider", "planModeApiProvider"].some((key) => doc[key] === "openai")),
    json(path.join(home(), ".cline", "data", "secrets.json"), [field(["openAiApiKey"], ctx.apiKey)], (doc) => !!doc.openAiApiKey),
  ]),
];

const TOOL_IDS = TOOLS.map((item) => item.id);
const ALIASES = { "claude-code": "claude", claudecode: "claude", factory: "droid", kilocode: "kilo" };
function resolveTools(list) {
  const ids = new Set();
  for (const raw of list) {
    const id = String(raw).trim().toLowerCase();
    if (!id) continue;
    if (id === "all") { TOOL_IDS.forEach((key) => ids.add(key)); continue; }
    const key = ALIASES[id] || id;
    if (!TOOL_IDS.includes(key)) throw new Error(`Unknown tool "${raw}"`);
    ids.add(key);
  }
  return TOOLS.filter((item) => ids.has(item.id));
}
module.exports = { TOOLS, TOOL_IDS, CLAUDE_MODELS, resolveTools, __test__: { stripTrailingCommas } };
