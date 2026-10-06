import { afterAll, beforeAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sourceGraph, contractSuite, evidence } from "../helpers/parity-pass8-source.js";

const test = contractSuite("catalog-assertions");
const graphs = {}, modules = {};
for (const label of ["local", "nine", "vans"]) graphs[label] = sourceGraph(label);
beforeAll(async () => {
  for (const [label, graph] of Object.entries(graphs)) {
    modules[label] = {
      caps: await graph.load("open-sse/providers/capabilities.js"),
      pricing: await graph.load("open-sse/providers/pricing.js"),
    };
  }
});
afterAll(() => {
  fs.writeFileSync(path.join(evidence, "source-hashes-catalog-assertions.json"),
    JSON.stringify(Object.fromEntries(Object.entries(graphs).map(([label, graph]) =>
      [label, Object.fromEntries(graph.loaded)])), null, 2));
  Object.values(graphs).forEach(graph => graph.dispose());
});

// All substantive assertions in both pinned files are represented here.
// Static table equality is not evidence of current vendor billing.
for (const label of ["local", "nine", "vans"]) {
  const pricingAnchor = [{ pin: label, path: "tests/unit/provider-pricing-minimax-m3.test.js",
    assertionLines: [5, 28], localPath: "open-sse/providers/pricing.js" }];
  test(`P8U-${label}-minimax-exists`, `${label} MiniMax-M3 default rate entry exists`,
    pricingAnchor, ["Pinned assertion lines 5-7"], () => {
      expect(modules[label].pricing.MODEL_PRICING["MiniMax-M3"]).toBeDefined();
    });
  test(`P8U-${label}-minimax-shape`, `${label} MiniMax-M3 default rate numeric shape`,
    pricingAnchor, ["Pinned assertion lines 9-16: input/output/cached are numeric"], () => {
      expect(modules[label].pricing.MODEL_PRICING["MiniMax-M3"]).toMatchObject({
        input: expect.any(Number), output: expect.any(Number), cached: expect.any(Number),
      });
    });
  for (const [field, value, lines] of [
    ["input", 0.30, [18, 20]], ["output", 1.20, [22, 24]], ["cached", 0.06, [26, 28]],
  ]) {
    test(`P8U-${label}-minimax-${field}`, `${label} MiniMax-M3 pinned default ${field}=${value}`,
      pricingAnchor, [`Pinned assertion lines ${lines.join("-")}; default source table only`], () => {
        expect(modules[label].pricing.MODEL_PRICING["MiniMax-M3"][field]).toBe(value);
      });
  }
  for (const [kind, field, lines] of [
    ["imageToText", "vision", [6, 8]], ["image", "imageOutput", [10, 14]],
    ["stt", "audioInput", [10, 14]], ["tts", "audioOutput", [10, 14]],
  ]) {
    test(`P8U-${label}-kind-${kind}`, `${label} custom service kind ${kind} declares ${field}`,
      [{ pin: label, path: "tests/unit/capabilities-service-kind.test.js",
        assertionLines: lines, localPath: "open-sse/providers/capabilities.js" }],
      ["Exact pinned capability assertion, independently executed per kind; no registration-only case"], () => {
        expect(modules[label].caps.capabilitiesFromServiceKind(kind)).toMatchObject({ [field]: true });
      });
  }
}
