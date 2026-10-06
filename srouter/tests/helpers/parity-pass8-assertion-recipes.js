import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { format } from "node:util";
import { expect, it, afterAll } from "vitest";
import { sourceGraph, repo, referenceEvidence, evidence } from "./parity-pass8-assertion-source.js";
const require=createRequire(path.join(repo,"package.json")),{parse}=require("@babel/parser");
const before=JSON.parse(fs.readFileSync(path.resolve(referenceEvidence,"../assertion-chunk-20261001/before.json")));
const allGraphs=[],observations=[],inventories=[],recipes=[],wiring=[];
let suiteName;
const sha=text=>crypto.createHash("sha256").update(text).digest("hex");
const serial=value=>{
  if(value===undefined)return{absent:true};
  if(typeof value==="function")return{functionSource:String(value)};
  if(value instanceof RegExp||Object.prototype.toString.call(value)==="[object RegExp]")return{regexp:String(value)};
  try{return JSON.parse(JSON.stringify(value,(_,v)=>v instanceof Map?{map:[...v]}:v));}
  catch{return String(value);}
};
function walk(node,visit,parent=null){
  if(!node||typeof node!=="object")return;
  if(node.type)visit(node,parent);
  for(const [key,val]of Object.entries(node)){
    if(["loc","start","end","extra"].includes(key))continue;
    if(Array.isArray(val))val.forEach(v=>walk(v,visit,node));else if(val&&typeof val==="object")walk(val,visit,node);
  }
}
function expectRoot(node){
  if(node?.type==="CallExpression"&&node.callee.type==="Identifier"&&node.callee.name==="expect")return node;
  if(node?.type==="MemberExpression")return expectRoot(node.object);
  return null;
}
export function inventory(file){
  const source=fs.readFileSync(file.path,"utf8"),ast=parse(source,{sourceType:"module"});
  const assertions=[],declarations=[],imports=[];
  walk(ast,node=>{
    if(node.type==="ImportDeclaration")imports.push({module:node.source.value,lines:[node.loc.start.line,node.loc.end.line],
      bindings:node.specifiers.map(s=>({local:s.local.name,imported:s.imported?.name||s.imported?.value||s.type}))});
    if(node.type!=="CallExpression")return;
    const text=source.slice(node.start,node.end);
    if(node.callee.type==="MemberExpression"&&(
      expectRoot(node.callee.object)||
      (node.callee.object.type==="Identifier"&&node.callee.object.name==="assert"))){
      const root=expectRoot(node.callee.object),actual=(root?.arguments||node.arguments)[0];
      assertions.push({slot:assertions.length,range:[node.loc.start.line,node.loc.end.line],expression:text,sourceStart:node.start,sourceEnd:node.end,
        actualArgument:actual?{start:actual.start,end:actual.end,source:source.slice(actual.start,actual.end)}:null,
        expectedArguments:(root?node.arguments:node.arguments.slice(1)).map(arg=>({start:arg.start,end:arg.end,source:source.slice(arg.start,arg.end)}))});
    }
    if(node.arguments.some(a=>["ArrowFunctionExpression","FunctionExpression"].includes(a.type))&&/^(?:it|describe|before)\b/.test(text)){
      const callback=node.arguments.find(a=>["ArrowFunctionExpression","FunctionExpression"].includes(a.type));
      declarations.push({siteIndex:declarations.length,range:[node.loc.start.line,node.loc.end.line],declaration:source.slice(node.callee.start,node.callee.end),
        title:source.slice(node.arguments[0].start,node.arguments[0].end),callbackSource:source.slice(callback.start,callback.end),
        callbackStart:callback.start,callbackEnd:callback.end});
    }
  });
  assertions.sort((a,b)=>a.sourceStart-b.sourceStart).forEach((a,i)=>a.slot=i);
  const result={...file,imports,staticAssertionSites:assertions.length,assertions,declarations,originalRecipeSource:source,
    fixtureContract:"Exact upstream callback source/table arguments and shared helper definitions preserved in recipe; helper-only tests are not backend acceptance."};
  inventories.push(result);return{source,ast,metadata:result};
}
function instrument(source,metadata){
  let modified=source;const edits=[];
  for(const a of [...metadata.assertions].reverse()){
    // Only test assertion execution is wrapped. Actual production modules are
    // byte-unchanged; recording failures does not invert original it.fails.
    const async=/\bawait\b/.test(a.expression);
    let expression=a.expression;
    const argumentsToCapture=[...(a.actualArgument?[{...a.actualArgument,kind:"actual"}]:[]),
      ...a.expectedArguments.map(arg=>({...arg,kind:"expected"}))].sort((x,y)=>y.start-x.start);
    for(const arg of argumentsToCapture){
      expression=expression.slice(0,arg.start-a.sourceStart)+`__assertionValue(${a.slot}, "${arg.kind}", (${arg.source}))`+expression.slice(arg.end-a.sourceStart);
    }
    const text=`${async?"await ":""}__assertionCheck(${a.slot}, ${async?"async ":""}() => (${expression}))`;
    edits.push({start:a.sourceStart,end:a.sourceEnd,text});
  }
  for(const declaration of metadata.declarations.filter(d=>d.declaration.startsWith("it"))){
    edits.push({start:declaration.callbackStart,end:declaration.callbackStart,text:`__assertionCallback(${declaration.siteIndex}, `});
    edits.push({start:declaration.callbackEnd,end:declaration.callbackEnd,text:")"});
  }
  for(const edit of edits.sort((a,b)=>b.start-a.start))modified=modified.slice(0,edit.start)+edit.text+modified.slice(edit.end);
  return modified;
}
function safeKv(){const data=new Map();return{get:async k=>data.get(k)||null,getAll:async()=>Object.fromEntries(data),set:async(k,v)=>data.set(k,v),remove:async k=>data.delete(k)};}
export async function registerPinnedRecipes(fileName){
  suiteName={"thinking-unified.test.js":"thinking","bugs-antigravity.test.js":"antigravity","kiro-minimal-wire-payload.test.js":"kiro","responses-completed-output.test.js":"responses","qoder-billing.test.js":"qoder","kimchi.test.js":"kimchi"}[fileName];
  for(const file of before.files.filter(f=>f.present&&path.basename(f.relativePath)===fileName)){
    const {source,metadata}=inventory(file),code=instrument(source,metadata);
    for(const implementation of ["local",file.pin]){
      const entries=[],groups=[],hooks=[],callbackSites=new WeakMap(),state={active:null},fixtureRoot=path.join(referenceEvidence,"reference",file.pin);
      function describe(name,callback){groups.push(String(name));try{callback();}finally{groups.pop();}}
      function collect(name,callback,args=[],originalInverted=false){
        entries.push({name:String(name),groups:[...groups],callback,args,originalInverted,index:entries.length,site:callbackSites.get(callback)});
      }
      const test=(name,callback)=>collect(name,callback);
      test.fails=(name,callback)=>collect(name,callback,[],true);
      test.each=table=>(name,callback)=>table.forEach((args,index)=>{
        const values=Array.isArray(args)?args:[args];collect(`${format(name.replaceAll("%#",String(index)),...values)} [row ${index}]`,callback,values);
      });
      const check=(slot,fn)=>{
        const target=state.active;if(!target)throw new Error("Assertion outside registered callback");
        const ordinal=target.assertions.filter(a=>a.slot===slot).length;
        const meta=metadata.assertions[slot];
        const row={slot,ordinal,range:meta.range,expression:meta.expression,status:"not-run"};
        target.assertions.push(row);
        const success=()=>{row.status="passed";};
        const failure=error=>{row.status="failed";row.error=error.stack||String(error);row.actual=serial(error.actual);row.expected=serial(error.expected);};
        try{
          const result=fn();
          if(result&&typeof result.then==="function")return result.then(success,failure);
          success();return result;
        }catch(error){failure(error);}
      };
      const value=(slot,kind,input)=>{
        const row=state.active?.assertions.findLast(a=>a.slot===slot);
        if(row){if(kind==="actual")row.actualValue=serial(input);else(row.expectedValues||=[]).push(serial(input));}
        return input;
      };
      const recipeExpect=Object.assign((...args)=>expect(...args),{
        // Preserve expect.any(Number) semantics across the VM realm boundary.
        any:constructor=>expect.any({Number,String,Boolean,Object,Array,Function}[constructor.name]||constructor),
      });
      let implementationCode=code,portability=null;
      if(file.pin==="vans"&&implementation==="local"&&fileName==="bugs-antigravity.test.js"){
        implementationCode=code.replace('import { getRequestTranslator } from "../../open-sse/translator/registry.js";','import * as actualLocalIndex from "../../open-sse/translator/index.js";')
          .replace('getRequestTranslator("openai:antigravity")','actualLocalIndex.getRequestTranslator');
        portability="Local has no public registry.js/getRequestTranslator export: assert actual index export absence (red), then separately execute supported registered pipeline; no inert getter is counted.";
      }
      const g=sourceGraph(implementation,{
        vitest:{describe,it:test,expect:recipeExpect},
        "node:test":{describe,it:test,before:fn=>hooks.push(fn)},
        "node:assert/strict":{default:assert},
        "src/lib/db/helpers/kvStore.js":{makeKv:safeKv},
      },{fixtureRoot,globals:{__assertionCheck:check,__assertionValue:value,
        __assertionCallback:(index,fn)=>{callbackSites.set(fn,metadata.declarations[index]);return fn;}},
        testTransform:(text,rel)=>rel===file.relativePath?implementationCode:text});
      allGraphs.push(g);
      let setupError;
      try{await g.load(file.relativePath);for(const hook of hooks)await hook();}
      catch(error){setupError=error;}
      const recipeDirectory=path.join(evidence,"recipe-code");fs.mkdirSync(recipeDirectory,{recursive:true});
      const recipePath=path.join(recipeDirectory,`${file.pin}-${implementation}-${fileName}`);fs.writeFileSync(recipePath,implementationCode);
      recipes.push({pin:file.pin,implementation,path:file.path,sha256:file.sha256,transformedSha256:sha(implementationCode),recipePath,portability,
        originalAssertionSites:metadata.staticAssertionSites,entries:entries.map(e=>({index:e.index,groups:e.groups,name:e.name,args:serial(e.args),originalInverted:e.originalInverted,range:e.site?.range})),setupError:setupError?.stack||null});
      if(setupError){
        it(`[A8-SETUP-${file.pin}-${implementation}-${fileName}] source-recipe setup must load`,()=>{throw setupError;});continue;
      }
      for(const entry of entries){
        const id=`A8-${file.pin}-${implementation}-${fileName}-${entry.index}`;
        const record={id,pin:file.pin,implementation,upstreamFile:file.path,upstreamSha256:file.sha256,
          groups:entry.groups,testName:entry.name,tableArguments:serial(entry.args),originalInverted:entry.originalInverted,
          cloneOnly:fileName==="kimchi.test.js"&&entry.groups[0]!=="kimchi registry entry",portability,
          status:"not-run",assertions:[],itRange:entry.site?.range||null,originalItTitle:entry.site?.title||null,fixtureSource:entry.site?.callbackSource||String(entry.callback)};
        observations.push(record);
        it(`[${id}] ${entry.groups.join(" / ")} / ${entry.name}`,async()=>{
          state.active=record;
          try{await entry.callback(...entry.args);}
          catch(error){record.executionError=error.stack||String(error);}
          finally{state.active=null;}
          record.productionSources=Object.fromEntries([...g.loaded].filter(([rel])=>!rel.startsWith("tests/")));
          record.status=record.executionError||record.assertions.some(a=>a.status==="failed")?"failed":"passed";
          if(record.executionError)throw new Error(`Fixture execution failed: ${record.executionError}`);
          const errors=record.assertions.filter(a=>a.status==="failed");
          if(errors.length)throw new Error(errors.map(a=>`Upstream ${file.relativePath}:${a.range.join("-")} ${a.expression}\n${a.error}`).join("\n\n"));
          expect(record.assertions.length,"No inert case may count as assertion coverage").toBeGreaterThan(0);
        },30000);
      }
    }
  }
}
export function extraCase(id,run,metadata={}){
  const record={id,pin:null,implementation:"actual supplemental",cloneOnly:false,status:"not-run",assertions:[],...metadata};observations.push(record);
  it(`[${id}] supplemental actual-source behavioral assertion`,async()=>{
    const check=async(name,fn,range=null)=>{
      const row={expression:name,range,status:"not-run"};record.assertions.push(row);
      try{await fn();row.status="passed";}
      catch(error){row.status="failed";row.error=error.stack||String(error);row.actual=serial(error.actual);row.expected=serial(error.expected);}
    };
    try{
      const result=await run(check);record.details=serial(result);
      const failures=record.assertions.filter(a=>a.status==="failed");
      if(failures.length)throw new Error(failures.map(a=>a.expression+"\n"+a.error).join("\n\n"));
      record.status="passed";
    }
    catch(error){record.status="failed";record.error=error.stack||String(error);record.actual=serial(error.actual);record.expected=serial(error.expected);throw error;}
  },30000);
}
export function ownedGraph(label,overrides={},options={}){
  const g=sourceGraph(label,{"src/lib/db/helpers/kvStore.js":{makeKv:safeKv},...overrides},options);
  allGraphs.push(g);return g;
}
export function wireRecord(record){wiring.push(record);}
afterAll(()=>{
  const suffix=process.env.ASSERTION_CHUNK_SUITE||suiteName;if(!suffix)throw new Error("Assertion suite isolation required");
  for(const [name,value]of [["observations",observations],["inventory",inventories],["recipes",recipes],["wiring",wiring],
    ["source-hashes",allGraphs.map(g=>({label:g.label,loaded:Object.fromEntries(g.loaded),origins:Object.fromEntries(g.origins)}))]]){
    fs.writeFileSync(path.join(evidence,`${suffix}-${name}.json`),JSON.stringify(value,null,2));
  }
  allGraphs.forEach(g=>g.dispose());
});
