import fs from "node:fs";
import path from "node:path";
import { expect, afterAll } from "vitest";
import { sourceGraph, evidence, contractSuite } from "../helpers/parity-pass8-protocol-source.js";
const test=contractSuite("protocol-stream"),graphs=[],outputs=[];
const kv=()=>({get:async()=>null,getAll:async()=>({}),set:async()=>{},remove:async()=>{}});
const chunk=(delta,finish_reason=null,extra={})=>({id:"chatcmpl-fixture",model:"fixture",choices:[{index:0,delta,finish_reason}],...extra});
const cases={
  summary:[chunk({reasoning_content:"summary"}),chunk({content:"answer"}),chunk({},"stop",{usage:{prompt_tokens:7,completion_tokens:2,total_tokens:9}}),"[DONE]"],
  trailer:[chunk({content:"answer"}),chunk({},"stop"),{id:"chatcmpl-fixture",choices:[],usage:{prompt_tokens:7,completion_tokens:2,total_tokens:9}},"[DONE]"],
  tool:[chunk({tool_calls:[{index:0,id:"call-fixture",type:"function",function:{name:"inspect",arguments:'{"path":'}}]}),chunk({tool_calls:[{index:0,function:{arguments:'"/fixture"}'}}]}),chunk({},"tool_calls",{usage:{prompt_tokens:7,completion_tokens:2,total_tokens:9}}),"[DONE]"],
  duplicate:[chunk({content:"answer"}),chunk({},"stop",{usage:{prompt_tokens:7,completion_tokens:2,total_tokens:9}}),"[DONE]","[DONE]"],
};
afterAll(()=>{
  fs.writeFileSync(path.join(evidence,"protocol-stream-results.json"),JSON.stringify(outputs,null,2));
  fs.writeFileSync(path.join(evidence,"source-hashes-protocol-stream.json"),JSON.stringify(graphs.map(g=>({label:g.label,files:Object.fromEntries(g.loaded)})),null,2));graphs.forEach(g=>g.dispose());
});
function graph(label){
  const g=sourceGraph(label,{"src/lib/db/helpers/kvStore.js":{makeKv:kv},"src/lib/usageDb.js":{trackPendingRequest(){},appendRequestLog:async()=>{},saveRequestDetail:async()=>{} }});
  graphs.push(g);return g;
}
function parse(raw){
  return raw.split(/\n\n/).filter(Boolean).map(block=>{
    const type=block.split("\n").find(l=>l.startsWith("event: "))?.slice(7);
    const data=block.split("\n").find(l=>l.startsWith("data: "))?.slice(6);
    return{type,data:data==="[DONE]"?"[DONE]":JSON.parse(data)};
  });
}
for(const label of ["local","nine","vans"])for(const [scenario,chunks]of Object.entries(cases)){
  test(`P8P-STREAM-${label}-${scenario}`,`${label} actual createSSEStream → Responses consumer ${scenario}`,
    [{pin:label,path:"open-sse/utils/stream.js",symbol:"createSSEStream",caller:"open-sse/handlers/chatCore/streamingHandler.js"},
      {pin:label,path:"open-sse/translator/response/openai-responses.js",symbol:"openaiToOpenAIResponsesResponse"}],
    ["Real stream caller supplies initState, targetFormat and invokes registered response translator","Created/item/summary/delta/done/completed lifecycle, output IDs, usage trailer, exactly one terminal"],
    async()=>{
      const g=graph(label),{createSSEStream}=await g.load("open-sse/utils/stream.js"),completed=[];
      const transform=createSSEStream({targetFormat:"openai",sourceFormat:"openai-responses",model:"fixture",provider:"openai",onStreamComplete:(...args)=>completed.push(args)});
      const raw=chunks.map(x=>`data: ${typeof x==="string"?x:JSON.stringify(x)}\n\n`).join("");
      // Deliberately split at arbitrary byte boundaries; actual SSE decoder runs.
      const bytes=new TextEncoder().encode(raw),input=new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=19)c.enqueue(bytes.slice(i,i+19));c.close();}});
      const text=await new Response(input.pipeThrough(transform)).text(),events=parse(text);
      outputs.push({label,scenario,events,completionCallbacks:completed.length});
      const terminal=events.filter(e=>e.type==="response.completed");
      expect.soft(terminal).toHaveLength(1);
      expect.soft(events.some(e=>e.data==="[DONE]")).toBe(false);
      const response=terminal[0]?.data.response;
      expect.soft(response?.usage).toMatchObject({input_tokens:7,output_tokens:2,total_tokens:9});
      const done=events.filter(e=>e.type==="response.output_item.done").map(e=>e.data.item);
      expect.soft(response?.output).toEqual(done);
      expect(events[0].type).toBe("response.created");
      for(const item of done){
        const added=events.findIndex(e=>e.type==="response.output_item.added"&&e.data.item.id===item.id);
        const end=events.findIndex(e=>e.type==="response.output_item.done"&&e.data.item.id===item.id);
        expect.soft(added).toBeGreaterThan(-1);expect.soft(end).toBeGreaterThan(added);
      }
      if(scenario==="summary"){
        const names=events.map(e=>e.type);
        expect.soft(names.indexOf("response.reasoning_summary_part.added")).toBeGreaterThan(-1);
        expect.soft(names.indexOf("response.reasoning_summary_text.delta")).toBeGreaterThan(names.indexOf("response.reasoning_summary_part.added"));
        expect.soft(names.indexOf("response.reasoning_summary_text.done")).toBeGreaterThan(names.indexOf("response.reasoning_summary_text.delta"));
        expect.soft(names.indexOf("response.reasoning_summary_part.done")).toBeGreaterThan(names.indexOf("response.reasoning_summary_text.done"));
      }
      if(scenario==="tool")expect.soft(done.find(i=>i.type==="function_call")).toMatchObject({call_id:"call-fixture",name:"inspect",arguments:'{"path":"/fixture"}'});
      expect.soft(completed).toHaveLength(1);
    },30000);
}
for(const label of ["local","nine","vans"]){
  test(`P8P-STREAM-${label}-cancel`,`${label} cancellation propagates from Responses reader to upstream source`,
    [{pin:label,path:"open-sse/utils/stream.js",symbol:"createSSEStream"}],
    ["Read actual emitted created event, cancel consumer, observe upstream cancel exactly once","No artificial completion after cancellation"],async()=>{
      const g=graph(label),{createSSEStream}=await g.load("open-sse/utils/stream.js"),cancelled=[],complete=[];
      const input=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk({content:"partial"}))}\n\n`));},cancel(reason){cancelled.push(reason);}});
      const reader=input.pipeThrough(createSSEStream({targetFormat:"openai",sourceFormat:"openai-responses",model:"fixture",onStreamComplete:()=>complete.push(true)})).getReader();
      expect((await reader.read()).done).toBe(false);await reader.cancel("fixture cancel");
      await new Promise(r=>setTimeout(r,10));
      expect(cancelled).toEqual(["fixture cancel"]);expect(complete).toHaveLength(0);
    });
}
for(const label of ["local","nine","vans"])for(const target of ["claude","gemini","openai-responses"]){
  test(`P8P-STREAM-MAP-${label}-${target}`,`${label} actual stream caller attaches inverse tool-name map for ${target}`,
    [{pin:label,path:"open-sse/utils/stream.js",symbol:"createSSEStream"},
      {pin:label,path:"open-sse/translator/index.js",symbol:"translateResponse"}],
    ["Actual caller passes toolNameMap into decoder state; native frame → SSE client restoration","Exact call ID, name and concatenated arguments, no name leakage"],async()=>{
      const g=graph(label),{createSSEStream}=await g.load("open-sse/utils/stream.js"),original="mcp__"+"a".repeat(80)+"__inspect";
      const frames=target==="claude"?[
        {type:"message_start",message:{id:"fixture",model:"fixture",usage:{input_tokens:12}}},
        {type:"content_block_start",index:0,content_block:{type:"tool_use",id:"call-fixture",name:"fitted_fixture",input:{}}},
        {type:"content_block_delta",index:0,delta:{type:"input_json_delta",partial_json:'{"path":"/fixture"}'}},
        {type:"content_block_stop",index:0},{type:"message_delta",delta:{stop_reason:"tool_use"},usage:{output_tokens:4}},{type:"message_stop"}]:
        target==="gemini"?[{candidates:[{content:{role:"model",parts:[{functionCall:{id:"call-fixture",name:"fitted_fixture",args:{path:"/fixture"}}}]},finishReason:"STOP"}]}]:
        [{type:"response.created",response:{id:"resp_fixture",model:"fixture"}},
          {type:"response.output_item.added",output_index:0,item:{id:"fc_fixture",type:"function_call",call_id:"call-fixture",name:"fitted_fixture",arguments:""}},
          {type:"response.function_call_arguments.delta",item_id:"fc_fixture",output_index:0,delta:'{"path":"/fixture"}'},
          {type:"response.completed",response:{id:"resp_fixture",model:"fixture",status:"completed",output:[],usage:{input_tokens:12,output_tokens:4,total_tokens:16}}}];
      let fitted="fitted_fixture",toolNameMap=new Map([[fitted,original]]),translatedBody,model="fixture";
      const body={messages:[{role:"user",content:"fixture user"}],tools:[{type:"function",function:{name:original,parameters:{type:"object",properties:{path:{type:"string"}}}}}]};
      if(label!=="vans"){
        const engine=await g.load("open-sse/translator/index.js");
        model={claude:"claude-sonnet-4-6",gemini:"gemini-2.5-pro","openai-responses":"gpt-5.4"}[target];
        translatedBody=engine.translateRequest("openai",target,model,structuredClone(body),true,{accessToken:"fixture",providerSpecificData:{projectId:"fixture-project"}},{claude:"anthropic",gemini:"gemini","openai-responses":"codex"}[target]);
        toolNameMap=translatedBody._toolNameMap;
        expect(toolNameMap?.size).toBeGreaterThan(0);
        fitted=[...toolNameMap].find(([,name])=>name===original)[0];
        expect(fitted.length).toBeLessThanOrEqual(64);
      }
      const raw=frames.map(f=>(target==="claude"||target==="openai-responses"?`event: ${f.type}\n`:"")+`data: ${JSON.stringify(f).replaceAll("fitted_fixture",fitted)}\n\n`).join("");
      const input=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(raw));c.close();}});
      let response;
      if(label==="vans")response=new Response(input.pipeThrough(createSSEStream({targetFormat:target,sourceFormat:"openai",model,toolNameMap})));
      else{
        // Persistence/reporting only is synthetic. Response routing/readiness,
        // disconnect controller, map attachment and stream decoder run unchanged.
        g.mocks["src/lib/usageDb.js"].saveRequestDetail=async()=>{};
        g.mocks["open-sse/handlers/chatCore/requestDetail.js"]={buildRequestDetail:()=>({}),extractRequestConfig:()=>({}),saveUsageStats:async()=>{},formatDoneLine:()=>""};
        const {handleStreamingResponse}=await g.load("open-sse/handlers/chatCore/streamingHandler.js");
        const {createStreamController}=await g.load("open-sse/utils/streamHandler.js");
        const result=await handleStreamingResponse({providerResponse:new Response(input,{headers:{"Content-Type":"text/event-stream"}}),
          provider:target==="openai-responses"?"codex":"openai",model,sourceFormat:"openai",targetFormat:target,body,stream:true,translatedBody,toolNameMap,
          requestStartTime:Date.now(),streamController:createStreamController(),onStreamComplete(){}});
        expect(result.success).toBe(true);response=result.response;
      }
      const text=await response.text();
      const events=parse(text),calls=events.flatMap(e=>e.data?.choices?.[0]?.delta?.tool_calls||[]);
      expect(calls.some(c=>c.function?.name===original)).toBe(true);expect(calls.some(c=>c.id==="call-fixture")).toBe(true);
      expect(calls.map(c=>c.function?.arguments||"").join("")).toBe('{"path":"/fixture"}');expect(text).not.toContain(fitted);
    });
}
