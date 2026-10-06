import { afterAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import bcrypt from "bcryptjs";
import { sourceGraph, plain, contractSuite } from "../helpers/parity-pass8-source.js";

const test=contractSuite("control-plane"),graphs=[];
afterAll(()=>graphs.forEach(g=>g.dispose()));
const req=body=>new Request("http://127.0.0.1/fixture",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
const next={NextResponse:{json:(data,options)=>Response.json(data,options)}};
const combos="src/app/api/combos/route.js",combo="src/app/api/combos/[id]/route.js",settingsPath="src/app/api/settings/route.js",overridesPath="src/app/api/providers/[id]/overrides/route.js";
for(const pin of ["nine","vans"])for(const scenario of ["crud","duplicate","name-validation","context-validation","not-found","nested-models"]){
  test(`P8-API-COMBO-${pin}-${scenario}`,`${pin} nonvisual combo API→repo→real SQLite ${scenario}`,
    [{pin,path:combos,symbol:"POST",caller:"src/shared/components/ComboForm.js"},{pin,path:combo,symbol:"PUT"},{pin,path:"src/lib/db/repos/combosRepo.js",symbol:"updateCombo"}],
    ["Actual route validation and real repo/SQLite, not a fake CRUD reimplementation", "Exact pinned status/response and rotation invalidation contract"],
    async()=>{
      const run=async label=>{
        if(!fs.existsSync(path.join(process.env.DATA_DIR||"","PASS8-OWNED")))throw new Error("Owned DB isolation required");
        const dir=fs.mkdtempSync(path.join(process.env.DATA_DIR,"combo-")),db=new DatabaseSync(path.join(dir,"data.sqlite"));
        let sequence=0;const reset=[];
        const adapter={
          exec:s=>db.exec(s),get:(s,p=[])=>db.prepare(s).get(...p),all:(s,p=[])=>db.prepare(s).all(...p),
          run:(s,p=[])=>db.prepare(s).run(...p),transaction:fn=>{db.exec("SAVEPOINT fixture");try{const r=fn();db.exec("RELEASE fixture");return r;}catch(e){db.exec("ROLLBACK TO fixture");db.exec("RELEASE fixture");throw e;}},
        };
        const g=sourceGraph(label,{"next/server":next,uuid:{v4:()=>`fixture-${++sequence}`},"src/lib/db/driver.js":{getAdapter:async()=>adapter},
          "open-sse/services/combo.js":{resetComboRotation:name=>reset.push(name)},
          "src/sse/services/allowedModels.js":{invalidateAllowedModelsCache(){}},
        },{randomUUID:()=>`fixture-${++sequence}`});
        graphs.push(g);
        try{
          const schema=await g.load("src/lib/db/schema.js");db.exec(schema.buildCreateTableSql("combos",schema.TABLES.combos));
          const repo=await g.load("src/lib/db/repos/combosRepo.js");g.mocks["src/lib/localDb"]={...repo};g.mocks["src/lib/localDb.js"]={...repo};
          const root=await g.load(combos),detail=await g.load(combo),out=[];
          const capture=async response=>{const r=await response;out.push({status:r.status,body:await r.json()});return out.at(-1).body;};
          if(scenario==="not-found"){
            const params={params:Promise.resolve({id:"missing"})};
            await capture(detail.GET(req({}),params));await capture(detail.PUT(req({name:"valid"}),params));await capture(detail.DELETE(req({}),params));
          }else if(scenario==="name-validation"){
            for(const name of ["","spaces fail","slash/fail","../fail","valid.dot",123])await capture(root.POST(req({name,models:[]})));
          }else if(scenario==="context-validation"){
            // 9router pin has no context_length persistence/validation contract.
            // Vans does: all invalid boundary fixtures are compared against Vans.
            for(const context_length of pin==="nine"?[128,null]:[-1,0,1,1.5,"128",128,null,{},Number.MAX_SAFE_INTEGER])await capture(root.POST(req({name:`fixture_${++sequence}`,models:["openai/a"],context_length})));
          }else{
            const created=await capture(root.POST(req({name:"fixture",models:scenario==="nested-models"?["combo/nested","openai/a"]:["openai/a"],kind:"llm",context_length:128})));
            const params={params:Promise.resolve({id:created.id})};
            if(scenario==="duplicate")await capture(root.POST(req({name:"fixture",models:[]})));
            else{
              await capture(root.GET());await capture(detail.GET(req({}),params));
              await capture(detail.PUT(req({name:"renamed",models:["openai/b"],context_length:null}),params));
              await capture(detail.DELETE(req({}),params));await capture(detail.GET(req({}),params));
            }
          }
          return{out,reset};
        }finally{db.close();g.dispose();}
      };
      expect(plain(await run("local"))).toMatchObject(plain(await run(pin)));
    });
}
async function settingsFixture(){
  let state={requireLogin:true,password:"stored-fixture-hash",oidcClientSecret:"fixture-oidc-secret",oidcIssuerUrl:"https://fixture.invalid",oidcClientId:"fixture-client",unrelated:"preserve"};
  let writes=0;const outbound=[],rotation=[];
  const getSettings=async()=>state,updateSettings=async data=>{writes++;state={...state,...plain(data)};return state;};
  const g=sourceGraph("local",{
    "next/server":next,"src/lib/localDb":{getSettings,updateSettings},"src/lib/localDb.js":{getSettings,updateSettings},
    "src/lib/db":{getSettings,updateSettings},"src/lib/db/index.js":{getSettings,updateSettings},
    "src/lib/network/outboundProxy":{applyOutboundProxyEnv:s=>outbound.push(plain(s))},
    "open-sse/services/combo.js":{resetComboRotation:name=>rotation.push(name)},
    bcryptjs:{default:bcrypt},
  });
  graphs.push(g);
  return{g,state:()=>state,writes:()=>writes,outbound,rotation,settings:await g.load(settingsPath),overrides:await g.load(overridesPath)};
}
for(const body of [null,[],42,"string",{password:"attacker-hash",mitmSudoEncrypted:"attacker",currentPassword:"secret-without-change"},{visionAdvisor:{enabled:"wrong"}},{customSystemPrompts:{enabled:"wrong"}}]){
  test(`P8-API-SETTINGS-${JSON.stringify(body)}`,"Settings API object/secret/custom state validation",
    [{pin:"vans",path:settingsPath,symbol:"PATCH"},{pin:"nine",path:settingsPath,symbol:"GET"}],
    ["Actual API refuses invalid document/custom contracts", "Protected fields cannot mass-assign secrets", "GET/PATCH never expose password or OIDC secret; no-store response"],
    async()=>{
      const f=await settingsFixture();try{
        const response=await f.settings.PATCH(req(body));const result=await response.json();
        if(body===null||typeof body!=="object"||Array.isArray(body)||body.visionAdvisor||body.customSystemPrompts){
          expect(response.status).toBe(400);expect(f.writes()).toBe(0);
        }else{
          expect(response.status).toBe(200);expect(f.state().password).toBe("stored-fixture-hash");
          expect(f.state().mitmSudoEncrypted).toBeUndefined();expect(result.password).toBeUndefined();expect(result.oidcClientSecret).toBeUndefined();
        }
        const get=await f.settings.GET();const exported=await get.json();
        expect(exported.password).toBeUndefined();expect(exported.oidcClientSecret).toBeUndefined();expect(get.headers.get("cache-control")).toBe("no-store");
      }finally{f.g.dispose();}
    });
}
for(const header of ["Authorization","Cookie","Host","Connection","x-api-key","chatgpt-account-id","x-9r-cli-token","x-captcha-token","X-Fixture"]){
  test(`P8-API-OVERRIDE-${header}`,`Provider override API and dispatch share validation: ${header}`,
    [{pin:"nine",path:overridesPath,symbol:"PUT"},{pin:"nine",path:overridesPath,symbol:"normalizeOverride",localPath:"open-sse/utils/providerOverrides.js",localSymbol:"applyProviderOverride",caller:"open-sse/executors/base.js"}],
    ["Real API/runtime normalizer: auth/account/relay/connection tokens cannot be overridden", "Benign header survives immutable header application; API response no-store"],async()=>{
      const f=await settingsFixture();try{
        const payload={headers:{[header]:"fixture"}};
        const r=await f.overrides.PUT(req(payload),{params:Promise.resolve({id:"openai"})});
        const runtime=await f.g.load("open-sse/utils/providerOverrides.js");
        const blocked=header!=="X-Fixture";
        expect(runtime.isBlockedOverrideHeader(header)).toBe(blocked);
        expect(r.status).toBe(blocked?400:200);
        if(blocked)expect(f.writes()).toBe(0);
        else{
          const original={Authorization:"Bearer immutable"};
          const applied=runtime.applyProviderOverride(original,payload);
          expect(applied[header.toLowerCase()]).toBe("fixture");expect(original).toEqual({Authorization:"Bearer immutable"});
        }
      }finally{f.g.dispose();}
    });
}
test("P8-API-OVERRIDE-concurrency","Concurrent provider override saves retain both providers",
  [{pin:"nine",path:overridesPath,symbol:"PUT"}],
  ["Actual route read/modify/write serialization retains different providers under concurrent requests"],
  async()=>{
    const f=await settingsFixture();try{
      const responses=await Promise.all([
        f.overrides.PUT(req({headers:{"X-Fixture-A":"a"}}),{params:Promise.resolve({id:"openai"})}),
        f.overrides.PUT(req({headers:{"X-Fixture-B":"b"}}),{params:Promise.resolve({id:"anthropic"})}),
      ]);
      expect(responses.map(r=>r.status)).toEqual([200,200]);
      expect(f.state().providerOverrides.openai.headers["x-fixture-a"]).toBe("a");
      expect(f.state().providerOverrides.anthropic.headers["x-fixture-b"]).toBe("b");
    }finally{f.g.dispose();}
  });
