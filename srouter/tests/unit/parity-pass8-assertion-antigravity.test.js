import { expect } from "vitest";
import { registerPinnedRecipes, extraCase, ownedGraph } from "../helpers/parity-pass8-assertion-recipes.js";
import { getRegistered, validMediaFixtures } from "../helpers/parity-pass8-assertion-native.js";
await registerPinnedRecipes("bugs-antigravity.test.js");
for(const label of ["local","nine","vans"]){
  extraCase(`A8-NATIVE-AG-${label}-valid-missing-id-and-role`,async check=>{
    const input={model:"gemini-2.5-pro",request:{contents:[
      {role:"user",parts:[{text:"Use echo for /fixture"}]},
      {role:"model",parts:[{functionCall:{name:"echo",args:{path:"/fixture"}}}]},
      {role:"user",parts:[{functionResponse:{name:"echo",response:{output:"fixture result"}}},{text:"User-owned extra directive"}]},
    ],tools:[{functionDeclarations:[{name:"echo",description:"Fixture echo",parameters:{type:"object",properties:{path:{type:"string"}},required:["path"]}}]}]}};
    const g=ownedGraph(label),ns=await g.load("open-sse/translator/request/antigravity-to-openai.js");
    const run=()=>ns.antigravityToOpenAIRequest("gemini-2.5-pro",structuredClone(input),false,{}),a=run(),b=run();
    const call=a.messages.find(m=>m.tool_calls)?.tool_calls[0],tool=a.messages.find(m=>m.role==="tool");
    await check("Valid missing IDs: nonempty generated function call id",()=>expect(call.id.length).toBeGreaterThan(0));
    await check("Original absent-ID request is stable across invocations",()=>expect(call.id).toBe(b.messages.find(m=>m.tool_calls).tool_calls[0].id));
    await check("Original missing-ID function response associates with actual call",()=>expect(tool.tool_call_id).toBe(call.id));
    await check("Valid user text co-located with functionResponse must remain user",()=>expect(a.messages.find(m=>m.content==="User-owned extra directive")?.role).toBe("user"));
    await check("Native tool output preserved independently of role assertion",()=>expect(tool.content).toContain("fixture result"));
    return{input,a,b,sources:Object.fromEntries(g.loaded),validity:"Known-model three-turn native conversation, declared tool and schema-valid user functionResponse; no fake call-fixture ID."};
  },{implementation:label,pin:label==="vans"?"vans":"nine",upstreamRelativePath:"tests/translator/bugs-antigravity.test.js",strengthening:true});
  extraCase(`A8-NATIVE-AG-${label}-registered-real-wire`,async check=>{
    const requests=[],g=ownedGraph(label,{},{
      fetch:async(url,options)=>{
        requests.push({url,options:{...options,body:JSON.parse(options.body)}});
        return Response.json({error:{message:"Synthetic wire boundary, not real Google backend"}},{status:400});
      }});
    const body={model:"gemini-2.5-pro",messages:[{role:"user",content:"Fixture valid native request"}],
      tools:[{type:"function",function:{name:"echo",parameters:{type:"object",properties:{path:{type:"string"}},required:["path"]}}}],max_tokens:2048},
      credentials={accessToken:"fixture",providerSpecificData:{projectId:"fixture-project"}};
    const engine=await g.load("open-sse/translator/index.js"),translated=engine.translateRequest("openai","antigravity","gemini-2.5-pro",body,false,credentials,"antigravity"),
      {ex,dispatch}=await getRegistered(g,"antigravity"),result=await ex.execute({model:"gemini-2.5-pro",body:translated,stream:false,credentials});
    const sent=requests[0].options.body;
    await check("Actual registered pipeline/dispatcher, not a fabricated getRequestTranslator getter",()=>expect(dispatch.hasSpecializedExecutor("antigravity")).toBe(true));
    await check("Actual transport serializes translator native envelope",()=>expect(sent.request.contents.some(c=>c.role==="user"&&c.parts.some(p=>p.text==="Fixture valid native request"))).toBe(true));
    await check("Native declared tool survives serialization",()=>expect(sent.request.tools[0].functionDeclarations[0].name).toBe("echo"));
    await check("Native tool argument schema preserves required fields",()=>expect(sent.request.tools[0].functionDeclarations[0].parameters).toMatchObject({type:"object",properties:{path:{type:"string"}},required:["path"]}));
    await check("Actual transport has nonempty Bearer header",()=>expect(requests[0].options.headers.Authorization).toBe("Bearer fixture"));
    await check("Controlled HTTP error is consumed, not disguised as live acceptance",async()=>expect((await result.response.json()).error.message).toContain("Synthetic wire boundary"));
    return{body,translated,requests,sources:Object.fromEntries(g.loaded),validity:"Real known model, user message, declared object tool schema; unchanged producer/registered executor and serialization execute. HTTP400 is synthetic."};
  },{implementation:label,pin:label==="vans"?"vans":"nine",upstreamRelativePath:"tests/translator/bugs-antigravity.test.js",strengthening:true});
  extraCase(`A8-NATIVE-AG-${label}-valid-sanitizer-readonly`,async check=>{
    const input={model:"gemini-3-flash",request:{
      contents:[{role:"user",parts:[{text:"hello"}]}],
      systemInstruction:{role:"user",parts:[{text:"prefix You are a Claude agent, built on Anthropic's Claude Agent SDK. suffix"},{text:"Keep this prompt."}]},
    }},original=structuredClone(input),g=ownedGraph(label),{AntigravityExecutor}=await g.load("open-sse/executors/antigravity.js");
    const out=new AntigravityExecutor().transformRequest("gemini-3-flash",input,false,{projectId:"fixture-project"});
    await check("Valid text-only system instruction sanitizes competitive prompt",()=>expect(out.request.systemInstruction.parts[0].text).toBe("prefix  suffix"),[31,31]);
    await check("Valid extra user instruction remains intact",()=>expect(out.request.systemInstruction.parts[1].text).toBe("Keep this prompt."),[33,33]);
    await check("Valid source request must not be mutated by sanitizer",()=>expect(input).toEqual(original),[34,34]);
    return{original,input,out,sources:Object.fromEntries(g.loaded),validity:"Text-only native system instruction counterpart; original text/plain inlineData placeholder is not treated as valid provider media."};
  },{implementation:label,pin:"vans",upstreamRelativePath:"tests/translator/bugs-antigravity.test.js",nativeUpstreamSlots:[0,2,3],strengthening:true});
  extraCase(`A8-NATIVE-AG-${label}-valid-media-wire`,async check=>{
    const media=validMediaFixtures(),requests=[],g=ownedGraph(label,{},{
      fetch:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return Response.json({error:{message:"Synthetic media boundary"}},{status:400});}});
    const source={model:"claude-opus-4-6-thinking",max_tokens:2048,messages:[{role:"user",content:[
      {type:"text",text:"explain this image"},{type:"image",source:{type:"base64",media_type:"image/png",data:media.png}},
      {type:"document",source:{type:"base64",media_type:"application/pdf",data:media.pdf}},
    ]}]},credentials={accessToken:"fixture",projectId:"fixture-project"};
    const engine=await g.load("open-sse/translator/index.js"),translated=engine.translateRequest("claude","antigravity",source.model,source,true,credentials,"antigravity"),
      {ex}=await getRegistered(g,"antigravity"),result=await ex.execute({model:source.model,body:translated,stream:true,credentials});
    const parts=requests[0].body.request.contents.find(c=>c.role==="user").parts,pdf=Buffer.from(media.pdf,"base64").toString("utf8");
    await check("Valid PNG signature, not fake header-only payload",()=>expect(Buffer.from(media.png,"base64").subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10])));
    await check("Valid PDF has complete xref/trailer/EOF and live object offsets",()=>expect(pdf.slice(media.pdfXref)).toMatch(/^xref[\s\S]*trailer[\s\S]*%%EOF\n$/));
    await check("PDF xref offsets point to each real object",()=>expect(media.pdfOffsets.map((offset,i)=>pdf.slice(offset).startsWith(`${i+1} 0 obj`))).toEqual([true,true,true]));
    await check("Original text/media count via actual registered wire",()=>expect(parts).toHaveLength(3),[306,306]);
    await check("Original text exact through wire",()=>expect(parts[0]).toEqual({text:"explain this image"}),[307,307]);
    await check("Valid PNG exact through wire",()=>expect(parts[1]).toEqual({inlineData:{mimeType:"image/png",data:media.png}}),[308,313]);
    await check("Valid complete PDF exact through wire",()=>expect(parts[2]).toEqual({inlineData:{mimeType:"application/pdf",data:media.pdf}}),[314,319]);
    await result.response.text();
    return{source,translated,requests,media,sources:Object.fromEntries(g.loaded),validity:"Original PDF at lines289/317 is a truncated catalog object without referenced Pages/xref/EOF. This independently generated complete blank-page PDF and CRC-correct 1px PNG are separate valid counterparts."};
  },{implementation:label,pin:"vans",upstreamRelativePath:"tests/translator/bugs-antigravity.test.js",strengthening:true});
  extraCase(`A8-NATIVE-AG-${label}-negative-schema-wire`,async check=>{
    const requests=[],g=ownedGraph(label,{},{
      fetch:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return Response.json({error:{message:"Synthetic malformed-input boundary"}},{status:400});}});
    const input={model:"gemini-2.5-pro",request:{
      contents:[{role:"user",parts:[{text:"hello"}]}],generationConfig:{maxOutputTokens:2048,temperature:0.7},
      max_tokens:4096,messages:[{role:"user",content:"hello"}],temperature:0.7,top_p:0.9,tool_choice:"auto",stream:true,stream_options:{include_usage:true},
      tools:[{functionDeclarations:[{name:"lookup",description:"Lookup a value",parameters:{type:"object",properties:{query:{type:"string"}}},parametersJsonSchema:{type:"object",properties:{query:{type:"string"}}}}]}],
    }},credentials={accessToken:"fixture",projectId:"fixture-project"};
    const {ex}=await getRegistered(g,"antigravity"),result=await ex.execute({model:"gemini-2.5-pro",body:input,stream:false,credentials}),req=requests[0].body.request;
    for(const [index,field]of ["max_tokens","messages","temperature","top_p","tool_choice","stream","stream_options"].entries())
      await check(`Original negative-input sanitation must drop ${field} at actual transport`,()=>expect(req[field]).toBeUndefined(),[211+index,211+index]);
    await check("Original mutually exclusive parametersJsonSchema must be removed at actual transport",()=>expect(req.tools[0].functionDeclarations[0].parametersJsonSchema).toBeUndefined(),[171,171]);
    await check("Independent valid schema survives sanitation",()=>expect(req.tools[0].functionDeclarations[0]).toMatchObject({name:"lookup",description:"Lookup a value",parameters:{type:"object",properties:{query:{type:"string"}}}}),[172,177]);
    await check("Valid native generationConfig is retained",()=>expect(req.generationConfig).toMatchObject({maxOutputTokens:2048,temperature:0.7}));
    await result.response.text();
    return{input,requests,sources:Object.fromEntries(g.loaded),validity:"Intentionally invalid mixed-namespace/dual-schema input; expected sanitation is exercised through actual executor serialization. Synthetic HTTP400 is NOT evidence that Google rejected the serialized fields."};
  },{implementation:label,pin:"vans",upstreamRelativePath:"tests/translator/bugs-antigravity.test.js",strengthening:true});
}
