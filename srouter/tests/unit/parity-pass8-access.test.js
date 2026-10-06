import { afterAll, beforeAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sourceGraph, evidence, plain, contractSuite } from "../helpers/parity-pass8-source.js";

const test=contractSuite("access");
const graphs=[], grants=new Map();
let access, requests, allowed, trust, reference, disabled={}, catalogCalls=0;
const accessPath="src/sse/services/access.js", requestPath="src/sse/services/requestAccess.js", allowedPath="src/sse/services/allowedModels.js", trustPath="src/sse/services/internalTrust.js";
beforeAll(async()=>{
  const g=sourceGraph("local",{
    "src/lib/db/index.js":{getProviderNodeById:async id=>id==="openai-compatible-fixture"?{id,prefix:"custom-fixture"}:null},
    "src/lib/localDb":{getSettings:async()=>({requireApiKey:true})},
    "src/lib/localDb.js":{getSettings:async()=>({requireApiKey:true})},
    "src/lib/disabledModelsDb":{getDisabledModels:async()=>disabled},
    "src/shared/utils/machineId":{getConsistentMachineId:async()=>"0123456789abcdef"},
    "src/shared/utils/machineId.js":{getConsistentMachineId:async()=>"0123456789abcdef"},
    // Authentication credential store boundary only. Actual trust/access/availability
    // and requestAccess control flow execute unchanged source.
    "src/sse/services/auth.js":{
      extractApiKey:r=>r.headers.get("authorization")?.replace(/^Bearer /,"")||null,
      getApiKeyInfo:async k=>grants.get(k)||null,
    },
    "src/app/api/v1/models/route.js":{buildModelsList:async kinds=>{
      catalogCalls++;
      return kinds.flatMap(kind=>[
        {id:"openai/fixture",kind},{id:"custom-fixture/fixture",kind},
        {id:"anthropic/fixture",kind},
      ]);
    }},
  });
  graphs.push(g);
  access=await g.load(accessPath);requests=await g.load(requestPath);allowed=await g.load(allowedPath);trust=await g.load(trustPath);
  const unused=()=>{throw new Error("Unused ACL dependency invoked");};
  const ref=sourceGraph("vans",{
    "src/lib/localDb":{getProviderConnections:unused,validateApiKey:unused,updateProviderConnection:unused,getSettings:unused,getProxyPools:unused,getProviderNodeById:async id=>id==="openai-compatible-fixture"?{id,prefix:"custom-fixture"}:null},
    "src/lib/network/connectionProxy":{resolveConnectionProxyConfig:unused,pickProxyPoolId:unused},
    "open-sse/utils/proxyFetch.js":{resolveAntigravityProxyConfig:unused},
    "src/sse/services/antigravityQuota.js":{getAntigravityQuotaCache:unused},
    "src/shared/utils/machineId":{getConsistentMachineId:async()=>"0123456789abcdef"},
  });
  graphs.push(ref);reference=await ref.load("src/sse/services/auth.js");
},60000);
afterAll(()=>{
  fs.writeFileSync(path.join(evidence,"source-hashes-access.json"),JSON.stringify(Object.fromEntries(graphs.map(g=>[g.label,Object.fromEntries(g.loaded)])),null,2));
  graphs.forEach(g=>g.dispose());
});
const grantValues=[
  ["null",null],["undefined",undefined],["empty",[]],["matching",["openai"]],
  ["wrong",["anthropic"]],["corrupt-string",'["openai"]'],["corrupt-object",{openai:true}],
];
for(const alias of ["grok-build","gb"]){
  test(`P8-ACL-extra-target-${alias}`,`Pinned provider alias ${alias} keeps canonical-principal authorization`,
    [{pin:"vans",path:"src/sse/services/auth.js",symbol:"isProviderAllowed",localPath:accessPath,caller:requestPath},
      {pin:"vans",path:"src/shared/constants/providers.js",symbol:"resolveProviderId"}],
    ["Compare actual pinned/local ACL with canonical grok-cli grant and non-primary alias target",
      "Unknown/empty/corrupt grant never widens access"],
    async()=>{
      const info={allowedProviders:["grok-cli"]};
      expect(await reference.isProviderAllowed(info,alias)).toBe(true);
      expect(await access.isProviderAllowed(info,alias)).toBe(true);
      expect(await access.isProviderAllowed({allowedProviders:[]},alias)).toBe(false);
    });
}
for(const [name,value]of grantValues)for(const kind of ["llm","embedding","image","imageToText","tts","stt","video","webSearch","webFetch","systemone"]){
  test(`P8-ACL-${name}-${kind}`,`Principal ${name} ${kind}: NULL unrestricted, [] denied, corrupt fail-closed`,
    [{pin:"vans",path:"src/sse/services/auth.js",symbol:"isKindAllowed",localPath:accessPath},
      {pin:"vans",path:"src/sse/services/auth.js",symbol:"isProviderAllowed",localPath:accessPath,caller:requestPath}],
    ["Full grant-state × modality negative/positive permissions", "Actual requestAccess kind/provider/model error ordering; target availability source boundary mocked only"],async()=>{
      const info={allowedProviders:value,allowedKinds:null,allowedCombos:null};
      const permits=value==null||(Array.isArray(value)&&value.includes("openai"));
      expect(await access.isProviderAllowed(info,"openai")).toBe(permits);
      expect(await reference.isProviderAllowed(info,"openai")).toBe(permits);
      const result=await requests.checkTargetAccess(info,"openai","fixture",kind);
      expect(result?.status??200).toBe(permits?200:403);
      const canonicalKind=["webSearch","webFetch"].includes(kind)?"web":kind==="imageToText"?"llm":kind;
      expect(access.isKindAllowed({allowedKinds:[canonicalKind]},kind)).toBe(true);
      expect(access.isKindAllowed({allowedKinds:[]},kind)).toBe(false);
      expect(access.isKindAllowed({allowedKinds:"corrupt"},kind)).toBe(false);
      expect(reference.isKindAllowed({allowedKinds:[canonicalKind]},canonicalKind)).toBe(true);
      expect(reference.isKindAllowed({allowedKinds:[]},canonicalKind)).toBe(false);
      expect(reference.isKindAllowed({allowedKinds:"corrupt"},canonicalKind)).toBe(false);
    });
}
for(const grant of [null,[],["fixture"],["other"],"fixture"]){
  const name=JSON.stringify(grant);
  test(`P8-COMBO-${name}`,`Combo ACL canonical name ${name}`,
    [{pin:"vans",path:"src/sse/services/auth.js",symbol:"isComboAllowed",localPath:accessPath,caller:requestPath}],
    ["combo/ prefix versus bare name keeps identical principal decision"],()=>{
      const info={allowedCombos:grant};const expected=grant===null||(Array.isArray(grant)&&grant.includes("fixture"));
      expect(access.isComboAllowed(info,"fixture")).toBe(expected);
      expect(access.isComboAllowed(info,"combo/fixture")).toBe(expected);
      expect(reference.isComboAllowed(info,"fixture")).toBe(expected);
      expect(reference.isComboAllowed(info,"combo/fixture")).toBe(expected);
      expect(requests.checkComboAccess(info,"combo/fixture")?.status??200).toBe(expected?200:403);
    });
}
for(const token of [null,"","0123456789abcdef","0123456789abcdee","0123456789abcdef-extra","0123456789ABCDEF","0123456789abcdef\n","0000000000000000"]){
  test(`P8-TRUST-${JSON.stringify(token)}`,`Internal machine capability exact token ${JSON.stringify(token)}`,
    [{pin:"vans",path:trustPath,symbol:"isTrustedInternalRequest",caller:requestPath}],
    ["No Host/Origin/session/probe-marker alone can grant trusted access", "Exact lowercase sixteen-hex machine-bound token only"],async()=>{
      // Custom Headers-like fixture also covers values HTTP's Headers constructor
      // would trim or reject; no real machine ID is computed.
      const request={headers:{get:k=>k==="x-9r-cli-token"?token:k==="host"?"localhost":k==="x-9r-probe"?"model-test":null}};
      expect(await trust.isTrustedInternalRequest(request)).toBe(token==="0123456789abcdef");
      expect(await reference.isTrustedInternalRequest(request)).toBe(token==="0123456789abcdef");
    });
}
for(const requireApiKey of [true,false])for(const key of [null,"unknown","fixture-denied","fixture-allowed"]){
  test(`P8-AUTH-${requireApiKey}-${key}`,`authenticateRequest require=${requireApiKey} key=${key}`,
    [{pin:"vans",path:"src/sse/handlers/chat.js",symbol:"handleChat",localPath:requestPath,localSymbol:"authenticateRequest",caller:"src/sse/handlers/chat.js"}],
    ["Known optional principal never loses restrictions", "Missing/invalid key rejected only when required; same principal object returned"],async()=>{
      const denied={allowedProviders:[],allowedKinds:null,allowedCombos:null},permitted={allowedProviders:null,allowedKinds:null,allowedCombos:null};
      grants.set("fixture-denied",denied);grants.set("fixture-allowed",permitted);
      const request=new Request("http://127.0.0.1/fixture",{headers:key?{authorization:`Bearer ${key}`}:{host:"localhost"}});
      const r=await requests.authenticateRequest(request,{requireApiKey});
      const known=key==="fixture-denied"||key==="fixture-allowed";
      if(requireApiKey&&!known)expect(r.error.status).toBe(401);
      else{
        expect(r.error).toBeUndefined();
        expect(r.apiKeyInfo).toBe(known?grants.get(key):null);
        if(key==="fixture-denied")expect((await requests.checkTargetAccess(r.apiKeyInfo,"openai","fixture","llm")).status).toBe(403);
      }
    });
}
test("P8-CATALOG-principal-cache","Model availability request cache is principal-scoped and disabled flags are rechecked",
  [{pin:"vans",path:allowedPath,symbol:"isModelAllowed",caller:requestPath}],
  ["Different principal object creates independent catalog", "Disabled model immediately denies even after prior cached success", "Custom prefix resolution uses actual node metadata"],
  async()=>{
    disabled={};const first={},second={};const before=catalogCalls;
    expect(await allowed.isModelAllowed("openai/fixture",first)).toBe(true);
    expect(await allowed.isModelAllowed("openai/fixture",first)).toBe(true);
    expect(catalogCalls-before).toBe(1);
    expect(await allowed.isModelAllowed("openai/fixture",second)).toBe(true);
    expect(catalogCalls-before).toBe(2);
    disabled={openai:["fixture"]};
    expect(await allowed.isModelAllowed("openai/fixture",first)).toBe(false);
    disabled={};
    expect(await allowed.isModelAllowed("openai-compatible-fixture/fixture",first)).toBe(true);
    disabled={"custom-fixture":["fixture"]};
    expect(await allowed.isModelAllowed("openai-compatible-fixture/fixture",first)).toBe(false);
    disabled={};
  });
test("P8-ACL-all-registry-aliases","Every actual local provider id and alias is equivalent under principal grants",
  [{pin:"vans",path:"src/sse/services/auth.js",symbol:"isProviderAllowed",localPath:accessPath,caller:requestPath}],
  ["All registry id/alias permutations enforce allowedProviders without widening empty/corrupt grants"],
  async()=>{
    const registry=(await graphs[0].load("open-sse/providers/registry/index.js")).default;
    for(const p of registry){
      for(const granted of [p.id,p.alias,...(p.aliases||[])].filter(Boolean)){
        for(const target of [p.id,p.alias].filter(Boolean)){
          expect(await access.isProviderAllowed({allowedProviders:[granted]},target),`${granted} permits ${target}`).toBe(true);
          expect(await access.isProviderAllowed({allowedProviders:[]},target)).toBe(false);
        }
      }
    }
  });
