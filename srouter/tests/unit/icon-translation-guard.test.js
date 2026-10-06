import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function element(classes = [], children = []) {
  const classNames = new Set(classes);
  const attributes = new Map();
  return {
    nodeType: 1,
    children,
    matches: selector => selector === ".material-symbols-outlined" &&
      classNames.has("material-symbols-outlined"),
    querySelectorAll(selector) {
      return children.flatMap(child => child.nodeType === 1
        ? [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]
        : []);
    },
    classList: { contains: name => classNames.has(name), add: vi.fn(name => classNames.add(name)) },
    getAttribute: name => attributes.get(name) ?? null,
    setAttribute: vi.fn((name, value) => attributes.set(name, value)),
  };
}

describe("icon-only translation protection", () => {
  let init;
  let callback;
  let observe;
  let constructor;
  let icon;
  let label;
  let button;
  let body;

  beforeEach(async () => {
    vi.resetModules();
    icon = element(["material-symbols-outlined"]);
    label = element();
    button = element([], [icon, label]);
    body = element([], [button]);
    observe = vi.fn();
    constructor = vi.fn();
    vi.stubGlobal("document", { body });
    vi.stubGlobal("MutationObserver", class {
      constructor(fn) { constructor(); callback = fn; }
      observe(...args) { observe(...args); }
    });
    ({ initIconTranslationGuard: init } = await import("../../src/i18n/iconTranslationGuard.js"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const expectProtected = icon => {
    expect(icon.getAttribute("translate")).toBe("no");
    expect(icon.classList.contains("notranslate")).toBe(true);
    expect(icon.getAttribute("data-i18n-skip")).toBe("true");
  };

  it("protects initial glyphs but leaves the label, button and body translatable", () => {
    init();
    expectProtected(icon);
    for (const normal of [body, button, label]) {
      expect(normal.getAttribute("translate")).toBeNull();
      expect(normal.classList.contains("notranslate")).toBe(false);
      expect(normal.getAttribute("data-i18n-skip")).toBeNull();
    }
  });

  it("protects dynamically added icons and icons nested in modals", () => {
    init();
    const added = element(["material-symbols-outlined"]);
    const nested = element(["material-symbols-outlined"]);
    const modal = element([], [nested]);
    callback([{ type: "childList", addedNodes: [added, modal, { nodeType: 3 }] }]);
    expectProtected(added);
    expectProtected(nested);
    expect(modal.getAttribute("translate")).toBeNull();
  });

  it("protects an existing element when React turns it into an icon", () => {
    init();
    label.classList.add("material-symbols-outlined");
    callback([{ type: "attributes", target: label }]);
    expectProtected(label);
    expect(observe).toHaveBeenCalledWith(body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["class"],
    });
  });

  it("is idempotent and does not loop on its own class mutation", () => {
    init();
    const attributeWrites = icon.setAttribute.mock.calls.length;
    const classWrites = icon.classList.add.mock.calls.length;
    callback([{ type: "attributes", target: icon }]);
    init();
    expect(icon.setAttribute).toHaveBeenCalledTimes(attributeWrites);
    expect(icon.classList.add).toHaveBeenCalledTimes(classWrites);
    expect(constructor).toHaveBeenCalledTimes(1);
  });

  it("runs safely without a browser document", () => {
    vi.stubGlobal("document", undefined);
    // Server environments have no document binding, rather than undefined.
    vi.unstubAllGlobals();
    expect(init).not.toThrow();
  });
});
