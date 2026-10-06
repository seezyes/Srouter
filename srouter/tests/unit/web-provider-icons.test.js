import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getWebProviderIconSrc, getWebGroupIconSrc } from "@/shared/utils/webProviderIcons";

const root = resolve(import.meta.dirname, "../..");
const publicDir = resolve(root, "public");
const assetFile = (src) => resolve(publicDir, src.replace(/^\//, ""));

const WEB_ICONS = {
  exa: "/providers/web/exa.svg",
  "brave-search": "/providers/web/brave-search.svg",
  "vercel-ai-gateway": "/providers/web/vercel-ai-gateway.svg",
  serper: "/providers/web/serper.svg",
};
const WEB_ASSETS = [...Object.values(WEB_ICONS), "/providers/web/ollama-cloud.png"];

// SHA-256 of public/providers/ollama.png recorded before the namespaced web
// icon assets were added (2026-10-03). Ollama Search reuses this registry mark
// and must stay byte-identical: the white llama is group-header only.
const OLLAMA_SEARCH_SHA256 = "4f1b00455c38365309f1d11e0a4f3dfa22ef16bf013189f786ab4ebc36f211e3";

describe("web provider icon overrides", () => {
  it("maps the four refreshed web providers to namespaced assets", () => {
    for (const [id, src] of Object.entries(WEB_ICONS)) {
      expect(getWebProviderIconSrc(id), id).toBe(src);
      expect(getWebProviderIconSrc(`  ${id.toUpperCase()}  `), id).toBe(src);
    }
  });

  it("falls back to the shared registry for every other id", () => {
    expect(getWebProviderIconSrc("tavily")).toBe("/providers/tavily.png");
    expect(getWebProviderIconSrc("perplexity-agent")).toBe("/providers/perplexity.png");
    expect(getWebProviderIconSrc("")).toBeNull();
    expect(getWebProviderIconSrc(null)).toBeNull();
    expect(getWebProviderIconSrc(undefined)).toBeNull();
  });

  it("keeps Ollama Search on the untouched registry icon", () => {
    expect(getWebProviderIconSrc("ollama-search")).toBe("/providers/ollama.png");
    expect(getWebProviderIconSrc("ollama")).toBe("/providers/ollama.png");
  });

  it("overrides only the Ollama collapsed group header", () => {
    expect(getWebGroupIconSrc("Ollama")).toBe("/providers/web/ollama-cloud.png");
    expect(getWebGroupIconSrc(" ollama ")).toBe("/providers/web/ollama-cloud.png");
    for (const name of ["Google", "Perplexity", "Unknown", "", null, undefined]) {
      expect(getWebGroupIconSrc(name)).toBeNull();
    }
  });
});

describe("web provider icon assets", () => {
  it("ships a non-empty asset for every mapped override", () => {
    for (const src of WEB_ASSETS) {
      const file = assetFile(src);
      expect(existsSync(file), file).toBe(true);
      // The smallest asset is the 176-byte Vercel triangle; a truncated or
      // placeholder file would be far below this floor.
      expect(statSync(file).size, file).toBeGreaterThan(100);
    }
  });

  it("ships self-contained SVGs without scripts or external references", () => {
    for (const src of WEB_ASSETS.filter((asset) => asset.endsWith(".svg"))) {
      const svg = readFileSync(assetFile(src), "utf8");
      expect(svg.startsWith("<svg"), src).toBe(true);
      expect(svg, src).toContain("</svg>");
      expect(svg, src).not.toMatch(/<script/i);
      expect(svg, src).not.toMatch(/\son[a-z]+\s*=/i);
      expect(svg, src).not.toMatch(/<image[\s>]/i);
      expect(svg, src).not.toMatch(/<foreignObject/i);
      expect(svg, src).not.toMatch(/href\s*=\s*["']https?:/i);
      expect(svg, src).not.toMatch(/@import/i);
      expect(svg, src).not.toMatch(/url\(\s*["']?https?:/i);
    }
  });

  it("ships the Ollama group mark as a PNG badge mirroring the Cloud card", () => {
    const png = readFileSync(assetFile("/providers/web/ollama-cloud.png"));
    // PNG signature — the asset is a composed raster, not an SVG.
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.length).toBeGreaterThan(1000);
  });

  it("ships the Vercel favicon badge with black circle and white triangle", () => {
    const svg = readFileSync(assetFile("/providers/web/vercel-ai-gateway.svg"), "utf8");
    expect(svg).toMatch(/<circle[^>]*fill="#000000"/i);
    expect(svg).toMatch(/fill="#ffffff"/i);
    expect(svg).not.toMatch(/fill="#fff"/i);
  });

  it("leaves the Ollama Search registry icon byte-identical", () => {
    const icon = readFileSync(assetFile("/providers/ollama.png"));
    expect(createHash("sha256").update(icon).digest("hex")).toBe(OLLAMA_SEARCH_SHA256);
  });
});
