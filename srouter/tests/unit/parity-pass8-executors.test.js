import { beforeAll, afterAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sourceGraph, evidence, referenceEvidence, repo, plain, contractSuite } from "../helpers/parity-pass8-source.js";

const test = contractSuite("executors");
const roots = { local: repo, nine: path.join(referenceEvidence,"reference/nine"), vans: path.join(referenceEvidence,"reference/vans") };
const graphs = {}, engines = {}, requests = {};
const index = "open-sse/executors/index.js";
const base = "open-sse/executors/base.js";
const def = "open-sse/executors/default.js";
function specializedRegistrationStubs(root) {
  const source = fs.readFileSync(path.join(root,index),"utf8");
  const mocks = {};
  // Imports and re-exports may ask for different bindings from the same module.
  // These are registration-only surrogates; no specialized behavior is covered.
  for (const [, binding, filename] of source.matchAll(/(?:import|export)\s+(.+?)\s+from\s+"\.\/([^"]+)";/g)) {
    if (filename === "default.js" || filename === "base.js") continue;
    const placeholder = class { constructor() { this.pass8RegistrationOnly = true; } };
    const exports = mocks[`open-sse/executors/${filename}`] || {};
    if (binding.startsWith("{")) for (const name of binding.slice(1,-1).split(",").map(s=>s.trim())) exports[name] = placeholder;
    else exports.default = placeholder;
    mocks[`open-sse/executors/${filename}`] = exports;
  }
  return mocks;
}
beforeAll(async () => {
  for (const [label,root] of Object.entries(roots)) {
    requests[label] = [];
    const fetch = async (url, init, proxy) => {
      requests[label].push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body), proxy, aborted: init.signal.aborted });
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "fixture" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    graphs[label] = sourceGraph(label, {
      ...specializedRegistrationStubs(root),
      "open-sse/services/oauthCredentialManager.js": { shouldRefreshCredentials: () => false },
    }, { fetch });
    engines[label] = {
      dispatch: await graphs[label].load(index),
      providers: await graphs[label].load("open-sse/providers/index.js"),
      default: await graphs[label].load(def),
    };
  }
},60000);
afterAll(() => {
  fs.writeFileSync(path.join(evidence,"source-hashes-executors.json"),JSON.stringify(Object.fromEntries(Object.entries(graphs).map(([k,g])=>[k,Object.fromEntries(g.loaded)])),null,2));
  Object.values(graphs).forEach(g=>g.dispose());
});
// These are named client-brand/version headers only. Authentication, account,
// content-type, protocol beta and all other headers are compared.
const brandHeaders = new Set(["user-agent", "x-client-version", "x-core-version", "x-client-type"]);
const canonicalHeaders = h => Object.fromEntries(Object.entries(h).filter(([k])=>!brandHeaders.has(k.toLowerCase()))
  .map(([k,v])=>[k.toLowerCase(),k.toLowerCase()==="anthropic-beta"?v.split(",").map(x=>x.trim()).sort().join(","):v]));
for (const pin of ["nine","vans"]) {
  const files = fs.readdirSync(path.join(roots[pin],"open-sse/providers/registry")).filter(f=>f.endsWith(".js")&&f!=="index.js");
  for (const file of files) test(`P8-WIRE-${pin}-${file.slice(0,-3)}`, `${pin} actual default dispatch/auth/request/status protocol: ${file}`,
    [{ pin, path: index, symbol: "getExecutor", caller: "open-sse/handlers/chatCore.js" },
      { pin, path: def, symbol: "DefaultExecutor.buildHeaders" }, { pin, path: base, symbol: "BaseExecutor.execute" }],
    ["Real dispatch index's default branch; specialized registration dependencies are inert and never asserted as protocol coverage",
      "POST URL, credential precedence, auth descriptor, SSE Accept and emitted transformed payload compared against pinned executor",
      "Fixture response reaches caller; no network calls; explicit retry-zero config isolates wire protocol"], async () => {
      const reference = (await graphs[pin].load(`open-sse/providers/registry/${file}`)).default;
      if (!reference.transport || engines[pin].dispatch.hasSpecializedExecutor(reference.id)) return { covered:false, reason:"Specialized/no-transport branch: inventory only; no protocol behavior asserted." };
      if(engines.local.dispatch.hasSpecializedExecutor(reference.id))return {covered:false,reason:"Inert registration placeholder cannot certify specialized replacement; see P8A-ADAPTER behavioral tests. No wire parity asserted here."};
      for (const credentials of [
        { apiKey: "fixture-api", providerSpecificData: { accountId: "fixture-account", orgId: "fixture-org", deviceId: "fixture-device" } },
        { accessToken: "fixture-oauth", providerSpecificData: { accountId: "fixture-account", deviceId: "fixture-device" } },
        { apiKey: "fixture-api", accessToken: "fixture-oauth", providerSpecificData: { accountId: "fixture-account", deviceId: "fixture-device" } },
      ]) for (const stream of [false,true]) {
        const upstream = engines[pin].dispatch.getExecutor(reference.id);
        const local = engines.local.dispatch.getExecutor(reference.id);
        const originalLocal = local.config, originalUpstream = upstream.config;
        const disabledRetry = { 429:0, 500:0, 502:0, 503:0, 504:0 };
        local.config = { ...local.config, retry: disabledRetry };
        upstream.config = { ...upstream.config, retry: disabledRetry };
        const model=reference.id==="claude"?"claude-sonnet-4-6":"fixture-model";
        const body = { model, stream, messages: [{ role: "user", content: "fixture content" }], max_tokens: 128 };
        const proxyOptions = { strictProxy: true, proxyUrl: "http://fixture-proxy.invalid:9090" };
        try {
          const expected = await upstream.execute({ model, body: structuredClone(body), stream, credentials: structuredClone(credentials), proxyOptions });
          const actual = await local.execute({ model, body: structuredClone(body), stream, credentials: structuredClone(credentials), proxyOptions });
          const refRequest = requests[pin].at(-1), currentRequest = requests.local.at(-1);
          expect(currentRequest.url).toBe(refRequest.url);
          expect(currentRequest.method).toBe("POST");
          const currentHeaders=canonicalHeaders(currentRequest.headers),refHeaders=canonicalHeaders(refRequest.headers);
          if(reference.id==="kimi"){
            expect(currentHeaders["x-msh-platform"]).toBe("srouter");
            expect(currentHeaders["x-msh-version"]).toBe("0.16.0");
            delete currentHeaders["x-msh-platform"];delete currentHeaders["x-msh-version"];
            delete refHeaders["x-msh-platform"];delete refHeaders["x-msh-version"];
          }
          expect(currentHeaders).toMatchObject(refHeaders);
          expect(plain(currentRequest.body)).toMatchObject(plain(refRequest.body));
          expect(currentRequest.proxy).toEqual(proxyOptions);
          expect(actual.response.status).toBe(expected.response.status);
          await actual.response.body.cancel(); await expected.response.body.cancel();
        } finally { local.config=originalLocal; upstream.config=originalUpstream; }
      }
    });
}
for (const [provider, kind, apiType, endpoint] of [
  ["openai-compatible-fixture","openai","chat","/chat/completions"],
  ["openai-compatible-responses-fixture","openai-responses","responses","/responses"],
  ["anthropic-compatible-fixture","claude",null,"/messages"],
]) test(`P8-NODE-${provider}`, `Compatible node ${kind} dispatch retains custom origin and auth`,
  [{ pin:"nine",path:def,symbol:"DefaultExecutor.buildUrl" },{pin:"vans",path:def,symbol:"DefaultExecutor.buildHeaders"}],
  ["Custom node baseUrl/apiType override reaches execute", "API-key versus OAuth selected by actual descriptor"],
  async () => {
    const ex = new engines.local.default.DefaultExecutor(provider);
    const creds={apiKey:"fixture-node-key",providerSpecificData:{baseUrl:"https://fixture.invalid/api/",apiType}};
    const r=await ex.execute({model:"fixture",body:{messages:[{role:"user",content:"node"}]},stream:false,credentials:creds});
    expect(requests.local.at(-1).url).toBe(`https://fixture.invalid/api${endpoint}`);
    expect(requests.local.at(-1).headers[kind==="claude"?"x-api-key":"Authorization"]).toBe(kind==="claude"?"fixture-node-key":"Bearer fixture-node-key");
    await r.response.body.cancel();
  });
