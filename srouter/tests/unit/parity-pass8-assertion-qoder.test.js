import { expect } from "vitest";
import { registerPinnedRecipes, extraCase, ownedGraph } from "../helpers/parity-pass8-assertion-recipes.js";
import { usageStorage, getRegistered, decodeEvents } from "../helpers/parity-pass8-assertion-native.js";
await registerPinnedRecipes("qoder-billing.test.js");
for(const label of ["local","nine"])for(const scenario of ["billing-first","billing-late","normal-text","cancel"]){
  extraCase(`A8-NATIVE-QODER-${label}-${scenario}`,async check=>{
    const requests=[],cancelled=[],store=usageStorage(),callerController=new AbortController();
    const ok={statusCodeValue:200,body:JSON.stringify({id:"chatcmpl-1",model:"qoder/auto",choices:[{index:0,delta:{content:"error 110 means billing daily count exceeded in docs"},finish_reason:null}]})},
      billing={statusCodeValue:403,body:{code:"110",message:"Billing daily count exceeded"}};
    const g=ownedGraph(label,{"src/lib/usageDb.js":store.exports},{
      fetch:async(url,options,proxy)=>{
        requests.push({url,options,proxy});
        if(url.endsWith("/model/list"))return Response.json({chat:[{key:"auto",max_output_tokens:1024,is_reasoning:true,source:"system"}]});
        if(!url.includes("agent_chat_generation"))throw new Error("Unexpected synthetic Qoder URL "+url);
        const frames=scenario==="billing-first"?[billing]:scenario==="billing-late"?[ok,billing]:[ok,...(scenario==="cancel"?[]:[{statusCodeValue:200,body:"[DONE]"}])];
        return new Response(new ReadableStream({
          start(c){for(const f of frames)c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(f)}\n\n`));},
          cancel:reason=>cancelled.push(reason===undefined?"upstream-cancelled":String(reason)),
        }),{headers:{"Content-Type":"text/event-stream"}});
      }});
    const {ex}=await getRegistered(g,"qoder");
    const args={model:"qoder/auto",body:{messages:[{role:"user",content:"fixture user"}],max_tokens:256},stream:true,
      credentials:{accessToken:"dt-fixture",providerSpecificData:{userId:"fixture-user",machineId:"fixture-machine"}},signal:callerController.signal};
    const result=await ex.execute(args),inference=requests.find(r=>r.url.includes("agent_chat_generation"));
    await check("Actual dispatcher reaches COSY inference transport",()=>expect(inference.options.headers["Cosy-Bodyhash"]).toMatch(/^[a-f0-9]{32}$/));
    await check("Actual strict proxy request policy",()=>expect(inference.proxy.strictProxy).toBe(true));
    if(scenario==="cancel"){
      const reader=result.response.body.getReader();await reader.read();await reader.cancel("assertion-owned-cancel");await new Promise(r=>setTimeout(r,10));
      await check("Native consumer cancellation reaches upstream once",()=>expect(cancelled).toEqual(["upstream-cancelled"]));
      return{scenario,requests,cancelled,sources:Object.fromEntries(g.loaded)};
    }
    const raw=await result.response.text();
    if(scenario==="billing-first"){
      await check("Original first-envelope billing HTTP result",()=>expect(result.response.status).toBe(403),[65,65]);
      await check("First-envelope body remains an actual structured error",()=>expect(JSON.parse(raw).error.message).toContain("110"),[69,69]);
    }else{
      const {parseSSEToOpenAIResponse}=await g.load("open-sse/handlers/chatCore/sseToJsonHandler.js"),consumer=parseSSEToOpenAIResponse(raw,"qoder/auto"),events=decodeEvents(raw);
      if(scenario==="billing-late"){
        await check("Actual chatCore parser sees structured billing failure, not success",()=>expect(consumer.error).toMatchObject({status:403,code:"qoder_billing_block",type:"quota_error"}),[154,156]);
        await check("Actual caller receives exact billing message",()=>expect(consumer.error.message).toContain("Billing daily count exceeded"),[155,155]);
      }else{
        await check("Actual chatCore parser retains legitimate billing-documentation text",()=>expect(consumer.choices[0].message.content).toBe("error 110 means billing daily count exceeded in docs"),[180,181]);
        await check("No false positive in actual error consumer",()=>expect(consumer.error).toBeUndefined());
      }
      await check("One terminal DONE, not duplicated by wrapper",()=>expect(events.filter(e=>e.data==="[DONE]")).toHaveLength(1),[276,276]);
      await check("Terminal frame closes upstream keepalive",()=>expect(cancelled).toHaveLength(1));
      return{scenario,requests,raw,consumer,events,cancelled,sources:Object.fromEntries(g.loaded)};
    }
    await check("Rejected first frame cancels upstream before handoff",()=>expect(cancelled).toHaveLength(1));
    return{scenario,requests,raw,cancelled,sources:Object.fromEntries(g.loaded)};
  },{implementation:label,pin:"nine",upstreamRelativePath:"tests/unit/qoder-billing.test.js",strengthening:true,scenario});
}
