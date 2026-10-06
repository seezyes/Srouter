import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { groupAntigravityModels } from "../../src/app/(dashboard)/dashboard/providers/[id]/antigravityModelGroups.js";
import { hasProviderBanRisk } from "../../src/app/(dashboard)/dashboard/providers/components/providerBanRisk.js";
import antigravity from "../../open-sse/providers/registry/antigravity.js";

const models = (...ids) => ids.map((id) => ({ id, name: id }));
const current = antigravity.models.filter((model) => !model.kind || model.kind === "llm");

describe("explicit current Antigravity model groups", () => {
  it("collapses exactly five current Gemini families while retaining every model object", () => {
    const result = groupAntigravityModels("antigravity", current);
    expect(result.filter((g) => g.models.length > 1).map((g) => [g.name, g.models.length])).toEqual([
      ["Gemini 3.8 Flash", 4],
      ["Gemini 3.7 Flash", 3],
      ["Gemini 3.6 Flash", 3],
      ["Gemini 3.5 Flash", 4],
      ["Gemini 3.1 Pro", 2],
    ]);
    expect(result.flatMap((g) => g.models)).toEqual(current);
    for (const model of result.flatMap((g) => g.models)) expect(current.includes(model)).toBe(true);
    expect(result.filter((g) => g.models.length === 1).map((g) => g.id)).toEqual([
      "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium", "gemini-3-flash",
    ]);
  });

  it.each(["gemini", "gemini-cli", "grok-cli", "claude", "xai"])("never groups %s models", (id) => {
    const source = models("gemini-3.8-flash-high", "gemini-3.8-flash-low");
    expect(groupAntigravityModels(id, source)).toEqual(source.map((model) => ({ id: model.id, models: [model] })));
  });

  it("does not adopt future IDs even when they share today's version prefix", () => {
    const source = models("gemini-3.8-flash-high", "gemini-3.8-flash-low", "gemini-3.8-flash-max", "gemini-4-argon-high", "gemini-4-argon-low");
    const result = groupAntigravityModels("antigravity", source);
    expect(result.map((g) => g.id)).toEqual([
      "ag-gemini-3.8-flash", "gemini-3.8-flash-max", "gemini-4-argon-high", "gemini-4-argon-low",
    ]);
    expect(result.flatMap((g) => g.models)).toEqual(source);
  });

  it("leaves a lone enabled variant separate and regroups only the enabled variants", () => {
    const source = models("gemini-3.7-flash-high");
    expect(groupAntigravityModels("antigravity", source)).toEqual([{ id: source[0].id, models: source }]);
    const pair = models("gemini-3.7-flash-high", "gemini-3.7-flash-low");
    expect(groupAntigravityModels("antigravity", pair)[0].models).toEqual(pair);
    expect(groupAntigravityModels("antigravity", [])).toEqual([]);
  });

  it("keeps unrelated chips and input order intact", () => {
    const source = models("unrelated", "gemini-3.6-flash-low", "middle", "gemini-3.6-flash-high");
    const result = groupAntigravityModels("antigravity", source);
    expect(result.map((g) => g.id)).toEqual(["unrelated", "ag-gemini-3.6-flash", "middle"]);
    expect(result[1].models).toEqual([source[1], source[3]]);
    expect(source.map((m) => m.id)).toEqual(["unrelated", "gemini-3.6-flash-low", "middle", "gemini-3.6-flash-high"]);
  });
});

describe("provider card ban-risk scope", () => {
  it("uses the Connected badge size and a rounded vector warning", () => {
    const source = readFileSync(new URL("../../src/app/(dashboard)/dashboard/providers/components/ProviderBanRiskBadge.js", import.meta.url), "utf8");
    expect(source).toContain('<Badge variant="warning" size="sm">');
    expect(source).not.toContain("text-[8px]");
    expect(source).toContain('width="10" height="10"');
    expect(source).toContain('strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"');
    expect(source).not.toContain("material-symbols-outlined");
    expect(source).toContain("PROVIDER_BAN_RISK_NOTICE");
  });

  it.each(["gemini-cli", "antigravity"])("marks %s as ban risk", (id) => {
    expect(hasProviderBanRisk(id)).toBe(true);
  });

  it.each(["claude", "gemini", "vertex", "qoder", "grok-cli", "burngate", "antigravity-future"])("does not add the badge to %s", (id) => {
    expect(hasProviderBanRisk(id)).toBe(false);
  });
});
