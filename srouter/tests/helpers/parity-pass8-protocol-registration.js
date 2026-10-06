import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
const owned=new Set(["kimchi.js","qoder.js","xiaomi-mimo.js","zed.js","default.js","base.js"]);
// Unrelated registrations are inert to avoid executing foreign provider setup.
// The four owned classes, their dependencies, Default/Base and the dispatcher
// itself are unchanged actual source. Their execute methods are never mocked.
export async function registeredAdapter(g,provider){
  const source=fs.readFileSync(path.join(g.root,"open-sse/executors/index.js"),"utf8");
  for(const match of source.matchAll(/^import\s+(.+?)\s+from\s+"\.\/([^"]+)";/gm)){
    if(owned.has(match[2]))continue;
    const exports={};
    if(match[1].startsWith("{")){
      for(const name of match[1].replace(/[{}]/g,"").split(",").map(s=>s.trim()).filter(Boolean))exports[name]=class {execute(){throw new Error("Unowned provider dispatch forbidden");}};
    }else exports.default=class {execute(){throw new Error("Unowned provider dispatch forbidden");}};
    g.mocks["open-sse/executors/"+match[2]]=exports;
  }
  for(const m of source.matchAll(/^export\s+\{([^}]+)\}\s+from\s+"\.\/([^"]+)";/gm)){
    if(owned.has(m[2]))continue;
    const exports=g.mocks["open-sse/executors/"+m[2]]||{};
    for(const entry of m[1].split(",")){
      const name=entry.trim().split(/\s+as\s+/)[0];
      if(name&&!exports[name])exports[name]=class {execute(){throw new Error("Unowned provider dispatch forbidden");}};
    }
    g.mocks["open-sse/executors/"+m[2]]=exports;
  }
  const dispatch=await g.load("open-sse/executors/index.js"),ex=dispatch.getExecutor(provider);
  expect(dispatch.getExecutor(provider)).toBe(ex);
  const expected=g.label!=="vans";
  expect(dispatch.hasSpecializedExecutor(provider)).toBe(expected);
  const namespace=await g.load("open-sse/executors/"+(expected?{"kimchi":"kimchi.js","qoder-cn":"qoder.js","xiaomi-mimo":"xiaomi-mimo.js",zed:"zed.js"}[provider]:"default.js"));
  const Constructor=expected?namespace[{kimchi:"KimchiExecutor","qoder-cn":"QoderExecutor","xiaomi-mimo":"XiaomiMimoExecutor",zed:"default"}[provider]]:namespace.DefaultExecutor;
  expect(ex).toBeInstanceOf(Constructor);
  return ex;
}
