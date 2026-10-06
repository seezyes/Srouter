import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import PropTypes from "prop-types";
import { renderToPipeableStream } from "react-dom/server";
import { loadBindings, transform } from "next/dist/build/swc/index.js";
import nextDynamic from "next/dist/shared/lib/app-dynamic.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const components = new URL("../../src/shared/components/", import.meta.url);
let helperCode;
let modalsCode;
let kiroCode;

async function compile(name) {
  const file = new URL(name, components);
  return (await transform(readFileSync(file, "utf8"), {
    filename: file.pathname,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" },
  })).code;
}

function evaluate(code, dependencies) {
  const compiled = { exports: {} };
  new Function("module", "exports", "require", code)(compiled, compiled.exports, (id) => {
    const dependency = dependencies(id);
    if (!dependency) throw new Error(`Unexpected import: ${id}`);
    return dependency;
  });
  return compiled.exports;
}

function helper(react = React) {
  return evaluate(helperCode, (id) => id === "react" ? react : id === "prop-types" ? PropTypes : null).default;
}

function registry() {
  const imported = [];
  const options = [];
  // Use the actual Next App Router dynamic implementation and React Suspense.
  // A browser marker permits ssr:false children in the streaming test renderer;
  // modal implementations are stand-ins, but their real import loaders execute.
  const dynamic = (loader, config) => {
    options.push(config);
    return nextDynamic(loader, config);
  };
  const exports = evaluate(modalsCode, (id) => {
    if (id === "next/dynamic") return dynamic;
    if (id === "./onDemandModal") return helper();
    imported.push(id);
    return { __esModule: true, default: (props) => React.createElement("span", { "data-dialog": id }, props.isOpen ? props.title || "open" : "closed") };
  });
  return { exports, imported, options };
}

function render(element) {
  return new Promise((resolve, reject) => {
    const sink = new PassThrough();
    let html = "";
    sink.on("data", (chunk) => { html += chunk.toString(); });
    sink.on("end", () => resolve(html));
    sink.on("error", reject);
    const stream = renderToPipeableStream(element, {
      onAllReady() { stream.pipe(sink); },
      onError: reject,
    });
  });
}

beforeAll(async () => {
  await loadBindings();
  helperCode = await compile("onDemandModal.js");
  modalsCode = await compile("onDemandModals.js");
  kiroCode = await compile("KiroOAuthWrapper.js");
});
beforeEach(() => vi.stubGlobal("window", {}));
afterEach(() => vi.unstubAllGlobals());

describe("on-demand dialog runtime loading", () => {
  it("does not execute any modal import when every registered dialog is closed", async () => {
    const { exports, imported, options } = registry();
    const html = await render(React.createElement(React.Fragment, null,
      ...Object.values(exports).map((Dialog, index) => React.createElement(Dialog, { key: index, isOpen: false }))));
    expect(html).toBe("");
    expect(imported).toEqual([]);
    expect(options).toHaveLength(20);
    expect(options.every((option) => option.ssr === false)).toBe(true);
  });

  it.each(["OAuthModal", "ModelSelectModal", "DonateModal", "ChangelogModal", "KiroOAuthWrapper"])(
    "opening %s runs only that import and forwards the latest props", async (name) => {
      const { exports, imported } = registry();
      const html = await render(React.createElement(React.Fragment, null,
        ...Object.entries(exports).map(([key, Dialog]) => React.createElement(Dialog, {
          key, isOpen: key === name, title: "current props",
        }))));
      expect(imported).toEqual([`./${name}`]);
      expect(html).toContain("current props");
    },
  );

  it("retains an activated component for close/reset cleanup and subsequent reopening", () => {
    // Follow the same wrapper instance's state between owner renders, while
    // checking its actual React element identity and complete forwarded props.
    let activated = false;
    const gate = helper({
      ...React,
      useState: () => [activated, (value) => { activated = value; }],
    });
    const Component = vi.fn();
    const Dialog = gate(Component);
    const onClose = vi.fn();
    expect(Dialog({ isOpen: false })).toBeNull();
    const opened = Dialog({ isOpen: true, onClose, selectedModel: "first" });
    const closed = Dialog({ isOpen: false, onClose, selectedModel: "next" });
    const reopened = Dialog({ isOpen: true, onClose, selectedModel: "next" });
    expect(opened.type).toBe(Component);
    expect(closed.type).toBe(opened.type);
    expect(closed.props).toEqual({ isOpen: false, onClose, selectedModel: "next" });
    expect(reopened.type).toBe(opened.type);
    expect(reopened.props.selectedModel).toBe("next");
  });

  it("loads only the selected Kiro branch and preserves device/social return flows", async () => {
    const { exports, imported } = registry();
    const state = [];
    let cursor = 0;
    const react = {
      ...React,
      useCallback: (callback) => callback,
      useState: (initial) => {
        const index = cursor++;
        if (!(index in state)) state[index] = initial;
        return [state[index], (value) => { state[index] = value; }];
      },
    };
    const dependencies = {
      react,
      "react/jsx-runtime": jsxRuntime,
      "prop-types": PropTypes,
      "./onDemandModals": { __esModule: true, ...exports },
    };
    const Kiro = evaluate(kiroCode, (id) => dependencies[id]).default;
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    const ownerRender = (isOpen = true) => {
      cursor = 0;
      return Kiro({ isOpen, onClose, onSuccess, providerInfo: { name: "Kiro" } });
    };
    await render(ownerRender(false));
    expect(imported).toEqual([]);
    const selection = ownerRender();
    await render(selection);
    expect(imported).toEqual(["./KiroAuthModal"]);
    selection.props.onMethodSelect("idc", { startUrl: "https://example.invalid" });
    const device = ownerRender();
    await render(device);
    expect(imported).toEqual(["./KiroAuthModal", "./OAuthModal"]);
    expect(device.props.idcConfig.startUrl).toBe("https://example.invalid");
    device.props.onClose();
    expect(onClose).not.toHaveBeenCalled();
    const returned = ownerRender();
    expect(returned.type).toBe(selection.type);
    returned.props.onMethodSelect("social", { provider: "github" });
    const social = ownerRender();
    await render(social);
    expect(imported).toEqual(["./KiroAuthModal", "./OAuthModal", "./KiroSocialOAuthModal"]);
    expect(social.props.provider).toBe("github");
    social.props.onSuccess();
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(ownerRender(false).type).toBe(selection.type);
  });

  it("keeps visible non-dialog cards and lightweight primitives eager", () => {
    const barrel = readFileSync(new URL("index.js", components), "utf8");
    for (const name of ["ProviderInfoCard", "NoAuthProxyCard", "Card", "Button", "Input"]) {
      expect(barrel).toContain(`export { default as ${name} } from "./${name}"`);
    }
    expect(barrel).toContain('export { default as Modal, ConfirmModal } from "./Modal"');
    const login = readFileSync(new URL("../../src/app/login/page.js", import.meta.url), "utf8");
    expect(login).not.toMatch(/from ["']@\/shared\/components["']/);
  });

  it("keeps Kiro child branches lazy and the no-isOpen access dialog owner-conditional", () => {
    const kiro = readFileSync(new URL("KiroOAuthWrapper.js", components), "utf8");
    expect(kiro).toContain('from "./onDemandModals"');
    expect(kiro).not.toMatch(/import \w+ from "\.\/(?:OAuthModal|KiroAuthModal|KiroSocialOAuthModal)"/);
    const endpoint = readFileSync(new URL("../../src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js", import.meta.url), "utf8");
    expect(endpoint).toContain('dynamic(() => import("./components/ApiKeyAccessModal"), { ssr: false })');
    expect(endpoint).toContain("{accessKey && <ApiKeyAccessModal");
    expect(endpoint).not.toContain("onDemandModal(");
  });
});
