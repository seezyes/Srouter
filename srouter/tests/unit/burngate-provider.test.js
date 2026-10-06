import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import burngate from "../../open-sse/providers/registry/burngate.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getDefaultModel, getModelUpstreamId, isValidModel } from "../../open-sse/config/providerModels.js";
import { parseModel } from "../../open-sse/services/model.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { FREE_PROVIDERS, FREE_TIER_PROVIDERS, APIKEY_PROVIDERS } from "../../src/shared/constants/providers.js";
import { getProviderIconSrc } from "../../src/shared/utils/providerIcon.js";
import { orderFreeTierEntries } from "../../src/app/(dashboard)/dashboard/providers/components/freeTierOrder.js";

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
}));
vi.mock("@/models", () => ({ getProviderNodeById: vi.fn() }));
import { testApiKeyConnection } from "../../src/app/api/providers/[id]/test/testUtils.js";
import { POST as validate } from "../../src/app/api/providers/validate/route.js";

const MODEL_IDS = [
  "deepseek/deepseek-v4.1-flash",
  "stealth/space-bunny-alpha",
  "xiaomi/mimo-v2.6-flash",
  "stealth/pixel-canary",
];
const entry = (id) => [id, { name: id }];
afterEach(() => vi.unstubAllGlobals());

describe("BurnGate registry and transport", () => {
  it("registers once as Free Tier with API-key onboarding", () => {
    expect(REGISTRY.filter((r) => r.id === "burngate")).toEqual([burngate]);
    expect(FREE_TIER_PROVIDERS.burngate).toMatchObject({
      name: "BurnGate", alias: "burngate", hasFree: true,
      authType: "apikey", authModes: ["apikey"],
      notice: { apiKeyUrl: "https://t.me/burngateapiBot" },
    });
    expect(FREE_PROVIDERS.burngate).toBeUndefined();
    expect(APIKEY_PROVIDERS.burngate).toBeUndefined();
    expect(burngate.noAuth).toBeUndefined();
  });

  it("uses the owner-supplied API base with standard Bearer auth", () => {
    const executor = new DefaultExecutor("burngate");
    expect(PROVIDERS.burngate.format).toBe("openai");
    expect(executor.noAuth).toBe(false);
    expect(executor.buildUrl(MODEL_IDS[0], true)).toBe("https://burngate.space/api/v1/chat/completions");
    expect(executor.buildUrl(MODEL_IDS[0], false)).toBe("https://burngate.space/api/v1/chat/completions");
    expect(executor.buildHeaders({ apiKey: "fixture-burngate-key" }).Authorization).toBe("Bearer fixture-burngate-key");
    expect(PROVIDERS.burngate.validateUrl).toBe("https://burngate.space/api/v1/models");
  });

  it("exposes exactly the four supplied model IDs without guessed capabilities or pricing", () => {
    expect(PROVIDER_MODELS.burngate.map((m) => m.id)).toEqual(MODEL_IDS);
    expect(getDefaultModel("burngate")).toBe(MODEL_IDS[0]);
    for (const model of burngate.models) {
      expect(model).not.toHaveProperty("pricing");
      expect(model).not.toHaveProperty("capabilities");
      expect(isValidModel("burngate", model.id)).toBe(true);
      expect(getModelUpstreamId("burngate", model.id)).toBe(model.id);
      expect(parseModel(`burngate/${model.id}`)).toMatchObject({ provider: "burngate", model: model.id });
    }
  });

  it("resolves the supplied PNG as a compact 256px provider icon", () => {
    expect(getProviderIconSrc("burngate")).toBe("/providers/burngate.png");
    const png = readFileSync(new URL("../../public/providers/burngate.png", import.meta.url));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBe(256);
    expect(png.readUInt32BE(20)).toBe(256);
  });
});

describe("Free Tier order", () => {
  it("places BurnGate directly after OpenCode without moving other cards or mutating inputs", () => {
    const free = [entry("opencode"), entry("gemini-cli"), entry("kiro"), entry("freebuff")];
    const tier = [entry("burngate"), entry("openrouter"), entry("nvidia")];
    const result = orderFreeTierEntries(free, tier).map(([id]) => id);
    expect(result).toEqual(["opencode", "burngate", "gemini-cli", "kiro", "freebuff", "openrouter", "nvidia"]);
    expect(result.filter((id) => id !== "burngate")).toEqual([...free, ...tier].map(([id]) => id).filter((id) => id !== "burngate"));
    expect(free.map(([id]) => id)).toEqual(["opencode", "gemini-cli", "kiro", "freebuff"]);
    expect(tier.map(([id]) => id)).toEqual(["burngate", "openrouter", "nvidia"]);
  });

  it("keeps BurnGate visible when search/status filters hide OpenCode", () => {
    expect(orderFreeTierEntries([], [entry("burngate")])).toEqual([entry("burngate")]);
    expect(orderFreeTierEntries([entry("opencode")], [])).toEqual([entry("opencode")]);
    expect(orderFreeTierEntries([], [])).toEqual([]);
  });
});

describe("BurnGate connection test (mocked)", () => {
  it.each([200, 401, 403])("validates a newly entered API key against HTTP %i", async (status) => {
    const fetchMock = vi.fn(async () => new Response("{}", { status }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await validate(new Request("http://localhost/api/providers/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "burngate", apiKey: "fixture-key" }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ valid: status === 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://burngate.space/api/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer fixture-key" }),
    }));
  });

  it.each([200, 401, 403, 429, 500])("uses the models endpoint and handles HTTP %i", async (status) => {
    const fetchMock = vi.fn(async () => new Response("{}", { status }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await testApiKeyConnection({ provider: "burngate", apiKey: "fixture-key" });
    expect(result).toEqual({ valid: status === 200, error: status === 200 ? null : "Invalid API key" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://burngate.space/api/v1/models", expect.objectContaining({
      headers: { Authorization: "Bearer fixture-key" },
    }));
  });

  it("returns a transport failure instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fixture offline"); }));
    expect(await testApiKeyConnection({ provider: "burngate", apiKey: "fixture-key" }))
      .toEqual({ valid: false, error: "fixture offline" });
  });
});
