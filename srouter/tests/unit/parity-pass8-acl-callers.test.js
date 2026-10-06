import { afterAll, beforeAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sourceGraph, plain, contractSuite, evidence } from "../helpers/parity-pass8-source.js";
const test=contractSuite("acl-callers"),graphs=[];
const enumeration=sourceGraph("local");graphs.push(enumeration);
const registry=(await enumeration.load("open-sse/providers/registry/index.js")).default;
let access;
beforeAll(async()=>{
  const g=sourceGraph("local",{"src/lib/db/index.js":{getProviderNodeById:async()=>null}});
  graphs.push(g);access=await g.load("src/sse/services/access.js");
});
afterAll(()=>{
  fs.writeFileSync(path.join(evidence,"source-hashes-acl-callers.json"),JSON.stringify(graphs.map(g=>({label:g.label,loaded:Object.fromEntries(g.loaded)})),null,2));
  graphs.forEach(g=>g.dispose());
});
for(const provider of registry)for(const grant of [...new Set([provider.id,provider.alias,...(provider.aliases||[])].filter(Boolean))]){
  for(const target of [...new Set([provider.id,provider.alias,...(provider.aliases||[])].filter(Boolean))]){
    test(`P8A-ACL-${provider.id}-${grant}-${target}`,`Independent ACL grant=${grant} target=${target}`,
      [{pin:"vans",path:"src/sse/services/auth.js",symbol:"isProviderAllowed",localPath:"src/sse/services/access.js",caller:"src/sse/services/requestAccess.js"}],
      ["One registry alias permutation per case; empty grant never widens access"],async()=>{
        expect.soft(await access.isProviderAllowed({allowedProviders:[grant]},target)).toBe(true);
        expect.soft(await access.isProviderAllowed({allowedProviders:[]},target)).toBe(false);
      });
  }
}
for(const alias of ["gb","grok-build"]){
  test(`P8A-ACL-PERSISTED-${alias}`,`Persisted ${alias} grant → actual auth/requestAccess → canonical grok-cli target`,
    [{pin:"vans",path:"src/sse/services/auth.js",symbol:"getApiKeyInfo",localPath:"src/sse/services/requestAccess.js",caller:"src/sse/handlers/chat.js"},
      {pin:"vans",path:"src/lib/db/repos/apiKeysRepo.js",symbol:"createApiKey"}],
    ["Real SQLite row, actual create/read repository and auth extraction; only model catalog and unrelated account-selection dependencies mocked",
      "Normal chat canonical target must accept alias-form grant; response is availability denial, not privilege widening"],async()=>{
      if(!process.env.DATA_DIR||!fs.existsSync(path.join(process.env.DATA_DIR,"PASS8-OWNED")))throw new Error("Owned isolated DATA_DIR required");
      const dir=fs.mkdtempSync(path.join(process.env.DATA_DIR,"acl-")),db=new DatabaseSync(path.join(dir,"fixture.sqlite"));
      db.exec("CREATE TABLE apiKeys(id TEXT PRIMARY KEY,key TEXT,name TEXT,machineId TEXT,isActive INTEGER,createdAt TEXT,allowedProviders TEXT,allowedCombos TEXT,allowedKinds TEXT)");
      const adapter={get:(sql,args=[])=>db.prepare(sql).get(...args),all:(sql,args=[])=>db.prepare(sql).all(...args),
        run:(sql,args=[])=>db.prepare(sql).run(...args),transaction:fn=>{db.exec("BEGIN");try{const r=fn();db.exec("COMMIT");return r;}catch(e){db.exec("ROLLBACK");throw e;}}};
      let keys;
      const unused=()=>{throw new Error("Unrelated account selection invoked");};
      const g=sourceGraph("local",{
        "src/lib/db/driver.js":{getAdapter:async()=>adapter},
        "src/shared/utils/apiKey":{generateApiKeyWithMachine:()=>({key:"fixture-synthetic-key"})},
        "src/lib/localDb":{getProviderConnections:unused,validateApiKey:async k=>keys.validateApiKey(k),getApiKeyByKey:async k=>keys.getApiKeyByKey(k),
          updateProviderConnection:unused,getSettings:async()=>({requireApiKey:true}),getProxyPools:unused},
        "src/lib/network/connectionProxy":{resolveConnectionProxyConfig:unused,pickProxyPoolId:unused},
        "src/sse/services/antigravityQuota.js":{getAntigravityQuotaCache:unused},
        "src/lib/db/index.js":{getProviderNodeById:async()=>null},
        "src/lib/disabledModelsDb":{getDisabledModels:async()=>({})},
        "src/shared/utils/machineId":{getConsistentMachineId:async()=>"0123456789abcdef"},
        "src/app/api/v1/models/route.js":{buildModelsList:async()=>[{id:"grok-cli/fixture",kind:"llm"}]},
      });graphs.push(g);
      try{
        keys=await g.load("src/lib/db/repos/apiKeysRepo.js");
        const created=await keys.createApiKey("fixture grant","fixture-machine",{allowedProviders:[alias],allowedKinds:["llm"]});
        expect(db.prepare("SELECT allowedProviders FROM apiKeys WHERE id=?").get(created.id).allowedProviders).toBe(JSON.stringify([alias]));
        const request=new Request("http://127.0.0.1/v1/chat/completions",{headers:{Authorization:`Bearer ${created.key}`}});
        const requests=await g.load("src/sse/services/requestAccess.js"),principal=await requests.authenticateRequest(request,{requireApiKey:true});
        expect(principal.error).toBeUndefined();expect(plain(principal.apiKeyInfo.allowedProviders)).toEqual([alias]);
        const result=await requests.checkTargetAccess(principal.apiKeyInfo,"grok-cli","fixture","llm");
        expect(result?.status??200).toBe(200);
      }finally{db.close();}
    });
}
