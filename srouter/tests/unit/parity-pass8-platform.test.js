import { expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import * as confbox from "confbox";
import { repo, contractSuite } from "../helpers/parity-pass8-source.js";

const test=contractSuite("platform"),p="cli/src/cli/commands/connectTools.js";
function fixture(){
  if(!fs.existsSync(path.join(process.env.DATA_DIR||"","PASS8-OWNED")))throw new Error("Owned isolation missing");
  const home=fs.mkdtempSync(path.join(process.env.DATA_DIR,"cli-"));
  const chmod=[];
  const check=p=>{const r=path.resolve(p);if(r!==home&&!r.startsWith(home+path.sep))throw new Error("Config write/read escaped owned HOME");return r;};
  const io={};
  for(const method of ["readFileSync","writeFileSync","mkdirSync","existsSync"])io[method]=(p,...args)=>fs[method](check(p),...args);
  io.lstatSync=p=>{
    // Actual writer scans parent links. Metadata only; no foreign contents.
    const r=path.resolve(p);
    if(r!==home&&!r.startsWith(home+path.sep)&&!home.startsWith(r.endsWith(path.sep)?r:r+path.sep))throw new Error("Metadata escaped HOME ancestor chain");
    return fs.lstatSync(r);
  };
  io.copyFileSync=(a,b)=>fs.copyFileSync(check(a),check(b));
  io.chmodSync=(p,mode)=>{chmod.push({path:check(p),mode});fs.chmodSync(p,mode);};
  const cjsModule={exports:{}},context=vm.createContext({
    module:cjsModule,exports:cjsModule.exports,console,process:{env:{HOME:home,USERPROFILE:home}},
    require:name=>{
      if(name==="fs")return io;
      if(name==="path")return path;
      if(name==="os")return{homedir:()=>home};
      throw new Error(`Blocked CJS dependency ${name}`);
    },
  });
  const script=new vm.Script(fs.readFileSync(path.join(repo,p),"utf8"),{
    filename:path.join(repo,p),
    importModuleDynamically:async name=>{
      if(name!=="confbox")throw new Error(`Blocked dynamic dependency ${name}`);
      const m=new vm.SyntheticModule(Object.keys(confbox),function(){for(const [k,v]of Object.entries(confbox))this.setExport(k,v);},{context});
      await m.link(()=>{throw new Error("Unexpected confbox dependency");});await m.evaluate();return m;
    },
  });
  script.runInContext(context);
  return{home,tools:cjsModule.exports,chmod};
}
const context={baseUrl:"https://fixture.invalid",apiKey:"fixture-secret-not-real",model:"openai/fixture",claudeModels:{}};
const anchors=[{pin:"nine",path:p,symbol:"<module-behavior>",localSymbol:"tool",caller:"cli/src/cli/commands/connect.js"}];
function read(file){const text=fs.readFileSync(file,"utf8");return file.endsWith(".toml")?confbox.parseTOML(text):confbox.parseJSONC(text);}
function write(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,file.endsWith(".toml")?confbox.stringifyTOML(value):JSON.stringify(value));}
for(const id of ["claude","codex","opencode","droid","crush","kilo","cline"]){
  test(`P8-CONNECT-${id}-roundtrip`,`${id} owned apply/reset preserves foreign unrelated settings`,
    anchors,["Real CJS config writer with only owned FS/HOME boundary", "Native tool endpoint/key/model fields created then original document restored", "Before-images/sidecars record all managed fields and writes request mode0600"],async()=>{
      const {tools,chmod}=fixture(),tool=tools.resolveTools([id])[0],files=tool.paths();
      for(const file of files)write(file,{pass8Foreign:{theme:"preserve",nested:{enabled:true}}});
      const before=files.map(read);
      await tool.preflight(context);const touched=await tool.apply(context);expect([...touched]).toEqual([...files]);
      expect(files.map(file=>fs.readFileSync(file,"utf8")).join("\n")).toContain("fixture-secret-not-real");
      for(const file of files){
        expect(read(file).pass8Foreign).toEqual({theme:"preserve",nested:{enabled:true}});
        const record=read(`${file}.srouter-connect.json`);expect(record.tool).toBe(id);expect(record.fields.length).toBeGreaterThan(0);
      }
      expect(chmod.every(entry=>entry.mode===0o600)).toBe(true);
      await tool.reset();
      files.forEach((file,i)=>expect(read(file)).toEqual(before[i]));
    });
  for(const invalid of ["null","[]","123","{broken","{\"x\":"]){
    test(`P8-CONNECT-${id}-invalid-${invalid}`,`${id} invalid config refuses before any write: ${invalid}`,
      anchors,["Malformed, scalar/array and truncated documents do not become empty config", "All-file preflight prevents Cline first-document write if second is corrupt"],
      async()=>{
        const {tools}=fixture(),tool=tools.resolveTools([id])[0],files=tool.paths();
        for(const file of files)write(file,{pass8Foreign:"preserved"});
        const bad=files.at(-1);fs.writeFileSync(bad,invalid);
        const before=files.map(file=>fs.readFileSync(file,"utf8"));
        await expect(tool.apply(context)).rejects.toThrow();
        files.forEach((file,i)=>expect(fs.readFileSync(file,"utf8")).toBe(before[i]));
        files.forEach(file=>expect(fs.existsSync(`${file}.srouter-connect.json`)).toBe(false));
      });
  }
  test(`P8-CONNECT-${id}-changed-owner`,`${id} edited managed field refuses reset and reapply`,
    anchors,["User changes after ownership snapshot cannot be overwritten", "Sidecar field membership, prior/after values and complete document preflight are checked"],async()=>{
      const {tools}=fixture(),tool=tools.resolveTools([id])[0],files=tool.paths();
      await tool.apply(context);
      const file=files.at(-1),record=read(`${file}.srouter-connect.json`),doc=read(file);
      const keys=record.fields[0].keys;let target=doc;for(const key of keys.slice(0,-1))target=target[key];
      target[keys.at(-1)]="user-edited";write(file,doc);
      const before=files.map(f=>fs.readFileSync(f,"utf8"));
      await expect(tool.reset()).rejects.toThrow("Managed config changed");
      await expect(tool.apply({...context,apiKey:"new-fixture"})).rejects.toThrow("Managed config changed");
      files.forEach((f,i)=>expect(fs.readFileSync(f,"utf8")).toBe(before[i]));
    });
}
test("P8-CONNECT-selection","Tool selector aliases, duplicate elimination and unknown names",
  [{pin:"nine",path:p,symbol:"<module-behavior>",localSymbol:"resolveTools"}],
  ["All seven selectable adapters, stable order, aliases and unknown input rejection"],()=>{
    const {tools}=fixture();
    expect([...tools.resolveTools(["all","all"]).map(t=>t.id)]).toEqual(["claude","codex","opencode","droid","crush","kilo","cline"]);
    expect([...tools.resolveTools(["factory","droid","claudecode","claude-code","kilocode"]).map(t=>t.id)]).toEqual(["claude","droid","kilo"]);
    expect(()=>tools.resolveTools(["unknown"])).toThrow("Unknown tool");
  });
