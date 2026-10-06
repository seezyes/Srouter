import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";
import { expect } from "vitest";
import { repo } from "./parity-pass8-assertion-source.js";
const require=createRequire(path.join(repo,"package.json"));
const initSqlJs=require("sql.js/dist/sql-asm.js");
export async function sqliteMemory(){
  const SQL=await initSqlJs(),db=new SQL.Database(),calls=[];
  db.run("CREATE TABLE providerConnections(id TEXT PRIMARY KEY,provider TEXT,authType TEXT,name TEXT,email TEXT,priority INTEGER,isActive INTEGER,data TEXT,createdAt TEXT,updatedAt TEXT)");
  const rows=(sql,args=[])=>{
    calls.push({sql,args});const stmt=db.prepare(sql);try{stmt.bind(args);const out=[];while(stmt.step())out.push(stmt.getAsObject());return out;}finally{stmt.free();}
  };
  const adapter={
    run(sql,args=[]){calls.push({sql,args});db.run(sql,args);},
    all:rows,get:(sql,args)=>rows(sql,args)[0]||null,
    transaction(fn){db.run("BEGIN");try{const r=fn();db.run("COMMIT");return r;}catch(error){db.run("ROLLBACK");throw error;}},
  };
  return{adapter,calls,close:()=>db.close()};
}
export async function getRegistered(g,provider){
  const own=new Set([`${provider==="qoder-cn"?"qoder":provider}.js`,"default.js","base.js"]);
  const source=fs.readFileSync(path.join(g.root,"open-sse/executors/index.js"),"utf8");
  const Forbidden=class {execute(){throw new Error("Assertion chunk forbids unowned provider execution");}};
  for(const m of source.matchAll(/^import\s+(.+?)\s+from\s+"\.\/([^"]+)";/gm)){
    if(own.has(m[2]))continue;
    const exports={};
    if(m[1].startsWith("{"))for(const n of m[1].replace(/[{}]/g,"").split(",").map(s=>s.trim()).filter(Boolean))exports[n]=Forbidden;
    else exports.default=Forbidden;
    g.mocks["open-sse/executors/"+m[2]]=exports;
  }
  for(const m of source.matchAll(/^export\s+\{([^}]+)\}\s+from\s+"\.\/([^"]+)";/gm)){
    if(own.has(m[2]))continue;
    const exports=g.mocks["open-sse/executors/"+m[2]]||{};
    for(const entry of m[1].split(",")){const n=entry.trim().split(/\s+as\s+/)[0];if(n)exports[n]||=Forbidden;}
    g.mocks["open-sse/executors/"+m[2]]=exports;
  }
  const dispatch=await g.load("open-sse/executors/index.js"),ex=dispatch.getExecutor(provider);
  expect(ex,"Actual provider dispatcher must return a usable owned instance").toBeDefined();
  expect(dispatch.getExecutor(provider)).toBe(ex);
  expect(ex).not.toBeInstanceOf(Forbidden);
  return{ex,dispatch};
}
export function decodeEvents(text){
  return text.split(/\r?\n\r?\n/).filter(Boolean).map(block=>{
    const lines=block.split(/\r?\n/),data=lines.filter(l=>l.startsWith("data:")).map(l=>l.slice(5).trim()).join("\n");
    return{event:lines.find(l=>l.startsWith("event:"))?.slice(6).trim(),data:data==="[DONE]"?"[DONE]":JSON.parse(data)};
  });
}
export function usageStorage(){
  const calls=[];
  return{calls,exports:{trackPendingRequest:(...args)=>calls.push({operation:"trackPendingRequest",args}),
    appendRequestLog:async(...args)=>calls.push({operation:"appendRequestLog",args}),
    saveRequestDetail:async(...args)=>calls.push({operation:"saveRequestDetail",args}),
    saveRequestUsage:async(...args)=>calls.push({operation:"saveRequestUsage",args}),
    saveUsageHistory:async(...args)=>calls.push({operation:"saveUsageHistory",args}),
    getPricing:async()=>({})}};
}
export function validMediaFixtures(){
  const crc32=bytes=>{
    let value=0xffffffff;
    for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}
    return(value^0xffffffff)>>>0;
  };
  const chunk=(name,bytes)=>{
    const tag=Buffer.from(name),size=Buffer.alloc(4),checksum=Buffer.alloc(4);size.writeUInt32BE(bytes.length);checksum.writeUInt32BE(crc32(Buffer.concat([tag,bytes])));
    return Buffer.concat([size,tag,bytes,checksum]);
  };
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1,0);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6;
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",ihdr),chunk("IDAT",deflateSync(Buffer.from([0,255,255,255,255]))),chunk("IEND",Buffer.alloc(0))]);
  const objects=["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>","<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] >>"];
  let pdf="%PDF-1.4\n";const offsets=[];
  objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${object}\nendobj\n`;});
  const xref=Buffer.byteLength(pdf);
  pdf+=`xref\n0 4\n0000000000 65535 f \n${offsets.map(n=>String(n).padStart(10,"0")+" 00000 n \n").join("")}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return{png:png.toString("base64"),pdf:Buffer.from(pdf).toString("base64"),pdfOffsets:offsets,pdfXref:xref};
}
