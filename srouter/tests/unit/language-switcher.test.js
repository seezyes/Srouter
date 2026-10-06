import { readFileSync } from "node:fs";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { loadBindings, transform } from "next/dist/build/swc/index.js";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as config from "../../src/i18n/config.js";

const file = new URL("../../src/shared/components/LanguageSwitcher.js", import.meta.url);
let LanguageSwitcher;
let state;
let cursor;
const reloadTranslations = vi.fn();

beforeAll(async () => {
  await loadBindings();
  const { code } = await transform(readFileSync(file, "utf8"), {
    filename: file.pathname,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" },
  });
  const imports = {
    react: {
      ...React,
      useState: (initial) => {
        const index = cursor++;
        if (!(index in state)) state[index] = initial;
        return [state[index], (value) => { state[index] = value; }];
      },
      useEffect: () => {},
      useRef: () => ({ current: null }),
    },
    "react/jsx-runtime": jsxRuntime,
    "react-dom": { createPortal: (children) => children },
    "next/image": { default: ({ unoptimized, ...props }) => React.createElement("img", props) },
    "@/i18n/config": config,
    "@/i18n/runtime": { reloadTranslations },
  };
  const compiled = { exports: {} };
  new Function("module", "exports", "require", code)(compiled, compiled.exports, (id) => {
    if (!(id in imports)) throw new Error(`Unexpected import: ${id}`);
    const dependency = imports[id];
    return "default" in dependency ? { ...dependency, __esModule: true } : dependency;
  });
  LanguageSwitcher = compiled.exports.default;
});

beforeEach(() => {
  state = [];
  reloadTranslations.mockReset();
  vi.stubGlobal("document", { body: {} });
});
afterEach(() => vi.unstubAllGlobals());

function render(props = {}) {
  cursor = 0;
  return LanguageSwitcher({ isOpen: true, hideTrigger: true, ...props });
}

function find(tree, predicate) {
  if (!React.isValidElement(tree)) return null;
  if (predicate(tree)) return tree;
  for (const child of React.Children.toArray(tree.props.children)) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return null;
}

function search(query) {
  find(render(), (node) => node.type === "input").props.onChange({ target: { value: query } });
  return renderToStaticMarkup(render());
}

describe("language picker flags and search", () => {
  it("uses local SVG flags for all supported locales, not emoji", () => {
    const html = renderToStaticMarkup(render());
    const paths = [...html.matchAll(/src="(\/flags\/[^"]+\.svg)"/g)].map((match) => match[1]);
    expect(paths).toHaveLength(config.LOCALES.length);
    expect(new Set(paths).size).toBe(config.LOCALES.length);
    for (const path of paths) {
      const svg = readFileSync(new URL(`../../public${path}`, import.meta.url), "utf8");
      expect(svg).toContain("<svg");
      expect(svg).not.toMatch(/<script|<image|https?:\/\/(?!www\.w3\.org)/);
    }
    expect(html).not.toMatch(/\p{Regional_Indicator}/u);
    expect(html).toContain('src="/flags/us.svg"');
    expect(html).toContain('alt=""');
  });

  it("mounts an autofocus search in the header before the language grid", () => {
    const tree = render();
    const input = find(tree, (node) => node.type === "input");
    expect(input.props).toMatchObject({ type: "search", autoFocus: true, "aria-label": "Search languages" });
    const html = renderToStaticMarkup(tree);
    expect(html.indexOf('type="search"')).toBeLessThan(html.indexOf('src="/flags/us.svg"'));
  });

  it("shows the uppercase country code beside every flag, including the trigger", () => {
    const html = renderToStaticMarkup(render());
    const pairs = [...html.matchAll(/src="\/flags\/([^.]+)\.svg"[^>]*\/?><span[^>]*>([A-Z]{2})<\/span>/g)];
    expect(pairs).toHaveLength(config.LOCALES.length);
    for (const [, country, code] of pairs) expect(code).toBe(country.toUpperCase());
    const trigger = renderToStaticMarkup(render({ isOpen: false, hideTrigger: false }));
    expect(trigger).toMatch(/src="\/flags\/us\.svg"[^>]*\/?><span[^>]*>US<\/span>/);
  });

  it.each([
    ["  рУс  ", ["ru"]],
    ["pt-", ["br", "pt"]],
    ["KR", ["kr"]],
    ["English", ["us"]],
    ["中文", ["cn", "tw"]],
  ])("filters native names, locale and country codes for %s", (query, countries) => {
    const html = search(query);
    expect([...html.matchAll(/src="\/flags\/([^.]+)\.svg"/g)].map((match) => match[1])).toEqual(countries);
  });

  it("shows an empty state and restores all languages when cleared", () => {
    expect(search("not-a-language")).toContain("No languages found");
    expect(search("").match(/src="\/flags\//g)).toHaveLength(config.LOCALES.length);
  });

  it("clears the query on close and preserves controlled close behavior", () => {
    search("ru");
    const onClose = vi.fn();
    find(render({ onClose }), (node) => node.props["aria-label"] === "Close").props.onClick();
    expect(onClose).toHaveBeenCalledWith("en");
    expect(find(render(), (node) => node.type === "input").props.value).toBe("");
  });

  it("keeps locale saving and translation reload after selecting a filtered result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    search("ru");
    const onClose = vi.fn();
    const button = find(render({ onClose }), (node) => node.type === "button" && node.props.title === "Русский");
    await button.props.onClick();
    expect(fetch).toHaveBeenCalledWith("/api/locale", expect.objectContaining({
      method: "POST", body: JSON.stringify({ locale: "ru" }),
    }));
    expect(reloadTranslations).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("ru");
    expect(find(render(), (node) => node.type === "input").props.value).toBe("");
  });
});
