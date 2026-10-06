// UI settings: pure mapping helpers + the pre-paint script.
//
// The pre-paint script in src/app/layout.js has to run as an opaque string
// during SSR, so it cannot import the runtime mapper. These tests are the guard
// against the two drifting apart: the script is executed against stubbed
// globals and its output must match buildBackdropVars() exactly.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  BACKDROP_VAR_SPEC,
  BAKED_CUBE_TEXTURE,
  DEFAULT_BACKDROP,
  DEFAULT_CUBE,
  UI_PREPAINT_SCRIPT,
  UI_STORAGE_KEY,
  buildBackdropVars,
  buildBakedCubeStyle,
  buildCubeHostOpacity,
  rgbaFromHex,
} from "@/shared/constants/uiSettings.js";

describe("ui settings: rgbaFromHex", () => {
  it("converts #rrggbb + alpha", () => {
    expect(rgbaFromHex("#6366f1", 0.2)).toBe("rgba(99, 102, 241, 0.2)");
    expect(rgbaFromHex("6366f1", 1)).toBe("rgba(99, 102, 241, 1)");
    expect(rgbaFromHex("#000000", 0)).toBe("rgba(0, 0, 0, 0)");
  });

  it("degrades safely on garbage input instead of emitting invalid CSS", () => {
    expect(rgbaFromHex("", 0.5)).toBe("rgba(0, 0, 0, 0.5)");
    expect(rgbaFromHex("#zzz", 0.5)).toBe("rgba(0, 0, 0, 0.5)");
    // Omitting alpha means "fully opaque" (the documented default parameter).
    expect(rgbaFromHex(undefined, undefined)).toBe("rgba(0, 0, 0, 1)");
    expect(rgbaFromHex("#ffffff")).toBe("rgba(255, 255, 255, 1)");
  });

  it("clamps alpha into [0, 1]", () => {
    expect(rgbaFromHex("#ffffff", 5)).toBe("rgba(255, 255, 255, 1)");
    expect(rgbaFromHex("#ffffff", -3)).toBe("rgba(255, 255, 255, 0)");
  });
});

describe("ui settings: buildBackdropVars", () => {
  it("every key the spec reads exists in the defaults", () => {
    // This is what keeps the runtime mapper and the pre-paint script in
    // agreement: both backfill from DEFAULT_BACKDROP, so a key missing there
    // would silently resolve to a different value in each.
    for (const [, key, format] of BACKDROP_VAR_SPEC) {
      expect(DEFAULT_BACKDROP, `${key} missing from DEFAULT_BACKDROP`).toHaveProperty(key);
      if (format.startsWith("rgba:")) {
        const alphaKey = format.slice(5);
        expect(DEFAULT_BACKDROP, `${alphaKey} missing from DEFAULT_BACKDROP`).toHaveProperty(alphaKey);
      }
    }
  });

  it("maps the defaults onto the documented variable names", () => {
    const vars = buildBackdropVars(DEFAULT_BACKDROP);
    expect(Object.keys(vars).sort()).toEqual(BACKDROP_VAR_SPEC.map(([name]) => name).sort());
    expect(vars["--bg-app-light-top"]).toBe(DEFAULT_BACKDROP.lightTop);
    expect(vars["--bg-app-light-glow"]).toBe(rgbaFromHex(DEFAULT_BACKDROP.lightGlow, DEFAULT_BACKDROP.lightGlowAlpha));
    expect(vars["--bg-app-glow"]).toBe(rgbaFromHex(DEFAULT_BACKDROP.darkGlow, DEFAULT_BACKDROP.darkGlowAlpha));
    expect(vars["--bg-glow-size"]).toBe(`${DEFAULT_BACKDROP.glowSizeRem}rem`);
    expect(vars["--vignette-color-dark"]).toBe(
      rgbaFromHex(DEFAULT_BACKDROP.darkVignetteHex, DEFAULT_BACKDROP.darkVignette),
    );
  });

  it("falls back to defaults for missing keys", () => {
    expect(buildBackdropVars({ lightTop: "#123456" })["--bg-app-light-top"]).toBe("#123456");
    expect(buildBackdropVars({ lightTop: "#123456" })["--bg-app-light-bottom"]).toBe(DEFAULT_BACKDROP.lightBottom);
    expect(buildBackdropVars(null)).toEqual(buildBackdropVars(DEFAULT_BACKDROP));
  });
});

describe("ui settings: baked cube texture", () => {
  it("uses only the compact 2x asset at a fixed CSS scale", () => {
    expect(DEFAULT_CUBE).toEqual({ enabled: true, dim: 12 });
    expect(buildBakedCubeStyle(DEFAULT_CUBE)).toEqual({
      position: "absolute", inset: 0, opacity: 0.12,
      backgroundImage: `url("${BAKED_CUBE_TEXTURE.src}")`,
      backgroundSize: "704px 352px", backgroundRepeat: "repeat",
    });
  });

  it("retains enabled/dim without accepting legacy geometry controls", () => {
    expect(buildBakedCubeStyle({ enabled: false, dim: 60 }).opacity).toBe(0);
    expect(buildBakedCubeStyle({ dim: 999 }).opacity).toBe(1);
    expect(buildBakedCubeStyle({ dim: -5 }).opacity).toBe(0);
    expect(buildBakedCubeStyle({ dim: "invalid" }).opacity).toBe(0.12);
    expect(buildBakedCubeStyle({ cubeSize: 80, color: "#000000", motionMode: "wave" }).backgroundSize).toBe("704px 352px");
  });
});

describe("ui settings: host opacity", () => {
  it("is the dim percentage, and zero when the field is off", () => {
    expect(buildCubeHostOpacity({ dim: 40, enabled: true })).toBeCloseTo(0.4);
    expect(buildCubeHostOpacity({ dim: 40, enabled: false })).toBe(0);
    expect(buildCubeHostOpacity({})).toBeCloseTo(DEFAULT_CUBE.dim / 100);
  });
});

describe("ui settings: pre-paint script", () => {
  const originalDocument = globalThis.document;
  const originalLocalStorage = globalThis.localStorage;
  let stored;
  let applied;

  function runScript() {
    // The script is an opaque string by design: it has to be inlined in the SSR
    // HTML, so it cannot import the runtime helpers.
    new Function(UI_PREPAINT_SCRIPT)();
  }

  beforeEach(() => {
    applied = {};
    globalThis.document = {
      documentElement: {
        style: {
          setProperty: (name, value) => {
            applied[name] = value;
          },
        },
      },
    };
    globalThis.localStorage = { getItem: (key) => (key === UI_STORAGE_KEY ? stored : null) };
  });

  afterEach(() => {
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
  });

  it("applies nothing when there is no persisted state", () => {
    stored = null;
    runScript();
    expect(applied).toEqual({});
  });

  it("applies nothing when the stored state has no backdrop", () => {
    stored = JSON.stringify({ state: { developerMode: true } });
    runScript();
    expect(applied).toEqual({});
  });

  it("produces exactly the values the runtime mapper produces", () => {
    stored = JSON.stringify({ state: { backdrop: DEFAULT_BACKDROP } });
    runScript();
    expect(applied).toEqual(buildBackdropVars(DEFAULT_BACKDROP));
  });

  it("produces the same values for a customised backdrop", () => {
    const custom = {
      lightTop: "#111111",
      lightMid: "#222222",
      lightBottom: "#333333",
      lightGlow: "#ff0000",
      lightGlowAlpha: 0.42,
      darkTop: "#010101",
      darkMid: "#020202",
      darkBottom: "#030303",
      darkGlow: "#00ff00",
      darkGlowAlpha: 0.13,
      glowSizeRem: 47,
      lightVignetteHex: "#abcdef",
      lightVignette: 0.25,
      darkVignetteHex: "#123456",
      darkVignette: 0.75,
    };
    stored = JSON.stringify({ state: { backdrop: custom } });
    runScript();
    expect(applied).toEqual(buildBackdropVars(custom));
  });

  it("fills missing keys from the defaults, like the runtime mapper", () => {
    stored = JSON.stringify({ state: { backdrop: { lightTop: "#0a0b0c" } } });
    runScript();
    expect(applied).toEqual(buildBackdropVars({ lightTop: "#0a0b0c" }));
    expect(applied["--bg-glow-size"]).toBe(`${DEFAULT_BACKDROP.glowSizeRem}rem`);
  });

  it("never throws on corrupt storage", () => {
    stored = "{not json";
    expect(() => runScript()).not.toThrow();
    expect(applied).toEqual({});
  });
});
