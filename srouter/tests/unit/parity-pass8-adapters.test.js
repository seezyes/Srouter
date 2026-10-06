import { afterAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sourceGraph, plain, contractSuite, evidence } from "../helpers/parity-pass8-source.js";
import { registeredAdapter } from "../helpers/parity-pass8-protocol-registration.js";

const test=contractSuite("adapters"),graphs=[],wires=[];
const fail=()=>{throw new Error("Uninvoked side-effect boundary called");};
const kv=()=>({get:async()=>null,getAll:async()=>({}),set:fail,remove:fail});
const overrides={
  "node:fs":{default:{existsSync:()=>false,readFileSync:fail,copyFileSync:fail,unlinkSync:fail}},
  "node:path":{default:path},
  "open-sse/executors/antigravity.js":{AntigravityExecutor:class{}},
  "src/lib/db/helpers/kvStore.js":{makeKv:kv},
  "src/lib/usageDb.js":{saveRequestDetail:fail,appendRequestLog:fail},
  "open-sse/handlers/chatCore/requestDetail.js":{buildRequestDetail:fail,extractRequestConfig:fail,saveUsageStats:fail,formatDoneLine:fail},
  "open-sse/handlers/chatCore/nonStreamingHandler.js":{translateNonStreamingResponse:fail},
};
afterAll(()=>{
  fs.writeFileSync(path.join(evidence,"source-hashes-adapters.json"),JSON.stringify(graphs.map(g=>({label:g.label,loaded:Object.fromEntries(g.loaded)})),null,2));
  fs.writeFileSync(path.join(evidence,"adapter-wire-results.json"),JSON.stringify(wires,null,2));
  graphs.forEach(g=>g.dispose());
});
for(const provider of ["kimchi","qoder-cn","xiaomi-mimo","zed"])for(const scenario of ["json","http401","abort"]){
  test(`P8P-VANS-DEFAULT-${provider}-${scenario}`,`Vans actual getExecutor default baseline ${provider} ${scenario}`,
    [{pin:"vans",path:"open-sse/executors/index.js",symbol:"getExecutor"},
      {pin:"vans",path:"open-sse/executors/default.js",symbol:"DefaultExecutor"},
      {pin:"vans",path:"open-sse/executors/base.js",symbol:"execute"}],
    ["Actual Vans registration fallback and wire response consumer, not a placeholder specialized oracle","Compare generic protocol limitations separately from actual local/Nine protocol replacement"],async()=>{
      const calls=[],controller=new AbortController();
      const g=graph(async(url,init)=>{
        calls.push({url,init});
        if(init.signal?.aborted)throw init.signal.reason;
        return Response.json({choices:[{message:{role:"assistant",content:"fixture answer"},finish_reason:"stop"}]},{status:scenario==="http401"?401:200});
      },"vans");
      const ex=await registeredAdapter(g,provider);
      ex.config={...ex.config,retry:{}};
      if(scenario==="abort")controller.abort(new Error("fixture cancel"));
      const args={model:"fixture-model",body:body(),stream:false,credentials:credential(),signal:controller.signal};
      if(scenario==="abort"){await expect(ex.execute(args)).rejects.toThrow("fixture cancel");return;}
      const result=await ex.execute(args),output=await consume(g,result);
      wires.push({id:`P8P-VANS-DEFAULT-${provider}-${scenario}`,calls:plain(calls),output});
      const inference=calls.find(c=>c.init.method==="POST");
      expect(inference).toBeDefined();
      expect(output.status).toBe(scenario==="http401"?401:200);
      if(scenario==="json")expect(output.value.choices[0].message.content).toBe("fixture answer");
      expect(JSON.parse(inference.init.body).messages).toEqual(body().messages);
    });
}
const body=()=>({messages:[{role:"system",content:"fixture system"},{role:"user",content:"fixture user"}],max_tokens:256});
const credential=()=>({accessToken:"dt-fixture",apiKey:"sk-fixture",providerSpecificData:{userId:"fixture-user",machineId:"fixture-machine",organizationId:"fixture-org"},_clientSessionId:"fixture-thread"});
const chunk=(delta,finish_reason=null,extra={})=>({id:"chatcmpl-fixture",object:"chat.completion.chunk",model:"fixture",choices:[{index:0,delta,finish_reason}],...extra});
const sse=items=>items.map(item=>`data: ${typeof item==="string"?item:JSON.stringify(item)}\n\n`).join("");
const qframe=item=>({statusCodeValue:200,body:typeof item==="string"?item:JSON.stringify(item)});
const success=()=>new Response(sse([chunk({content:"fixture answer"}),chunk({},"stop"),"[DONE]"]),{headers:{"Content-Type":"text/event-stream"}});
async function consume(g,result){
  const raw=await result.response.text();
  if(!result.response.ok)return{status:result.response.status,raw};
  if(result.response.headers.get("content-type")?.includes("event-stream")){
    const {parseSSEToOpenAIResponse}=await g.load("open-sse/handlers/chatCore/sseToJsonHandler.js");
    return{status:result.response.status,raw,value:plain(parseSSEToOpenAIResponse(raw,"fixture"))};
  }
  return{status:result.response.status,raw,value:JSON.parse(raw)};
}
function graph(fetch,label){const g=sourceGraph(label,overrides,{fetch});graphs.push(g);return g;}

// Independent inverse, not qoderEncodeBody used as its own oracle.
function decodeQoder(bytes){
  const alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  const custom="_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!$";
  const rearranged=[...Buffer.from(bytes).toString("latin1")].map(c=>alphabet[custom.indexOf(c)]).join("");
  const n=rearranged.length,a=Math.floor(n/3);
  return JSON.parse(Buffer.from(rearranged.slice(n-a)+rearranged.slice(a,n-a)+rearranged.slice(0,a),"base64").toString("utf8"));
}
function assertCosy(call,token){
  const bytes=Buffer.from(call.init.body||"");
  expect(call.init.headers["Cosy-Bodyhash"]).toBe(crypto.createHash("md5").update(bytes).digest("hex"));
  expect(call.init.headers["Cosy-Bodylength"]).toBe(String(bytes.length));
  expect(call.init.headers["Cosy-Sigpath"]).toBe(new URL(call.url).pathname.replace(/^\/algo/,""));
  const [,payload,signature]=call.init.headers.Authorization.split(".");
  const expected=crypto.createHash("md5").update(Buffer.from(`${payload}\n${call.init.headers["Cosy-Key"]}\n${call.init.headers["Cosy-Date"]}\n${bytes.toString("latin1")}\n${call.init.headers["Cosy-Sigpath"]}`,"latin1")).digest("hex");
  expect(signature).toBe(expected);
  const key=Buffer.from("12345678-1234-42");
  const decipher=crypto.createDecipheriv("aes-128-cbc",key,key);
  const info=JSON.parse(Buffer.concat([decipher.update(Buffer.from(JSON.parse(Buffer.from(payload,"base64").toString()).info,"base64")),decipher.final()]).toString());
  expect(info.uid).toBe("fixture-user");expect(info.security_oauth_token).toBe(token);
  expect(Buffer.from(call.init.headers["Cosy-Key"],"base64")).toHaveLength(128);
}
for(const label of ["local","nine"])for(const scenario of ["stream","nonstream","http401","billing-first","billing-late","missing-user","missing-token","missing-model","pat-success","pat-failure","abort","refresh"]){
  const id=`P8A-ADAPTER-${label}-qoder-cn-${scenario}`;
  test(id,`Actual Qoder CN COSY/encoded catalog → inference → SSE consumer: ${scenario}`,
    [{pin:"vans",path:"open-sse/providers/registry/qoder-cn.js",symbol:"default",localPath:"open-sse/executors/qoder.js",caller:"open-sse/handlers/chatCore.js"}],
    ["Actual model catalog, PAT exchange, encoding, RSA/AES/signature, envelope and cancellation source; transport only stubbed","No assertion that static placeholder pins implement COSY; replacement parity beyond these branches remains bounded"],async()=>{
      const calls=[],cancelled=[],controller=new AbortController(),creds=credential();creds.provider="qoder-cn";delete creds.apiKey;
      if(scenario==="missing-user")delete creds.providerSpecificData.userId;
      if(scenario==="missing-token")delete creds.accessToken;
      if(scenario.startsWith("pat-"))creds.apiKey="pt-fixture";
      const fetch=async(url,init,proxy)=>{
        calls.push({url,init,proxy});
        if(init.signal?.aborted)throw init.signal.reason;
        if(url.includes("jobToken"))return new Response(JSON.stringify({token:"jt-fixture"}),{status:scenario==="pat-failure"?401:200});
        if(url.endsWith("userinfo"))return Response.json({id:"fixture-user"});
        if(url.endsWith("/model/list"))return Response.json({chat:scenario==="missing-model"?[]:[{key:"auto",max_output_tokens:1024,is_reasoning:true,source:"system"}]});
        if(scenario==="abort"){controller.abort(new Error("fixture cancel"));throw controller.signal.reason;}
        if(scenario==="http401")return Response.json({error:{message:"fixture rejected"}},{status:401});
        const items=scenario==="billing-first"?[{statusCodeValue:403,body:'{"code":112,"message":"fixture quota"}'}]:
          [qframe(chunk({content:"fixture answer"})),...(scenario==="billing-late"?[{statusCodeValue:403,body:'{"code":"112","message":"fixture quota"}'}]:
            [qframe(chunk({finish_reason:"stop"})),qframe({choices:[],usage:{prompt_tokens:12,completion_tokens:4,total_tokens:16}}),qframe("[DONE]")])];
        const bytes=new TextEncoder().encode(sse(items));
        return new Response(new ReadableStream({start(c){c.enqueue(bytes);},cancel(reason){cancelled.push(reason||"cancelled");}}),{headers:{"Content-Type":"text/event-stream"}});
      };
      const g=graph(fetch,label),ex=await registeredAdapter(g,"qoder-cn");
      if(scenario==="refresh"){expect(await ex.refreshCredentials(creds)).toBeNull();expect(ex.needsRefresh(creds)).toBe(false);expect(calls).toHaveLength(0);return;}
      const args={model:"qoder/auto",body:body(),stream:scenario!=="nonstream",credentials:creds,signal:controller.signal,proxyOptions:{proxyUrl:"http://fixture.invalid:9090"}};
      if(scenario==="abort"){await expect(ex.execute(args)).rejects.toThrow("fixture cancel");expect(calls.at(-1).init.signal.aborted).toBe(true);return;}
      const result=await ex.execute(args),output=await consume(g,result);
      wires.push({id,calls:plain(calls),output,transformedBody:plain(result.transformedBody)});
      const expectedStatus={"missing-user":401,"missing-token":401,"missing-model":400,"pat-failure":401,http401:401,"billing-first":403}[scenario]||200;
      expect(output.status).toBe(expectedStatus);
      if(["missing-user","missing-token"].includes(scenario))expect(calls).toHaveLength(0);
      const inference=calls.find(c=>c.init.method==="POST"&&c.url.includes("agent_chat_generation"));
      if(inference){
        expect(inference.url).toBe("https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1");
        expect(inference.proxy.strictProxy).toBe(true);
        assertCosy(inference,scenario==="pat-success"?"jt-fixture":"dt-fixture");
        const decoded=decodeQoder(inference.init.body);
        expect(decoded).toEqual(plain(result.transformedBody));
        expect(decoded.system).toBe("fixture system");expect(decoded.messages).toEqual([{role:"user",content:"fixture user"}]);
        expect(decoded.parameters.max_tokens).toBe(256);expect(decoded.model_config.key).toBe("auto");
      }
      if(scenario==="billing-late"){expect(output.value.error.status).toBe(403);expect(output.value.error.code).toBe("qoder_billing_block");}
      if(["stream","nonstream","pat-success"].includes(scenario)){
        expect(output.value.choices[0].message.content).toBe("fixture answer");expect(output.value.choices[0].finish_reason).toBe("stop");
        expect(output.value.usage).toMatchObject({prompt_tokens:12,completion_tokens:4,total_tokens:16});
        expect(cancelled).toHaveLength(1);expect(output.raw.match(/data: \[DONE\]/g)).toHaveLength(1);
      }
    },30000);
}

for(const label of ["local","nine"])for(const scenario of ["json","stream","sanitize","http401","abort","refresh"]){
  const id=`P8A-ADAPTER-${label}-kimchi-${scenario}`;
  test(id,`Actual Kimchi gateway preserves payload and strips protocol-only artifacts: ${scenario}`,
    [{pin:"vans",path:"open-sse/providers/registry/kimchi.js",symbol:"default",localPath:"open-sse/executors/kimchi.js",caller:"open-sse/handlers/chatCore.js"}],
    ["Actual DefaultExecutor inheritance/transport plus Kimchi transformation; no specialized-class placeholder","System/user/schema association retained; sanitation is restricted to documented protocol fields"],async()=>{
      const calls=[],controller=new AbortController(),creds=credential();
      const g=graph(async(url,init,proxy)=>{calls.push({url,init,proxy});if(init.signal?.aborted)throw init.signal.reason;return scenario==="stream"?success():Response.json({choices:[{message:{content:"fixture answer"}}]},{status:scenario==="http401"?401:200});},label);
      const ex=await registeredAdapter(g,"kimchi");
      if(scenario==="refresh"){expect(await ex.refreshCredentials(creds)).toBeNull();expect(calls).toHaveLength(0);return;}
      const request=body();
      if(scenario==="sanitize")Object.assign(request,{system:"top-level system",anthropic_version:"2023-06-01",thinking:{type:"enabled",budget_tokens:128},reasoning_effort:"high",tools:[{type:"function",function:{name:"inspect",parameters:{type:"object"}},cache_control:{type:"ephemeral"}}],
        messages:[...request.messages,{role:"assistant",content:"prior answer",reasoning_content:"private historical reasoning",cache_control:{type:"ephemeral"}}]});
      if(scenario==="abort")controller.abort(new Error("fixture cancel"));
      const promise=ex.execute({model:"claude-sonnet-4-6",body:request,stream:scenario==="stream",credentials:creds,signal:controller.signal,proxyOptions:{strictProxy:true}});
      if(scenario==="abort"){await expect(promise).rejects.toThrow("fixture cancel");expect(calls[0].init.signal.aborted).toBe(true);return;}
      const result=await promise,output=await consume(g,result),call=calls.find(c=>c.init.method==="POST"),sent=JSON.parse(call.init.body);
      wires.push({id,calls:plain(calls),output,sent});
      expect(call.url).toBe("https://llm.kimchi.dev/openai/v1/chat/completions");
      expect(call.init.headers.Authorization).toBe("Bearer sk-fixture");
      expect(sent.messages.find(m=>m.role==="user").content).toBe("fixture user");
      if(scenario==="sanitize"){
        expect(sent.messages[0].content).toBe("top-level system\n\nfixture system");
        for(const key of ["system","anthropic_version","thinking","reasoning_effort"])expect(sent).not.toHaveProperty(key);
        expect(sent.messages.at(-1)).not.toHaveProperty("reasoning_content");
        expect(sent.tools[0]).toEqual({type:"function",function:{name:"inspect",parameters:{type:"object"}}});
      }
      if(scenario==="http401")expect(output.status).toBe(401);
      else expect(output.value.choices[0].message.content).toBe("fixture answer");
    });
}

for(const label of ["local","nine"])for(const scenario of ["cloud-json","cloud-stream","account-json","account-retry401","account-no-cookie","http401","abort","refresh"]){
  const id=`P8A-ADAPTER-${label}-xiaomi-mimo-${scenario}`;
  test(id,`Actual MiMo cloud/account session route and caller outcome: ${scenario}`,
    [{pin:"vans",path:"open-sse/providers/registry/xiaomi-mimo.js",symbol:"default",localPath:"open-sse/executors/xiaomi-mimo.js",caller:"open-sse/handlers/chatCore.js"}],
    ["Real account-session two-phase acquisition; no Desktop profile reads","Cloud bearer versus session-cookie route, effort/defaults and exactly one 401 refresh"],async()=>{
      const calls=[],controller=new AbortController(),creds=credential();let chatCount=0,phase2Count=0;
      const account=scenario.startsWith("account-");
      if(account)Object.assign(creds.providerSpecificData,{mimoPassToken:"fixture-pass",mimoUserId:"fixture-user",region:"sgp"});
      const g=graph(async(url,init,proxy)=>{
        calls.push({url,init,proxy});if(init.signal?.aborted)throw init.signal.reason;
        if(url.includes("/pass/serviceLogin"))return Response.json({code:scenario==="account-no-cookie"?1:0,location:"https://account.xiaomi.com/fixture-sso",nonce:123,ssecurity:"fixture-security"});
        if(url.includes("fixture-sso")){
          phase2Count++;expect(init.headers).not.toHaveProperty("Cookie");
          expect(new URL(url).searchParams.get("clientSign")).toBe(crypto.createHash("sha1").update("nonce=123&fixture-security").digest("base64"));
          return new Response("",{headers:{"Set-Cookie":`serviceToken=fixture-session-${phase2Count}; Path=/`}});
        }
        chatCount++;
        if(scenario==="http401"||(scenario==="account-retry401"&&chatCount===1))return Response.json({error:{message:"fixture rejected"}},{status:401});
        return scenario==="cloud-stream"?success():Response.json({choices:[{message:{content:"fixture answer"}}]});
      },label);
      const ex=await registeredAdapter(g,"xiaomi-mimo");
      if(scenario==="refresh"){expect(await ex.refreshCredentials(creds)).toBeNull();expect(calls).toHaveLength(0);return;}
      if(scenario==="abort")controller.abort(new Error("fixture cancel"));
      const promise=ex.execute({model:"mimo-v2.6-pro",body:{...body(),reasoning_effort:"xhigh"},stream:scenario==="cloud-stream",credentials:creds,signal:controller.signal,proxyOptions:{strictProxy:true}});
      if(scenario==="abort"){await expect(promise).rejects.toThrow("fixture cancel");expect(calls[0].init.signal.aborted).toBe(true);return;}
      const result=await promise,output=await consume(g,result),last=calls.at(-1),sent=JSON.parse(last.init.body);
      wires.push({id,calls:plain(calls),output,sent});
      if(account&&scenario!=="account-no-cookie"){
        expect(last.url).toBe("https://mimo-server-sgp.xiaomimimo.com/api/route/chat/completions");
        expect(last.init.headers.Cookie).toContain(`serviceToken=fixture-session-${phase2Count}`);
        expect(last.init.headers).not.toHaveProperty("Authorization");expect(sent.output_config.effort).toBe("high");
        expect(sent.temperature).toBe(1);expect(sent.top_p).toBe(0.95);
      }else{
        // Fail-closed oracle: account-route fallback must actually use cloud transport,
        // not merely call super() while inherited route detection still says account.
        expect(last.url).toBe("https://api.xiaomimimo.com/v1/chat/completions");
        expect(last.init.headers.Authorization).toBe("Bearer sk-fixture");
      }
      if(scenario==="account-retry401"){expect(chatCount).toBe(2);expect(phase2Count).toBe(2);}
      if(scenario==="http401")expect(output.status).toBe(401);
      else expect(output.value.choices[0].message.content).toBe("fixture answer");
    });
}

const zedEvents={
  x_ai:[chunk({content:"fixture answer"}),chunk({},"stop")],
  anthropic:[{type:"message_start",message:{id:"fixture",model:"claude-sonnet-4-6",usage:{input_tokens:12}}},
    {type:"content_block_start",index:0,content_block:{type:"text",text:""}},
    {type:"content_block_delta",index:0,delta:{type:"text_delta",text:"fixture answer"}},
    {type:"content_block_stop",index:0},{type:"message_delta",delta:{stop_reason:"end_turn"},usage:{output_tokens:4}},{type:"message_stop"}],
  google:[{candidates:[{content:{role:"model",parts:[{text:"fixture answer"}]},finishReason:"STOP"}],usageMetadata:{promptTokenCount:12,candidatesTokenCount:4,totalTokenCount:16}}],
  open_ai:[{type:"response.created",response:{id:"resp_fixture",model:"gpt-4o"}},
    {type:"response.output_text.delta",item_id:"msg_fixture",output_index:0,content_index:0,delta:"fixture answer"},
    {type:"response.completed",response:{id:"resp_fixture",model:"gpt-4o",status:"completed",output:[],usage:{input_tokens:12,output_tokens:4,total_tokens:16}}}],
};
for(const label of ["local","nine"])for(const provider of Object.keys(zedEvents))for(const scenario of ["stream","nonstream","http401","expired-retry","failed-status","abort","refresh"]){
  const id=`P8A-ADAPTER-${label}-zed-${provider}-${scenario}`;
  test(id,`Actual Zed token/catalog/thread/${provider} native decoder → OpenAI consumer: ${scenario}`,
    [{pin:"vans",path:"open-sse/providers/registry/zed.js",symbol:"default",localPath:"open-sse/executors/zed.js",caller:"open-sse/handlers/chatCore.js"}],
    ["Actual zedAuth token exchange/cache and provider translators; only fetch replaced","Exact hosted provider spelling, client identity, thread/prompt, native request and terminal outcomes"],async()=>{
      const calls=[],creds=credential(),controller=new AbortController();let completionCount=0,tokenCount=0;
      const g=graph(async(url,init,proxy)=>{
        calls.push({url,init,proxy});if(init.signal?.aborted)throw init.signal.reason;
        if(url.endsWith("/client/llm_tokens")){tokenCount++;expect(init.headers.Authorization).toBe("fixture-user dt-fixture");expect(JSON.parse(init.body)).toEqual({organization_id:"fixture-org"});return Response.json({token:`fixture-llm-${tokenCount}`});}
        if(url.endsWith("/models"))return Response.json({models:[{id:"fixture-model",provider,max_token_count:200000}]});
        completionCount++;
        if(scenario==="http401"||(scenario==="expired-retry"&&completionCount===1))return Response.json({message:"fixture rejected"},{status:401});
        const lines=scenario==="failed-status"?[{status:{failed:{message:"fixture failure"}}}]:zedEvents[provider].map(event=>({event}));
        return new Response(lines.map(x=>JSON.stringify(x)).join("\n")+'\n{"status":"stream_ended"}\n',{headers:{"Content-Type":"application/x-ndjson"}});
      },label);
      const ex=await registeredAdapter(g,"zed");
      if(scenario==="refresh"){expect(await ex.refreshCredentials(creds)).toBeNull();expect(ex.needsRefresh(creds)).toBe(false);expect(calls).toHaveLength(0);return;}
      if(scenario==="abort")controller.abort(new Error("fixture cancel"));
      const promise=ex.execute({model:"fixture-model",body:{...body(),prompt_id:"fixture-prompt"},stream:scenario!=="nonstream",credentials:creds,signal:controller.signal});
      if(scenario==="abort"){await expect(promise).rejects.toThrow("fixture cancel");expect(calls.every(c=>c.init.signal.aborted)).toBe(true);return;}
      const result=await promise,output=await consume(g,result),call=calls.at(-1),sent=JSON.parse(call.init.body);
      wires.push({id,calls:plain(calls),output,sent});
      expect(call.url).toBe("https://cloud.zed.dev/completions");expect(call.init.headers.Authorization).toBe(`Bearer fixture-llm-${tokenCount}`);
      expect(call.init.headers["User-Agent"]).toBe(label==="local"?"srouter/zed":"9router/zed");expect(sent.provider).toBe(provider);
      expect(sent.thread_id).toBe("fixture-thread");expect(sent.prompt_id).toBe("fixture-prompt");expect(sent.model).toBe("fixture-model");
      const request=sent.provider_request;
      if(provider==="anthropic"){expect(request.system.some(p=>p.text==="fixture system")).toBe(true);expect(request.messages[0].content[0].text).toBe("fixture user");}
      if(provider==="google"){expect(request.systemInstruction.parts[0].text).toBe("fixture system");expect(request.contents[0].parts[0].text).toBe("fixture user");expect(request).not.toHaveProperty("safetySettings");}
      if(provider==="open_ai"){expect(request.instructions).toBe("fixture system");expect(JSON.stringify(request.input)).toContain("fixture user");}
      if(provider==="x_ai")expect(request.messages).toEqual(body().messages);
      if(scenario==="expired-retry"){expect(completionCount).toBe(2);expect(tokenCount).toBe(2);}
      if(scenario==="http401"){expect(output.status).toBe(401);expect(completionCount).toBe(2);}
      else{
        expect(output.value.choices[0].message.content).toBe(scenario==="failed-status"?"[Zed error] fixture failure":"fixture answer");
        expect(output.raw.match(/data: \[DONE\]/g)).toHaveLength(1);
      }
    },30000);
}
