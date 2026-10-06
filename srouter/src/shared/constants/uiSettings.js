/**
 * UI settings: defaults plus the pure mapping helpers shared by the store, the
 * background component and the pre-paint script in src/app/layout.js.
 *
 * Everything here is framework-free on purpose so it can be imported from a
 * server component (the layout), from client components and from tests.
 */

// Must match the zustand-persist key in src/store/uiStore.js.
export const UI_STORAGE_KEY = "srouter-ui";

/**
 * Backdrop (the gradient painted underneath the cube field). Values mirror
 * globals.css so the app is unchanged until a developer edits something.
 * Numbers are alpha 0..1; colours are #rrggbb (alpha lives in its own key).
 */
export const DEFAULT_BACKDROP = Object.freeze({
  lightTop: "#f3f2f7",
  lightMid: "#dcd7ea",
  lightBottom: "#b9b1d2",
  lightGlow: "#6366f1",
  lightGlowAlpha: 0.14,
  darkTop: "#0b0e16",
  darkMid: "#07090f",
  darkBottom: "#04050a",
  darkGlow: "#6366f1",
  darkGlowAlpha: 0.14,
  glowSizeRem: 40,
  lightVignetteHex: "#4a4468",
  lightVignette: 0.3,
  darkVignetteHex: "#03050a",
  darkVignette: 0.62,
});

/**
 * Baked cube layer options. Geometry and face alpha are already in the bitmap;
 * dim controls the opacity of the entire transparent layer.
 */
export const DEFAULT_CUBE = Object.freeze({
  enabled: true,
  dim: 12, // host opacity, percent
});

export const BAKED_CUBE_TEXTURE = Object.freeze({
  src: "/backgrounds/iso-cube-compact.webp",
  cssWidth: 704,
  cssHeight: 352,
});

export const DEFAULT_UI = Object.freeze({
  developerMode: false,
  backdrop: DEFAULT_BACKDROP,
  cube: DEFAULT_CUBE,
});

// Bounds for the CSS backdrop and baked cube layer.
export const CUBE_LIMITS = Object.freeze({
  dim: { min: 0, max: 100, step: 1 },
  glowAlpha: { min: 0, max: 0.6, step: 0.01 },
  glowSizeRem: { min: 8, max: 80, step: 1 },
  vignette: { min: 0, max: 1, step: 0.01 },
});

/**
 * Which CSS custom property each backdrop field feeds, and how it is formatted.
 * Kept as a table so the app mapper and the pre-paint script cannot drift apart.
 * @type {Array<[string, string, "raw"|"rem"|`rgba:${string}`]>}
 */
export const BACKDROP_VAR_SPEC = Object.freeze([
  ["--bg-app-light-top", "lightTop", "raw"],
  ["--bg-app-light-mid", "lightMid", "raw"],
  ["--bg-app-light-bottom", "lightBottom", "raw"],
  ["--bg-app-light-glow", "lightGlow", "rgba:lightGlowAlpha"],
  ["--bg-app-top", "darkTop", "raw"],
  ["--bg-app-mid", "darkMid", "raw"],
  ["--bg-app-bottom", "darkBottom", "raw"],
  ["--bg-app-glow", "darkGlow", "rgba:darkGlowAlpha"],
  ["--bg-glow-size", "glowSizeRem", "rem"],
  ["--vignette-color-light", "lightVignetteHex", "rgba:lightVignette"],
  ["--vignette-color-dark", "darkVignetteHex", "rgba:darkVignette"],
]);

/** "#6366f1" + 0.2 -> "rgba(99, 102, 241, 0.2)" */
export function rgbaFromHex(hex, alpha = 1) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  const value = match ? match[1] : "000000";
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const a = Number.isFinite(Number(alpha)) ? Math.min(1, Math.max(0, Number(alpha))) : 0;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Resolve a backdrop patch into concrete CSS custom properties. */
export function buildBackdropVars(backdrop) {
  const b = { ...DEFAULT_BACKDROP, ...(backdrop || {}) };
  const out = {};
  for (const [name, key, format] of BACKDROP_VAR_SPEC) {
    if (format === "raw") out[name] = String(b[key]);
    else if (format === "rem") out[name] = `${Number(b[key]) || 0}rem`;
    else out[name] = rgbaFromHex(b[key], b[format.slice(5)]);
  }
  return out;
}

/**
 * Apply the backdrop variables to <html>. They are cosmetic CSS custom
 * properties, so this stays a no-op during SSR.
 */
export function applyBackdropVars(backdrop) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const vars = buildBackdropVars(backdrop);
  for (const name of Object.keys(vars)) root.style.setProperty(name, vars[name]);
}

/** Drop the inline overrides so globals.css defaults apply again. */
export function clearBackdropVars() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const [name] of BACKDROP_VAR_SPEC) root.style.removeProperty(name);
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Host opacity (0..1): the dim knob, dropped to 0 when the field is off. */
export function buildCubeHostOpacity(cube) {
  const c = { ...DEFAULT_CUBE, ...(cube || {}) };
  if (c.enabled === false) return 0;
  return clamp(c.dim, 0, 100, DEFAULT_CUBE.dim) / 100;
}

export function buildBakedCubeStyle(cube) {
  return {
    position: "absolute",
    inset: 0,
    opacity: buildCubeHostOpacity(cube),
    backgroundImage: `url("${BAKED_CUBE_TEXTURE.src}")`,
    backgroundSize: `${BAKED_CUBE_TEXTURE.cssWidth}px ${BAKED_CUBE_TEXTURE.cssHeight}px`,
    backgroundRepeat: "repeat",
  };
}

/**
 * Pre-paint script: applies the persisted backdrop variables before the first
 * paint so a reload never flashes the default gradient. Reads the same spec as
 * buildBackdropVars (only the three tiny format branches are restated, because
 * this has to run as an opaque string during SSR).
 *
 * Every key the script reads — including the alpha keys named in the "rgba:"
 * formats, which are separate fields in the store — is backfilled from the
 * defaults, so a backdrop persisted by an older build still paints correctly.
 */
const BACKDROP_READ_KEYS = (() => {
  const keys = new Set();
  for (const [, key, format] of BACKDROP_VAR_SPEC) {
    keys.add(key);
    if (format.startsWith("rgba:")) keys.add(format.slice(5));
  }
  return [...keys];
})();

export const UI_PREPAINT_SCRIPT = [
  "(function(){try{",
  `var raw=localStorage.getItem(${JSON.stringify(UI_STORAGE_KEY)});`,
  "if(!raw)return;",
  "var st=(JSON.parse(raw).state||{});var b=st.backdrop;if(!b)return;",
  `var spec=${JSON.stringify(BACKDROP_VAR_SPEC)};`,
  `var def=${JSON.stringify(DEFAULT_BACKDROP)};`,
  `var keys=${JSON.stringify(BACKDROP_READ_KEYS)};`,
  "for(var i=0;i<keys.length;i++){if(b[keys[i]]===undefined)b[keys[i]]=def[keys[i]]}",
  "var rgba=function(h,a){var m=/^#?([0-9a-f]{6})$/i.exec(String(h||''));var v=m?m[1]:'000000';",
  "a=Number(a);if(!isFinite(a))a=0;a=Math.min(1,Math.max(0,a));",
  "return 'rgba('+parseInt(v.slice(0,2),16)+', '+parseInt(v.slice(2,4),16)+', '+parseInt(v.slice(4,6),16)+', '+a+')'};",
  "var d=document.documentElement;",
  "for(var j=0;j<spec.length;j++){var name=spec[j][0],key=spec[j][1],fmt=spec[j][2],val;",
  "if(fmt==='raw')val=String(b[key]);else if(fmt==='rem')val=(Number(b[key])||0)+'rem';",
  "else val=rgba(b[key],b[fmt.slice(5)]);",
  "d.style.setProperty(name,val)}",
  "}catch(e){}})();",
].join("");
