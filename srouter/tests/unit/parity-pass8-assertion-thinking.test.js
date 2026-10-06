import { expect } from "vitest";
import { registerPinnedRecipes, extraCase, ownedGraph } from "../helpers/parity-pass8-assertion-recipes.js";
import { getRegistered } from "../helpers/parity-pass8-assertion-native.js";
await registerPinnedRecipes("thinking-unified.test.js");
for(const label of ["local","nine","vans"])for(const target of ["gemini","gemini-cli"]){
  extraCase(`A8-NATIVE-THINKING-${label}-${target}-high`,async check=>{
    const model=target==="gemini"?"gemini-2.5-flash":"gemini-2.5-pro",
      body={messages:[{role:"user",content:"fixture native user"}],max_tokens:1024,reasoning_effort:"high"},
      credentials={accessToken:"fixture",providerSpecificData:{projectId:"fixture-project"}},g=ownedGraph(label);
    const {translateRequest}=await g.load("open-sse/translator/index.js"),
      out=translateRequest("openai",target,model,body,true,credentials,target),native=out.request||out;
    await check("Exact Flash/CLI Pro HIGH budget, not substituted model",()=>expect(native.generationConfig.thinkingConfig.thinkingBudget).toBe(24576));
    await check("Gemini 2.5 must not receive unsupported thinkingLevel",()=>expect(native.generationConfig.thinkingConfig.thinkingLevel).toBeUndefined());
    await check("Native thoughts enabled with explicit HIGH intent",()=>expect(native.generationConfig.thinkingConfig.includeThoughts).toBe(true));
    await check("Actual producer leaves output room at exact 32768",()=>expect(native.generationConfig.maxOutputTokens).toBe(32768));
    await check("Valid native user content preserved",()=>expect(native.contents.some(c=>c.role==="user"&&c.parts.some(p=>p.text==="fixture native user"))).toBe(true));
    return{model,target,input:body,out,sources:Object.fromEntries(g.loaded),originalRanges:{nine:[[126,137]],vans:[[112,116]]}};
  },{implementation:label,pin:label==="vans"?"vans":"nine",upstreamRelativePath:"tests/translator/thinking-unified.test.js",strengthening:true});
}
for(const label of ["local","nine","vans"])extraCase(`A8-NATIVE-THINKING-${label}-glm52-low-wire`,async check=>{
  const requests=[],g=ownedGraph(label,{},{
    fetch:async(url,options)=>{requests.push({url,options:{...options,body:JSON.parse(options.body)}});return Response.json({choices:[{message:{role:"assistant",content:"fixture"}}]});}});
  const engine=await g.load("open-sse/translator/index.js"),caps=await g.load("open-sse/providers/capabilities.js"),
    body={model:"glm-5.2",messages:[{role:"user",content:"Fixture valid low-effort request"}],reasoning_effort:"low"},
    translated=engine.translateRequest("openai","openai","glm-5.2",structuredClone(body),false,{apiKey:"fixture"},"zai"),
    {ex}=await getRegistered(g,"zai"),result=await ex.execute({model:"glm-5.2",body:translated,stream:false,credentials:{apiKey:"fixture"}});
  await check("Exact GLM5.2 original low effort must reach wire",()=>expect(requests[0].options.body.reasoning_effort).toBe("low"),[158,158]);
  await check("Native messages remain schema-valid",()=>expect(requests[0].options.body.messages).toEqual(body.messages));
  await check("Synthetic transport result consumed",async()=>expect((await result.response.json()).choices[0].message.content).toBe("fixture"));
  return{body,translated,requests,capabilities:caps.getCapabilitiesForModel("zai","glm-5.2"),sources:Object.fromEntries(g.loaded)};
},{implementation:label,pin:label==="vans"?"vans":"nine",upstreamRelativePath:"tests/translator/thinking-unified.test.js",strengthening:true});
