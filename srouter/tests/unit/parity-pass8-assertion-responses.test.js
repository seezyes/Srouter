import { expect } from "vitest";
import { registerPinnedRecipes, extraCase, ownedGraph } from "../helpers/parity-pass8-assertion-recipes.js";
import { decodeEvents, usageStorage } from "../helpers/parity-pass8-assertion-native.js";
await registerPinnedRecipes("responses-completed-output.test.js");
for(const label of ["local","nine"])for(const scenario of ["empty","ordered","same-choice","tool","usage-trailer","cancel"]){
  extraCase(`A8-NATIVE-RESPONSES-${label}-${scenario}`,async check=>{
    const store=usageStorage(),g=ownedGraph(label,{"src/lib/usageDb.js":store.exports});
    const {createSSEStream}=await g.load("open-sse/utils/stream.js"),completed=[],cancelled=[];
    const chunk=(delta,index=0,finish_reason=null,usage=undefined)=>({id:"chatcmpl-1",model:"gpt-4o",object:"chat.completion.chunk",choices:[{index,delta,finish_reason}],...(usage?{usage}:{})});
    const usage={prompt_tokens:3,completion_tokens:1,total_tokens:4};
    const frames={
      empty:[chunk({},0,"stop",{prompt_tokens:0,completion_tokens:0,total_tokens:0})],
      ordered:[chunk({reasoning_content:"thinking"},0),chunk({content:"answer"},1),chunk({},0,"stop",usage)],
      "same-choice":[chunk({reasoning_content:"thinking"},0),chunk({content:"answer"},0),chunk({},0,"stop",usage)],
      tool:[chunk({tool_calls:[{index:0,id:"call_1",type:"function",function:{name:"get_weather",arguments:'{"city":"Paris"}'}}]}),chunk({},0,"tool_calls",usage)],
      "usage-trailer":[chunk({content:"OK"}),chunk({},0,"stop"),{id:"chatcmpl-1",choices:[],usage}],
      cancel:[chunk({content:"partial"})],
    }[scenario];
    const encoded=new TextEncoder().encode(frames.map(c=>`data: ${JSON.stringify(c)}\n\n`).join("")+(scenario==="cancel"?"":"data: [DONE]\n\n"));
    const source=new ReadableStream({start(c){for(let i=0;i<encoded.length;i+=13)c.enqueue(encoded.slice(i,i+13));if(scenario!=="cancel")c.close();},cancel:r=>cancelled.push(r)});
    const output=source.pipeThrough(createSSEStream({targetFormat:"openai",sourceFormat:"openai-responses",model:"gpt-4o",provider:"openai",onStreamComplete:(...args)=>completed.push(args)}));
    if(scenario==="cancel"){
      const reader=output.getReader();await reader.read();await reader.cancel("assertion-owned-cancel");await new Promise(r=>setTimeout(r,10));
      await check("Native reader cancellation reaches upstream once",()=>expect(cancelled).toEqual(["assertion-owned-cancel"]));
      await check("Cancellation does not synthesize successful completion",()=>expect(completed).toHaveLength(0));
      return{cancelled,completed,sources:Object.fromEntries(g.loaded)};
    }
    const text=await new Response(output).text(),events=decodeEvents(text),terminals=events.filter(e=>e.event==="response.completed"),response=terminals[0]?.data.response,
      done=events.filter(e=>e.event==="response.output_item.done").map(e=>e.data.item);
    await check("Native consumer requires one completed event",()=>expect(terminals).toHaveLength(1),[37,37]);
    await check("Native final output must equal already delivered done items",()=>expect(response.output).toEqual(done),[75,75]);
    await check("Exactly one stream completion callback",()=>expect(completed).toHaveLength(1));
    await check("Responses SSE does not expose OpenAI DONE sentinel",()=>expect(events.some(e=>e.data==="[DONE]")).toBe(false));
    if(scenario==="empty")await check("Truly no produced output through native stream consumer",()=>expect(response.output).toEqual([]),[121,121]);
    if(scenario==="ordered"||scenario==="same-choice"){
      await check("Both reasoning and message retained, in original output-index ordering",()=>expect(response.output.map(i=>i.type)).toEqual(["reasoning","message"]),[114,114]);
      await check("Final answer text remains exact",()=>expect(response.output.find(i=>i.type==="message").content[0]).toMatchObject({type:"output_text",text:"answer"}),[115,115]);
    }
    if(scenario==="tool")await check("Original tool item exact call association",()=>expect(response.output[0]).toMatchObject({type:"function_call",name:"get_weather",arguments:'{"city":"Paris"}',call_id:"call_1"}),[98,103]);
    if(scenario==="usage-trailer")await check("Native trailer preserves usage with output",()=>expect(response).toMatchObject({usage:{input_tokens:3,output_tokens:1,total_tokens:4},output:[{type:"message"}]}),[131,132]);
    return{scenario,frames,events,completedCallbacks:completed.length,sources:Object.fromEntries(g.loaded)};
  },{implementation:label,pin:"nine",upstreamRelativePath:"tests/unit/responses-completed-output.test.js",strengthening:true,scenario});
}
