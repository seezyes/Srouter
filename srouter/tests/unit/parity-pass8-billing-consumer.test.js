import { afterAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { sourceGraph, plain, contractSuite, evidence } from "../helpers/parity-pass8-source.js";
const test=contractSuite("billing-consumer"),graphs=[],outcomes=[];
afterAll(()=>{
  fs.writeFileSync(path.join(evidence,"source-hashes-billing-consumer.json"),JSON.stringify(graphs.map(g=>({label:g.label,loaded:Object.fromEntries(g.loaded)})),null,2));
  fs.writeFileSync(path.join(evidence,"billing-consumer-results.json"),JSON.stringify(outcomes,null,2));
  graphs.forEach(g=>g.dispose());
});
for(const label of ["local","nine","vans"])for(const scenario of ["plain","cache-reasoning","zero-cache-override"]){
  test(`P8A-BILLING-${label}-${scenario}`,`${label} pricing override → actual usage writer → history/daily SQLite cost: ${scenario}`,
    [{pin:label==="local"?"vans":label,path:"src/lib/db/repos/usageRepo.js",symbol:"saveRequestUsage",caller:"open-sse/handlers/chatCore/requestDetail.js"},
      {pin:label==="local"?"vans":label,path:"src/lib/db/repos/pricingRepo.js",symbol:"updatePricing"}],
    ["Real override KV, actual billing consumer and history/daily writes; isolated real SQLite","Independent formula validates configured rates, not vendor current billing authority"],async()=>{
      if(!process.env.DATA_DIR||!fs.existsSync(path.join(process.env.DATA_DIR,"PASS8-OWNED")))throw new Error("Owned isolated DATA_DIR required");
      const dir=fs.mkdtempSync(path.join(process.env.DATA_DIR,"billing-")),db=new DatabaseSync(path.join(dir,"fixture.sqlite"));
      db.exec("CREATE TABLE kv(scope TEXT,key TEXT,value TEXT,PRIMARY KEY(scope,key));CREATE TABLE _meta(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE usageHistory(id INTEGER PRIMARY KEY,timestamp TEXT,provider TEXT,model TEXT,connectionId TEXT,apiKey TEXT,endpoint TEXT,promptTokens INTEGER,completionTokens INTEGER,cost REAL,status TEXT,tokens TEXT,meta TEXT);CREATE TABLE usageDaily(dateKey TEXT PRIMARY KEY,data TEXT)");
      const adapter={get:(sql,args=[])=>db.prepare(sql).get(...args),all:(sql,args=[])=>db.prepare(sql).all(...args),
        run:(sql,args=[])=>db.prepare(sql).run(...args),transaction:fn=>{db.exec("BEGIN");try{const r=fn();db.exec("COMMIT");return r;}catch(e){db.exec("ROLLBACK");throw e;}}};
      const g=sourceGraph(label,{events:{EventEmitter},"src/lib/db/driver.js":{getAdapter:async()=>adapter}});graphs.push(g);
      try{
        const pricing=await g.load("src/lib/db/repos/pricingRepo.js"),usage=await g.load("src/lib/db/repos/usageRepo.js");
        const rates={input:1,output:2,cached:scenario==="zero-cache-override"?0:0.1,reasoning:2,cache_creation:1.2};
        await pricing.updatePricing({openai:{"fixture-billed-model":rates}});
        expect(plain(await pricing.getPricingForModel("openai","fixture-billed-model"))).toEqual(rates);
        const tokens={prompt_tokens:1000,completion_tokens:200,...(scenario==="plain"?{}:{cached_tokens:300,cache_creation_input_tokens:100,reasoning_tokens:20})};
        const expected=((1000-(tokens.cached_tokens||0)-(tokens.cache_creation_input_tokens||0))*rates.input+
          (tokens.cached_tokens||0)*rates.cached+200*rates.output+(tokens.reasoning_tokens||0)*rates.reasoning+(tokens.cache_creation_input_tokens||0)*rates.cache_creation)/1000000;
        await usage.saveRequestUsage({provider:"openai",model:"fixture-billed-model",tokens,timestamp:"2026-10-01T00:00:00Z",endpoint:"Chat Completions"});
        const history=await usage.getUsageHistory(),day=JSON.parse(db.prepare("SELECT data FROM usageDaily").get()?.data||"null");
        outcomes.push({label,scenario,expected,history,day});
        expect(history).toHaveLength(1);
        expect.soft(history[0].cost).toBeCloseTo(expected,12);
        expect.soft(day.cost).toBeCloseTo(expected,12);
        expect.soft(day.byProvider.openai.cost).toBeCloseTo(expected,12);
        expect(day.requests).toBe(1);expect(history[0].tokens).toEqual(tokens);
      }finally{db.close();}
    });
}
