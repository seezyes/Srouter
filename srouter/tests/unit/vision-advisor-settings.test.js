import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(async (settings) => settings),
}));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: vi.fn() }));

import { PATCH } from "../../src/app/api/settings/route.js";
import { updateSettings } from "@/lib/localDb";

const patch = (visionAdvisor) => PATCH(new Request("http://localhost/api/settings", {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ visionAdvisor }),
}));

describe("Vision Advisor settings API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists ordered global and model-specific chains", async () => {
    const response = await patch({
      enabled: true, models: ["openai/gpt-4o", "cmc/moonshotai/Kimi-K3"],
      overrides: { "cmc/deepseek/deepseek-v4-pro": ["openai/gpt-4o"] },
    });
    expect(response.status).toBe(200);
    const saved = updateSettings.mock.calls[0][0].visionAdvisor;
    expect(saved.models).toEqual(["openai/gpt-4o", "cmc/moonshotai/Kimi-K3"]);
    expect(saved.overrides["commandcode/deepseek/deepseek-v4-pro"]).toEqual(["openai/gpt-4o"]);
    expect((await response.json()).visionAdvisor).toEqual(saved);
  });

  it("accepts a legacy single advisor and normalizes it before saving", async () => {
    expect((await patch({ enabled: true, model: "openai/gpt-4o" })).status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({
      visionAdvisor: { enabled: true, models: ["openai/gpt-4o"], overrides: {} },
    });
  });

  it("rejects a malformed chain before any settings write", async () => {
    const response = await patch({ enabled: true, models: "openai/gpt-4o" });
    expect(response.status).toBe(400);
    expect(updateSettings).not.toHaveBeenCalled();
  });
});
