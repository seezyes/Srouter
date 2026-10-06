import { afterAll, beforeAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sourceGraph, plain, contractSuite, evidence, repo } from "../helpers/parity-pass8-source.js";

const test = contractSuite("catalog-consumers");
const input = JSON.parse(fs.readFileSync(path.resolve(repo,
  "../docs/work/T-0030-upstream-parity/evidence/pass8-catalog-closure-20261001/input62.json"), "utf8"));
const graphs = {}, modules = {}, details = [];
const dispatchGraphs = [];
let connections = [];
const noLive = async () => null;
// Credential/catalog boundaries are fixtures. Registry, alias resolution, ACL,
// model capabilities and the actual buildModelsList implementation are not mocked.
const local = sourceGraph("local", {
  "src/lib/localDb": {
    getProviderConnections: async () => connections, getCombos: async () => [],
    getCustomModels: async () => [], getModelAliases: async () => ({}),
  },
  "src/lib/disabledModelsDb": { getDisabledModels: async () => ({}) },
  "src/lib/db/index.js": { getProviderNodeById: async () => null },
  "src/sse/services/requestAccess.js": { authenticateRequest: noLive },
  "src/sse/services/allowedModels.js": { fetchModelsFetcherIds: async () => { throw new Error("Dynamic fetch forbidden"); } },
  "src/sse/services/tokenRefresh": { updateProviderCredentials: async () => { throw new Error("Credential write forbidden"); } },
  "src/lib/network/connectionProxy": { resolveConnectionProxyConfig: async () => ({}) },
  "open-sse/services/kiroModels.js": { resolveKiroModels: noLive },
  "open-sse/services/kimchiModels.js": { resolveKimchiModels: noLive },
  "open-sse/services/qoderModels.js": { resolveQoderModels: noLive, routableQoderModels: () => [] },
  "open-sse/services/copilotModels.js": { resolveCopilotModels: noLive },
  "open-sse/services/clinepassModels.js": { resolveClinepassModels: noLive, resolveClineModels: noLive },
  "open-sse/services/grokCliModels.js": { resolveGrokCliModels: noLive },
  "open-sse/services/cursorModels.js": { resolveCursorModels: noLive },
  "open-sse/shared/zedAuth.js": { resolveZedModels: noLive },
});
graphs.local = local;
graphs.nine = sourceGraph("nine");
graphs.vans = sourceGraph("vans");
beforeAll(async () => {
  for (const [label, graph] of Object.entries(graphs)) {
    modules[label] = {
      registry: (await graph.load("open-sse/providers/registry/index.js")).default,
      model: await graph.load("open-sse/services/model.js"),
      provider: await graph.load("open-sse/services/provider.js"),
      catalog: await graph.load("open-sse/config/providerModels.js"),
      caps: await graph.load("open-sse/providers/capabilities.js"),
      pricing: await graph.load("open-sse/providers/pricing.js"),
      thinking: await graph.load("open-sse/translator/concerns/thinkingUnified.js"),
      modality: await graph.load("open-sse/translator/concerns/modality.js"),
    };
  }
  modules.local.api = await local.load("src/app/api/v1/models/route.js");
}, 60000);
afterAll(() => {
  fs.writeFileSync(path.join(evidence, "catalog-consumer-fields.json"), JSON.stringify(details, null, 2));
  fs.writeFileSync(path.join(evidence, "source-hashes-catalog-consumers.json"),
    JSON.stringify(Object.fromEntries(Object.entries(graphs).map(([label, graph]) =>
      [label, Object.fromEntries(graph.loaded)])), null, 2));
  Object.values(graphs).forEach(graph => graph.dispose());
  dispatchGraphs.forEach(graph => graph.dispose());
});

async function published(provider, enabledModels) {
  connections = [{ id: "catalog-fixture", provider, isActive: true,
    providerSpecificData: { prefix: "catalog-fixture", ...(enabledModels ? { enabledModels } : {}) } }];
  return modules.local.api.buildModelsList(["llm", "image", "embedding", "tts", "stt", "video"],
    { skipDynamicFetch: true, apiKeyInfo: { allowedProviders: [provider] } });
}

function field(row, name, actual, expected, kind) {
  row.fields.push({ field: name, local: plain(actual ?? null), pinned: plain(expected ?? null),
    kind, equal: JSON.stringify(plain(actual ?? null)) === JSON.stringify(plain(expected ?? null)) });
}

function configuredTarget(module, provider, alias, model, source) {
  const supported = module.catalog.getModelSupportedFormats(alias, model);
  const transport = !supported || supported.includes(source)
    ? module.provider.resolveTransport(provider, source) : null;
  return transport?.format || module.catalog.getModelTargetFormat(alias, model)
    || module.provider.getTargetFormat(provider);
}

// These fixtures settle observable catalog contracts, not current vendor tariffs
// or successful live inference. In particular a larger pinned number is not an
// instruction to raise a local backend limit.
for (const entry of input) {
  const [, group, pin, ...parts] = entry.id.split("-");
  const provider = parts.join("-");
  test(`P8C-${entry.id}`, `${entry.id} actual catalog and native configuration consumers`,
    entry.anchors, ["All fields execute before failure; no first-failing-model truncation",
      "Live catalogs return unavailable; static fallback and explicitly enabled model paths are real",
      "Native thinking and modality consumers execute unchanged source; executor acceptance is separate"], async () => {
      const reference = modules[pin], current = modules.local;
      const row = { originalId: entry.id, group, pin, provider, fields: [], missingLiveProof: true };
      details.push(row);
      if (group === "MODEL") {
        // Local Codex inference and all-turn Claude detection are deliberate
        // source-backed extensions, but remain differential observations too.
        for (const model of ["gpt-6-sol", "gpt-5.6-terra", "codex-auto-review", "grok-build"]) {
          const actual = await current.model.getModelInfoCore(model, {});
          const expected = await reference.model.getModelInfoCore(model, {});
          field(row, `bare[${model}]`, actual, expected, "routing");
          if (model.startsWith("gpt-") || model === "codex-auto-review") expect(actual.provider).toBe("codex");
          else expect(actual).toEqual({ provider: "grok-cli", model: "grok-build" });
        }
        const body = { messages: [{ role: "user", content: "hello" },
          { role: "assistant", content: [{ type: "tool_use", id: "fixture-tool", name: "run", input: {} }] }] };
        field(row, "later-Claude-tool.sourceFormat", current.provider.detectFormat(body),
          reference.provider.detectFormat(body), "routing");
        expect(current.provider.detectFormat(body)).toBe("claude");
        expect(current.provider.detectFormat({ ...body, logprobs: false })).toBe("openai");
        return;
      }
      const ref = (await graphs[pin].load(`open-sse/providers/registry/${provider}.js`)).default;
      const actualDefinition = current.registry.find(item => item.id === ref.id);
      if (group === "CAT") {
        if (provider === "devin-cli") {
          // The exact local registration comment explains the safety exception.
          // Do not spawn a shell/filesystem-capable installed CLI to test it.
          expect(actualDefinition).toBeUndefined();
          expect(current.catalog.getModelsByProviderId(provider)).toHaveLength(0);
          const listed = await published(provider);
          expect(listed).toHaveLength(0);
          row.safetyException = "Registry deliberately excludes devin-cli: local agent has shell/fs access";
          return;
        }
        expect(actualDefinition).toBeDefined();
        for (const alias of [ref.id, ref.alias, ...(ref.aliases || [])].filter(Boolean)) {
          const target = await current.model.getModelInfoCore(`${alias}/fixture/model`, {});
          field(row, `parse[${alias}]`, target.provider, ref.id, "alias-dispatch");
          // Exactly mmf is backed by an actual adapter and persisted-principal
          // equivalence test below/in catalog-principals. Keep the raw field
          // observation; all other collisions remain red.
          const canonical = target.provider === "mmf" ? "mimo-free" : target.provider;
          expect.soft({ ...target, provider: canonical }).toEqual({ provider: ref.id, model: "fixture/model" });
        }
        const listed = await published(provider);
        for (const model of ref.models || []) {
          const id = typeof model === "string" ? model : model.id;
          const consumed = current.catalog.getModelsByProviderId(provider).some(item => item.id === id);
          field(row, `static[${id}]`, consumed, true, "static-catalog");
          expect.soft(consumed, `${provider}/${id} static consumer`).toBe(true);
          const listedModel = listed.find(item => item.id === `catalog-fixture/${id}`);
          field(row, `API[${id}]`, !!listedModel, true, "catalog-fallback");
          expect.soft(!!listedModel, `${provider}/${id} actual catalog fallback`).toBe(true);
          const actualWire = current.catalog.getModelUpstreamId(actualDefinition.alias || provider, id);
          const expectedWire = reference.catalog.getModelUpstreamId(ref.alias || provider, id);
          field(row, `wire[${id}]`, actualWire, expectedWire, "model-remap");
          expect.soft(actualWire, `${provider}/${id} resolved wire model`).toBe(expectedWire);
          const enabled = await published(provider, [id]);
          field(row, `explicit-enabled[${id}]`, enabled.some(item => item.id === `catalog-fixture/${id}`),
            true, "explicit-catalog");
          // Unknown static models may still be explicitly selected. This proves
          // visibility only, NOT the specialized executor's acceptance.
        }
        return;
      }
      if (group === "PRICE") {
        for (const model of ref.models || []) {
          const id = typeof model === "string" ? model : model.id;
          const actual = current.pricing.getPricingForModel(provider, id);
          const expected = reference.pricing.getPricingForModel(provider, id);
          if (!expected) {
            field(row, `rates[${id}]`, actual, null, "no-pinned-tariff");
            continue;
          }
          for (const rate of new Set([...Object.keys(actual || {}), ...Object.keys(expected)])) {
            field(row, `rates[${id}].${rate}`, actual?.[rate], expected[rate], "source-tariff");
            expect.soft(actual?.[rate], `${provider}/${id}.${rate}`).toBe(expected[rate]);
          }
          const tokens = { prompt_tokens: 1000, completion_tokens: 200,
            cached_tokens: 300, cache_creation_input_tokens: 100, reasoning_tokens: 20 };
          const cost = current.pricing.calculateCostFromTokens(tokens, actual);
          const expectedCost = reference.pricing.calculateCostFromTokens(tokens, expected);
          field(row, `cost[${id}]`, cost, expectedCost, "computed-charge");
          expect.soft(cost).toBeCloseTo(expectedCost, 12);
        }
        return;
      }
      expect(group).toBe("CAPS");
      for (const model of ref.models || []) {
        const id = typeof model === "string" ? model : model.id;
        const actual = current.caps.getCapabilitiesForModel(provider, id);
        const expected = reference.caps.getCapabilitiesForModel(provider, id);
        // Only positive-support differences and narrowed limits are parity
        // candidates; stronger local support is retained.
        for (const key of ["vision", "pdf", "audioInput", "videoInput", "imageOutput", "audioOutput",
          "tools", "search", "reasoning", "contextWindow", "maxOutput", "thinkingFormat"]) {
          if (actual[key] === expected[key]) continue;
          const limits = key === "contextWindow" || key === "maxOutput";
          if (!limits && key !== "thinkingFormat" && expected[key] !== true) continue;
          field(row, `caps[${id}].${key}`, actual[key], expected[key], limits ? "backend-limit" : "declared-support");
          if (limits) expect.soft(actual[key], `${provider}/${id}.${key}`).toBeGreaterThanOrEqual(expected[key]);
          else if (key !== "thinkingFormat") expect.soft(actual[key], `${provider}/${id}.${key}`).toBe(expected[key]);
        }
        const listed = await published(provider, [id]);
        const exposed = listed.find(item => item.id === `catalog-fixture/${id}`);
        if (exposed && (!model.kind || model.kind === "llm")) {
          expect.soft(exposed.context_length).toBe(actual.contextWindow);
          expect.soft(exposed.max_completion_tokens).toBe(actual.maxOutput);
          field(row, `API-limits[${id}]`, [exposed.context_length, exposed.max_completion_tokens],
            [expected.contextWindow, expected.maxOutput], "published-limit");
        }
        if (actual.thinkingFormat !== expected.thinkingFormat && expected.reasoning) {
          const alias = actualDefinition?.alias || provider;
          const refAlias = ref.alias || provider;
          for (const source of ["openai", "claude"]) {
            const actualTarget = configuredTarget(current, provider, alias, id, source);
            const expectedTarget = configuredTarget(reference, provider, refAlias, id, source);
            for (const intent of [{ mode: "none" }, { mode: "auto" }, { mode: "level", level: "high" },
              { mode: "budget", budget: 8192 }]) {
              const wire = plain(current.thinking.applyThinking(actualTarget, id, { model: id }, provider, intent));
              const refWire = plain(reference.thinking.applyThinking(expectedTarget, id, { model: id }, provider, intent));
              field(row, `thinking[${id}/${source}/${JSON.stringify(intent)}]`,
                { target: actualTarget, body: wire }, { target: expectedTarget, body: refWire }, "native-thinking-consumer");
              expect.soft(wire, `${provider}/${id}/${source}/${intent.mode}`).toEqual(refWire);
            }
          }
        }
        const body = { messages: [{ role: "user", content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AQ==" } },
          { type: "input_audio", input_audio: { data: "AQ==", format: "wav" } },
          { type: "file", file: { filename: "fixture.pdf", file_data: "data:application/pdf;base64,AQ==" } },
        ] }] };
        const localBody = structuredClone(body), referenceBody = structuredClone(body);
        current.modality.stripUnsupportedModalities(localBody, "openai", actual);
        reference.modality.stripUnsupportedModalities(referenceBody, "openai", expected);
        field(row, `media[${id}]`, localBody, referenceBody, "media-stripping-consumer");
        // videoInput/imageOutput have no branch here; do not infer executor
        // output parity just from a capability declaration.
      }
    }, 60000);
}

for (const label of ["local", "nine", "vans"]) {
  for (const zero of ["cached", "reasoning", "cache_creation"]) {
    test(`P8C-ZERO-${label}-${zero}`, `${label} explicitly zero ${zero} rate stays zero`,
      [{ pin: label, path: "open-sse/providers/pricing.js", symbol: "calculateCostFromTokens" }],
      ["A numeric zero is not a missing rate; independent calculation uses no vendor tariff"], () => {
        const rates = { input: 1, output: 2, cached: 0.1, reasoning: 3, cache_creation: 1.2, [zero]: 0 };
        const tokens = { prompt_tokens: 1000, completion_tokens: 200,
          cached_tokens: 300, cache_creation_input_tokens: 100, reasoning_tokens: 20 };
        const expected = (600 * rates.input + 200 * rates.output + 300 * rates.cached
          + 100 * rates.cache_creation + 20 * rates.reasoning) / 1000000;
        expect(modules[label].pricing.calculateCostFromTokens(tokens, rates)).toBeCloseTo(expected, 12);
      });
  }
}

test("P8C-MMF-actual-dispatch", "mmf alias executes the actual MiMo Free bootstrap and chat adapter",
  [{ pin: "local", path: "open-sse/executors/index.js", symbol: "getExecutor" },
    { pin: "local", path: "open-sse/executors/mimo-free.js", symbol: "MimoFreeExecutor.execute" }],
  ["Only unrelated constructors are stubbed; the selected MiMo adapter executes real bootstrap, auth and request transformation",
    "Same adapter does not establish equality of API-key provider grants"], async () => {
    const overrides = {}, calls = [];
    const imports = fs.readFileSync(path.join(repo, "open-sse/executors/index.js"), "utf8");
    for (const match of imports.matchAll(/^import\s+(.+?)\s+from\s+"\.\/([^"]+)";/gm)) {
      if (match[2] === "mimo-free.js") continue;
      class UnrelatedExecutor {
        execute() { throw new Error("Unrelated executor must not be invoked"); }
      }
      const names = match[1].replace(/[{}]/g, "").trim().split(/\s*,\s*/);
      overrides[`open-sse/executors/${match[2]}`] = Object.fromEntries(
        names.map(name => [match[1].startsWith("{") ? name : "default", UnrelatedExecutor]));
    }
    const syntheticOS = { platform: () => "win32", arch: () => "x64", hostname: () => "fixture",
      cpus: () => [{ model: "fixture CPU" }], userInfo: () => ({ username: "fixture-user" }) };
    overrides.os = { ...syntheticOS, default: syntheticOS };
    const fetch = async (url, options) => {
      calls.push({ url, method: options.method, body: JSON.parse(options.body), headers: options.headers });
      return url.endsWith("/bootstrap")
        ? Response.json({ jwt: "fixture-bootstrap-token" })
        : Response.json({ choices: [{ message: { content: "fixture response" }, finish_reason: "stop" }] });
    };
    const graph = sourceGraph("local", overrides, { fetch });
    dispatchGraphs.push(graph);
    const model = await graph.load("open-sse/services/model.js");
    const factory = await graph.load("open-sse/executors/index.js");
    const free = await graph.load("open-sse/executors/mimo-free.js");
    for (const alias of ["mmf", "mimo-free"]) {
      const target = model.parseModel(`${alias}/mimo-auto`);
      const executor = factory.getExecutor(target.provider);
      expect(executor).toBeInstanceOf(free.MimoFreeExecutor);
      const result = await executor.execute({ model: target.model,
        body: { model: target.model, messages: [{ role: "user", content: "fixture" }] },
        stream: false, credentials: {}, proxyOptions: { strictProxy: true, connectionProxyEnabled: true } });
      expect(result.response.status).toBe(200);
      expect(result.url).toBe("https://api.xiaomimimo.com/api/free-ai/openai/chat");
    }
    expect(calls.map(call => call.url)).toEqual([
      "https://api.xiaomimimo.com/api/free-ai/bootstrap",
      "https://api.xiaomimimo.com/api/free-ai/openai/chat",
      "https://api.xiaomimimo.com/api/free-ai/openai/chat",
    ]);
    for (const call of calls.slice(1)) {
      expect(call.body.messages[0].content).toBe(free.MIMO_SYSTEM_MARKER);
      expect(call.headers.Authorization).toBe("Bearer fixture-bootstrap-token");
    }
    details.push({ originalId: "P8-CAT-nine-mimo-free+P8-CAT-vans-mimo-free",
      group: "supplemental", fields: [], actualAdapterExecuted: true,
      remaining: "Canonical grant equivalence between provider ids mmf and mimo-free is not settled" });
    fs.writeFileSync(path.join(evidence, "source-hashes-catalog-mmf-dispatch.json"),
      JSON.stringify(Object.fromEntries(graph.loaded), null, 2));
  });

test("P8C-MUSE-alias-conflict", "Muse Web short alias is not allowed to silently select the Model API",
  [{ pin: "local", path: "open-sse/services/model.js", symbol: "getModelInfoCore" },
    { pin: "local", path: "open-sse/providers/registry/muse-spark-web.js", symbol: "aliases" }],
  ["Real canonical model resolution and native transport; no credentials or fetch"], async () => {
    const target = await modules.local.model.getModelInfoCore("muse/muse-spark", {});
    const format = modules.local.provider.getTargetFormat(target.provider);
    expect.soft(target.provider).toBe("muse-spark-web");
    expect.soft(format).toBe("muse-spark-web");
    expect(await modules.local.model.getModelInfoCore("muse-spark-web/muse-spark", {}))
      .toEqual({ provider: "muse-spark-web", model: "muse-spark" });
  });

for (const id of ["poolside/laguna-s-2.1", "poolside/laguna-xs-2.1"]) {
  test(`P8C-API-WIRE-${encodeURIComponent(id)}`, `Published ${id} retains its vendor namespace on replay`,
    [{ pin: "local", path: "src/app/api/v1/models/route.js", symbol: "buildModelsList" },
      { pin: "local", path: "open-sse/config/providerModels.js", symbol: "getModelUpstreamId" }],
    ["Actual public catalog → client replay → actual model resolver → upstream wire id",
      "Provider-qualified registry ids are not provider prefixes to discard"], async () => {
      connections = [{ id: "fixture", provider: "poolside", isActive: true, providerSpecificData: {} }];
      const listed = await modules.local.api.buildModelsList(["llm"],
        { skipDynamicFetch: true, apiKeyInfo: { allowedProviders: ["poolside"] } });
      const entry = listed.find(item => item.id.endsWith(id.split("/").pop()));
      expect(entry).toBeDefined();
      const target = await modules.local.model.getModelInfoCore(entry.id, {});
      expect(target.provider).toBe("poolside");
      expect(modules.local.catalog.getModelUpstreamId("poolside", target.model)).toBe(id);
    });
}
