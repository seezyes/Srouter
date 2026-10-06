import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { CLI_TOOLS } from "../../src/shared/constants/cliTools.js";
import zcodeProvider from "../../open-sse/providers/registry/zcode.js";

describe("ZCode incoming harness guide", () => {
  it("offers manual custom-provider setup, not an outgoing local backend", () => {
    const tool = CLI_TOOLS.zcode;
    expect(tool.id).toBe("zcode");
    expect(tool.configType).toBe("guide");
    expect(tool.docsUrl).toBe("https://zcode.z.ai/en/docs/configuration");
    expect(tool.guideSteps.map(step => step.step)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(tool.guideSteps.some(step => step.value === "{{baseUrl}}" && step.copyable)).toBe(true);
    expect(tool.guideSteps.some(step => step.value === "{{apiKey}}" && step.copyable)).toBe(true);
    expect(tool.guideSteps.some(step => step.type === "modelSelector")).toBe(true);
    expect(tool.notes.map(note => note.text).join(" ")).toContain("does not modify your ZCode profile");
    expect(tool.guideSteps.map(step => step.desc || "").join(" ")).toContain("No local app-server is needed");
    expect(tool.envVars).toBeUndefined();
  });

  it("retains the existing HTTP/OAuth provider and both legacy DeepSeek harnesses", () => {
    expect(zcodeProvider.hasOAuth).toBe(true);
    expect(zcodeProvider.transport.baseUrl).toMatch(/^https:\/\//);
    expect(CLI_TOOLS["deepseek-tui"].configType).toBe("custom");
    expect(CLI_TOOLS.codewhale.configType).toBe("custom");
  });

  it("uses the existing guide renderer and bundled ZCode icon", () => {
    expect(fs.existsSync(new URL("../../public/providers/zcode.png", import.meta.url))).toBe(true);
    const renderer = fs.readFileSync(new URL(
      "../../src/app/(dashboard)/dashboard/cli-tools/components/DefaultToolCard.js",
      import.meta.url,
    ), "utf8");
    expect(renderer).toContain('.replace(/\\{\\{baseUrl\\}\\}/g, baseUrlWithV1)');
    expect(renderer).toContain('item.type === "apiKeySelector"');
    expect(renderer).toContain('item.type === "modelSelector"');
    const summary = fs.readFileSync(new URL(
      "../../src/shared/utils/harnessStatus.js",
      import.meta.url,
    ), "utf8");
    expect(summary).toContain('tool?.configType === "guide"');
  });
});
