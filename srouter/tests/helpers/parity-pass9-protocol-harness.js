// Pass9 protocol-repair helper. Wraps the unchanged local-source VM loader from
// the historical Pass8 protocol helper without editing it. Only local (`srouter/`)
// production source is executed here; the Pass8 pin references stay read-only and
// are never rewritten. Evidence produced by Pass9 tests is written under the
// dedicated pass9-protocol-repairs directory, never into a Pass8 evidence root.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourceGraph as baseSourceGraph } from "./parity-pass8-protocol-source.js";

export const p9Repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const p9Evidence = path.resolve(
  p9Repo,
  "../docs/work/T-0030-upstream-parity/evidence/pass9-protocol-repairs",
);

const graphs = [];

// Local-only graph. `overrides`/`options` mirror the Pass8 loader contract.
export function localGraph(overrides = {}, options = {}) {
  const g = baseSourceGraph("local", overrides, options);
  graphs.push(g);
  return g;
}

export function disposeGraphs() {
  for (const g of graphs) g.dispose();
  graphs.length = 0;
}

export function writeEvidence(name, value) {
  try {
    fs.mkdirSync(p9Evidence, { recursive: true });
    fs.writeFileSync(path.join(p9Evidence, `${name}.json`), JSON.stringify(value, null, 2));
  } catch {
    /* evidence is best-effort; never fail a protocol assertion on a write error */
  }
}
