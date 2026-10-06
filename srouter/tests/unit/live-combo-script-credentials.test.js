import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const script = readFileSync(new URL("../../scripts/test-combo-autoswitch.mjs", import.meta.url), "utf8");

describe("live combo script credentials", () => {
  it.each([undefined, "", "   "])("fails before any request without an explicit API_KEY (%j)", (apiKey) => {
    const fetch = vi.fn();
    expect(() => runInNewContext(script, { process: { env: { API_KEY: apiKey } }, fetch }))
      .toThrow("Set API_KEY explicitly before running this live integration script.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("gets the bearer credential only from the environment", () => {
    expect(script).toContain("const KEY = process.env.API_KEY?.trim();");
    expect(script).not.toMatch(/process\.env\.API_KEY\s*\|\|/);
  });
});
