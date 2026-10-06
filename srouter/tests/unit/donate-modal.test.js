import { readFileSync } from "node:fs";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import PropTypes from "prop-types";
import { loadBindings, transform } from "next/dist/build/swc/index.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const file = new URL("../../src/shared/components/DonateModal.js", import.meta.url);
const source = readFileSync(file, "utf8");
let DonateModal;

beforeAll(async () => {
  await loadBindings();
  const { code } = await transform(source, {
    filename: file.pathname,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" },
  });
  const imports = {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "react-dom": { createPortal: (children) => children },
    "prop-types": PropTypes,
    "next/image": {
      default: ({ unoptimized, ...props }) => React.createElement("img", props),
    },
  };
  const compiled = { exports: {} };
  new Function("module", "exports", "require", code)(compiled, compiled.exports, (id) => {
    if (!(id in imports)) throw new Error(`Unexpected DonateModal import: ${id}`);
    const dependency = imports[id];
    return "default" in dependency ? { ...dependency, __esModule: true } : dependency;
  });
  DonateModal = compiled.exports.default;
});

afterEach(() => vi.unstubAllGlobals());

function render() {
  vi.stubGlobal("document", { body: {} });
  return renderToStaticMarkup(React.createElement(DonateModal, { isOpen: true, onClose: () => {} }));
}

describe("local Srouter support modal", () => {
  it("uses the requested title and message without remote donation content", () => {
    const html = render();
    expect(html).toContain("Support Srouter");
    expect(html).toContain("If Srouter helps your work, consider supporting development. Thank you! ❤️");
    for (const removed of ["Ko-fi", "PayPal", "MoMo", "Support 9Router", "Loading..."]) {
      expect(html).not.toContain(removed);
    }
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("GITHUB_CONFIG");
  });

  it("retains the window limits, three-card grid and empty side cards", () => {
    const html = render();
    expect(html).toContain("max-w-3xl");
    expect(html).toContain("max-h-[85vh]");
    expect(html).toContain("grid-cols-1 sm:grid-cols-3 gap-4");
    expect(html.match(/min-h-\[390px\]/g)).toHaveLength(3);
    expect(html.match(/aria-hidden="true"[^>]*><\/div>/g)).toHaveLength(2);
  });

  it("shows only the owner's Telegram link and a local QR image in the middle card", () => {
    const html = render();
    expect(html.match(/href="https:\/\/t.me\/seezyes"/g)).toHaveLength(2);
    expect(html).toContain(">Tg t.me/seezyes</a>");
    expect(html).toContain('src="/support/telegram-seezyes.png"');
    expect(html).toContain('alt="QR code for https://t.me/seezyes"');
    expect(html).toContain('rel="noopener noreferrer"');
    const qr = readFileSync(new URL("../../public/support/telegram-seezyes.png", import.meta.url));
    expect(qr.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("adds a Telegram icon and an Open button below the QR with a safe external link", () => {
    const html = render();
    expect(html).toContain('<svg aria-hidden="true" viewBox="0 0 24 24"');
    expect(html).toContain("bg-sky-500/20 text-sky-500");
    expect(html).toContain(">Open<span");
    expect(html).toContain(">open_in_new</span>");
    expect(html.indexOf(">Open<span")).toBeGreaterThan(html.indexOf('src="/support/telegram-seezyes.png"'));
    expect(html.match(/target="_blank" rel="noopener noreferrer"/g)).toHaveLength(2);
  });

  it("renders nothing when closed or during server rendering without a document", () => {
    expect(renderToStaticMarkup(React.createElement(DonateModal, { isOpen: false, onClose: () => {} }))).toBe("");
    vi.stubGlobal("document", undefined);
    expect(renderToStaticMarkup(React.createElement(DonateModal, { isOpen: true, onClose: () => {} }))).toBe("");
  });
});
