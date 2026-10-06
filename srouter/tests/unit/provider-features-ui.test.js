import { readFileSync } from "node:fs";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import PropTypes from "prop-types";
import { loadBindings, transform } from "next/dist/build/swc/index.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getProviderFeatures } from "../../open-sse/config/providerFeatures.js";
import { chooseProviderFeature } from "../../src/shared/utils/providerFeatureConfirmation.js";

let Card;
let frames;
let active;
let cursor;
const render = (component, props) => {
  active = frames.get(component) || [];
  frames.set(component, active);
  cursor = 0;
  return component(props);
};
function state(initial) {
  const frame = active;
  const index = cursor++;
  if (!(index in frame)) frame[index] = initial;
  return [frame[index], (value) => {
    frame[index] = typeof value === "function" ? value(frame[index]) : value;
  }];
}
function find(tree, predicate) {
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const match = find(child, predicate);
      if (match) return match;
    }
  } else if (tree && typeof tree === "object") {
    if (predicate(tree)) return tree;
    return find(tree.props?.children, predicate);
  }
  return null;
}
const button = (tree, label) => find(tree, (node) => node.type === "button" && node.props["aria-label"] === label);
const modalStub = () => null;

beforeAll(async () => {
  await loadBindings();
  const filename = new URL("../../src/app/(dashboard)/dashboard/providers/components/ProviderFeaturesCard.js", import.meta.url);
  const { code } = await transform(readFileSync(filename, "utf8"), {
    filename: filename.pathname,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" },
  });
  const dependencies = {
    react: { ...React, useState: state },
    "react/jsx-runtime": jsxRuntime,
    "prop-types": PropTypes,
    "@/shared/components": { Modal: modalStub },
    "open-sse/config/providerFeatures.js": { getProviderFeatures },
    "@/shared/utils/providerFeatureConfirmation": { chooseProviderFeature },
  };
  const compiled = { exports: {} };
  new Function("module", "exports", "require", code)(
    compiled, compiled.exports, (id) => {
      if (!(id in dependencies)) throw new Error(`Unexpected dependency ${id}`);
      return dependencies[id];
    },
  );
  Card = compiled.exports.default;
});
beforeEach(() => { frames = new Map(); });

function openDialog(controls) {
  const props = { providerName: "Fixture provider", controls };
  let card = render(Card, props);
  expect(find(card, (node) => node.type === modalStub)).toBeNull();
  find(card, (node) => node.type === "button").props.onClick();
  card = render(Card, props);
  const dialog = find(card, (node) => typeof node.type === "function");
  return { props: dialog.props, component: dialog.type, draw: () => render(dialog.type, dialog.props) };
}
function controls() {
  return {
    features: { accountPools: true, serviceTier: true, customHeaders: true },
    capabilities: { accountPools: true, serviceTier: true, customHeaders: true },
    ready: true, saving: false, error: "", save: vi.fn().mockResolvedValue(true),
  };
}

describe("actual provider feature card event handlers", () => {
  it("opens a dialog and requires two clicks before saving", async () => {
    const state = controls();
    const dialog = openDialog(state);
    await button(dialog.draw(), "Change Account Pools").props.onClick();
    expect(state.save).not.toHaveBeenCalled();
    expect(state.features.accountPools).toBe(true);
    await button(dialog.draw(), "Confirm Account Pools disable").props.onClick();
    expect(state.save).toHaveBeenCalledExactlyOnceWith("accountPools", false);
    expect(button(dialog.draw(), "Confirm Account Pools disable")).toBeNull();
  });
  it("changing the chosen feature re-arms rather than saving either setting", async () => {
    const state = controls();
    const dialog = openDialog(state);
    await button(dialog.draw(), "Change Account Pools").props.onClick();
    await button(dialog.draw(), "Change Custom Headers").props.onClick();
    expect(state.save).not.toHaveBeenCalled();
    expect(button(dialog.draw(), "Confirm Custom Headers disable")).toBeTruthy();
    expect(button(dialog.draw(), "Confirm Account Pools disable")).toBeNull();
  });
  it("cancel discards pending intent and a failed save retains the confirmation", async () => {
    const state = controls();
    state.save.mockResolvedValue(false);
    const dialog = openDialog(state);
    await button(dialog.draw(), "Change Service Tier").props.onClick();
    await button(dialog.draw(), "Confirm Service Tier disable").props.onClick();
    expect(button(dialog.draw(), "Confirm Service Tier disable")).toBeTruthy();
    find(dialog.draw(), (node) => node.type === "button" && node.props.children === "Cancel change").props.onClick();
    expect(button(dialog.draw(), "Confirm Service Tier disable")).toBeNull();
    expect(state.features.serviceTier).toBe(true);
  });
  it("does not allow changes during loading or saving and hides unsupported features", async () => {
    const state = controls();
    state.capabilities.serviceTier = false;
    state.ready = false;
    const dialog = openDialog(state);
    expect(button(dialog.draw(), "Change Service Tier")).toBeNull();
    const control = button(dialog.draw(), "Change Account Pools");
    expect(control.props.disabled).toBe(true);
    await control.props.onClick();
    expect(state.save).not.toHaveBeenCalled();
    state.ready = true;
    state.saving = true;
    await button(dialog.draw(), "Change Account Pools").props.onClick();
    expect(state.save).not.toHaveBeenCalled();
  });
  it("closing the window discards an unconfirmed choice", async () => {
    const state = controls();
    const dialog = openDialog(state);
    await button(dialog.draw(), "Change Custom Headers").props.onClick();
    dialog.props.onClose();
    expect(state.save).not.toHaveBeenCalled();
    frames.delete(dialog.component); // unmount resets local pending state
    const reopened = openDialog(state);
    expect(button(reopened.draw(), "Confirm Custom Headers disable")).toBeNull();
  });
});
