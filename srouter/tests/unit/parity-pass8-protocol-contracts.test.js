import fs from "node:fs";
import path from "node:path";
import { beforeAll, afterAll, expect } from "vitest";
import { sourceGraph, evidence, referenceEvidence, plain, contractSuite } from "../helpers/parity-pass8-protocol-source.js";
import { sources, targets, credential } from "../helpers/parity-pass8-protocol-fixtures.js";

const test=contractSuite("protocol-contracts");
const input=JSON.parse(fs.readFileSync(path.join(referenceEvidence,"../pass8-independent-20261001/protocol68-chunk-input.json")));
const graphs={},engines={},outputs=[],wires=[];
const kv=()=>{const data=new Map();return{get:async k=>data.get(k)||null,getAll:async()=>Object.fromEntries(data),set:async(k,v)=>data.set(k,v),remove:async k=>data.delete(k)};};
beforeAll(async()=>{
  for(const label of ["local","nine","vans"]){
    const g=sourceGraph(label,{"src/lib/db/helpers/kvStore.js":{makeKv:kv}},{
      fetch:async(url,init)=>{wires.push({label,url:String(url),body:JSON.parse(init.body),headers:Object.fromEntries(new Headers(init.headers))});return new Response('{"error":"bounded terminal"}',{status:400});}
    });
    graphs[label]=g;engines[label]=await g.load("open-sse/translator/index.js");
  }
},60000);
afterAll(()=>{
  fs.writeFileSync(path.join(evidence,"protocol-request-results.json"),JSON.stringify({outputs,wires},null,2));
  fs.writeFileSync(path.join(evidence,"source-hashes-protocol-contracts.json"),JSON.stringify(Object.fromEntries(Object.entries(graphs).map(([k,g])=>[k,Object.fromEntries(g.loaded)])),null,2));
  Object.values(graphs).forEach(g=>g.dispose());
});
function fixture(row){
  if(row.id.startsWith("P8-TR-")){
    const tail=row.id.slice("P8-TR-vans-".length);
    const source=Object.keys(sources).sort((a,b)=>b.length-a.length).find(s=>tail.startsWith(s+"-"));
    return{source,target:tail.slice(source.length+1),body:structuredClone(sources[source]),stream:false};
  }
  const tail=row.id.slice("P8-EDGE-vans-".length);
  const target=Object.keys(targets).sort((a,b)=>b.length-a.length).find(t=>tail.startsWith(t+"-"));
  const variant=tail.slice(target.length+1),body=structuredClone(sources.openai);
  if(variant==="image")body.messages.at(-1).content=[{type:"text",text:"Pass8 user payload"},{type:"image_url",image_url:{url:"data:image/png;base64,AQID"}}];
  if(variant==="reasoning"){body.reasoning_effort="high";body.messages[2].reasoning_content="reasoning history";}
  if(variant==="parallel"){body.messages[2].tool_calls.push({id:"call-second",type:"function",function:{name:"inspect",arguments:"{}"}});body.messages.splice(4,0,{role:"tool",tool_call_id:"call-second",content:"second answer"});}
  if(variant==="json-schema")body.response_format={type:"json_schema",json_schema:{name:"fixture",strict:true,schema:{type:"object",properties:{ok:{type:"boolean"}},required:["ok"],additionalProperties:false}}};
  if(variant==="tool-none")body.tool_choice="none";
  if(variant==="malformed-args")body.messages[2].tool_calls[0].function.arguments="{broken";
  if(variant==="long-tool"){const name="mcp__"+"a".repeat(80)+"__inspect";body.tools[0].function.name=name;body.messages[2].tool_calls[0].function.name=name;}
  return{source:"openai",target,body,stream:true,variant};
}
function comparable(value,variant){
  const map=value?._toolNameMap?.map||value?._toolNameMap,out=plain(value);
  if(out)delete out._toolNameMap;
  if(variant==="long-tool"){
    const original="mcp__"+"a".repeat(80)+"__inspect";
    const restore=v=>{
      if(typeof v==="string"){for(const[fitted,name]of map||[])if(name===original)v=v.replaceAll(fitted,name);if(v===original.slice(0,64))return original;return v;}
      if(Array.isArray(v))return v.map(restore);
      if(v&&typeof v==="object")return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,restore(x)]));
      return v;
    };return restore(out);
  }
  return out;
}
for(const row of input.filter(r=>!r.id.startsWith("P8-WIRE-"))){
  test("P8P-"+row.id,`${row.id} exact original fields plus newer pinned request contract`,
    row.anchors,["Actual registered source/target path, no translator/executor class mocks","Exact full newer-pin output, with only proven inverse tool names restored","Actual native executor consumes Kiro/Gemini payload into captured HTTP body"],
    async()=>{
      const f=fixture(row),[model,provider]=targets[f.target],values={};
      for(const label of ["local","nine","vans"]){
        const value=engines[label].translateRequest(f.source,f.target,model,structuredClone(f.body),f.stream,credential(),provider,null,[],"fixture-connection");
        values[label]=plain(value);
      }
      outputs.push({id:row.id,source:f.source,target:f.target,variant:f.variant||null,fixture:f.body,values,originalFields:row.comparedFields});
      expect.soft(comparable(values.local,f.variant)).toEqual(comparable(values.nine,f.variant));
      expect(values.local).not.toBeNull();
      if(["kiro","gemini","gemini-cli","vertex","antigravity"].includes(f.target)){
        let executor;
        if(f.target==="gemini"){const {DefaultExecutor}=await graphs.local.load("open-sse/executors/default.js");executor=new DefaultExecutor("gemini");}
        else{
          const namespace=await graphs.local.load(`open-sse/executors/${f.target}.js`);
          const Constructor=namespace[{kiro:"KiroExecutor","gemini-cli":"GeminiCLIExecutor",vertex:"VertexExecutor",antigravity:"AntigravityExecutor"}[f.target]];
          executor=new Constructor();
        }
        executor.config={...executor.config,retry:{},baseUrls:executor.config.baseUrl?[executor.config.baseUrl]:executor.config.baseUrls?.slice(0,1)};
        const start=wires.length;
        const result=await executor.execute({model,body:structuredClone(values.local),stream:f.stream,credentials:credential(),signal:new AbortController().signal});
        expect(result.response.status).toBe(400);
        const wire=wires.slice(start).find(w=>w.label==="local");
        expect(wire).toBeDefined();
        const payload=f.target==="gemini-cli"||f.target==="antigravity"?wire.body.request:wire.body;
        if(f.target==="kiro"){
          expect(payload.conversationState.currentMessage.userInputMessage).toBeDefined();
          expect(payload).not.toHaveProperty("agentMode");
          expect(payload.conversationState).not.toHaveProperty("agentContinuationId");
          expect(payload.conversationState).not.toHaveProperty("agentTaskType");
        }else{
          expect(payload.contents.length).toBeGreaterThan(0);
          const thinking=payload.generationConfig?.thinkingConfig;
          if(f.variant!=="reasoning")expect(thinking).toBeUndefined();
        }
      }
      return{coverage:{originalId:row.id,fields:row.comparedFields.length,actualRegistration:true}};
    },30000);
}
for(const label of ["local","nine","vans"]){
  test(`P8P-ROLE-${label}`,`${label} native function result with co-located user text preserves user authority`,
    [{pin:label,path:"open-sse/translator/request/antigravity-to-openai.js",symbol:"antigravityToOpenAIRequest",caller:"translateRequest"}],
    ["Tool output is associated with matching call","Co-located user text remains user, not assistant, and is not lost"],()=>{
      const out=engines[label].translateRequest("antigravity","openai","gpt-4o",structuredClone(sources.antigravity),false,credential(),"openai");
      const follow=out.messages.find(m=>m.content==="continue");
      expect.soft(follow).toBeDefined();
      expect.soft(follow?.role).toBe("user");
      expect(out.messages.find(m=>m.role==="tool")?.tool_call_id).toBe("call-fixture");
    });
}
for(const label of ["local","nine"])for(const intent of ["none","auto","low","high","native-budget","suffix"]){
  test(`P8P-THINK-${label}-${intent}`,`${label} explicit/native/suffix Gemini thinking branch ${intent}`,
    [{pin:label,path:"open-sse/translator/concerns/thinkingUnified.js",symbol:"applyThinking",caller:"translateRequest"}],
    ["Native budget retained; suffix overrides explicit effort; omission is not silently auto","Independent exact 0/-1/1024/24576/4096 budget and includeThoughts assertions"],()=>{
      const native=intent==="native-budget",body=structuredClone(native?sources.gemini:sources.openai);
      if(native)body.generationConfig.thinkingConfig={thinkingBudget:4096,includeThoughts:true};
      else body.reasoning_effort=intent==="suffix"?"low":intent;
      const model=intent==="suffix"?"gemini-2.5-pro(high)":"gemini-2.5-pro";
      const out=engines[label].translateRequest(native?"gemini":"openai","gemini",model,body,true,credential(),"gemini");
      const expected={none:0,auto:-1,low:1024,high:24576,"native-budget":4096,suffix:24576}[intent];
      expect(out.generationConfig.thinkingConfig.thinkingBudget).toBe(expected);
      expect(out.generationConfig.thinkingConfig.includeThoughts).toBe(intent!=="none");
    });
}
for(const label of ["local","nine","vans"]){
  test(`P8P-CLAUDE-SIGNED-${label}`,`${label} native signed thinking is preserved while foreign unsigned reasoning is not replayed`,
    [{pin:label,path:"open-sse/translator/index.js",symbol:"translateRequest"},
      {pin:label,path:"open-sse/translator/request/openai-to-claude.js",symbol:"getContentBlocksFromMessage"}],
    ["Native Claude signed thought/history preserved byte-for-byte; no unsupported synthesized unsigned thinking block","Text and call/result identity stay observable independently of array-index shifts"],()=>{
      const native=structuredClone(sources.claude);
      native.messages[1].content.unshift({type:"thinking",thinking:"native thought",signature:"fixture-native-signature"});
      const nativeOut=engines[label].translateRequest("claude","claude","claude-sonnet-4-6",native,false,credential(),"anthropic");
      expect(nativeOut.messages[1].content.find(b=>b.type==="thinking")).toEqual({type:"thinking",thinking:"native thought",signature:"fixture-native-signature"});
      const foreign=structuredClone(sources.openai);foreign.reasoning_effort="high";foreign.messages[2].reasoning_content="foreign unsourced thought";
      const out=engines[label].translateRequest("openai","claude","claude-sonnet-4-6",foreign,false,credential(),"anthropic");
      expect.soft(out.messages.flatMap(m=>m.content).filter(b=>b.type==="thinking")).toEqual([]);
      expect(out.messages.flatMap(m=>m.content).find(b=>b.type==="tool_use")).toMatchObject({id:"call-fixture",name:"inspect",input:{path:"/fixture"}});
    });
  test(`P8P-RESP-SYSTEM-${label}`,`${label} Responses system/developer order and malformed arguments preserve associations`,
    [{pin:label,path:"open-sse/translator/request/openai-responses.js",symbol:"openaiToOpenAIResponsesRequest",caller:"translateRequest"}],
    ["System then developer instructions cannot be silently discarded or inverted","Malformed JSON is recovered to object arguments without breaking call/result ID and user roles"],()=>{
      const body=structuredClone(sources.openai);
      body.messages.splice(1,0,{role:"developer",content:"developer directive"});
      body.messages.find(m=>m.role==="assistant").tool_calls[0].function.arguments="{broken";
      const out=engines[label].translateRequest("openai","openai-responses","gpt-5.4",body,true,credential(),"codex");
      const instructionText=[out.instructions||"",...out.input.filter(i=>i.role==="system"||i.role==="developer").map(i=>i.content.map(c=>c.text).join("\n"))].join("\n");
      expect.soft(instructionText).toContain("Pass8 system");expect.soft(instructionText).toContain("developer directive");
      expect.soft(instructionText.indexOf("Pass8 system")).toBeLessThan(instructionText.indexOf("developer directive"));
      expect(out.input.find(i=>i.type==="function_call")).toMatchObject({call_id:"call-fixture",name:"inspect",arguments:"{}"});
      expect(out.input.find(i=>i.type==="function_call_output")).toMatchObject({call_id:"call-fixture",output:"tool answer"});
      expect(out.input.filter(i=>i.role==="user").map(i=>i.content[0].text)).toEqual(["Pass8 user payload","continue"]);
    });
}
