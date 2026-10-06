import { readFileSync } from "node:fs";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import PropTypes from "prop-types";
import { renderToStaticMarkup } from "react-dom/server";
import { loadBindings, transform } from "next/dist/build/swc/index.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

let Toggle;
let Settings;
let UsageTable;
const setStreamerMode = vi.fn();
let enabled = false;
beforeAll(async () => {
  const filename = new URL("../../src/shared/components/StreamerMode.js", import.meta.url);
  await loadBindings();
  const { code } = await transform(readFileSync(filename, "utf8"), {
    filename: filename.pathname,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" },
  });
  const dependencies = {
    react: { ...React, useSyncExternalStore: () => enabled },
    "react/jsx-runtime": jsxRuntime,
    "./Toggle": props => React.createElement("button", {
      role: "switch", "aria-label": props["aria-label"], "aria-checked": props.checked,
    }),
    "@/store/streamerModeStore": {
      getStreamerMode: () => enabled, getServerStreamerMode: () => false,
      subscribeStreamerMode: () => () => {}, mountStreamerMode: () => () => {},
      setStreamerMode,
    },
  };
  const compiledModule = { exports: {} };
  new Function("module", "exports", "require", code)(compiledModule, compiledModule.exports, id => dependencies[id]);
  Toggle = compiledModule.exports.default;
  Settings = compiledModule.exports.PrivacyModeSettings;

  const tableFilename = new URL("../../src/app/(dashboard)/dashboard/usage/components/UsageTable.js", import.meta.url);
  const tableResult = await transform(readFileSync(tableFilename, "utf8"), {
    filename: tableFilename.pathname,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" },
  });
  const tableModule = { exports: {} };
  const tableDependencies = {
    react: React, "react/jsx-runtime": jsxRuntime,
    "prop-types": PropTypes,
    "@/shared/components/Card": props => React.createElement("div", {}, props.children),
    "@/shared/components/Badge": props => React.createElement("span", {}, props.children),
  };
  new Function("module", "exports", "require", tableResult.code)(tableModule, tableModule.exports, id => tableDependencies[id]);
  UsageTable = tableModule.exports.default;
});

describe("privacy mode controls", () => {
  it("shows an accessible inactive control", () => {
    enabled = false;
    const html = renderToStaticMarkup(React.createElement(Toggle));
    expect(html).toContain('aria-label="Privacy Mode"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("Enable Privacy Mode");
    expect(html.replace(/<[^>]*>/g, "").trim()).toBe("visibility");
    Toggle().props.onClick();
    expect(setStreamerMode).toHaveBeenLastCalledWith(true);
  });

  it("shows its enabled state and clipboard limitation", () => {
    enabled = true;
    const html = renderToStaticMarkup(React.createElement(Toggle));
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain(">Streamer</span>");
    expect(html).not.toContain(">Privacy Mode</span>");
    expect(html.replace(/<[^>]*>/g, "").trim()).toBe("visibility_off");
    expect(html).toContain("copied values remain unchanged");
    Toggle().props.onClick();
    expect(setStreamerMode).toHaveBeenLastCalledWith(false);
  });

  it("renders a settings switch sharing the header state and setter", () => {
    for (const value of [false, true]) {
      enabled = value;
      const html = renderToStaticMarkup(React.createElement(Settings));
      expect(html).toContain(">Privacy Mode</h3>");
      expect(html).toContain(`aria-checked="${value}"`);
      expect(html).toContain("Copied values remain unchanged");
      const control = Settings().props.children[0].props.children[1];
      expect(control.props.checked).toBe(value);
      control.props.onChange(!value);
      expect(setStreamerMode).toHaveBeenLastCalledWith(!value);
    }
  });

  it("adds privacy mode to settings with Russian localization", () => {
    const profile = readFileSync(new URL("../../src/app/(dashboard)/dashboard/profile/page.js", import.meta.url), "utf8");
    expect(profile).toContain("<PrivacyModeSettings />");
    const ru = JSON.parse(readFileSync(new URL("../../public/i18n/literals/ru.json", import.meta.url), "utf8"));
    expect(ru["Privacy Mode"]).toBe("Режим конфиденциальности");
    expect(ru["Hide secrets and all account names on screen."]).toContain("все названия");
  });

  it.each(["account", "apiKey", "model", "provider"])(
    "marks only private group text, not the row, chevron or model: %s", tableType => {
      const html = renderToStaticMarkup(React.createElement(UsageTable, {
        title: "Usage", columns: [{ field: "label", label: "Label" }],
        groupedData: [{ groupKey: "My account", summary: { requests: 4 }, items: [] }],
        tableType, sortBy: "label", sortOrder: "asc", onToggleSort: () => {},
        viewMode: "costs", storageKey: "fixture",
        renderDetailCells: () => null, renderSummaryCells: () => null,
      }));
      expect(html).toContain("chevron_right");
      expect(html).not.toMatch(/<(?:tr|td|div)[^>]*data-streamer-sensitive/);
      if (tableType === "account" || tableType === "apiKey") {
        expect(html).toMatch(/<span data-streamer-sensitive="true"[^>]*>My account<\/span>/);
      } else expect(html).not.toContain("data-streamer-sensitive");
    },
  );

  it("explicitly marks account labels across providers, quotas, import and pickers", () => {
    const read = file => readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8");
    for (const file of [
      "app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js",
      "app/(dashboard)/dashboard/providers/[id]/ServiceTierSection.js",
      "app/(dashboard)/dashboard/providers/components/ConnectionsCard.js",
      "app/(dashboard)/dashboard/providers/components/AccountPoolsCard.js",
      "app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js",
      "app/(dashboard)/dashboard/import/page.js",
      "shared/components/EditConnectionModal.js",
      "shared/components/AddCustomSearchProviderModal.js",
      "shared/components/UsageStats.js",
    ]) expect(read(file)).toContain("data-streamer-sensitive");
    expect(read("shared/components/StreamerMode.js")).not.toContain("email-like");
  });

  it("wires masking at the layout and before the first paint", () => {
    const read = file => readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8");
    expect(read("app/layout.js")).toContain("__html: STREAMER_PREPAINT_SCRIPT");
    expect(read("app/layout.js")).toContain("streamerMode.css");
    expect(read("shared/components/Header.js")).toContain("<StreamerModeToggle />");
    expect(read("shared/components/layouts/DashboardLayout.js")).toContain("<StreamerModeController />");
    expect(read("shared/components/layouts/DashboardLayout.js")).toContain("data-streamer-surface");
  });

  it("marks known key fragments and native key-picker options explicitly", () => {
    const read = file => readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8");
    for (const name of ["GenericExampleCard", "SttExampleCard", "TtsExampleCard", "ExaSearchExampleCard"]) {
      expect(read(`shared/components/capability-pages/provider/components/${name}.js`))
        .toContain('data-streamer-sensitive={apiKey ? true : undefined}');
    }
    expect(read("app/(dashboard)/dashboard/cli-tools/components/ApiKeySelect.js"))
      .toContain("data-streamer-sensitive={o.value !== CUSTOM_VALUE");
    expect(read("app/(dashboard)/dashboard/console-log/ConsoleLogClient.js"))
      .toContain("data-streamer-sensitive");
    expect(read("app/(dashboard)/dashboard/usage/components/RequestDetailsTab.js"))
      .toContain("data-streamer-sensitive");
  });

  it("marks both Custom Headers fields and styles masked form fields as solid blocks", () => {
    const card = readFileSync(new URL("../../src/app/(dashboard)/dashboard/providers/[id]/CustomConfigCard.js", import.meta.url), "utf8");
    const inputs = card.match(/<input[\s\S]*?\/>/g) || [];
    expect(inputs).toHaveLength(2);
    for (const input of inputs) expect(input).toContain("data-streamer-sensitive");
    const css = readFileSync(new URL("../../src/shared/components/streamerMode.css", import.meta.url), "utf8");
    expect(css).toContain(':is(input, textarea)[data-streamer-mask="true"]');
    expect(css).toContain("border-color: transparent !important");
  });
});
