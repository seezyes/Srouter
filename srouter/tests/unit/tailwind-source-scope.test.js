import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { transform } from "lightningcss";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const cssPath = path.join(projectRoot, "src/app/globals.css");

describe("Tailwind application source boundary", () => {
  it("resolves the scan base to src rather than the repository root", () => {
    const css = readFileSync(cssPath, "utf8");
    const source = css.match(/@import "tailwindcss" source\("([^"]+)"\)/)?.[1];
    expect(source).toBeDefined();
    expect(path.resolve(path.dirname(cssPath), source)).toBe(path.join(projectRoot, "src"));
  });

  it("generates parseable CSS with the application shadow utilities", async () => {
    const result = await postcss([tailwindcss({ base: projectRoot })]).process(
      readFileSync(cssPath, "utf8"),
      { from: cssPath },
    );
    expect(result.css).toContain("--tw-shadow: var(--shadow-warm)");
    expect(result.css).toContain("--tw-shadow: var(--shadow-elev)");
    expect(() => transform({ filename: cssPath, code: Buffer.from(result.css) })).not.toThrow();
  }, 30000);
});
