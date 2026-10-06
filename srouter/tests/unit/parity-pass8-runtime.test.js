import { afterAll, expect } from "vitest";
import { sourceGraph, plain, contractSuite } from "../helpers/parity-pass8-source.js";

const test = contractSuite("runtime");
const graphs=[];
afterAll(()=>graphs.forEach(g=>g.dispose()));
const load = async (label,p,overrides={},options={}) => { const g=sourceGraph(label,overrides,options); graphs.push(g); return {g,m:await g.load(p)}; };
const semaphore="open-sse/services/accountSemaphore.js";
for(const pin of ["vans"]) {
  for(const scenario of ["fifo","abort","timeout","blocked-wakeup","queue-cap","key-scopes","bypass"]) {
    test(`P8-SEM-${pin}-${scenario}`,`${pin} semaphore ${scenario} concurrency/cleanup`,
      [{pin,path:semaphore,symbol:scenario==="key-scopes"?"buildAccountSemaphoreKey":"acquire",caller:"open-sse/handlers/chatCore.js"}],
      ["Actual source concurrency state machine; FIFO/idempotent release/cancellation/timeout", "No external resources and all timers cleared in finally"],async()=>{
        const run=async label=>{
          const {g,m}=await load(label,semaphore,{}, {realClock:true});
          const key=m.buildAccountSemaphoreKey({provider:"fixture",accountKey:"account-a",proxyHash:"proxy-a"});
          let release, r2, r3;
          try{
            if(scenario==="key-scopes") return [
              key,m.buildAccountSemaphoreKey({provider:"fixture",accountKey:"account-b",proxyHash:"proxy-a"}),
              m.buildAccountSemaphoreKey({provider:"fixture",accountKey:"account-a",proxyHash:"proxy-b"}),
              m.resolveAccountSemaphoreMaxConcurrency({providerSpecificData:{maxConcurrency:0}}),
              m.resolveAccountSemaphoreMaxConcurrency({}),
            ];
            if(scenario==="bypass"){ release=await m.acquire(key,{maxConcurrency:0}); release(); return m.getAccountSemaphoreStats(); }
            release=await m.acquire(key,{maxConcurrency:1});
            if(scenario==="queue-cap"){
              const pending=m.acquire(key,{maxConcurrency:1,maxQueueSize:1,timeoutMs:1000});
              const rejected=await m.acquire(key,{maxConcurrency:1,maxQueueSize:1}).catch(e=>e);
              expect(m.isSemaphoreCapacityError(rejected)).toBe(true);
              release();r2=await pending;r2();return "capacity";
            }
            if(scenario==="abort"){
              const c=new AbortController(),reason=new Error("fixture abort");
              const pending=m.acquire(key,{maxConcurrency:1,signal:c.signal,timeoutMs:1000});
              c.abort(reason);
              expect(await pending.catch(e=>e)).toBe(reason);
              expect(m.getAccountSemaphoreStats()[0].queued).toBe(0);
              return "abort";
            }
            if(scenario==="timeout"){
              const error=await m.acquire(key,{maxConcurrency:1,timeoutMs:15}).catch(e=>e);
              expect(m.isSemaphoreCapacityError(error)).toBe(true);
              expect(m.getAccountSemaphoreStats()[0].queued).toBe(0);return "timeout";
            }
            const order=[];
            const second=m.acquire(key,{maxConcurrency:1,timeoutMs:1000}).then(r=>{order.push(2);return r;});
            if(scenario==="blocked-wakeup")m.markBlocked(key,20);
            const third=m.acquire(key,{maxConcurrency:1,timeoutMs:1000}).then(r=>{order.push(3);return r;});
            release();release();r2=await second;expect(order).toEqual([2]);r2();r2();r3=await third;r3();
            expect(order).toEqual([2,3]);return order;
          }finally{ release?.();r2?.();r3?.();g.dispose(); }
        };
        expect(plain(await run("local"))).toEqual(plain(await run(pin)));
      });
  }
}
const base="open-sse/executors/base.js";
for(const pin of ["nine","vans"])for(const status of [200,401,403,429,500,502,503,504]){
  test(`P8-RETRY-${pin}-${status}`,`${pin} BaseExecutor status ${status} retry and proxy propagation`,
    [{pin,path:base,symbol:"BaseExecutor.execute",caller:"open-sse/handlers/chatCore.js"}],
    ["Actual BaseExecutor same-account retry/fallback emitted URLs and response status", "Retries deterministic with zero-delay configured budget; credentials/proxy preserved"],async()=>{
      async function run(label){
        const calls=[];
        const fetch=async(url,init,proxy)=>{calls.push({url,auth:init.headers.Authorization,proxy});return new Response("fixture",{status:calls.length===1?status:200});};
        const {g,m}=await load(label,base,{"open-sse/services/oauthCredentialManager.js":{shouldRefreshCredentials:()=>false}},{fetch});
        const ex=new m.BaseExecutor("fixture",{baseUrls:["https://a.invalid","https://b.invalid"],timeoutMs:100,retry:Object.fromEntries([429,500,502,503,504].map(s=>[s,{attempts:1,delayMs:0}]))});
        try{
          const r=await ex.execute({model:"fixture",body:{messages:[]},stream:false,credentials:{accessToken:"fixture"},proxyOptions:{strictProxy:true},accountCount:1});
          await r.response.body.cancel();
          return{calls,status:r.response.status};
        }finally{g.dispose();}
      }
      expect(plain(await run("local"))).toEqual(plain(await run(pin)));
    });
}
test("P8-CANCEL-dispatch","Cancelled client signal reaches the actual transport boundary unchanged",
  [{pin:"nine",path:base,symbol:"BaseExecutor.execute"},{pin:"vans",path:base,symbol:"BaseExecutor.execute"}],
  ["Signal propagation and abort error preservation are compared to both pins",
    "This does NOT prove no fetch invocation: the mock transport explicitly rejects an aborted signal"],async()=>{
    const run=async label=>{
      let attempts=0;
      const c=new AbortController();c.abort(new DOMException("fixture abort","AbortError"));
      const {g,m}=await load(label,base,{"open-sse/services/oauthCredentialManager.js":{shouldRefreshCredentials:()=>false}},{fetch:async(_url,init)=>{
        attempts++;expect(init.signal.aborted).toBe(true);throw init.signal.reason;
      }});
      try{
        const ex=new m.BaseExecutor("fixture",{baseUrl:"https://fixture.invalid",retry:{502:0}});
        await expect(ex.execute({model:"fixture",body:{},stream:false,credentials:{},signal:c.signal})).rejects.toThrow("fixture abort");
        return attempts;
      }finally{g.dispose();}
    };
    const actual=await run("local");
    expect(actual).toBe(await run("nine"));expect(actual).toBe(await run("vans"));
  });
