const os = require("os");
const { TOOLS, TOOL_IDS, CLAUDE_MODELS, resolveTools } = require("./connectTools");
const DEFAULT_MODEL = "cc/claude-sonnet-5";
const HELP = `
Usage: srouter connect <server-url> [options]
Configure local tools against a Srouter server, without starting a local server.
  --tools <list>       ${TOOL_IDS.join(", ")}, all (TTY picker; non-TTY: claude)
  --password <pw>      Or SROUTER_PASSWORD; masked terminal prompt is preferred
  --api-key <key>      Skip dashboard login
  --key-name <name>    Reuse/create an active key (default: cli-<hostname>)
  --model <model>      Non-Claude model (default: ${DEFAULT_MODEL})
  --fable|--opus|--sonnet|--haiku <model>  Claude model mappings
  --print-env          Print a template, never the API key
  --reset              Restore only unchanged fields managed by connect
  -h, --help           Show help
Remote servers require HTTPS. Existing foreign credentials/configs are not replaced.
`;

function parseArgs(argv) {
  const opts = { password: process.env.SROUTER_PASSWORD || null, keyName: `cli-${os.hostname()}`.slice(0, 64), apiKey: null, models: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${a}`);
      return value;
    };
    if (a === "--password") opts.password = next();
    else if (a === "--api-key") opts.apiKey = next();
    else if (a === "--key-name") opts.keyName = next();
    else if (a === "--tools") opts.tools = next().split(",");
    else if (a === "--model") opts.model = next();
    else if (a === "--print-env") opts.printEnv = true;
    else if (a === "--reset") opts.reset = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (CLAUDE_MODELS.some((model) => a === `--${model.flag}`)) opts.models[a.slice(2)] = next();
    else if (!a.startsWith("-") && !opts.url) opts.url = a;
    else throw new Error(`Unknown option: ${a}`);
  }
  return opts;
}

function normalizeServerUrl(input) {
  let raw = String(input || "").trim();
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Server URL must be HTTP(S), without credentials");
  return url.origin;
}
const maskKey = () => "****";
class Cancelled extends Error {}

async function selectTools(opts) {
  if (opts.tools) return resolveTools(opts.tools);
  if (!process.stdin.isTTY) return resolveTools(["claude"]);
  const { MultiSelect } = require("enquirer");
  const ids = await new MultiSelect({
    message: "Select tools (space to toggle, enter to confirm)",
    choices: TOOLS.map((tool) => ({ name: tool.id, message: tool.name, enabled: tool.id === "claude" })),
  }).run().catch(() => { throw new Cancelled(); });
  return resolveTools(ids);
}

function warnMissingModels(tools, ctx, catalog) {
  const ids = new Set(catalog.map((model) => model?.id));
  // Model IDs are user input. Do not let terminal controls alter warning output.
  const printable = (value) => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  const warn = (model, flag) => {
    if (!ids.has(model)) console.log(`Warning: ${printable(model)} is not in the server catalog; use ${flag} to override. Configuration will continue.`);
  };
  if (tools.some((tool) => tool.id === "claude")) {
    for (const model of CLAUDE_MODELS) warn(ctx.claudeModels[model.envKey], `--${model.flag}`);
  }
  if (tools.some((tool) => tool.id !== "claude")) warn(ctx.model, "--model");
}

async function request(url, { method = "GET", body, cookie, apiKey } = {}) {
  const headers = { Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let res;
  try {
    res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined,
      redirect: "error", signal: AbortSignal.timeout(15000) });
  } catch {
    throw new Error(`Cannot reach ${new URL(url).origin}`);
  }
  let data = null;
  try { data = await res.json(); } catch { /* invalid response */ }
  return { status: res.status, headers: res.headers, data };
}

function extractAuthCookie(headers) {
  const cookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie") || ""];
  for (const cookie of cookies) {
    const match = /(?:^|,\s*)(srouter_auth_token)=([^;]+)/.exec(cookie);
    if (match && !/[\r\n]/.test(match[2])) return `${match[1]}=${match[2]}`;
  }
  return null;
}

async function getKey(server, opts) {
  if (opts.apiKey) return opts.apiKey;
  let password = opts.password;
  if (password == null) {
    if (!process.stdin.isTTY) throw new Error("Password required: set SROUTER_PASSWORD or pass --password");
    const { Password } = require("enquirer");
    password = await new Password({ message: "Srouter dashboard password" }).run()
      .catch(() => { throw new Cancelled(); });
  }
  if (["123456", "password", "change-me", "changeme"].includes(String(password).trim().toLowerCase())) {
    throw new Error("Replace the default dashboard password before connecting");
  }
  const login = await request(`${server}/api/auth/login`, { method: "POST", body: { password } });
  const cookie = login.status === 200 && login.data?.success && extractAuthCookie(login.headers);
  if (!cookie) throw new Error(`Login failed (${login.status})`);
  const list = await request(`${server}/api/keys`, { cookie });
  if (list.status !== 200 || !Array.isArray(list.data?.keys)) throw new Error(`Failed to list keys (${list.status})`);
  const existing = list.data.keys.find((key) => key.isActive !== false && key.name === opts.keyName && typeof key.key === "string");
  if (existing) return existing.key;
  const created = await request(`${server}/api/keys`, { method: "POST", cookie, body: { name: opts.keyName } });
  if (created.status !== 201 || typeof created.data?.key !== "string" || !created.data.key) throw new Error(`Failed to create key (${created.status})`);
  return created.data.key;
}

async function run(argv) {
  try {
    const opts = parseArgs(argv);
    if (opts.help || (!opts.reset && !opts.url)) { console.log(HELP); return opts.help ? 0 : 1; }
    const tools = await selectTools(opts);
    if (!tools.length) throw new Error("Select at least one tool");
    if (opts.reset) {
      let failed = 0;
      for (const tool of tools) {
        try { await tool.reset(); console.log(`${tool.name}: reset complete`); }
        catch { failed++; console.log(`${tool.name}: config conflict, left unchanged`); }
      }
      return failed ? 1 : 0;
    }
    const server = normalizeServerUrl(opts.url);
    const url = new URL(server);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Remote connect requires HTTPS");
    const ctx = { baseUrl: server, model: opts.model || DEFAULT_MODEL, claudeModels: {} };
    for (const model of CLAUDE_MODELS) ctx.claudeModels[model.envKey] = opts.models[model.flag] || model.defaultValue;
    // All local documents are inspected before login/key creation or first write.
    for (const tool of tools) await tool.preflight(ctx);
    ctx.apiKey = await getKey(server, opts);
    const models = await request(`${server}/v1/models`, { apiKey: ctx.apiKey });
    if (models.status === 401 || models.status === 403) throw new Error("API key rejected by server");
    if (models.status !== 200 || !Array.isArray(models.data?.data)) throw new Error("Server model catalog unavailable");
    warnMissingModels(tools, ctx, models.data.data);
    for (const tool of tools) await tool.apply(ctx);
    console.log(`Configured ${tools.map((tool) => tool.name).join(", ")} at ${server}/v1`);
    if (opts.printEnv) console.log(`OPENAI_BASE_URL=${server}/v1\nOPENAI_API_KEY=<copy the selected key securely from the dashboard>`);
    return 0;
  } catch (error) {
    if (error instanceof Cancelled) return 130;
    throw error;
  }
}
module.exports = { run, __test__: { parseArgs, normalizeServerUrl, extractAuthCookie, maskKey, Cancelled, selectTools, warnMissingModels } };
