import { afterAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sourceGraph, contractSuite, evidence } from "../helpers/parity-pass8-source.js";
const test=contractSuite("network"),graphs=[];
afterAll(()=>{
  fs.writeFileSync(path.join(evidence,"source-hashes-network.json"),JSON.stringify(graphs.map(g=>({label:g.label,loaded:Object.fromEntries(g.loaded)})),null,2));
  graphs.forEach(g=>g.dispose());
});
const p="src/shared/utils/ssrfGuard.js";
async function guard(label,addresses=[],fetch=async()=>new Response("fixture")){
  const lookup=async()=>addresses;
  const dns={promises:{lookup}};
  const g=sourceGraph(label,{
    "node:dns":{default:dns},"node:dns/promises":{default:{lookup}},
    undici:{Agent:class{constructor(options){this.options=options;}async close(){}},fetch},
  },{fetch});graphs.push(g);return await g.load(p);
}
const blocked=[
  "127.0.0.1","127.1","2130706433","0x7f000001","0177.0.0.1",
  "0.0.0.0","10.1.2.3","172.16.0.1","172.31.255.255","192.168.0.1",
  "169.254.169.254","100.64.0.1","100.127.255.255","localhost","localhost.",
  "host.local","host.localhost","host.internal","[::1]","[::]","[fc00::1]",
  "[fe80::1]","[::ffff:127.0.0.1]","[::ffff:7f00:1]","[64:ff9b::7f00:1]","[::127.0.0.1]",
];
for(const pin of ["nine"])for(const host of blocked){
  test(`P8-SSRF-${pin}-${host}`,`${pin} literal private-target boundary ${host}`,
    [{pin,path:p,symbol:"assertPublicUrl",caller:"open-sse/handlers/search/callers.js"}],
    ["Actual pinned/local IP canonicalization contract; internal literals and disguised IPv4 forms denied"],
    async()=>{const local=await guard("local"),ref=await guard(pin);const url=`http://${host}/fixture`;
      expect(()=>ref.assertPublicUrl(url)).toThrow();expect(()=>local.assertPublicUrl(url)).toThrow();
    });
}
for(const pin of ["nine","vans"])for(const addresses of [
  [{address:"8.8.8.8",family:4}],
  [{address:"8.8.8.8",family:4},{address:"10.0.0.2",family:4}],
  [{address:"2001:4860:4860::8888",family:6}],
  [{address:"::ffff:7f00:1",family:6}],
]){
  test(`P8-DNS-${pin}-${addresses.map(a=>a.address).join("-")}`,`${pin} DNS multi-address trust decision`,
    [{pin,path:p,symbol:pin==="vans"?"assertPublicUrl":"assertPublicUrlResolved",localSymbol:"assertPublicUrlResolved",caller:"src/app/api/cli-tools/cowork-mcp-tools/route.js"}],
    ["Deterministic DNS fixture, any private answer denies even mixed with public", "No actual DNS lookup"],
    async()=>{
      const local=await guard("local",addresses),ref=await guard(pin,addresses);
      const outcome=async(m,symbol)=>{try{await m[symbol]("https://fixture.invalid");return "allowed";}catch{return "blocked";}};
      expect(await outcome(local,"assertPublicUrlResolved")).toBe(await outcome(ref,pin==="vans"?"assertPublicUrl":"assertPublicUrlResolved"));
    });
}
for(const pin of ["nine"])for(const scenario of ["private-redirect","relative-public","cycle-limit","abort"]){
  test(`P8-REDIRECT-${pin}-${scenario}`,`${pin} redirect/abort boundary ${scenario}`,
    [{pin,path:p,symbol:"fetchPublic",caller:"src/app/api/cli-tools/cowork-mcp-tools/route.js"}],
    ["Manual redirect on every actual fetch, destination revalidation, bounded hops", "AbortSignal retained and private destination never dispatched"],
    async()=>{
      const run=async label=>{
        const calls=[],c=new AbortController();
        const fetch=async(url,init)=>{
          calls.push({url:String(url),redirect:init.redirect,signalRetained:init.signal===c.signal});
          if(scenario==="abort"){c.abort(new DOMException("fixture abort","AbortError"));throw c.signal.reason;}
          if(scenario==="private-redirect")return new Response(null,{status:307,headers:{location:"http://127.0.0.1/private"}});
          if(scenario==="cycle-limit")return new Response(null,{status:302,headers:{location:"/cycle"}});
          return calls.length===1?new Response(null,{status:308,headers:{location:"/next"}}):new Response("fixture");
        };
        const m=await guard(label,[{address:"8.8.8.8",family:4}],fetch);
        let status,error;
        try{const r=await m.fetchPublic("https://fixture.invalid/start",{method:"POST",body:"fixture",signal:c.signal},{maxRedirects:2});status=r.status;await r.body?.cancel();}
        catch(e){error=e.message;}
        expect(calls.every(x=>x.redirect==="manual"&&x.signalRetained)).toBe(true);
        if(scenario==="private-redirect")expect(calls).toHaveLength(1);
        return{calls,status,error};
      };
      expect(await run("local")).toEqual(await run(pin));
    });
}
for(const url of ["https://user:password@fixture.invalid/path","ftp://fixture.invalid/path","http://224.0.0.1/","http://240.0.0.1/"]){
  test(`P8-VANS-DENY-${url}`,`Vans unsupported/reserved target rejected before fetch: ${url}`,
    [{pin:"vans",path:p,symbol:"assertPublicUrl",localSymbol:"assertPublicUrlResolved",caller:"src/app/api/cli-tools/cowork-mcp-tools/route.js"}],
    ["Pinned explicit HTTP(S)-only/no-userinfo/multicast/reserved boundary; local equivalent must reject too"],
    async()=>{
      const ref=await guard("vans",[{address:"8.8.8.8",family:4}]),local=await guard("local",[{address:"8.8.8.8",family:4}]);
      await expect(ref.assertPublicUrl(url)).rejects.toThrow("Blocked URL");
      await expect(local.assertPublicUrlResolved(url)).rejects.toThrow("Blocked URL");
    });
}
test("P8-VANS-DNS-PIN","Validated DNS address is pinned to transport to prevent rebinding",
  [{pin:"vans",path:p,symbol:"guardedFetch",localSymbol:"fetchPublic",caller:"src/app/api/cli-tools/cowork-mcp-tools/route.js"}],
  ["Execute actual source guard with explicit DNS and transport spies", "Transport uses prevalidated public address, not a second attacker-controlled lookup", "Pinned Agent is closed after response; no real DNS/socket"],
  async()=>{
    const run=async label=>{
      let queries=0,connected=null,closed=0;
      const lookup=async()=>[++queries===1?{address:"8.8.8.8",family:4}:{address:"127.0.0.1",family:4}];
      const fetch=async(_url,init)=>{
        if(init.dispatcher?.options?.connect?.lookup){
          connected=await new Promise((resolve,reject)=>init.dispatcher.options.connect.lookup("fixture.invalid",{},(err,address)=>err?reject(err):resolve(address)));
        }else connected=(await lookup())[0].address;
        return new Response("fixture");
      };
      const g=sourceGraph(label,{
        "node:dns":{default:{promises:{lookup}}},"node:dns/promises":{default:{lookup}},
        undici:{Agent:class{constructor(options){this.options=options;}async close(){closed++;}},fetch},
      },{fetch});graphs.push(g);
      const m=await g.load(p);
      const r=await(label==="vans"?m.guardedFetch("https://fixture.invalid/start"):m.fetchPublic("https://fixture.invalid/start"));
      await r.body.cancel();
      return{connected,closed};
    };
    const expected=await run("vans");expect(expected).toEqual({connected:"8.8.8.8",closed:1});
    expect((await run("local")).connected).toBe(expected.connected);
  });

for(const [scenario,url]of [
  ["public","https://fixture.invalid"],
  ["private","http://127.0.0.1"],
  ["rebinding","https://fixture.invalid"],
  ["ftp","ftp://fixture.invalid"],
  ["multicast","http://224.0.0.1"],
  ["reserved","http://240.0.0.1"],
  ["userinfo","https://user:fixture@fixture.invalid"],
]){
  test(`P8-SEARCH-EGRESS-${scenario}`,`Actual search dispatcher→request builder→guard→transport ${scenario}`,
    [{pin:"vans",path:"open-sse/handlers/search/index.js",symbol:"handleSearchCore",caller:"src/sse/handlers/search.js"},
      {pin:"vans",path:"open-sse/handlers/search/callers.js",symbol:"resolveBaseUrl"},
      {pin:"vans",path:p,symbol:"guardedFetch",localSymbol:"fetchPublic"}],
    ["Real Serper registration and request builder use untrusted provider_options.baseUrl",
      "No guard/request builder mock: caller rejection or public address pin survives to transport"],
    async()=>{
      const run=async label=>{
        let calls=0,connected=null;
        const lookup=async()=>[{address:"8.8.8.8",family:4}];
        const fetch=async(_url,init)=>{
          calls++;
          if(init.dispatcher?.options?.connect?.lookup){
            connected=await new Promise((resolve,reject)=>init.dispatcher.options.connect.lookup("fixture.invalid",{},(err,address)=>err?reject(err):resolve(address)));
          }else connected=scenario==="rebinding"?"127.0.0.1":"8.8.8.8";
          return new Response(JSON.stringify({organic:[]}),{status:200,headers:{"content-type":"application/json"}});
        };
        const g=sourceGraph(label,{
          "node:dns":{default:{promises:{lookup}}},"node:dns/promises":{default:{lookup}},
          undici:{Agent:class{constructor(options){this.options=options;}async close(){}},fetch},
          "open-sse/handlers/search/chatSearch.js":{handleChatSearch(){throw new Error("Chat-only branch not covered by dedicated search");}},
        },{fetch});graphs.push(g);
        const provider=(await g.load("open-sse/providers/registry/serper.js")).default;
        const core=await g.load("open-sse/handlers/search/index.js");
        const result=await core.handleSearchCore({
          body:{query:"fixture query",provider_options:{baseUrl:url}},
          provider,providerConfig:provider.searchConfig,credentials:{apiKey:"fixture-key"},
        });
        await result.response?.body?.cancel();
        return{success:result.success,calls,connected};
      };
      const expected=await run("vans");
      if(["public","rebinding"].includes(scenario))expect(expected).toEqual({success:true,calls:1,connected:"8.8.8.8"});
      else expect(expected.calls).toBe(0);
      expect(await run("local")).toEqual(expected);
    });
}
