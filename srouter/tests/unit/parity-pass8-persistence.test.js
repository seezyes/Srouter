import { afterAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import initSqlJs from "sql.js";
import { sourceGraph, plain, contractSuite, evidence } from "../helpers/parity-pass8-source.js";

const test=contractSuite("persistence"),graphs=[];
afterAll(()=>{
  fs.writeFileSync(path.join(evidence,"source-hashes-persistence.json"),JSON.stringify(graphs.map(g=>({label:g.label,loaded:Object.fromEntries(g.loaded)})),null,2));
  graphs.forEach(g=>g.dispose());
});
function ownedDir(){
  if(!process.env.DATA_DIR||!fs.existsSync(path.join(process.env.DATA_DIR,"PASS8-OWNED")))throw new Error("Fresh Pass8 DATA_DIR marker required before DB imports");
  return fs.mkdtempSync(path.join(process.env.DATA_DIR,"adapter-"));
}

for(const label of ["nine","vans"]){
  test(`P8A-DB-${label}-bun-surrogate-close-hooks`,`${label} actual Bun source close() removes process listeners (Node-backed surrogate only)`,
    [{pin:label,path:"src/lib/db/adapters/bunSqliteAdapter.js",symbol:"createBunSqliteAdapter",caller:"src/lib/db/driver.js"}],
    ["Actual pinned close lifecycle executes; no native Bun runtime certification","Source-level listener leak can be distinguished from a local-only regression"],async()=>{
      const dir=ownedDir(),{g,a}=await adapter(label,"bun-surrogate",dir);
      try{
        expect(g.process.listenerCount("beforeExit")).toBe(1);
        a.close();
        for(const event of ["beforeExit","SIGINT","SIGTERM"])expect.soft(g.process.listenerCount(event),`${label} leaked ${event}`).toBe(0);
      }finally{a.close();}
    });
}
function scopedFs(dir){
  const check=p=>{const r=path.resolve(String(p));if(r!==dir&&!r.startsWith(dir+path.sep))throw new Error(`DB fixture escaped owned directory: ${r}`);return r;};
  const facade={};
  for(const method of ["existsSync","statSync","readFileSync","writeFileSync","mkdirSync","readdirSync"])facade[method]=(p,...args)=>fs[method](check(p),...args);
  facade.copyFileSync=(a,b)=>fs.copyFileSync(check(a),check(b));
  // No pruning/deletion: these tests never need an actual deletion.
  facade.rmSync=()=>{throw new Error("Pass8 database deletion is forbidden");};
  return facade;
}
// Bun/betterSqlite are source-contract surrogates, NOT native-runtime acceptance.
// Their unchanged adapter source runs against an explicitly labelled real
// node:sqlite backing implementation; native addons cannot safely load on Node24.
class NativeSurrogate{
  constructor(file){this.db=new DatabaseSync(file);}
  exec(sql){return this.db.exec(sql);}
  prepare(sql){return this.db.prepare(sql);}
  pragma(sql){return this.db.exec(`PRAGMA ${sql}`);}
  transaction(fn){return()=>{
    const name=`s${crypto.randomUUID().replaceAll("-","")}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try{const r=fn();this.db.exec(`RELEASE ${name}`);return r;}
    catch(e){this.db.exec(`ROLLBACK TO ${name}`);this.db.exec(`RELEASE ${name}`);throw e;}
  };}
  close(){this.db.close();}
}
const adapters=[
  ["node","nodeSqliteAdapter.js","createNodeSqliteAdapter"],
  ["sqljs","sqljsAdapter.js","createSqlJsAdapter"],
  ["bun-surrogate","bunSqliteAdapter.js","createBunSqliteAdapter"],
  ["better-surrogate","betterSqliteAdapter.js","createBetterSqliteAdapter"],
];
async function adapter(label,kind,dir){
  const desc=adapters.find(x=>x[0]===kind);
  const file=path.join(dir,"data.sqlite");
  const g=sourceGraph(label,{
    "node:fs":{default:scopedFs(dir)},"node:path":{default:path},
    "node:sqlite":{DatabaseSync}, "bun:sqlite":{Database:NativeSurrogate},
    "better-sqlite3":{default:NativeSurrogate}, "sql.js":{default:initSqlJs},
    uuid:{v4:crypto.randomUUID},
    "src/lib/db/version.js":{getAppVersion:()=>"0.16.0",timestampSlug:()=>"fixture"},
  });
  graphs.push(g);
  const m=await g.load(`src/lib/db/adapters/${desc[1]}`);
  const a=await m[desc[2]](file);
  return{g,a,file};
}
for(const [kind,file]of adapters)for(const scenario of ["rows-and-bind","nested-rollback","durable-reopen","close-hooks"]){
  test(`P8-DB-${kind}-${scenario}`,`${kind} adapter ${scenario}`,
    [{pin:"nine",path:`src/lib/db/adapters/${file}`,symbol:"<module-behavior>",caller:"src/lib/db/driver.js"},
      {pin:"vans",path:`src/lib/db/adapters/${file}`,symbol:"<module-behavior>",caller:"src/lib/db/driver.js"}],
    ["Actual unchanged local adapter source; real SQLite backing", "Bun/better-labelled cases do not certify those runtimes", "Binding/injection/nested rollback/persistence/listener cleanup as selected"],
    async()=>{
      const dir=ownedDir();const {g,a}=await adapter("local",kind,dir);
      let closed=false;
      try{
        a.exec("CREATE TABLE fixture(id INTEGER PRIMARY KEY, data TEXT NOT NULL)");
        if(scenario==="close-hooks"){
          expect(g.process.listenerCount("SIGINT")).toBe(1);
          a.close();closed=true;
          for(const event of ["beforeExit","SIGINT","SIGTERM"])expect(g.process.listenerCount(event),`${kind} leaked ${event}`).toBe(0);
          a.close();return;
        }
        const injected="'); DROP TABLE fixture; --";
        const inserted=a.run("INSERT INTO fixture(data) VALUES(?)",[injected]);
        expect(Number(inserted.changes)).toBe(1);
        expect(plain(a.get("SELECT data FROM fixture WHERE id=?",[1]))).toEqual({data:injected});
        if(scenario==="rows-and-bind"){
          expect(a.get("SELECT * FROM fixture WHERE id=?",[999])).toBeUndefined();
          expect(plain(a.all("SELECT id,data FROM fixture ORDER BY id"))).toEqual([{id:1,data:injected}]);
        }
        if(scenario==="nested-rollback"){
          expect(()=>a.transaction(()=>{
            a.run("INSERT INTO fixture(data) VALUES(?)",["outer"]);
            a.transaction(()=>a.run("INSERT INTO fixture(data) VALUES(?)",["inner"]));
            throw new Error("rollback");
          })).toThrow("rollback");
          expect(a.get("SELECT COUNT(*) AS n FROM fixture").n).toBe(1);
          a.transaction(()=>{
            a.run("INSERT INTO fixture(data) VALUES(?)",["survives"]);
            try{a.transaction(()=>{a.run("INSERT INTO fixture(data) VALUES(?)",["gone"]);throw new Error("inner");});}catch{}
          });
          expect(a.all("SELECT data FROM fixture").map(r=>r.data)).toEqual([injected,"survives"]);
        }
        if(scenario==="durable-reopen"){
          a.close();closed=true;
          const reopened=await adapter("local",kind,dir);
          try{expect(reopened.a.get("SELECT data FROM fixture WHERE id=?",[1]).data).toBe(injected);}
          finally{reopened.a.close();reopened.g.dispose();}
        }
      }finally{if(!closed)a.close();g.dispose();}
    });
}
for(const kind of ["node","sqljs"])for(const grant of [null,[],["openai"],"corrupt-json",{wrong:true}]){
  test(`P8-KEYDB-${kind}-${JSON.stringify(grant)}`,`${kind} real DB key principal grant/identity roundtrip ${JSON.stringify(grant)}`,
    [{pin:"vans",path:"src/lib/db/repos/apiKeysRepo.js",symbol:"getApiKeyById"},
      {pin:"vans",path:"src/lib/db/repos/apiKeysRepo.js",symbol:"updateApiKey"},
      {pin:"vans",path:"src/lib/db/schema.js",symbol:"TABLES"}],
    ["Actual repo reads persistent SQL fields and fail-closes corrupt grants", "PATCH cannot replace id/key/machine identity and retains unspecified grants", "Active flag changes boolean validation"],
    async()=>{
      const dir=ownedDir(),{g,a}=await adapter("local",kind,dir);
      try{
        const schema=await g.load("src/lib/db/schema.js");
        a.exec(schema.buildCreateTableSql("apiKeys",schema.TABLES.apiKeys));
        const raw=grant===null?null:typeof grant==="string"?grant:JSON.stringify(grant);
        a.run("INSERT INTO apiKeys(id,key,name,machineId,isActive,createdAt,allowedProviders,allowedCombos,allowedKinds) VALUES(?,?,?,?,?,?,?,?,?)",
          ["fixture-id","sk-fixture","original","0123456789abcdef",1,"2026-10-01",raw,"[]",null]);
        g.mocks["src/lib/db/driver.js"]={getAdapter:async()=>a};
        const keys=await g.load("src/lib/db/repos/apiKeysRepo.js");
        const expected=grant===null?null:Array.isArray(grant)?grant:[];
        expect(plain((await keys.getApiKeyById("fixture-id")).allowedProviders)).toEqual(expected);
        const updated=await keys.updateApiKey("fixture-id",{id:"attacker",key:"attacker-key",machineId:"attacker-machine",name:"renamed",isActive:false});
        expect(updated.id).toBe("fixture-id");expect(updated.key).toBe("sk-fixture");expect(updated.machineId).toBe("0123456789abcdef");
        expect(plain(updated.allowedProviders)).toEqual(expected);
        expect(plain(updated.allowedCombos)).toEqual([]);expect(updated.allowedKinds).toBe(null);
        expect(await keys.validateApiKey("sk-fixture")).toBe(false);
        await expect(keys.updateApiKey("fixture-id",{allowedKinds:["unsupported"]})).rejects.toThrow("unsupported");
        expect(await keys.deleteApiKey("fixture-id")).toBe(true);
        expect(await keys.deleteApiKey("fixture-id")).toBe(false);
      }finally{a.close();g.dispose();}
    });
}
for(const label of ["local","nine","vans"]){
  test(`P8-MIGRATION-${label}-retry`,`${label} aborted legacy import remains retryable on the next initialization`,
    [{pin:label==="local"?"nine":label,path:"src/lib/db/migrate.js",symbol:"runMigrationOnce",caller:"src/lib/db/driver.js"}],
    ["Pinned migration explicitly promises rollback, legacy JSON kept and next boot retry", "Duplicate legacy identity aborts import, correcting legacy file then reopening must import all rows", "Actual migration runner and SQLite, only backup/version/filesystem boundaries scoped"],
    async()=>{
      const dir=ownedDir(),{g,a}=await adapter(label,"node",dir);
      const legacy=path.join(dir,"db.json"),dbDir=dir;
      const record={id:"legacy-a",provider:"openai",authType:"apikey",apiKey:"fixture",name:"legacy",isActive:true};
      fs.writeFileSync(legacy,JSON.stringify({providerConnections:[record,record],apiKeys:[]}));
      g.mocks["src/lib/db/paths.js"]={
        DB_DIR:dbDir,LEGACY_FILES:{main:legacy,usage:path.join(dir,"usage.json"),disabled:path.join(dir,"disabled.json"),details:path.join(dir,"details.json")},
      };
      g.mocks["src/lib/db/driver.js"]={getAdapter:async()=>a,getAdapterSync:()=>a};
      g.mocks["src/lib/db/backup.js"]={
        pruneOldBackups(){},makeBackupDir(){const p=path.join(dir,"backup");fs.mkdirSync(p,{recursive:true});return p;},
        backupFile(src,dest){if(fs.existsSync(src))fs.copyFileSync(src,path.join(dest,path.basename(src)));},
        backupDbLite(){},
      };
      const migrate=await g.load("src/lib/db/migrate.js");
      try{
        await migrate.runMigrationOnce(a);
        expect(a.get("SELECT COUNT(*) AS n FROM providerConnections").n).toBe(0);
        expect(fs.existsSync(path.join(dbDir,".migrated-from-json"))).toBe(false);
        fs.writeFileSync(legacy,JSON.stringify({providerConnections:[record],apiKeys:[]}));
        // New adapter represents a subsequent normal initialization, not a
        // manual delete of SQLite or metadata which would hide the defect.
        a.close();
        const reopened=await adapter(label,"node",dir);
        // New graph intentionally creates a new module WeakSet as a real boot does.
        reopened.g.mocks["src/lib/db/paths.js"]=g.mocks["src/lib/db/paths.js"];
        reopened.g.mocks["src/lib/db/backup.js"]=g.mocks["src/lib/db/backup.js"];
        reopened.g.mocks["src/lib/db/driver.js"]={getAdapter:async()=>reopened.a,getAdapterSync:()=>reopened.a};
        try{
          const next=await reopened.g.load("src/lib/db/migrate.js");
          await next.runMigrationOnce(reopened.a);
          expect(reopened.a.get("SELECT COUNT(*) AS n FROM providerConnections").n).toBe(1);
        }finally{reopened.a.close();reopened.g.dispose();}
      }finally{try{a.close();}catch{}g.dispose();}
    });
}
