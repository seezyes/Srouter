import { describe, expect, it } from "vitest";
import { APP_CONFIG, UPSTREAM_LINES, UPSTREAM_LINES_NOTE, formatUpstreamLine } from "@/shared/constants/config.js";
import pkg from "../../package.json" with { type: "json" };

/**
 * The product version is shown in the sidebar and in Profile, and it is the
 * source/build version; a frozen delivery retains its own version. The upstream lines under it are the
 * last *full* equivalents (marked "+++", because newer upstream releases are
 * ported only partially). Both are user-visible contracts: pin them here so a
 * version bump cannot silently drop the equivalents or the "+++" marker.
 */
describe("product version", () => {
  it("is the app version from package.json", () => {
    expect(APP_CONFIG.version).toBe(pkg.version);
    expect(APP_CONFIG.version).toMatch(/^\d+\.\d+(\.\d+)?$/);
  });

  it("pins the current development release at 0.17.1", () => {
    expect(APP_CONFIG.version).toBe("0.17.1");
  });
});

describe("upstream lines", () => {
  it("lists 9router and VansRouter", () => {
    expect(UPSTREAM_LINES.map((line) => line.name)).toEqual(["9router", "VansRouter"]);
  });

  it("renders each line as name + last full equivalent + +++", () => {
    expect(formatUpstreamLine(UPSTREAM_LINES[0])).toBe("9router v0.5.95+++");
    expect(formatUpstreamLine(UPSTREAM_LINES[1])).toBe("VansRouter v0.91.21+++");
    for (const line of UPSTREAM_LINES) {
      expect(line.suffix).toBe("+++");
      expect(line.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("keeps the caption the user asked for", () => {
    expect(UPSTREAM_LINES_NOTE).toBe("Equivalent");
  });
});
