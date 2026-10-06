import fs from "node:fs";
import vm from "node:vm";

export const readSource = relative => fs.readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8");
// Dangerous boundaries are explicit stubs; the production function body is
// evaluated unchanged. These are fixture checks, not live/platform acceptance.
export function evaluateSource(source, stubs = {}) {
  const context = vm.createContext({
    console, Response, Request, Headers, URL, AbortController, AbortSignal,
    DOMException, ReadableStream, Buffer, Date, Map, Set, Promise,
    setTimeout, clearTimeout, setImmediate, process: { env: {} }, ...stubs,
  });
  vm.runInContext(source.replace(/^import\s+[\s\S]*?;\s*$/gm, "")
    .replace(/\bexport\s+(?=(?:async\s+)?function|const|let|class)/g, ""), context);
  return context;
}
export const evaluateFile = (relative, stubs) => evaluateSource(readSource(relative), stubs);
export const jsonResponse = { json: (body, init) => Response.json(body, init) };
export const quietLog = { info() {}, warn() {}, debug() {}, error() {} };
