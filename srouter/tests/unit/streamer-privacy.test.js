import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  createStreamerPrivacyGuard, readStreamerPreference,
  writeStreamerPreference, STREAMER_PREPAINT_SCRIPT, STREAMER_STORAGE_KEY,
  STREAMER_HIDDEN_LABEL,
} from "../../src/shared/utils/streamerPrivacy.js";

describe("streamer persistence and prepaint", () => {
  it("defaults off, persists only a boolean and survives unavailable storage", () => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
    expect(readStreamerPreference(storage)).toBe(false);
    storage.getItem.mockReturnValue("true");
    expect(readStreamerPreference(storage)).toBe(true);
    storage.getItem.mockReturnValue('{"enabled":true}');
    expect(readStreamerPreference(storage)).toBe(false);
    writeStreamerPreference(storage, true);
    expect(storage.setItem).toHaveBeenCalledWith(STREAMER_STORAGE_KEY, "true");
    writeStreamerPreference(storage, false);
    expect(storage.setItem).toHaveBeenLastCalledWith(STREAMER_STORAGE_KEY, "false");
    const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
    expect(readStreamerPreference(blocked)).toBe(false);
    expect(() => writeStreamerPreference(blocked, true)).not.toThrow();
  });

  it.each(["/dashboard", "/dashboard/quota", "/dashboard/harness/deepseek-harness"])(
    "applies persisted privacy before paint on %s", pathname => {
      const add = vi.fn();
      runInNewContext(STREAMER_PREPAINT_SCRIPT, {
        location: { pathname }, localStorage: { getItem: () => "true" },
        document: { documentElement: { classList: { add } } },
      });
      expect(add).toHaveBeenCalledWith("streamer-mode");
    },
  );

  it.each(["/login", "/dashboardish", "/"])("does not cover unrelated route %s", pathname => {
    const add = vi.fn();
    runInNewContext(STREAMER_PREPAINT_SCRIPT, {
      location: { pathname }, localStorage: { getItem: () => "true" },
      document: { documentElement: { classList: { add } } },
    });
    expect(add).not.toHaveBeenCalled();
  });

  it("keeps a saved off preference off", () => {
    const add = vi.fn();
    runInNewContext(STREAMER_PREPAINT_SCRIPT, {
      location: { pathname: "/dashboard" }, localStorage: { getItem: () => "false" },
      document: { documentElement: { classList: { add } } },
    });
    expect(add).not.toHaveBeenCalled();
  });
});

// A small DOM fixture: callbacks are delivered explicitly to exercise lifecycle
// and restoration without launching a browser or touching working dashboard data.
function element(tag = "span", text = "", attrs = {}, children = []) {
  const attributes = new Map(Object.entries(attrs));
  const node = {
    nodeType: 1, tagName: tag.toUpperCase(), children, parentElement: null, isConnected: true,
    childNodes: [...(text ? [{ nodeType: 3, textContent: text }] : []), ...children],
    getAttribute: name => attributes.get(name) ?? null,
    hasAttribute: name => attributes.has(name),
    setAttribute: (name, value) => attributes.set(name, String(value)),
    removeAttribute: name => attributes.delete(name),
    matches(selector) {
      return selector.split(",").some(item => {
        const value = item.trim();
        if (value.startsWith("[")) return attributes.has(value.slice(1, -1));
        if (value.startsWith(".")) return (attributes.get("class") || "").split(" ").includes(value.slice(1));
        return value.toUpperCase() === node.tagName;
      });
    },
    closest(selector) {
      return node.matches(selector) ? node : node.parentElement?.closest(selector);
    },
    querySelectorAll() {
      return children.flatMap(child => [child, ...child.querySelectorAll("*")]);
    },
  };
  Object.defineProperty(node, "textContent", {
    get: () => node.childNodes.map(child => child.textContent).join(""),
    set: value => { node.childNodes = [{ nodeType: 3, textContent: value, parentElement: node }]; },
  });
  Object.defineProperty(node, "value", {
    get: () => attributes.get("value") ?? node.textContent,
  });
  Object.defineProperty(node, "options", { get: () => children.filter(child => child.tagName === "OPTION") });
  for (const child of node.childNodes) child.parentElement = node;
  return node;
}

function documentFixture(children) {
  let deliver;
  const disconnect = vi.fn();
  const observe = vi.fn();
  const root = element("html");
  const classes = new Set();
  root.classList = {
    toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    contains: name => classes.has(name),
  };
  const doc = {
    documentElement: root, body: element("body", "", {}, children),
    defaultView: {
      MutationObserver: class {
        constructor(callback) { deliver = callback; }
        observe(...args) { observe(...args); }
        disconnect() { disconnect(); }
      },
    },
  };
  return { doc, deliver: records => deliver(records), disconnect, observe };
}

describe("streamer DOM guard", () => {
  it("masks account names/emails and tooltips but preserves labels and data", () => {
    const name = element("span", "PLUS user@example.test", { "data-streamer-sensitive": "", title: "user@example.test" });
    const nickname = element("span", "My account", { "data-streamer-sensitive": "" });
    const plain = element("p", "OpenAI Codex");
    const input = element("input", "", { value: "opaque-provider-credential" });
    const fixture = documentFixture([name, nickname, plain, input]);
    const guard = createStreamerPrivacyGuard(fixture.doc);
    guard.setEnabled(true);
    expect(name.getAttribute("data-streamer-mask")).toBe("true");
    expect(name.getAttribute("title")).toBe(STREAMER_HIDDEN_LABEL);
    expect(name.textContent).toBe("PLUS user@example.test");
    expect(nickname.getAttribute("data-streamer-mask")).toBe("true");
    expect(plain.getAttribute("data-streamer-mask")).toBeNull();
    expect(input.value).toBe("opaque-provider-credential");
    expect(fixture.doc.documentElement.getAttribute("data-streamer-ready")).toBe("true");
    guard.setEnabled(false);
    expect(name.getAttribute("data-streamer-mask")).toBeNull();
    expect(name.getAttribute("title")).toBe("user@example.test");
    expect(fixture.doc.documentElement.classList.contains("streamer-mode")).toBe(false);
    expect(fixture.disconnect).toHaveBeenCalledOnce();
  });

  it("covers explicit split text and skips scripts/icons without heuristics", () => {
    const split = element("span", "", { "data-streamer-sensitive": "" }, [element("span", "user"), element("span", "@example.test")]);
    const script = element("script", 'const fixture = "user@example.test";');
    const icon = element("span", "user@example.test", { class: "material-symbols-outlined" });
    const unmarked = element("p", "user@example.test sk-fixture", { title: "Bearer fixture" });
    const image = element("img", "", { src: "data:image/png;base64,fixture", alt: "QR code" });
    const fixture = documentFixture([split, script, icon, unmarked, image]);
    createStreamerPrivacyGuard(fixture.doc).setEnabled(true);
    expect(split.getAttribute("data-streamer-mask")).toBe("true");
    expect(script.getAttribute("data-streamer-mask")).toBeNull();
    expect(icon.getAttribute("data-streamer-mask")).toBeNull();
    expect(unmarked.getAttribute("data-streamer-mask")).toBeNull();
    expect(unmarked.getAttribute("title")).toBe("Bearer fixture");
    expect(image.getAttribute("data-streamer-mask")).toBeNull();
  });

  it("covers newly mounted portals and changing labels without masking entire cards", () => {
    const text = element("p", "ordinary");
    const fixture = documentFixture([text]);
    const guard = createStreamerPrivacyGuard(fixture.doc);
    guard.setEnabled(true);
    text.setAttribute("data-streamer-sensitive", "");
    text.textContent = "My nickname";
    fixture.deliver([{ type: "characterData", target: text.childNodes[0] }]);
    expect(text.getAttribute("data-streamer-mask")).toBe("true");
    text.textContent = "Account 2";
    fixture.deliver([{ type: "characterData", target: text.childNodes[0] }]);
    expect(text.getAttribute("data-streamer-mask")).toBe("true");
    text.removeAttribute("data-streamer-sensitive");
    fixture.deliver([{ type: "attributes", target: text }]);
    expect(text.getAttribute("data-streamer-mask")).toBeNull();
    const portal = element("div", "", {}, [element("span", "opaque", { "data-streamer-sensitive": "" })]);
    fixture.deliver([{ type: "childList", target: fixture.doc.body, addedNodes: [portal] }]);
    expect(portal.children[0].getAttribute("data-streamer-mask")).toBe("true");
    expect(portal.getAttribute("data-streamer-mask")).toBeNull();
  });

  it("hides native option labels without changing explicit or implicit option values", () => {
    const explicit = element("option", "My account", { "data-streamer-sensitive": "", value: "account-id" });
    const implicit = element("option", "other@example.test", { "data-streamer-sensitive": "" });
    const labelled = element("option", "Account 3", { "data-streamer-sensitive": "", label: "third@example.test", value: "third" });
    const fixture = documentFixture([element("select", "", {}, [explicit, implicit, labelled])]);
    const guard = createStreamerPrivacyGuard(fixture.doc);
    guard.setEnabled(true);
    expect(explicit.textContent).toContain(STREAMER_HIDDEN_LABEL);
    expect(explicit.value).toBe("account-id");
    expect(implicit.value).toBe("other@example.test");
    expect(labelled.getAttribute("label")).toBe(STREAMER_HIDDEN_LABEL);
    guard.setEnabled(false);
    expect(explicit.textContent).toBe("My account");
    expect(implicit.textContent).toBe("other@example.test");
    expect(implicit.hasAttribute("value")).toBe(false);
    expect(labelled.getAttribute("label")).toBe("third@example.test");
  });

  it("preserves newer React-provided option labels and attributes on disable", () => {
    const option = element("option", "user@example.test", { "data-streamer-sensitive": "", value: "account-id" });
    const span = element("span", "Account", { "data-streamer-sensitive": "", title: "user@example.test" });
    const fixture = documentFixture([element("select", "", {}, [option]), span]);
    const guard = createStreamerPrivacyGuard(fixture.doc);
    guard.setEnabled(true);
    option.textContent = "new@example.test";
    fixture.deliver([{ type: "childList", target: option, addedNodes: [] }]);
    span.setAttribute("title", "new@example.test");
    fixture.deliver([{ type: "attributes", target: span }]);
    guard.setEnabled(false);
    expect(option.textContent).toBe("new@example.test");
    expect(span.getAttribute("title")).toBe("new@example.test");
  });

  it("does not overwrite a newer safe tooltip", () => {
    const span = element("span", "", { "data-streamer-sensitive": "", title: "user@example.test" });
    const fixture = documentFixture([span]);
    const guard = createStreamerPrivacyGuard(fixture.doc);
    guard.setEnabled(true);
    span.setAttribute("title", "Safe replacement");
    guard.setEnabled(false);
    expect(span.getAttribute("title")).toBe("Safe replacement");
  });

  it("restores attributes and option labels when their explicit marker is removed", () => {
    const option = element("option", "My account", { "data-streamer-sensitive": "", label: "My account" });
    const span = element("span", "nickname", { "data-streamer-sensitive": "", title: "nickname" });
    const fixture = documentFixture([element("select", "", {}, [option]), span]);
    const guard = createStreamerPrivacyGuard(fixture.doc);
    guard.setEnabled(true);
    option.removeAttribute("data-streamer-sensitive");
    span.removeAttribute("data-streamer-sensitive");
    fixture.deliver([{ type: "attributes", target: option }, { type: "attributes", target: span }]);
    expect(option.textContent).toBe("My account");
    expect(option.getAttribute("label")).toBe("My account");
    expect(option.value).toBe("My account");
    expect(span.getAttribute("title")).toBe("nickname");
    expect(span.getAttribute("data-streamer-mask")).toBeNull();
    guard.dispose();
  });

  it("suppresses sensitive link hover URLs, QR images and datalist popups reversibly", () => {
    const anchor = element("a", "Login", { "data-streamer-private-attributes": "", href: "https://example.test/?token=fixture" });
    const img = element("img", "", { "data-streamer-sensitive": "", alt: "QR code user@example.test", src: "https://example.test/qr.png" });
    const input = element("input", "", { list: "credential-list", value: "opaque" });
    const fixture = documentFixture([anchor, img, input]);
    const guard = createStreamerPrivacyGuard(fixture.doc);
    guard.setEnabled(true);
    expect(anchor.getAttribute("href")).toBeNull();
    expect(img.getAttribute("data-streamer-mask")).toBe("true");
    fixture.deliver([{ type: "attributes", target: img }]);
    expect(img.getAttribute("data-streamer-mask")).toBe("true");
    expect(input.getAttribute("list")).toBeNull();
    expect(input.value).toBe("opaque");
    guard.setEnabled(false);
    expect(anchor.getAttribute("href")).toContain("token=fixture");
    expect(img.getAttribute("data-streamer-mask")).toBeNull();
    expect(input.getAttribute("list")).toBe("credential-list");
  });

  it("covers explicitly marked opaque credentials, including native key options", () => {
    const secret = element("span", "opaque", { "data-streamer-sensitive": "true", title: "opaque" });
    const option = element("option", "opaque", { "data-streamer-sensitive": "true", value: "opaque" });
    const fixture = documentFixture([secret, element("select", "", {}, [option])]);
    const guard = createStreamerPrivacyGuard(fixture.doc);
    guard.setEnabled(true);
    expect(secret.getAttribute("title")).toBe(STREAMER_HIDDEN_LABEL);
    expect(option.textContent).toContain(STREAMER_HIDDEN_LABEL);
    expect(option.value).toBe("opaque");
    guard.dispose();
    expect(option.textContent).toBe("opaque");
    expect(secret.getAttribute("title")).toBe("opaque");
  });

  it("masks explicitly marked form fields and unmasks them on disable", () => {
    const name = element("input", "", { "data-streamer-sensitive": "", value: "X-Custom-Token" });
    const value = element("input", "", { "data-streamer-sensitive": "", value: "secret-token" });
    const plain = element("input", "", { value: "opaque" });
    const fixture = documentFixture([name, value, plain]);
    const guard = createStreamerPrivacyGuard(fixture.doc);
    guard.setEnabled(true);
    expect(name.getAttribute("data-streamer-mask")).toBe("true");
    expect(value.getAttribute("data-streamer-mask")).toBe("true");
    expect(plain.getAttribute("data-streamer-mask")).toBeNull();
    // Screen-sharing guard only: field values stay intact for save and copy.
    expect(name.value).toBe("X-Custom-Token");
    expect(value.value).toBe("secret-token");
    guard.setEnabled(false);
    expect(name.getAttribute("data-streamer-mask")).toBeNull();
    expect(value.getAttribute("data-streamer-mask")).toBeNull();
    expect(value.value).toBe("secret-token");
  });

  it("does not loop on self-authored option and title mutations", () => {
    const option = element("option", "user@example.test", { "data-streamer-sensitive": "", value: "id" });
    const span = element("span", "user@example.test", { "data-streamer-sensitive": "", title: "user@example.test" });
    const fixture = documentFixture([element("select", "", {}, [option]), span]);
    const guard = createStreamerPrivacyGuard(fixture.doc);
    guard.setEnabled(true);
    const text = option.textContent;
    fixture.deliver([{ type: "childList", target: option, addedNodes: [] }, { type: "attributes", target: span }]);
    guard.setEnabled(true);
    expect(option.textContent).toBe(text);
    expect(fixture.observe).toHaveBeenCalledOnce();
    guard.dispose();
    guard.dispose();
    expect(fixture.disconnect).toHaveBeenCalledOnce();
  });

  it("clears a stale prepaint class when the persisted setting is off", () => {
    const fixture = documentFixture([]);
    fixture.doc.documentElement.classList.toggle("streamer-mode", true);
    createStreamerPrivacyGuard(fixture.doc).setEnabled(false);
    expect(fixture.doc.documentElement.classList.contains("streamer-mode")).toBe(false);
  });

  it("restores detached portal nodes before dropping references, then protects them if reinserted", () => {
    const span = element("span", "user@example.test", { "data-streamer-sensitive": "", title: "user@example.test" });
    const fixture = documentFixture([span]);
    const guard = createStreamerPrivacyGuard(fixture.doc);
    guard.setEnabled(true);
    span.isConnected = false;
    fixture.doc.body.children.length = 0;
    fixture.deliver([{ type: "childList", target: fixture.doc.body, addedNodes: [] }]);
    expect(span.getAttribute("title")).toBe("user@example.test");
    expect(span.getAttribute("data-streamer-mask")).toBeNull();
    span.isConnected = true;
    fixture.doc.body.children.push(span);
    fixture.deliver([{ type: "childList", target: fixture.doc.body, addedNodes: [span] }]);
    expect(span.getAttribute("title")).toBe(STREAMER_HIDDEN_LABEL);
    expect(span.getAttribute("data-streamer-mask")).toBe("true");
    guard.dispose();
    expect(span.getAttribute("title")).toBe("user@example.test");
  });
});

describe("streamer wiring and concealment CSS", () => {
  it("replaces only inline private labels with solid rounded panels in normal flow", () => {
    const css = readFileSync(new URL("../../src/shared/components/streamerMode.css", import.meta.url), "utf8");
    expect(css).toContain('html.streamer-mode:not([data-streamer-ready="true"])');
    expect(css).toContain("color: transparent !important");
    expect(css).toContain("input[type=\"text\"]");
    expect(css).toContain("textarea");
    expect(css).toContain("pre, textarea");
    expect(css).toContain("::selection");
    expect(css).not.toContain("filter: blur");
    expect(css).not.toContain("repeating-linear-gradient");
    expect(css).not.toMatch(/background\s*:/);
    expect(css).toContain(":not(.material-symbols-outlined)");
    expect(css).toContain(':is(span, code)[data-streamer-sensitive]');
    expect(css).toContain("font-size: 0 !important");
    expect(css).toContain("width: 112px !important");
    expect(css).toContain("min-width: 112px !important");
    expect(css).toContain("max-width: 112px !important");
    expect(css).toContain("height: 10px !important");
    expect(css).toContain("flex: none !important");
    expect(css).toContain("background-color: #242936 !important");
    expect(css).toContain("border-radius: 4px !important");
    expect(css).toContain("display: none !important");
    expect(css).not.toContain("position: absolute");
    expect(css).not.toContain("::after");
    expect(css).not.toContain("::before");
  });
});
