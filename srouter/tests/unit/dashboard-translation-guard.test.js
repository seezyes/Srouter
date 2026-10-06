import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const layout = readFileSync(new URL("../../src/app/layout.js", import.meta.url), "utf8");

describe("dashboard browser translation compatibility", () => {
  it("declares initial English without prohibiting manual browser translation", () => {
    expect(layout).toMatch(/<html[^>]*lang="en"/);
    expect(layout).not.toContain('translate="no"');
    expect(layout).not.toContain("notranslate");
    expect(layout).toContain("<RuntimeI18nProvider>");
    expect(layout).not.toContain("data-i18n-skip");
  });
});

describe("runtime document language", () => {
  let runtime;
  let text;
  let skipText;
  let observerCallback;

  beforeEach(async () => {
    vi.resetModules();
    const root = { lang: "en", hasAttribute: () => false };
    const body = {
      nodeType: 1, tagName: "BODY", parentElement: root, hasAttribute: () => false,
      matches: () => false, querySelectorAll: () => [],
    };
    text = { nodeValue: "Providers", parentElement: body };
    skipText = {
      nodeValue: "Providers",
      parentElement: { tagName: "SPAN", parentElement: body, hasAttribute: () => true },
    };
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {
      cookie: "locale=ru",
      documentElement: root,
      body,
      createTreeWalker: () => {
        const nodes = [text, skipText];
        return { nextNode: () => nodes.shift() || null };
      },
    });
    vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4 });
    vi.stubGlobal("Node", { ELEMENT_NODE: 1, TEXT_NODE: 3 });
    vi.stubGlobal("MutationObserver", class {
      constructor(callback) { observerCallback = callback; }
      observe() {}
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ Providers: "Провайдеры", Settings: "Настройки" }),
    }));
    runtime = await import("../../src/i18n/runtime.js");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps English until the dictionary is loaded, then applies text and language", async () => {
    let resolveFetch;
    fetch.mockReturnValueOnce(new Promise(resolve => { resolveFetch = resolve; }));
    const init = runtime.initRuntimeI18n();
    expect(document.documentElement.lang).toBe("en");
    expect(text.nodeValue).toBe("Providers");
    resolveFetch({ ok: true, json: async () => ({ Providers: "Провайдеры" }) });
    await init;
    expect(text.nodeValue).toBe("Провайдеры");
    expect(document.documentElement.lang).toBe("ru");
    expect(skipText.nodeValue).toBe("Providers");
  });

  it("restores English text and language without fetching an English dictionary", async () => {
    await runtime.initRuntimeI18n();
    document.cookie = "locale=en";
    await runtime.reloadTranslations();
    expect(text.nodeValue).toBe("Providers");
    expect(document.documentElement.lang).toBe("en");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("updates language and text when switching to another supported locale", async () => {
    await runtime.initRuntimeI18n();
    document.cookie = "locale=zh";
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ Providers: "提供商" }) });
    await runtime.reloadTranslations();
    expect(text.nodeValue).toBe("提供商");
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("keeps translating React text rewrites", async () => {
    await runtime.initRuntimeI18n();
    text.nodeValue = "Settings";
    observerCallback([{ type: "characterData", target: text }]);
    expect(text.nodeValue).toBe("Настройки");
    observerCallback([{ type: "characterData", target: text }]);
    document.cookie = "locale=en";
    await runtime.reloadTranslations();
    expect(text.nodeValue).toBe("Settings");
  });

  it("does not localize new icon ligatures before the icon observer runs", async () => {
    await runtime.initRuntimeI18n();
    const iconText = {
      nodeValue: "Providers",
      parentElement: {
        tagName: "SPAN", hasAttribute: () => false,
        classList: { contains: name => name === "material-symbols-outlined" },
      },
    };
    observerCallback([{ type: "characterData", target: iconText }]);
    expect(iconText.nodeValue).toBe("Providers");
    expect(iconText._originalText).toBeUndefined();
  });

  it.each(["network", "http", "json"])("uses English fallback after a %s dictionary failure", async (failure) => {
    await runtime.initRuntimeI18n();
    vi.spyOn(console, "error").mockImplementation(() => {});
    if (failure === "network") fetch.mockRejectedValueOnce(new Error("offline"));
    if (failure === "http") fetch.mockResolvedValueOnce({ ok: false, status: 404 });
    if (failure === "json") fetch.mockResolvedValueOnce({
      ok: true, json: async () => { throw new Error("invalid JSON"); },
    });
    await runtime.reloadTranslations();
    expect(text.nodeValue).toBe("Providers");
    expect(document.documentElement.lang).toBe("en");
  });

  it("normalizes unsupported locale cookies to English", async () => {
    document.cookie = "locale=unsupported";
    await runtime.initRuntimeI18n();
    expect(document.documentElement.lang).toBe("en");
    expect(text.nodeValue).toBe("Providers");
    expect(fetch).not.toHaveBeenCalled();
  });
});
