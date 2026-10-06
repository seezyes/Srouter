import fs from "node:fs";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { describe, expect, it } from "vitest";
import { loadBindings, transform } from "next/dist/build/swc/index.js";
import { CLI_TOOLS } from "../../src/shared/constants/cliTools.js";
import { getHarnessStatus } from "../../src/shared/utils/harnessStatus.js";

const CARD_PATH = "../../src/app/(dashboard)/dashboard/cli-tools/components/DeepSeekHarnessToolCard.js";
const cardSource = () => fs.readFileSync(new URL(CARD_PATH, import.meta.url), "utf8");
const fallbackBlock = (id) => [
  `          - id: ${id}`,
  "            reasoningEfforts:",
  "              low: low",
  "              medium: medium",
  "              high: high",
  "              max: max",
].join("\n");

// The manual snippet is built by the named helpers exported from the card.
// Compile and evaluate the real module so these tests exercise the actual
// functions instead of re-deriving their text.
let cardModule;
async function loadCardModule() {
  if (cardModule) return cardModule;
  await loadBindings();
  const { code } = await transform(cardSource(), {
    filename: CARD_PATH,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" },
  });
  const compiled = { exports: {} };
  const NullComponent = () => null;
  const dependencies = {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "@/shared/components": { Card: NullComponent, Button: NullComponent, ManualConfigModal: NullComponent },
    "@/shared/components/onDemandModals": { ModelSelectModal: NullComponent },
    "next/image": { default: NullComponent },
    "./ApiKeySelect": { default: NullComponent },
  };
  new Function("module", "exports", "require", code)(compiled, compiled.exports, (id) => {
    if (!(id in dependencies)) throw new Error(`Unexpected import in the card: ${id}`);
    const dependency = dependencies[id];
    return dependency && "default" in dependency ? { ...dependency, __esModule: true } : dependency;
  });
  cardModule = compiled.exports;
  return cardModule;
}

describe("DeepSeek Harness, distinct from DeepSeek TUI", () => {
  it("declares the one-click custom provider card without claiming login or a live connection", () => {
    const tool = CLI_TOOLS["deepseek-harness"];
    expect(tool.name).toBe("DeepSeek Harness");
    expect(tool.configType).toBe("custom");
    expect(tool.statusMode).toBe("installation");
    expect("guideSteps" in tool).toBe(false);
    expect(tool.description).toMatch(/one-click/i);
    expect(tool.notes ?? []).toHaveLength(0);
    expect(CLI_TOOLS["deepseek-tui"].name).toBe("DeepSeek TUI");
    expect(CLI_TOOLS.codewhale.name).toBe("CodeWhale");
    expect(fs.existsSync(new URL("../../public/providers/deepseek-harness.png", import.meta.url))).toBe(true);
  });

  it("routes the tool to its dedicated one-click card", () => {
    const card = fs.readFileSync(new URL(
      "../../src/app/(dashboard)/dashboard/cli-tools/components/DeepSeekHarnessToolCard.js", import.meta.url,
    ), "utf8");
    expect(card).toContain("/api/cli-tools/deepseek-harness-settings");
    expect(card).toContain("Add to DeepSeek Harness");
    expect(card).toContain("SROUTER_API_KEY");
    expect(card).not.toContain("Default Model");
    expect(card).toContain("ModelSelectModal");
    expect(card).toContain("Restart DeepSeek Harness");
    expect(card).not.toContain("availableModels");
    const client = fs.readFileSync(new URL(
      "../../src/app/(dashboard)/dashboard/cli-tools/[toolId]/ToolDetailClient.js", import.meta.url,
    ), "utf8");
    expect(client).toContain('case "deepseek-harness":');
    expect(client).toContain("DeepSeekHarnessToolCard");
    const index = fs.readFileSync(new URL(
      "../../src/app/(dashboard)/dashboard/cli-tools/components/index.js", import.meta.url,
    ), "utf8");
    expect(index).toContain("DeepSeekHarnessToolCard");
  });

  it("labels installation only, never login or a working Srouter connection", () => {
    const tool = CLI_TOOLS["deepseek-harness"];
    expect(getHarnessStatus({ installed: true, hasSrouter: true }, tool).label).toBe("Installed");
    expect(getHarnessStatus({ installed: false }, tool).label).toBe("Not installed");
    expect(getHarnessStatus({ error: "fixture" }, tool).label).toBe("Unknown");
    expect(getHarnessStatus(null, tool).label).toBe("Unknown");
    expect(getHarnessStatus(null, CLI_TOOLS.zcode).label).toBe("Guide");
    expect(getHarnessStatus({ installed: true, hasSrouter: true }, CLI_TOOLS.codex).label).toBe("Connected");
    expect(getHarnessStatus({ installed: true }, CLI_TOOLS.codex).label).toBe("Not configured");
  });

  it("keeps detection in the existing batch status endpoint and never shells out", () => {
    const batch = fs.readFileSync(new URL(
      "../../src/app/api/cli-tools/all-statuses/route.js", import.meta.url,
    ), "utf8");
    expect(batch).toContain('"deepseek-harness": deepseekHarnessGet');
    const source = fs.readFileSync(new URL(
      "../../src/app/api/cli-tools/deepseek-harness-settings/route.js", import.meta.url,
    ), "utf8");
    expect(source).not.toMatch(/child_process|exec\(/);
  });

  it("explains missing Effort levels in one line, only for our own configured provider", () => {
    const card = fs.readFileSync(new URL(
      "../../src/app/(dashboard)/dashboard/cli-tools/components/DeepSeekHarnessToolCard.js", import.meta.url,
    ), "utf8");
    // The hint needs our provider, undeclared levels AND a readable non-empty
    // model list; otherwise the "Choose at least one model first." guard makes
    // the advice impossible to follow.
    expect(card).toContain("const levelsMissing = hasSrouter && status?.levelsDeclared === false && status.models?.length > 0;");
    expect(card).toContain("{levelsMissing && (");
    expect(card).toContain("Some Srouter models declare no Effort levels. Press Add to DeepSeek Harness to declare them.");
    // A single short line, not a repeated note or a new block.
    expect(card.match(/Some Srouter models declare no Effort levels/g)).toHaveLength(1);
  });

  it("keeps the Models row honest when the server sends no models array", () => {
    const card = fs.readFileSync(new URL(
      "../../src/app/(dashboard)/dashboard/cli-tools/components/DeepSeekHarnessToolCard.js", import.meta.url,
    ), "utf8");
    // Missing array is distinguished from a real empty configuration, and the
    // copy must not promise a fix that reloading alone cannot deliver.
    expect(card).toContain("const modelsUnreadable = modelChoice === null && !Array.isArray(status?.models);");
    expect(card).toContain("The server returned no model list. Reload once the app server is updated.");
    expect(card).not.toContain("Configured models could not be read from the config.");
    expect(card).toContain("No models selected yet");
  });

  it("blocks apply and reset when the patch file cannot be read safely", () => {
    const card = fs.readFileSync(new URL(
      "../../src/app/(dashboard)/dashboard/cli-tools/components/DeepSeekHarnessToolCard.js", import.meta.url,
    ), "utf8");
    expect(card).toContain("const configUnsafe = status?.configReadable === false;");
    expect(card).toContain("{configUnsafe && (");
    expect(card).toContain("DeepSeek Harness configuration cannot be read safely. Fix or remove the file before applying.");
    // Add stays blocked for an unknown model list, Reset only when configured,
    // and both stay blocked for an unreadable configuration.
    expect(card).toContain("disabled={foreignRoute || modelsUnreadable || configUnsafe}");
    expect(card).toContain("disabled={!hasSrouter || foreignRoute || configUnsafe}");
    // The Select control is deliberately not disabled by these states.
    const selectButton = card.slice(card.indexOf("setModalOpen(true)}"), card.indexOf("setModalOpen(true)}") + 300);
    expect(selectButton).toContain("Select");
    expect(selectButton).not.toContain("disabled");
  });

  it("warns against duplicating the llm-pi-ai entry in the manual snippet", () => {
    const card = fs.readFileSync(new URL(
      "../../src/app/(dashboard)/dashboard/cli-tools/components/DeepSeekHarnessToolCard.js", import.meta.url,
    ), "utf8");
    expect(card).toContain("If an `llm-pi-ai` entry already exists, replace it instead of adding a second one.");
    const modal = fs.readFileSync(new URL(
      "../../src/shared/components/ManualConfigModal.js", import.meta.url,
    ), "utf8");
    // Additive: only configs that carry a note render one.
    expect(modal).toContain("{config.note && (");
    expect(modal).toContain("{config.note}");
    expect(modal).toContain("{config.filename}");
    expect(modal).toContain("{config.content}");
  });

  it("declares only the real Effort levels in the manual snippet", async () => {
    // DSH has no true Off — its adapter maps Off to "no reasoning option",
    // identical to Default — so the snippet declares only real levels, and the
    // set is read per model from the Srouter registry (`xhigh` included where
    // the model supports it). Registry vision data adds the `input` line.
    const { buildModelLines } = await loadCardModule();
    const lines = buildModelLines(["cx/gpt-6.1-sol"], {
      "cx/gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max"],
    }, { "cx/gpt-6.1-sol": true });
    expect(lines).toBe([
      "          - id: cx/gpt-6.1-sol",
      "            input: [text, image]",
      "            reasoningEfforts:",
      "              low: low",
      "              medium: medium",
      "              high: high",
      "              xhigh: xhigh",
      "              max: max",
    ].join("\n"));
    expect(lines).toContain("xhigh: xhigh");
    expect(lines).not.toMatch(/off:/);
  });

  it("declares the narrow level set of a model that supports fewer levels", async () => {
    const { buildModelLines } = await loadCardModule();
    const lines = buildModelLines(["deepseek/deepseek-v4-pro"], {
      "deepseek/deepseek-v4-pro": ["high", "max"],
    });
    expect(lines).toBe([
      "          - id: deepseek/deepseek-v4-pro",
      "            reasoningEfforts:",
      "              high: high",
      "              max: max",
    ].join("\n"));
    expect(lines).not.toMatch(/low:|off:/);
  });

  it("marks a non-reasoning model with reasoningEfforts: false and no nested levels", async () => {
    const { buildModelLines } = await loadCardModule();
    const lines = buildModelLines(["some/non-reasoning"], { "some/non-reasoning": false }, { "some/non-reasoning": false });
    expect(lines).toBe([
      "          - id: some/non-reasoning",
      "            input: [text]",
      "            reasoningEfforts: false",
    ].join("\n"));
    // A scalar `false` line, never an empty nested block.
    expect(lines).not.toMatch(/reasoningEfforts:\n/);
    expect(lines).not.toMatch(/^\s{14}\S+:/m);
    expect(lines).not.toMatch(/off:/);
  });

  it("keeps the conservative fallback levels for a model without registry data", async () => {
    const { buildModelLines } = await loadCardModule();
    const lines = buildModelLines(["brand-new/model"], {});
    expect(lines).toBe(fallbackBlock("brand-new/model"));
    // Unknown data must not be declared non-reasoning, must not gain an
    // invented `input` line, and `xhigh` is not invented either.
    expect(lines).not.toMatch(/false|xhigh:|off:/);
    expect(lines).not.toContain("input:");
  });

  it("renders the Models row as a reorderable vertical list", () => {
    const card = cardSource();
    // Two icon buttons in the ComboFormModal style, plus the removal button.
    expect(card).toContain('title="Move up"');
    expect(card).toContain('title="Move down"');
    expect(card).toContain(">arrow_upward</span>");
    expect(card).toContain(">arrow_downward</span>");
    expect(card).toContain("title={`Remove ${model}`}");
    // Reordering is a local swap in the selection, never a server request.
    expect(card).toContain("const handleModelMove = (index, direction) => {");
    expect(card).toContain("setModelChoice(next);");
    expect(card).toContain("const upDisabled = modelsLocked || index === 0;");
    expect(card).toContain("const downDisabled = modelsLocked || index === selectedModels.length - 1;");
    expect(card).toContain("const modelsLocked = foreignRoute || modelsUnreadable || configUnsafe || applying || restoring;");
    // Position counter and the honest strings survive the vertical list.
    expect(card).toContain("{index + 1}");
    expect(card).toContain("No models selected yet");
    expect(card).toContain("The server returned no model list. Reload once the app server is updated.");
    expect(card).toContain("Select");
    // The old horizontal chip row is gone.
    expect(card).not.toContain("inline-flex items-center gap-1 rounded bg-surface/40 border border-border");
  });

  it("shows vision and effort traits only when the server reports them", () => {
    const card = cardSource();
    expect(card).toContain("const vision = status?.modelVision?.[model];");
    expect(card).toContain('typeof vision === "boolean"');
    expect(card).toContain('traits.push(vision ? "vision" : "no vision");');
    expect(card).toContain('traits.push("no reasoning");');
    expect(card).toContain('traits.push(`effort ${levels.join("/")}`)');
    expect(card).toContain('traits.join(" · ")');
    // A missing key is "unknown" and renders nothing; `false` is the only
    // value that means "not reasoning".
    expect(card).toContain("levels === false");
  });

  it("shows the provider protocol read-only from the status payload", () => {
    const card = cardSource();
    expect(card).toContain(">Protocol</span>");
    expect(card).toContain("{protocolLabel}");
    expect(card).toContain('PROTOCOL_LABELS[status?.api] || status?.api || "OpenAI Chat Completions"');
    expect(card).toContain('"openai-responses": "OpenAI Responses"');
    expect(card).toContain('"anthropic-messages": "Anthropic Messages"');
    // Read-only display: no selector anywhere in the card.
    expect(card).not.toContain("<select");
    // The manual snippet's `api:` follows the same status value.
    expect(card).toContain('api: ${status?.api || "openai-completions"}');
  });

  it("keeps the placeholder snippet and the modelLevels wiring intact", async () => {
    const card = cardSource();
    const { buildModelLines } = await loadCardModule();
    expect(card).toContain("buildModelLines(selectedModels, status?.modelLevels, status?.modelVision)");
    expect(buildModelLines([], {})).toBe(fallbackBlock("<model-or-combo-id>"));
  });

  it("leaves the rest of the card contract untouched", () => {
    const card = fs.readFileSync(new URL(
      "../../src/app/(dashboard)/dashboard/cli-tools/components/DeepSeekHarnessToolCard.js", import.meta.url,
    ), "utf8");
    // POST payload and controls.
    expect(card).toContain("baseUrl: getEffectiveBaseUrl()");
    expect(card).toContain("apiKey: selectedApiKey?.trim() || undefined");
    expect(card).toContain("models: selectedModels");
    expect(card).toContain("Choose at least one model first.");
    // Foreign-provider guard and restart hint.
    expect(card).toContain("already exists in DeepSeek Harness");
    expect(card).toContain("Restart DeepSeek Harness to see the Srouter provider and its models in Settings → Models.");
  });
});
