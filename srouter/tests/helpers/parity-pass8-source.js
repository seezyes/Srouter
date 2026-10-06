import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, it } from "vitest";

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// References never move. Continuation observations must never mutate first-pass evidence.
export const referenceEvidence = path.resolve(repo, "../docs/work/T-0030-upstream-parity/evidence/pass8-code-parity-20261001");
export const evidence = path.resolve(process.env.PASS8_OUTPUT_DIR || path.resolve(repo, "../docs/work/T-0030-upstream-parity/evidence/pass8-adjudication-20261001"));
if(evidence===referenceEvidence||evidence.startsWith(referenceEvidence+path.sep))throw new Error("First Pass8 evidence is immutable");
export const pins = {
  nine: "a99cf57239ff778b61e434c2786009d5ed1c412c",
  vans: "ad591d72de4cdba9516d2408f227e7ddf9c0e417",
};
const deny = (...args) => { throw new Error(`Pass8 hazardous dependency is not stubbed: ${args[0] || ""}`); };

// Executes the unchanged actual source. VM integration is deliberately narrower
// than a real application entrypoint. Imports outside this allow-list fail closed.
export function sourceGraph(label, overrides = {}, options = {}) {
  const root = label === "local" ? repo : path.join(referenceEvidence, "reference", label);
  const modules = new Map(), timers = new Set(), loaded = new Map();
  const fakeProcess = new EventEmitter();
  Object.assign(fakeProcess, {
    env: { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, DATA_DIR: process.env.DATA_DIR, NODE_ENV: "test", ...options.env },
    platform: "win32", version: process.version, versions: { node: process.versions.node }, cwd: () => options.cwd || "C:\\pass8-fixture",
    pid: 999999, exit: deny, kill: deny, stdout: { write() {} }, stderr: { write() {} },
  });
  const deterministicCrypto = {
    ...crypto, randomUUID: options.randomUUID || (() => "12345678-1234-4234-8234-123456789012"),
    randomBytes: n => Buffer.alloc(n, 7),
  };
  const fixedMath = Object.create(Math);
  fixedMath.random = () => 0.314159265;
  const FixedDate = class extends Date {
    constructor(...args) { super(...(args.length ? args : [1790812800000])); }
    static now() { return 1790812800000; }
  };
  const context = vm.createContext({
    console, Buffer, TextEncoder, TextDecoder, URL, URLSearchParams,
    btoa: value=>Buffer.from(value,"binary").toString("base64"),
    atob: value=>Buffer.from(value,"base64").toString("binary"),
    Request, Response, Headers, ReadableStream, WritableStream, TransformStream,
    AbortController, AbortSignal, DOMException, structuredClone,
    process: fakeProcess, Date: options.realClock ? Date : FixedDate,
    Math: fixedMath, crypto: deterministicCrypto, fetch: options.fetch || deny,
    setTimeout: (...args) => { const t = setTimeout(...args); timers.add(t); return t; },
    clearTimeout: t => { clearTimeout(t); timers.delete(t); },
    setInterval: (...args) => { const t = setInterval(...args); timers.add(t); t.unref?.(); return t; },
    clearInterval: t => { clearInterval(t); timers.delete(t); },
    queueMicrotask,
  });
  context.global = context;
  const mocks = {
    os: { platform: () => "win32", arch: () => "x64", hostname: () => "pass8-host", homedir: () => fakeProcess.env.HOME, release: () => "10.0.0", default: { platform: () => "win32", arch: () => "x64", hostname: () => "pass8-host", homedir: () => fakeProcess.env.HOME, release: () => "10.0.0" } },
    "node:os": { platform: () => "win32", arch: () => "x64", hostname: () => "pass8-host", homedir: () => fakeProcess.env.HOME, release: () => "10.0.0", default: { platform: () => "win32", arch: () => "x64", hostname: () => "pass8-host", homedir: () => fakeProcess.env.HOME, release: () => "10.0.0" } },
    "node:net": { isIP, default: { isIP } },
    "node:timers/promises": { setTimeout: delay },
    module: { createRequire: () => (specifier) => {
      if (specifier === "../../package.json") return JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
      throw new Error(`Pass8 CommonJS dependency blocked: ${specifier}`);
    } },
    uuid: { v4: deterministicCrypto.randomUUID },
    "node:dns/promises": { default: { lookup: deny }, lookup: deny },
    undici: { Agent: class { constructor(config) { this.config = config; } async close() {} }, fetch: options.fetch || deny },
    "open-sse/utils/proxyFetch.js": { proxyAwareFetch: options.fetch || deny, withProxy: deny },
    "open-sse/utils/debugLog.js": { dbg() {}, isDebugEnabled: () => false },
    // Do not read host fingerprints. Only synthetic identities are visible.
    "open-sse/shared/machineId.js": { getMachineId: () => "0123456789abcdef", getMachineIdSync: () => "0123456789abcdef" },
    ...overrides,
  };
  const synthetic = (id, obj) => {
    if (modules.has(id)) return modules.get(id);
    const mod = new vm.SyntheticModule(Object.keys(obj), function () {
      for (const [k, v] of Object.entries(obj)) this.setExport(k, v);
    }, { context, identifier: id });
    modules.set(id, mod); return mod;
  };
  function resolve(specifier, parent) {
    if (specifier === "crypto" || specifier === "node:crypto") return { builtin: deterministicCrypto };
    if (specifier === "node:buffer" || specifier === "buffer") return { builtin: { Buffer } };
    let rel;
    if (specifier.startsWith("open-sse/")) rel = specifier;
    else if (specifier.startsWith("@/")) rel = `src/${specifier.slice(2)}`;
    else if (specifier.startsWith(".")) rel = path.relative(root, path.resolve(path.dirname(parent), specifier)).replaceAll("\\", "/");
    else if (Object.hasOwn(mocks, specifier)) return { mock: specifier };
    else throw new Error(`Pass8 forbidden import ${specifier} from ${parent}`);
    if (Object.hasOwn(mocks, rel)) return { mock: rel };
    for (const candidate of [rel, `${rel}.js`, `${rel}/index.js`]) {
      if (Object.hasOwn(mocks, candidate)) return { mock: candidate };
      const full = path.resolve(root, candidate);
      if (!full.startsWith(root + path.sep)) throw new Error("Pass8 import escaped source root");
      if (fs.existsSync(full) && fs.statSync(full).isFile()) return { full, rel: candidate };
    }
    throw new Error(`Pass8 missing source import ${specifier} from ${parent}`);
  }
  function moduleFor(specifier, parent = path.join(root, "<root>")) {
    const resolved = resolve(specifier, parent);
    if (resolved.builtin) return synthetic(`builtin:${specifier}`, { ...resolved.builtin, default: resolved.builtin });
    if (resolved.mock) return synthetic(`mock:${resolved.mock}`, mocks[resolved.mock]);
    const { full, rel } = resolved;
    if (modules.has(full)) return modules.get(full);
    const bytes = fs.readFileSync(full);
    loaded.set(rel, crypto.createHash("sha256").update(bytes).digest("hex"));
    if (rel.endsWith(".json")) return synthetic(full, { default: JSON.parse(bytes.toString("utf8")) });
    const mod = new vm.SourceTextModule(bytes.toString("utf8"), {
      context, identifier: full,
      initializeImportMeta(meta) { meta.url = new URL(`file:///${full.replaceAll("\\", "/")}`).href; },
      importModuleDynamically: async (s, m) => {
        const child = moduleFor(s, m.identifier);
        if (child.status === "unlinked") await child.link(linker);
        if (child.status === "linked") await child.evaluate();
        return child;
      },
    });
    modules.set(full, mod); return mod;
  }
  const linker = (s, m) => moduleFor(s, m.identifier);
  return {
    label, root, process: fakeProcess, loaded, mocks,
    async load(p) {
      const mod = moduleFor(`./${p}`);
      if (mod.status === "unlinked") await mod.link(linker);
      if (mod.status === "linked") await mod.evaluate();
      if (mod.status !== "evaluated") throw mod.status === "errored" ? mod.error : new Error(`Unexpected VM state ${mod.status}: ${p}`);
      return mod.namespace;
    },
    dispose() { for (const t of timers) { clearTimeout(t); clearInterval(t); } timers.clear(); },
  };
}

export const plain = value => JSON.parse(JSON.stringify(value, (key, val) => {
  if (val instanceof Map || Object.prototype.toString.call(val) === "[object Map]") return { map: [...val.entries()] };
  if (val instanceof Set || Object.prototype.toString.call(val) === "[object Set]") return { set: [...val.values()] };
  return val;
}));

export function contractSuite(name) {
  const cases = [];
  afterAll(() => fs.writeFileSync(path.join(evidence, `observations-${name}.json`), JSON.stringify(cases, null, 2)));
  return function test(id, description, anchors, assertions, run, timeout = 15000) {
    const entry = { id, description, anchors, assertions, status: "not-run", testFile: `tests/unit/parity-pass8-${name}.test.js`, testName: `[${id}] ${description}` };
    cases.push(entry);
    it(entry.testName, async ({task}) => {
      try {
        const outcome=await run();
        if(task.result?.errors?.length){
          entry.status="failed";
          entry.error="Soft assertions failed after executing all fields";
          entry.assertionErrors=plain(task.result.errors);
          return;
        }
        entry.status=outcome?.covered===false?"unverified":"passed";
        if(outcome?.covered===false)entry.reason=outcome.reason;
        if(outcome?.coverage)entry.coverage=outcome.coverage;
      }
      catch (e) {
        entry.status = "failed"; entry.error = e.stack || String(e);
        if("actual" in e||"expected" in e)entry.difference=plain({actual:e.actual,expected:e.expected});
        throw e;
      }
    }, timeout);
  };
}
