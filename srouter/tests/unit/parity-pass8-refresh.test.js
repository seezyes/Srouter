import { afterAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sourceGraph, plain, contractSuite, evidence } from "../helpers/parity-pass8-source.js";

const test=contractSuite("refresh"),graphs=[];
afterAll(()=>{
  fs.writeFileSync(path.join(evidence,"source-hashes-refresh.json"),JSON.stringify(graphs.map(g=>({label:g.label,loaded:Object.fromEntries(g.loaded)})),null,2));
  graphs.forEach(g=>g.dispose());
});
const p="open-sse/executors/default.js";
const providers=["claude","codex","iflow","gemini","kiro","cline","clinepass","kimi","kimi-coding","kilocode","openai"];
const scenarios=["success","retained-refresh","expired","server-error","malformed-json","transport-error","missing-refresh"];
for(const pin of ["nine","vans"])for(const provider of providers)for(const scenario of scenarios){
  test(`P8-REFRESH-${pin}-${provider}-${scenario}`,`${pin} default ${provider} OAuth refresh ${scenario}`,
    [{pin,path:p,symbol:"DefaultExecutor.refreshCredentials",caller:"open-sse/handlers/chatCore.js"}],
    ["Actual default refresh dispatch and JSON/form wire grant; no OAuth/user credentials or network",
      "Proxy propagation, response expiry/refresh-token retention, malformed/transport errors fail closed"],
    async()=>{
      const run=async label=>{
        const calls=[],proxy={strictProxy:true,proxyUrl:"http://fixture-proxy.invalid:9090"};
        const fetch=async(url,init,options)=>{
          calls.push({url,method:init.method,headers:init.headers,body:String(init.body),proxy:options});
          if(scenario==="transport-error")throw new Error("fixture transport unavailable");
          if(scenario==="malformed-json")return new Response("{invalid",{status:200});
          const payload={
            access_token:"fixture-fresh-access",accessToken:"fixture-fresh-access",expires_in:600,expiresIn:600,
            expiresAt:"2026-10-01T00:10:00.000Z",
            ...(scenario==="retained-refresh"?{}:{refresh_token:"fixture-fresh-refresh",refreshToken:"fixture-fresh-refresh"}),
          };
          return new Response(JSON.stringify(payload),{status:scenario==="expired"?401:scenario==="server-error"?500:200});
        };
        const g=sourceGraph(label,{}, {fetch});graphs.push(g);
        const {DefaultExecutor}=await g.load(p),ex=new DefaultExecutor(provider);
        const credentials={accessToken:"fixture-stale-access",
          ...(scenario==="missing-refresh"?{}:{refreshToken:"fixture-retained-refresh"}),
          providerSpecificData:{deviceId:"fixture-device"}};
        const result=await ex.refreshCredentials(credentials,{info(){},error(){}},proxy);
        if(scenario==="missing-refresh"){expect(calls).toHaveLength(0);expect(result).toBeNull();}
        for(const call of calls){expect(call.method).toBe("POST");expect(call.proxy).toEqual(proxy);}
        if(["expired","server-error","malformed-json","transport-error"].includes(scenario))expect(result).toBeNull();
        return plain({result,calls});
      };
      const actual=await run("local"),expected=await run(pin);
      if(provider==="kimi"||provider==="kimi-coding"){
        for(const call of actual.calls){
          expect(call.headers["X-Msh-Platform"]).toBe("srouter");
          expect(call.headers["X-Msh-Version"]).toBe("0.16.0");
        }
        // ONLY these two known product identity fields are substituted.
        for(const result of [actual,expected])for(const call of result.calls){
          delete call.headers["X-Msh-Platform"];delete call.headers["X-Msh-Version"];
        }
      }
      expect(actual).toEqual(expected);
    },30000);
}
