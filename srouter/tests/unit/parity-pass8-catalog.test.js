import { beforeAll, afterAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sourceGraph, evidence, referenceEvidence, plain, contractSuite } from "../helpers/parity-pass8-source.js";

const test = contractSuite("catalog");
const graphs = Object.fromEntries(["local", "nine", "vans"].map(label => [label, sourceGraph(label)]));
const modules = {};
const registryPath = "open-sse/providers/registry/index.js";
const pricingPath = "open-sse/providers/pricing.js";
const capsPath = "open-sse/providers/capabilities.js";
const modelPath = "open-sse/services/model.js";
const providerPath = "open-sse/services/provider.js";
// The actual MiMo dispatch and persisted-principal fixtures prove this exact
// executor alias. Do not normalize other provider IDs (notably Muse).
const canonicalProvider = value => value === "mmf" ? "mimo-free" : value;
beforeAll(async () => {
  for (const [label, g] of Object.entries(graphs)) {
    modules[label] = {
      registry: (await g.load(registryPath)).default,
      pricing: await g.load(pricingPath), caps: await g.load(capsPath),
      model: await g.load(modelPath), provider: await g.load(providerPath),
    };
  }
}, 60000);
afterAll(() => {
  fs.writeFileSync(path.join(evidence, "source-hashes-catalog.json"), JSON.stringify(
    Object.fromEntries(Object.entries(graphs).map(([k,g]) => [k, Object.fromEntries(g.loaded)])), null, 2));
  Object.values(graphs).forEach(g => g.dispose());
});
// Full-tree dormant blobs remain in contract-coverage.json as inventory-only.
// A commented upstream registration is not a callable provider contract.
const files = label => [...fs.readFileSync(path.join(referenceEvidence,"reference",label,registryPath),"utf8")
  .matchAll(/^import\s+\w+\s+from\s+"\.\/([^"]+\.js)";/gm)].map(m=>m[1]);
for (const pin of ["nine", "vans"]) {
  for (const file of files(pin)) {
    const anchor = `open-sse/providers/registry/${file}`;
    test(`P8-CAT-${pin}-${file.slice(0,-3)}`, `${pin} registry consumer preserves aliases, target lane and declared models: ${file}`,
      [{ pin, path: anchor, symbol: "default", caller: modelPath }, { pin, path: providerPath, symbol: "getTargetFormat" }],
      ["Resolve every provider id/alias through actual parseModel/getModelInfoCore", "Preserve all pinned declared model IDs and per-model target formats; extra local models allowed", "Preserve available native transport endpoints"], async () => {
        const ref = (await graphs[pin].load(anchor)).default;
        const current = modules.local.registry.find(e => e.id === ref.id);
        expect(current, `missing registry provider ${ref.id}`).toBeDefined();
        for (const alias of [ref.id, ref.alias, ...(ref.aliases || [])].filter(Boolean)) {
          expect(canonicalProvider(modules.local.model.parseModel(`${alias}/fixture/model`).provider)).toBe(canonicalProvider(ref.id));
          const target = await modules.local.model.getModelInfoCore("fixture-alias", { "fixture-alias": `${alias}/fixture/model` });
          expect({ ...target, provider: canonicalProvider(target.provider) }).toEqual({ provider: canonicalProvider(ref.id), model: "fixture/model" });
        }
        for (const m of ref.models || []) {
          const id = typeof m === "string" ? m : m.id;
          const actual = (current.models || []).find(row => (typeof row === "string" ? row : row.id) === id);
          expect(actual, `${ref.id}/${id} missing from local model consumer input`).toBeDefined();
          if (m.targetFormat) expect(actual.targetFormat, `${ref.id}/${id} transport`).toBe(m.targetFormat);
          if (m.upstreamModelId) expect(actual.upstreamModelId).toBe(m.upstreamModelId);
        }
        // Local OpenAI/Factory native lanes extend the pinned default lane.
        for (const transport of ref.transports || []) {
          const actual = modules.local.provider.resolveTransport(ref.id, transport.format);
          expect(actual?.baseUrl, `${ref.id}/${transport.format}`).toBe(transport.baseUrl);
        }
        if (ref.transport) {
          expect(modules.local.provider.getTargetFormat(ref.id)).toBe(modules[pin].provider.getTargetFormat(ref.id));
        }
      });
    test(`P8-CAPS-${pin}-${file.slice(0,-3)}`, `${pin} model capability/context consumer: ${file}`,
      [{ pin, path: capsPath, symbol: "getCapabilitiesForModel", caller: "open-sse/handlers/chatCore.js" }, { pin, path: anchor, symbol: "default" }],
      ["Every model keeps positive upstream modality/tool support", "Context/output limits do not narrow pinned support", "Reasoning format remains callable for reasoning-capable pinned models"], async () => {
        const ref = (await graphs[pin].load(anchor)).default;
        if(!ref.models?.length)return {covered:false,reason:"No declared pinned model: this case has no capability assertions; runtime/dynamic catalog remains unverified."};
        for (const m of ref.models || []) {
          const id = typeof m === "string" ? m : m.id;
          const expected = modules[pin].caps.getCapabilitiesForModel(ref.id, id);
          const actual = modules.local.caps.getCapabilitiesForModel(ref.id, id);
          for (const key of ["vision", "pdf", "audioInput", "videoInput", "imageOutput", "audioOutput", "tools", "search", "reasoning"]) {
            if (expected[key]) expect(actual[key], `${ref.id}/${id}: ${key}`).toBe(true);
          }
          expect(actual.contextWindow, `${ref.id}/${id}: contextWindow`).toBeGreaterThanOrEqual(expected.contextWindow);
          expect(actual.maxOutput, `${ref.id}/${id}: maxOutput`).toBeGreaterThanOrEqual(expected.maxOutput);
          if (expected.reasoning) expect(actual.thinkingFormat, `${ref.id}/${id}: thinkingFormat`).toBe(expected.thinkingFormat);
        }
      });
    test(`P8-PRICE-${pin}-${file.slice(0,-3)}`, `${pin} model billing calculation: ${file}`,
      [{ pin, path: pricingPath, symbol: "getPricingForModel", caller: "src/lib/db/repos/pricingRepo.js" },
        { pin, path: pricingPath, symbol: "calculateCostFromTokens" }, { pin, path: anchor, symbol: "default" }],
      ["All upstream catalog model rates and costs match actual pinned resolver", "Cache-inclusive and reasoning/output fixtures preserve reference charges"], async () => {
        const ref = (await graphs[pin].load(anchor)).default;
        const testedModels=[],withoutPinnedRate=[];
        for (const m of ref.models || []) {
          const id = typeof m === "string" ? m : m.id;
          const expected = modules[pin].pricing.getPricingForModel(ref.id, id);
          if (!expected) { withoutPinnedRate.push(id); continue; }
          testedModels.push(id);
          const actual = modules.local.pricing.getPricingForModel(ref.id, id);
          expect(plain(actual), `${ref.id}/${id}: rate`).toEqual(plain(expected));
          for (const tokens of [
            { prompt_tokens: 1234, completion_tokens: 456 },
            { prompt_tokens: 1234, completion_tokens: 456, cached_tokens: 500, cache_creation_input_tokens: 200, reasoning_tokens: 123 },
            { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 50 },
          ]) {
            expect(modules.local.pricing.calculateCostFromTokens(tokens, actual), `${ref.id}/${id}: cost`)
              .toBeCloseTo(modules[pin].pricing.calculateCostFromTokens(tokens, expected), 12);
          }
        }
        const coverage={testedModels,withoutPinnedRate};
        return testedModels.length?{coverage}:{covered:false,coverage,reason:"No pinned rates for declared models: no pricing assertions executed; remains unverified."};
      });
  }
  test(`P8-MODEL-${pin}-edge`, `${pin} aliases and ambiguous format routing`,
    [{ pin, path: modelPath, symbol: "getModelInfoCore" }, { pin, path: providerPath, symbol: "detectFormat" }],
    ["Bare aliases, object aliases, unknown model fallback, slash preservation", "Native/ambiguous tool and media shapes use pinned format detection"], async () => {
      for (const input of [null, "", "fixture", "openai/a/b", "gpt-4o", "gpt-6-sol", "claude-opus-4.6", "grok-build", "codex-auto-review"]) {
        expect(plain(await modules.local.model.getModelInfoCore(input, {}))).toEqual(plain(await modules[pin].model.getModelInfoCore(input, {})));
      }
      for (const body of [
        {}, { input: "x" }, { input: [] }, { contents: [] },
        { request: { contents: [] }, userAgent: "antigravity" },
        { messages: [{ role: "user", content: "x" }], system: "" },
        { messages: [{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "tool_use", id: "t", name: "run", input: {} }] }] },
        { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AQ==" } }] }] },
        { messages: [], logprobs: false },
      ]) expect(modules.local.provider.detectFormat(body)).toBe(modules[pin].provider.detectFormat(body));
    });
}
