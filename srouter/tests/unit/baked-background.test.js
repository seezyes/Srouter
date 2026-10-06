import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { loadBindings, transform } from "next/dist/build/swc/index.js";
import { describe, expect, it } from "vitest";
import * as settings from "@/shared/constants/uiSettings.js";

const root = resolve(import.meta.dirname, "../..");
const read = (file) => readFileSync(resolve(root, file), "utf8");
async function compile(file, imports) {
  await loadBindings();
  const { code } = await transform(read(file), {
    filename: file,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" },
  });
  const compiledModule = { exports: {} };
  const dependencies = { react: React, "react/jsx-runtime": jsxRuntime, ...imports };
  new Function("module", "exports", "require", code)(compiledModule, compiledModule.exports, (id) => {
    if (!(id in dependencies)) throw new Error(`Unexpected import: ${id}`);
    const dependency = dependencies[id];
    return dependency && "default" in dependency ? { ...dependency, __esModule: true } : dependency;
  });
  return compiledModule.exports.default;
}

describe("baked app background", () => {
  it.each(["fixed", "contained"])("renders %s placement with the compact asset and no canvas", async (variant) => {
    const Background = await compile("src/app/landing/components/IsoCubeBackground.js", {
      "@/store/uiStore": { default: (selector) => selector({ backdrop: settings.DEFAULT_BACKDROP, cube: settings.DEFAULT_CUBE }) },
      "@/shared/constants/uiSettings": settings,
    });
    const html = renderToStaticMarkup(React.createElement(Background, { variant, baseClassName: "bg-app-gradient" }));
    expect(html).toContain(variant === "contained" ? "absolute inset-0" : "fixed inset-0");
    expect(html).toContain('data-cube-background="compact"');
    expect(html).toContain("iso-cube-compact.webp");
    expect(html).toContain("704px 352px");
    expect(html).toContain("opacity:0.12");
    expect(html).not.toContain("<canvas");
    expect(html).not.toContain("lossless");
  });

  it("rehydrates only supported cube settings, preserving enabled/dim", async () => {
    let options;
    await compile("src/store/uiStore.js", {
      zustand: { create: (factory) => factory(() => {}, () => ({})) },
      "zustand/middleware": { persist: (factory, config) => { options = config; return factory; } },
      "@/shared/constants/uiSettings": settings,
    });
    const current = { developerMode: false, backdrop: settings.DEFAULT_BACKDROP, cube: settings.DEFAULT_CUBE };
    const state = options.merge({ cube: { enabled: false, dim: 41, color: "#ffffff", motionMode: "wave", cubeSize: 64 }, mark: { secretGeometry: true } }, current);
    expect(state.cube).toEqual({ enabled: false, dim: 41 });
    expect(state).not.toHaveProperty("mark");
    expect(options.merge({}, current).cube).toEqual(settings.DEFAULT_CUBE);
  });

  it("keeps two bitmap sources but exposes only compact through public assets", () => {
    expect(readdirSync(resolve(root, "public/backgrounds"))).toEqual(["iso-cube-compact.webp"]);
    for (const [file, bytes] of [["public/backgrounds/iso-cube-compact.webp", 555526], ["dev/background-textures/iso-cube-lossless.webp", 1312890]]) {
      const data = readFileSync(resolve(root, file));
      expect(data.length).toBe(bytes);
      expect(data.toString("ascii", 0, 4)).toBe("RIFF");
      expect(data.toString("ascii", 8, 12)).toBe("WEBP");
    }
    expect(read("scripts/copy-standalone-assets.mjs")).toContain('resolve(projectRoot, "public")');
    expect(read("scripts/copy-standalone-assets.mjs")).not.toContain("background-textures");
    expect(read("next.config.mjs")).toContain('"./dev/background-textures/**/*"');
  });

  it("removes private generator implementations and their UI controls", () => {
    for (const file of ["src/lib/isoCubeField", "dev/icon-editor", "scripts/build-brand-icons.mjs", "src/shared/constants/brandMark.js"]) {
      expect(existsSync(resolve(root, file))).toBe(false);
    }
    const source = read("src/app/landing/components/IsoCubeBackground.js");
    expect(source).not.toMatch(/createIsoCubeField|requestAnimationFrame|canvas|getContext/);
    const page = read("src/app/(dashboard)/dashboard/ui/page.js");
    expect(page).toContain('redirect("/dashboard/profile")');
    expect(page).not.toMatch(/MOTION_MODES|cube\.color|cube\.cubeSize|cube\.jitterY|cube\.motionMode|cube\.seed/);
  });

  it("redirects old UI editor bookmarks without rendering a background editor", async () => {
    const Page = await compile("src/app/(dashboard)/dashboard/ui/page.js", {
      "next/navigation": { redirect: (href) => { throw new Error(`REDIRECT:${href}`); } },
    });
    expect(() => Page()).toThrow("REDIRECT:/dashboard/profile");
    const profile = read("src/app/(dashboard)/dashboard/profile/page.js");
    expect(profile).toContain("Enable developer-only tools, including import from the main Srouter instance.");
    expect(profile).not.toContain("every background");
  });
});
