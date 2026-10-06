import { afterAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sourceGraph, referenceEvidence, plain, contractSuite } from "../helpers/parity-pass8-source.js";

const test=contractSuite("kernels"),graphs=[];
afterAll(()=>graphs.forEach(g=>g.dispose()));
const graphCache=new Map();
async function module(label,p){
  if(!graphCache.has(label)){const g=sourceGraph(label);graphs.push(g);graphCache.set(label,g);}
  return await graphCache.get(label).load(p);
}
const cases=[
  ["open-sse/providers/pricing.js","matchPattern",[["a.*+?","a.Z+?"],["MiniMax-*","minimax-M2.5"],["a*b","axxb"],["a*b","xaxxb"]]],
  ["open-sse/providers/pricing.js","formatCost",[[null],[undefined],[NaN],[0],[0.125],[-1.555],[1000000]]],
  ["open-sse/providers/pricing.js","calculateCostFromTokens",[
    [{prompt_tokens:100,completion_tokens:20,cached_tokens:40,cache_creation_input_tokens:10,reasoning_tokens:5},{input:2,output:6,cached:0.5,cache_creation:3,reasoning:4}],
    [{input_tokens:10,output_tokens:2,cache_read_input_tokens:20},{input:2,output:6,cached:0}],
    [null,{input:2,output:6}],[{},null],
  ]],
  ["open-sse/translator/concerns/thinking.js","effortToBudget",[["minimal"],["low"],["medium"],["high"],["xhigh"],["max"],["unknown"],[null]]],
  ["open-sse/translator/concerns/thinking.js","budgetToEffort",[[0],[1024],[4096],[16384],[32768],[null],[-1]]],
  ["open-sse/translator/concerns/thinking.js","budgetToLevel",[[0],[1024],[4096],[16384],[32768],[null],[-1]]],
  ["open-sse/translator/concerns/json.js","safeParseJSON",[['{"x":1}',null],["broken",{fallback:true}],["null",{}],["[]",{}],["",null]]],
  ["open-sse/translator/concerns/image.js","parseDataUri",[["data:image/png;base64,AQID"],["data:application/pdf;base64,AQID"],["https://fixture.invalid/image"],["data:image/png,not-base64"]]],
  ["open-sse/translator/concerns/image.js","encodeDataUri",[["image/png","AQID"],["application/pdf","JVBERg=="]]],
  ["open-sse/translator/concerns/reasoning.js","extractReasoningText",[[{reasoning_content:"x"}],[{reasoning:"x"}],[{content:"x"}],[{}]]],
  ["open-sse/translator/concerns/finishReason.js","toOpenAIFinish",[
    ["end_turn","claude"],["tool_use","claude"],["max_tokens","claude"],["STOP","gemini"],["MAX_TOKENS","gemini"],["SAFETY","gemini"],["unknown","gemini"],
  ]],
  ["open-sse/translator/concerns/finishReason.js","fromOpenAIFinish",[
    ["stop","claude"],["length","claude"],["tool_calls","claude"],["content_filter","gemini"],["stop","gemini"],
  ]],
  ["open-sse/translator/concerns/usage.js","toOpenAIUsage",[
    [{input_tokens:100,output_tokens:20,cache_read_input_tokens:30,cache_creation_input_tokens:10},"claude"],
    [{promptTokenCount:100,candidatesTokenCount:20,totalTokenCount:120,cachedContentTokenCount:30,thoughtsTokenCount:5},"gemini"],
    [{input_tokens:100,output_tokens:20,total_tokens:120,input_tokens_details:{cached_tokens:30},output_tokens_details:{reasoning_tokens:5}},"responses"],
  ]],
];
for(const pin of ["nine","vans"])for(const [p,symbol,fixtures]of cases){
  test(`P8-KERNEL-${pin}-${symbol}`,`${pin} actual ${p} ${symbol} edge/reference fixtures`,
    [{pin,path:p,symbol,caller:p.includes("pricing")?"src/lib/db/repos/pricingRepo.js":"open-sse/translator/index.js"}],
    ["Value/error boundary compared with exact pinned source for all deterministic fixtures", "Usage/cache/finish/thinking conversion helper contract; not whole caller coverage"],async()=>{
      const local=await module("local",p),ref=await module(pin,p);
      for(const args of fixtures){
        const output=m=>{try{return{value:plain(m[symbol](...structuredClone(args))??null)};}catch(e){return{error:e.message};}};
        expect(output(local),JSON.stringify(args)).toEqual(output(ref));
      }
    });
}
const corpora=[
  "",
  "small unstructured output",
  Array.from({length:800},(_,i)=>`src/file${i%30}.js:${i+1}: match result ${i}`).join("\n"),
  Array.from({length:800},(_,i)=>`./src/dir${i%30}/file${i}.js`).join("\n"),
  "diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1,500 +1,500 @@\n"+Array.from({length:800},(_,i)=>`${i%3===0?"+":i%3===1?"-":" "}line ${i}`).join("\n"),
  "On branch main\nChanges not staged for commit:\n"+Array.from({length:100},(_,i)=>`modified: src/file${i}.js`).join("\n"),
  Array.from({length:800},(_,i)=>`${i+1}→const value${i} = ${i};`).join("\n"),
  Array.from({length:800},(_,i)=>i%10===0?`ERROR fixture failure ${i}`:"INFO repetitive log").join("\n"),
];
for(const pin of ["nine","vans"]){
  const dir=path.join(referenceEvidence,"reference",pin,"open-sse/rtk/filters");
  for(const file of fs.readdirSync(dir).filter(f=>f.endsWith(".js"))){
    const p=`open-sse/rtk/filters/${file}`,symbol=file.slice(0,-3);
    test(`P8-RTK-${pin}-${symbol}`,`${pin} RTK filter ${symbol}: long, structured, empty and malformed text`,
      [{pin,path:p,symbol,caller:"open-sse/rtk/autodetect.js"}],
      ["Actual filter applies to deterministic git/status/find/grep/log/text corpus", "No subprocess: these parse text only; output compared to pinned source"],async()=>{
        const local=await module("local",p),ref=await module(pin,p);
        for(const text of corpora)expect(plain(local[symbol](text)??null)).toEqual(plain(ref[symbol](text)??null));
      });
  }
  for(const shape of ["openai","claude","error","disabled"]){
    const p="open-sse/rtk/index.js";
    test(`P8-RTK-CALLER-${pin}-${shape}`,`${pin} RTK actual caller traversal ${shape}`,
      [{pin,path:p,symbol:"compressMessages",caller:"open-sse/handlers/chatCore.js"}],
      ["Actual content walker→autodetect→filter wiring", "Disabled/error tool output remains intact; stats and mutated body match reference"],
      async()=>{
        const content=corpora.at(-1);
        const body=shape==="claude"||shape==="error"?{messages:[{role:"user",content:[{type:"tool_result",tool_use_id:"fixture",is_error:shape==="error",content}]}]}:
          {messages:[{role:"tool",tool_call_id:"fixture",content}]};
        const local=await module("local",p),ref=await module(pin,p),actual=structuredClone(body),expected=structuredClone(body);
        const result=local.compressMessages(actual,shape!=="disabled"),reference=ref.compressMessages(expected,shape!=="disabled");
        expect(plain(actual)).toEqual(plain(expected));expect(plain(result??null)).toEqual(plain(reference??null));
        if(shape==="disabled"||shape==="error")expect(actual).toEqual(body);
      });
  }
}
