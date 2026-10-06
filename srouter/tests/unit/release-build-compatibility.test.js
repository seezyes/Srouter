import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GET } from "../../src/app/api/pricing/defaults/route.js";
import { getDefaultPricing } from "../../open-sse/providers/pricing.js";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("production build compatibility", () => {
  it("serves default pricing through a valid GET route", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(getDefaultPricing());
  });

  it("removes the cancelled plugin cube implementation completely", () => {
    for (const path of [
      "src/lib/vendor/iso-cube-field",
      "src/app/(dashboard)/dashboard/token-saver/vendor/iso-cube-field",
      "src/app/(dashboard)/dashboard/token-saver/staticCubeBorder.js",
      "src/app/(dashboard)/dashboard/token-saver/staticCubeBorderAdapter.js",
    ]) {
      expect(existsSync(new URL(`../../${path}`, import.meta.url))).toBe(false);
    }
  });

  it("uses the shared validator in both combo routes", () => {
    for (const path of ["src/app/api/combos/route.js", "src/app/api/combos/[id]/route.js"]) {
      expect(read(path)).toContain('import { validateContextLength } from "@/shared/utils/comboContextLength.js"');
    }
  });

  it("ships only a baked compact background without the private generator", () => {
    for (const path of ["src/lib/isoCubeField", "dev/icon-editor", "scripts/build-brand-icons.mjs", "src/shared/constants/brandMark.js"]) {
      expect(existsSync(new URL(`../../${path}`, import.meta.url))).toBe(false);
    }
    expect(read("src/app/landing/components/IsoCubeBackground.js")).toContain("buildBakedCubeStyle");
    expect(existsSync(new URL("../../public/backgrounds/iso-cube-compact.webp", import.meta.url))).toBe(true);
    expect(existsSync(new URL("../../public/backgrounds/iso-cube-lossless.webp", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../../dev/background-textures/iso-cube-lossless.webp", import.meta.url))).toBe(true);
    expect(JSON.parse(read("package.json")).scripts["icon:editor"]).toBeUndefined();
  });

  it("does not export helper names from Next pages or routes", () => {
    for (const [path, name] of [
      ["src/app/(dashboard)/dashboard/proxy-fitness/page.js", "recordsOf"],
      ["src/app/api/combos/[id]/route.js", "validateContextLength"],
      ["src/app/api/pricing/route.js", "GET_DEFAULTS"],
      ["src/app/api/v1/messages/count_tokens/route.js", "estimateAnthropicInputTokens"],
    ]) {
      expect(read(path)).not.toMatch(new RegExp(`export\\s+(?:(?:async\\s+)?function\\s+${name}\\b|\\{[^}]*\\b${name}\\b)`));
    }
  });

  it("preserves aliases without deprecated baseUrl or inactive build validators", () => {
    const config = JSON.parse(read("tsconfig.json"));
    expect(config.compilerOptions.baseUrl).toBeUndefined();
    expect(config.compilerOptions.paths["@/*"]).toEqual(["./src/*"]);
    expect(config.compilerOptions.paths["open-sse/*"]).toEqual(["./open-sse/*"]);
    expect(config.exclude).toContain(".next-dev");
    expect(config.exclude).toContain(".next-release");
    expect(read("next.config.mjs")).not.toContain("ignoreBuildErrors");
  });
});
