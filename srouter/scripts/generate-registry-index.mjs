// Add explicitly requested entries without re-enabling hidden providers or
// rewriting existing registry metadata. Usage: node scripts/generate-registry-index.mjs factory
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const registryDir = join(dirname(fileURLToPath(import.meta.url)), "../open-sse/providers/registry");
const indexPath = join(registryDir, "index.js");
const original = readFileSync(indexPath, "utf8");
let source = original;
const providers = process.argv.slice(2);
if (!providers.length) throw new Error("Specify registry entries to add.");
let nextId = Math.max(...[...source.matchAll(/^import p(\d+)\b/gm)].map(match => Number(match[1]))) + 1;
for (const provider of providers) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(provider) || provider === "index" || !existsSync(join(registryDir, `${provider}.js`))) {
    throw new Error("Invalid registry entry.");
  }
  if (source.includes(`from "./${provider}.js"`)) continue;
  if (!source.includes("export default [") || !/\n\];\s*$/.test(source)) {
    throw new Error("Unexpected registry index structure.");
  }
  const symbol = `p${nextId++}`;
  source = source.replace("export default [", `import ${symbol} from "./${provider}.js";\nexport default [`);
  source = source.replace(/(\n\];\s*)$/, `\n  ${symbol},$1`);
}
if (source !== original) writeFileSync(indexPath, source, "utf8");
console.log("Registry imports generated; existing order and exclusions preserved.");
