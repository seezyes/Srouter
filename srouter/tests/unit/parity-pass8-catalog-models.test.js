import { afterAll, beforeAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sourceGraph, plain, contractSuite, evidence, referenceEvidence } from "../helpers/parity-pass8-source.js";

const test=contractSuite("catalog-models"),graphs={},modules={},definitions=[];
const registryPath="open-sse/providers/registry/index.js",modelPath="open-sse/services/model.js",providerPath="open-sse/services/provider.js";
const pricingPath="open-sse/providers/pricing.js",capsPath="open-sse/providers/capabilities.js";
// Exact adapter + persisted-principal equivalence is proved in catalog-consumers
// and catalog-principals. This does not authorize normalizing any other ID.
const canonicalProvider=value=>value==="mmf"?"mimo-free":value;
// Immutable initial failed IDs define expansion scope, NOT an allowed-failure baseline.
const firstRun=path.join(referenceEvidence,"runs/fd4929f0-e38b-4624-a30a-8f4a31b082e2");
const failed=new Set(JSON.parse(fs.readFileSync(path.join(firstRun,"observations-catalog.json"),"utf8")).filter(x=>x.status==="failed").map(x=>x.id));
for(const label of ["local","nine","vans"])graphs[label]=sourceGraph(label);
for(const pin of ["nine","vans"]){
  const files=[...fs.readFileSync(path.join(referenceEvidence,"reference",pin,registryPath),"utf8").matchAll(/^import\s+\w+\s+from\s+"\.\/([^"]+\.js)";/gm)].map(m=>m[1]);
  for(const file of files){
    const provider=file.slice(0,-3),groups=["CAT","CAPS","PRICE"].filter(group=>failed.has(`P8-${group}-${pin}-${provider}`));
    if(!groups.length)continue;
    const anchor=`open-sse/providers/registry/${file}`,def=(await graphs[pin].load(anchor)).default;
    definitions.push({pin,provider,groups,anchor,def});
  }
}
beforeAll(async()=>{
  for(const [label,g]of Object.entries(graphs))modules[label]={registry:(await g.load(registryPath)).default,
    caps:await g.load(capsPath),pricing:await g.load(pricingPath),model:await g.load(modelPath),provider:await g.load(providerPath),
    catalog:await g.load("open-sse/config/providerModels.js")};
},60000);
afterAll(()=>{
  fs.writeFileSync(path.join(evidence,"source-hashes-catalog-models.json"),JSON.stringify(Object.fromEntries(Object.entries(graphs).map(([k,g])=>[k,Object.fromEntries(g.loaded)])),null,2));
  Object.values(graphs).forEach(g=>g.dispose());
});
for(const {pin,provider,groups,anchor,def}of definitions){
  const anchors=[{pin,path:anchor,symbol:"default",caller:modelPath}];
  if(groups.includes("CAT")){
    for(const alias of [...new Set([def.id,def.alias,...(def.aliases||[])].filter(Boolean))]){
      test(`P8A-CAT-${pin}-${provider}-alias-${encodeURIComponent(alias)}`,`${provider} independently resolve declared alias ${alias}`,
        anchors,["Actual parseModel and model-alias indirection; no model loop stops on first failure"],async()=>{
          expect(canonicalProvider(modules.local.model.parseModel(`${alias}/fixture/model`).provider)).toBe(canonicalProvider(def.id));
          const target=await modules.local.model.getModelInfoCore("fixture-alias",{"fixture-alias":`${alias}/fixture/model`});
          expect({...target,provider:canonicalProvider(target.provider)}).toEqual({provider:canonicalProvider(def.id),model:"fixture/model"});
        });
    }
    for(const transport of def.transports||[])test(`P8A-CAT-${pin}-${provider}-lane-${transport.format}`,`${provider} native lane ${transport.format}`,anchors,
      ["resolveTransport uses the declared native endpoint"],()=>expect(modules.local.provider.resolveTransport(provider,transport.format)?.baseUrl).toBe(transport.baseUrl));
  }
  for(const model of def.models||[]){
    const id=typeof model==="string"?model:model.id,encoded=encodeURIComponent(id)+(model.kind?`-kind-${model.kind}`:"");
    if(groups.includes("CAT"))test(`P8A-CAT-${pin}-${provider}-model-${encoded}`,`${provider}/${id} model declaration and wire identifiers`,anchors,
      ["A declaration comparison is not proof of live availability; every pinned model independently executes"],()=>{
        const current=modules.local.registry.find(p=>p.id===def.id);
        const consumed=modules.local.catalog.getProviderModels(def.alias||def.id);
        expect.soft(consumed.some(m=>(typeof m==="string"?m:m.id)===id),`${provider}/${id} actual getProviderModels catalog consumer`).toBe(true);
        const actual=current?.models?.find(m=>(typeof m==="string"?m:m.id)===id);
        expect(actual,`${provider}/${id} missing declaration`).toBeDefined();
        if(model.targetFormat)expect(actual.targetFormat).toBe(model.targetFormat);
        if(model.upstreamModelId)expect(actual.upstreamModelId).toBe(model.upstreamModelId);
      });
    if(groups.includes("CAPS"))test(`P8A-CAPS-${pin}-${provider}-${encoded}`,`${provider}/${id} all observable capability fields`,
      [...anchors,{pin,path:capsPath,symbol:"getCapabilitiesForModel",caller:"open-sse/handlers/chatCore.js"}],
      ["Independent model case; soft assertions execute every field even after a mismatch","Numeric backend limits are comparison-only: trusted backend authority remains required"],()=>{
        const expected=modules[pin].caps.getCapabilitiesForModel(def.id,id),actual=modules.local.caps.getCapabilitiesForModel(def.id,id);
        for(const field of ["vision","pdf","audioInput","videoInput","imageOutput","audioOutput","tools","search","reasoning"]){
          if(expected[field])expect.soft(actual[field],`${provider}/${id}.${field}`).toBe(true);
        }
        expect.soft(actual.contextWindow,`${provider}/${id}.contextWindow`).toBeGreaterThanOrEqual(expected.contextWindow);
        expect.soft(actual.maxOutput,`${provider}/${id}.maxOutput`).toBeGreaterThanOrEqual(expected.maxOutput);
        if(expected.reasoning)expect.soft(actual.thinkingFormat,`${provider}/${id}.thinkingFormat`).toBe(expected.thinkingFormat);
      });
    if(groups.includes("PRICE"))test(`P8A-PRICE-${pin}-${provider}-${encoded}`,`${provider}/${id} rate fields and calculated charges`,
      [...anchors,{pin,path:pricingPath,symbol:"calculateCostFromTokens",caller:"src/lib/db/repos/usageRepo.js"}],
      ["Every model independently resolves all rates and executes all token permutations","Source calculations are not authority for current vendor tariff"],()=>{
        const expected=modules[pin].pricing.getPricingForModel(def.id,id),actual=modules.local.pricing.getPricingForModel(def.id,id);
        if(!expected)return{covered:false,reason:`No pinned tariff for ${provider}/${id}; billing cannot be certified.`};
        expect.soft(plain(actual),`${provider}/${id}.rates`).toEqual(plain(expected));
        for(const tokens of [{prompt_tokens:1234,completion_tokens:456},
          {prompt_tokens:1234,completion_tokens:456,cached_tokens:500,cache_creation_input_tokens:200,reasoning_tokens:123},
          {input_tokens:10,output_tokens:20,cache_read_input_tokens:50}]){
          expect.soft(modules.local.pricing.calculateCostFromTokens(tokens,actual),JSON.stringify(tokens))
            .toBeCloseTo(modules[pin].pricing.calculateCostFromTokens(tokens,expected),12);
        }
      });
  }
}
const modelInputs=[null,"","fixture","openai/a/b","gpt-4o","gpt-6-sol","claude-opus-4.6","grok-build","codex-auto-review"];
const formatInputs=[{}, {input:"x"},{input:[]},{contents:[]},{request:{contents:[]},userAgent:"antigravity"},
  {messages:[{role:"user",content:"x"}],system:""},
  {messages:[{role:"user",content:"x"},{role:"assistant",content:[{type:"tool_use",id:"t",name:"run",input:{}}]}]},
  {messages:[{role:"user",content:[{type:"image_url",image_url:{url:"data:image/png;base64,AQ=="}}]}]},
  {messages:[],logprobs:false}];
for(const pin of ["nine","vans"]){
  for(const [i,input]of modelInputs.entries())test(`P8A-MODEL-${pin}-${i}`,`${pin} canonical model input ${JSON.stringify(input)}`,
    [{pin,path:modelPath,symbol:"getModelInfoCore",caller:"src/sse/handlers/chat.js"}],["Each model-routing permutation executes independently"],
    async()=>expect(plain(await modules.local.model.getModelInfoCore(input,{}))).toEqual(plain(await modules[pin].model.getModelInfoCore(input,{}))));
  for(const [i,input]of formatInputs.entries())test(`P8A-FORMAT-${pin}-${i}`,`${pin} format input ${JSON.stringify(input)}`,
    [{pin,path:providerPath,symbol:"detectFormat",caller:"src/sse/handlers/chat.js"}],["Each ambiguous body independently executes; no previous routing mismatch hides it"],
    ()=>expect(modules.local.provider.detectFormat(input)).toBe(modules[pin].provider.detectFormat(input)));
}
