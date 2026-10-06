import { afterAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sourceGraph, plain, contractSuite, evidence } from "../helpers/parity-pass8-source.js";
const test=contractSuite("intent"),graphs=[];
afterAll(()=>{
  fs.writeFileSync(path.join(evidence,"source-hashes-intent.json"),JSON.stringify(graphs.map(g=>({label:g.label,loaded:Object.fromEntries(g.loaded)})),null,2));
  graphs.forEach(g=>g.dispose());
});
const overrides={"open-sse/executors/antigravity.js":{AntigravityExecutor:class{}},"src/lib/db/helpers/kvStore.js":{makeKv:()=>({get:async()=>null,getAll:async()=>({})})}};
for(const model of ["claude-sonnet-4-6","claude-opus-4-6","claude-haiku-4-5","fixture-model"])for(const summarized of [true,false]){
  test(`P8A-BETA-${model}-${summarized}`,`Actual dispatch gates heavy-agent flags and preserves requested thinking summary: ${model}/${summarized}`,
    [{pin:"vans",path:"open-sse/executors/default.js",symbol:"DefaultExecutor.buildHeaders",caller:"open-sse/handlers/chatCore.js"},
      {pin:"nine",path:"open-sse/providers/shared.js",symbol:"selectAnthropicBeta"}],
    ["No blanket beta removal: assert each heavy-agent flag on opus/sonnet and absent elsewhere","Requested summary forbids redact-thinking; raw authentication survives"],async()=>{
      const calls=[],g=sourceGraph("local",{}, {fetch:async(url,init)=>{calls.push({url,init});return Response.json({content:[{type:"text",text:"fixture answer"}]});}});graphs.push(g);
      const {DefaultExecutor}=await g.load("open-sse/executors/default.js"),ex=new DefaultExecutor("claude");
      const result=await ex.execute({model,body:{messages:[{role:"user",content:"fixture"}],...(summarized?{thinking:{type:"adaptive",display:"summarized"}}:{})},
        stream:false,credentials:{apiKey:"fixture-api"}});
      expect(result.response.status).toBe(200);
      const flags=calls[0].init.headers["Anthropic-Beta"].split(",");
      for(const flag of ["advanced-tool-use-2025-11-20","effort-2025-11-24"])expect(flags.includes(flag)).toBe(/^claude-(sonnet|opus)/.test(model));
      expect(flags.includes("redact-thinking-2026-02-12")).toBe(!summarized);
      expect(new Set(flags).size).toBe(flags.length);expect(calls[0].init.headers["x-api-key"]).toBe("fixture-api");
    });
}
for(const label of ["local","nine"])for(const target of ["gemini","gemini-cli","antigravity","vertex"]){
  test(`P8A-THINKING-${label}-${target}-explicit`,`${label} explicit high reasoning intent reaches actual ${target} request`,
    [{pin:"vans",path:"open-sse/translator/index.js",symbol:"translateRequest",caller:"open-sse/handlers/chatCore.js"},
      {pin:"nine",path:"open-sse/translator/concerns/thinkingUnified.js",symbol:"captureThinking"}],
    ["Explicit client effort is not confused with unspecified upstream default; no thinking-config field discarded"],async()=>{
      const g=sourceGraph(label,overrides);graphs.push(g);
      const engine=await g.load("open-sse/translator/index.js");
      const result=engine.translateRequest("openai",target,"gemini-2.5-pro",{messages:[{role:"user",content:"fixture user"}],reasoning_effort:"high"},true,
        {accessToken:"fixture",providerSpecificData:{projectId:"fixture-project"}},target,null,[],"fixture");
      const wire=result.request||result;
      expect(wire.generationConfig.thinkingConfig).toMatchObject({thinkingBudget:24576,includeThoughts:true});
      expect(wire.contents[0].parts[0].text).toBe("fixture user");
      expect(wire.generationConfig.maxOutputTokens).toBeGreaterThanOrEqual(24576);
    });
}
const nativeFrames={
  claude:[{type:"message_start",message:{id:"fixture",model:"fixture",usage:{input_tokens:12}}},
    {type:"content_block_start",index:0,content_block:{type:"tool_use",id:"call-fixture",name:"fitted_fixture",input:{}}},
    {type:"content_block_delta",index:0,delta:{type:"input_json_delta",partial_json:'{"path":"/fixture"}'}},
    {type:"content_block_stop",index:0},{type:"message_delta",delta:{stop_reason:"tool_use"},usage:{output_tokens:4}},{type:"message_stop"}],
  gemini:[{candidates:[{content:{role:"model",parts:[{functionCall:{id:"call-fixture",name:"fitted_fixture",args:{path:"/fixture"}}}]},finishReason:"STOP"}]}],
  "openai-responses":[{type:"response.created",response:{id:"resp_fixture",model:"fixture"}},
    {type:"response.output_item.added",output_index:0,item:{id:"fc_fixture",type:"function_call",call_id:"call-fixture",name:"fitted_fixture",arguments:""}},
    {type:"response.function_call_arguments.delta",item_id:"fc_fixture",output_index:0,delta:'{"path":"/fixture"}'},
    {type:"response.completed",response:{id:"resp_fixture",model:"fixture",status:"completed",output:[],usage:{input_tokens:12,output_tokens:4,total_tokens:16}}}],
};
for(const label of ["local","nine","vans"])for(const [target,frames]of Object.entries(nativeFrames)){
  test(`P8A-NATIVE-MAP-${label}-${target}`,`${label} actual native ${target} decoder restores fitted names/arguments/IDs`,
    [{pin:label==="local"?"nine":label,path:"open-sse/translator/index.js",symbol:"translateResponse",caller:"open-sse/handlers/chatCore/streamingHandler.js"}],
    ["Real native event sequence and inverse-name restore; state attachment manually supplied, so caller attachment remains unverified"],async()=>{
      const g=sourceGraph(label,overrides);graphs.push(g);const engine=await g.load("open-sse/translator/index.js"),state=engine.initState(target);
      const original="mcp__"+"a".repeat(80)+"__inspect";state.toolNameMap=new Map([["fitted_fixture",original]]);
      // Serialize each emission immediately, just as the SSE caller does.
      // Retaining mutable state objects until the end invents duplicate args.
      const output=[];
      for(const frame of frames)output.push(...plain(engine.translateResponse(target,"openai",structuredClone(frame),state)));
      const calls=output.flatMap(c=>c.choices?.[0]?.delta?.tool_calls||[]);
      expect(calls.some(c=>c.function?.name===original)).toBe(true);
      expect(calls.some(c=>c.id==="call-fixture")).toBe(true);
      expect(calls.map(c=>c.function?.arguments||"").join("")).toBe('{"path":"/fixture"}');
      expect(JSON.stringify(plain(output))).not.toContain("fitted_fixture");
    });
}
