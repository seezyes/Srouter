import { readFileSync } from "node:fs";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { loadBindings, transform } from "next/dist/build/swc/index.js";
import { beforeAll, describe, expect, it } from "vitest";

const file = new URL("../../src/app/(dashboard)/dashboard/quota/page.js", import.meta.url);
const source = readFileSync(file, "utf8");
let QuotaPage;
const ProviderLimits = () => React.createElement("section", { "data-quota-limits": true }, "Account quotas");
const CardSkeleton = () => React.createElement("div", null, "Loading quotas");

beforeAll(async () => {
  await loadBindings();
  const { code } = await transform(source, {
    filename: file.pathname,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" },
  });
  const imports = {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "@/shared/components/Loading": { CardSkeleton },
    "../usage/components/ProviderLimits": { default: ProviderLimits },
  };
  const compiled = { exports: {} };
  new Function("module", "exports", "require", code)(compiled, compiled.exports, (id) => {
    if (!(id in imports)) throw new Error(`Unexpected QuotaPage import: ${id}`);
    const dependency = imports[id];
    return "default" in dependency ? { ...dependency, __esModule: true } : dependency;
  });
  QuotaPage = compiled.exports.default;
});

describe("Quota Tracker page", () => {
  it("renders account quotas without the available free tiers catalogue", () => {
    const html = renderToStaticMarkup(React.createElement(QuotaPage));
    expect(html).toContain("Account quotas");
    expect(html.match(/data-quota-limits/g)).toHaveLength(1);
    expect(html).not.toContain("Available free tiers");
    expect(source).not.toMatch(/FreeTierList|listFreeTiers|providers\/freeTiers/);
  });

  it("preserves the quota loading boundary", () => {
    const tree = QuotaPage();
    expect(tree.type).toBe(React.Suspense);
    expect(tree.props.fallback.type).toBe(CardSkeleton);
    expect(tree.props.children.props.children.type).toBe(ProviderLimits);
  });
});
