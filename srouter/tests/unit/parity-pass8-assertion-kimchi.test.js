import { expect } from "vitest";
import { registerPinnedRecipes, extraCase, ownedGraph } from "../helpers/parity-pass8-assertion-recipes.js";
import { sqliteMemory, getRegistered } from "../helpers/parity-pass8-assertion-native.js";
await registerPinnedRecipes("kimchi.test.js");
const native=(label,slots,extra={})=>({implementation:label,pin:"nine",upstreamRelativePath:"tests/unit/kimchi.test.js",nativeUpstreamSlots:slots,...extra});
for(const label of ["local","nine"]){
  extraCase(`A8-NATIVE-KIMCHI-${label}-oauth-url`,async check=>{
    const g=ownedGraph(label,{"src/lib/oauth/utils/server.js":{startLocalServer:()=>{throw new Error("No real listener");}}});
    const svc=await g.load("src/lib/oauth/services/kimchi.js");
    const url=svc.buildKimchiAuthUrl("http://127.0.0.1:4321/callback","abc123"),parsed=new URL(url);
    await check("Original origin",()=>expect(parsed.origin).toBe("https://app.kimchi.dev"),[81,81]);
    await check("Original pathname",()=>expect(parsed.pathname).toBe("/cli-auth"),[82,82]);
    await check("Original encoded callback",()=>expect(parsed.searchParams.get("callback")).toBe("http://127.0.0.1:4321/callback"),[83,83]);
    await check("Original state",()=>expect(parsed.searchParams.get("state")).toBe("abc123"),[84,84]);
    return{url,caller:"KimchiService.startLogin",sources:Object.fromEntries(g.loaded)};
  },native(label,[10,11,12,13]));
  extraCase(`A8-NATIVE-KIMCHI-${label}-callback-state`,async check=>{
    const calls=[],g=ownedGraph(label,{"src/lib/oauth/utils/server.js":{startLocalServer:()=>{throw new Error("No real listener");}}},{fetch:async(...args)=>{calls.push(args);return new Response(null,{status:200});}});
    const {KimchiService}=await g.load("src/lib/oauth/services/kimchi.js"),svc=new KimchiService();
    await check("Original mismatched state rejects restart",()=>expect(svc._handleCallback({token:"castai_v1_x",state:"wrong"},"expected")).rejects.toThrow(/restart/i),[88,91]);
    await check("State rejection reaches no validation transport",()=>expect(calls).toHaveLength(0));
    const result=await svc._handleCallback({token:"castai_v1_x",state:"match"},"match");
    await check("Original matching callback returns token",()=>expect(result.token).toBe("castai_v1_x"),[96,96]);
    await check("Actual callback validates token before accepting",()=>expect(calls[0][1].headers.Authorization).toBe("Bearer castai_v1_x"));
    return{result,requests:calls,sources:Object.fromEntries(g.loaded)};
  },native(label,[14,15]));
  for(const status of [200,401,403,500,0])extraCase(`A8-NATIVE-KIMCHI-${label}-validation-${status}`,async check=>{
    const calls=[],g=ownedGraph(label,{"src/lib/oauth/utils/server.js":{startLocalServer:()=>{throw new Error("No real listener");}}},{
      fetch:async(url,options)=>{calls.push({url,options});if(status===0)throw new Error("Synthetic offline network failure");return new Response(null,{status});}});
    const {KimchiService}=await g.load("src/lib/oauth/services/kimchi.js"),svc=new KimchiService(),result=await svc.validateToken("castai_v1_x");
    if(status===200)await check("Original valid object",()=>expect(result).toEqual({valid:true}),[160,160]);
    else if(status===401||status===403){
      await check("Original invalid result",()=>expect(result.valid).toBe(false),[status===401?164:169,status===401?164:169]);
      await check("Original error text",()=>expect(result.error).toMatch(status===401?/invalid or expired/i:/scope/i),[status===401?165:170,status===401?165:170]);
      await check("Stronger actual callback refuses invalid token",()=>expect(svc._handleCallback({token:"castai_v1_x",state:"match"},"match")).rejects.toThrow(status===401?/invalid or expired/i:/scope/i));
    }else await check("Original unknown/network fail-open",()=>expect(result.valid).toBe(true),[status===500?173:174,status===500?173:174]);
    await check("Actual validation transport GET/Bearer",()=>expect(calls[0].options).toMatchObject({method:"GET",headers:{Authorization:"Bearer castai_v1_x",Accept:"application/json"}}));
    return{status,result,requests:calls,sources:Object.fromEntries(g.loaded)};
  },native(label,{200:[23],401:[24,25],403:[26,27],500:[28],0:[29]}[status]));
  extraCase(`A8-NATIVE-KIMCHI-${label}-callback-session`,async check=>{
    let callback,closed=0;const requests=[];
    const g=ownedGraph(label,{"src/lib/oauth/utils/server.js":{startLocalServer:async fn=>{callback=fn;return{port:4321,close:()=>closed++};}}},
      {fetch:async(url,options)=>{requests.push({url,options});return new Response(null,{status:200});}});
    const ns=await g.load("src/lib/oauth/services/kimchi.js"),session=await new ns.KimchiService().startLogin();
    callback({token:"castai_v1_x",state:session.state});
    const result=await session.result;await Promise.resolve();
    await check("Real service/session consumer receives validated token",()=>expect(ns.getResolvedSession(session.state)).toEqual({token:"castai_v1_x"}));
    await check("Synthetic listener closed exactly once",()=>expect(closed).toBe(1));
    await check("Session auth URL carries actual state",()=>expect(new URL(session.authUrl).searchParams.get("state")).toBe(session.state));
    return{result,closed,requests,session:{authUrl:session.authUrl,state:session.state},sources:Object.fromEntries(g.loaded)};
  },native(label,[10,11,12,13,15],{strengthening:true}));
  const modelFixtures=[
    {name:"rich",raw:[{slug:"glm-5.2-fp8",display_name:"GLM 5.2",reasoning:true,limits:{context_window:1048576,max_output_tokens:1048576}}],slots:[16,17]},
    {name:"fallback",raw:[{slug:"kimi-k2.7",display_name:"",reasoning:false,limits:{}}],slots:[18,19,20]},
    {name:"null",raw:null,slots:[21]}, {name:"object",raw:{},slots:[22]},
  ];
  for(const fixture of modelFixtures)extraCase(`A8-NATIVE-KIMCHI-${label}-models-${fixture.name}`,async check=>{
    const requests=[],g=ownedGraph(label,{},{
      fetch:async(url,options)=>{
        requests.push({url,options});
        if(url==="https://api.github.com/repos/getkimchi/kimchi/releases/latest")return new Response(JSON.stringify({tag_name:"v0.1.58"}));
        if(String(url).includes("/v1/models/metadata?include_in_cli=true"))return new Response(JSON.stringify({models:fixture.raw}));
        throw new Error("Unexpected synthetic URL "+url);
      }});
    const ns=await g.load("open-sse/services/kimchiModels.js"),entry=await ns.resolveKimchiModels({accessToken:"castai_v1_x"},{forceRefresh:true});
    if(fixture.name==="rich"){
      await check("Original model length",()=>expect(entry.models).toHaveLength(1),[124,124]);
      await check("Original clone's exact shape against ACTUAL richer model (red retained)",()=>expect(entry.models[0]).toEqual({id:"glm-5.2-fp8",name:"GLM 5.2",contextLength:1048576,maxOutputTokens:1048576,isReasoning:true}),[125,131]);
      await check("Native richer schema: reasoning and capability budgets",()=>expect(entry.models[0]).toMatchObject({id:"glm-5.2-fp8",name:"GLM 5.2",reasoning:true,contextLength:1048576,maxOutputTokens:1048576,capabilities:{reasoning:true,contextWindow:1048576,maxOutput:1048576}}));
      await check("Actual metadata cache consumer returns same normalized schema",()=>expect(ns.getCachedKimchiModelMetadata("kimchi/glm-5.2-fp8")).toEqual(entry.models[0]));
    }else if(fixture.name==="fallback"){
      await check("Original fallback name",()=>expect(entry.models[0].name).toBe("kimi-k2.7"),[136,136]);
      await check("Original clone nullable context against actual absent field (red retained)",()=>expect(entry.models[0].contextLength).toBe(null),[137,137]);
      await check("Original clone isReasoning against actual reasoning field (red retained)",()=>expect(entry.models[0].isReasoning).toBe(false),[138,138]);
      await check("Native fallback reasoning=false and omitted absent budget",()=>expect(entry.models[0]).toMatchObject({id:"kimi-k2.7",name:"kimi-k2.7",reasoning:false}));
      await check("No invented native context budget",()=>expect(Object.hasOwn(entry.models[0],"contextLength")).toBe(false));
    }else{
      // No mapKimchiMetadata export exists. The actual nullable catalog entry is
      // deliberately NOT coerced to [] to make the clone's assertions green.
      await check("Clone empty-array expectation compared with actual catalog result (red retained)",()=>expect(entry).toEqual([]),[fixture.name==="null"?142:143,fixture.name==="null"?142:143]);
      await check("Actual parser returns no catalog for absent/invalid collection",()=>expect(entry).toBe(null));
    }
    await check("Actual catalog transport Bearer",()=>expect(requests.find(r=>String(r.url).includes("/v1/models/metadata")).options.headers.Authorization).toBe("Bearer castai_v1_x"));
    return{fixture,entry,requests,sources:Object.fromEntries(g.loaded),contract:"Clone schemas are not public catalog schemas; no full Kimchi-file equivalence certified."};
  },native(label,fixture.slots,{cloneCounterpart:true}));
  const google={authType:"oauth",email:"x@y.com",providerSpecificData:{username:"google-oauth2|123"}},
    hf={authType:"oauth",email:"x@y.com",providerSpecificData:{username:"huggingface|456"}},
    legacy={authType:"oauth",email:"x@y.com",providerSpecificData:{}},
    other={authType:"oauth",email:"z@y.com",providerSpecificData:{username:"google-oauth2|789"}},
    ws1={authType:"oauth",email:"a@b.com",providerSpecificData:{chatgptAccountId:"ws1"}},
    ws2={authType:"oauth",email:"a@b.com",providerSpecificData:{chatgptAccountId:"ws2"}};
  const dedup=[
    ["other-email",other,google,false,30,[207,207]],["same-idp",google,{...google},true,31,[212,212]],
    ["cross-idp",google,hf,false,32,[216,216]],["legacy",legacy,{...legacy},true,33,[220,220]],
    ["missing-username",google,{...legacy},false,34,[224,224]],["workspace-same",ws1,{...ws1},true,35,[231,231]],
    ["workspace-other",ws1,ws2,false,36,[232,232]],
  ];
  for(const [name,seed,incoming,match,slot,range]of dedup)extraCase(`A8-NATIVE-KIMCHI-${label}-dedup-${name}`,async check=>{
    const sql=await sqliteMemory();let sequence=0;
    const g=ownedGraph(label,{"src/lib/db/driver.js":{getAdapter:async()=>sql.adapter}},{randomUUID:()=>`assertion-fixture-${++sequence}`});
    try{
      sql.adapter.run("INSERT INTO providerConnections(id,provider,authType,name,email,priority,isActive,data,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)",
        ["original-row","kimchi","oauth","fixture",seed.email,1,1,JSON.stringify({providerSpecificData:seed.providerSpecificData}),"2026-10-01","2026-10-01"]);
      const ns=await g.load("src/lib/db/repos/connectionsRepo.js"),result=await ns.createProviderConnection({...incoming,provider:"kimchi",name:"fixture"});
      const rows=await ns.getProviderConnections({provider:"kimchi"});
      await check("Original matcher business result through actual persisted ID",()=>expect(result.id==="original-row").toBe(match),range);
      await check("Actual repository row cardinality prevents cross-IdP overwrite",()=>expect(rows.length).toBe(match?1:2));
      await check("New identity leaves original persisted identity intact",()=>expect(rows.find(r=>r.id==="original-row").providerSpecificData).toEqual(seed.providerSpecificData));
      return{seed,incoming,match,result,rows,sql:sql.calls,sources:Object.fromEntries(g.loaded),
        portability:"Object-reference identity assertions in an inlined Array.find clone are not a persistence API contract; native equality uses original stored ID, not object-reference normalization."};
    }finally{sql.close();}
  },native(label,[slot],{cloneCounterpart:true,originalRange:range}));
  extraCase(`A8-NATIVE-KIMCHI-${label}-registered-transport`,async check=>{
    const requests=[],g=ownedGraph(label,{},{
      fetch:async(url,options)=>{
        requests.push({url,options:{...options,body:typeof options?.body==="string"?JSON.parse(options.body):options?.body}});
        if(url==="https://api.github.com/repos/getkimchi/kimchi/releases/latest")return new Response(JSON.stringify({tag_name:"v0.1.58"}));
        return new Response(JSON.stringify({id:"fixture",choices:[{message:{role:"assistant",content:"OK"},finish_reason:"stop"}]}),{headers:{"Content-Type":"application/json"}});
      }});
    const {ex,dispatch}=await getRegistered(g,"kimchi"),body={model:"kimi-k2.7",messages:[{role:"user",content:"fixture"}]},
      definition=(await g.load("open-sse/providers/registry/kimchi.js")).default;
    const result=await ex.execute({model:"kimi-k2.7",body,stream:false,credentials:{accessToken:"castai_v1_x",providerSpecificData:{username:"fixture"}}});
    const sent=requests.find(r=>String(r.url).includes("/chat/completions"));
    await check("Actual specialized registration",()=>expect(dispatch.hasSpecializedExecutor("kimchi")).toBe(true));
    await check("Registry endpoint actually reaches transport",()=>expect(sent.url).toBe("https://llm.kimchi.dev/openai/v1/chat/completions"),[20,23]);
    await check("Auth descriptor actually produces Bearer",()=>expect(sent.options.headers.Authorization).toBe("Bearer castai_v1_x"),[31,35]);
    await check("Actual authenticated User-Agent is nonempty",()=>expect(sent.options.headers["User-Agent"]).toMatch(/^kimchi\/\d+\.\d+\.\d+$/),[27,27]);
    await check("Actual OAuth entry retains auth mode despite freeTier category",()=>expect(definition).toMatchObject({category:"freeTier",hasOAuth:true,authModes:["oauth","apikey"]}));
    await check("Native request schema has required messages/model",()=>expect(sent.options.body).toMatchObject(body));
    await check("Native response consumed",async()=>expect((await result.response.json()).choices[0].message.content).toBe("OK"));
    return{requests,result:{url:result.url,transformedBody:result.transformedBody},sources:Object.fromEntries(g.loaded)};
  },native(label,[0,1,2,3,4,5,6,7,8,9],{strengthening:true}));
}
