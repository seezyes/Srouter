import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { REGISTRY_ALIAS_TO_ID } from "@/shared/constants/providerAliases";
import { buildActiveAliases, getAvailableModelsGrouped } from "../../cli/src/cli/utils/modelSelector.js";

const fixtures = vi.hoisted(() => ({ connections: [] }));
vi.mock("@/models", () => ({
  getProviderConnections: vi.fn(async () => fixtures.connections),
  getProviderNodes: vi.fn(async () => []),
  createProviderConnection: vi.fn(), getProviderNodeById: vi.fn(), getProxyPoolById: vi.fn(),
}));
vi.mock("next/server", () => ({ NextResponse: { json: body => Response.json(body) } }));
import { GET } from "@/app/api/providers/route.js";
const require = createRequire(import.meta.url);

describe("provider GET → CLI selector", () => {
  it("publishes safe registry metadata and all aliases for active connections", async () => {
    fixtures.connections = [
      { provider: "zcode", accessToken: "fixture-secret", isActive: true },
      { provider: "grok-cli", isActive: true },
      { provider: "openai", isActive: false },
      { provider: "openai-compatible-fixture", isActive: true, providerSpecificData: { prefix: "fixture-prefix" } },
    ];
    const payload = await (await GET()).json();
    expect(payload.aliasMap).toEqual(REGISTRY_ALIAS_TO_ID);
    expect(JSON.stringify(payload)).not.toContain("fixture-secret");
    expect(payload.connections[0].hasCredential).toBe(true);
    const aliases = buildActiveAliases(payload);
    for (const alias of ["zc", "gcli", "gb", "grok-build", "fixture-prefix"]) expect(aliases.has(alias), alias).toBe(true);
    expect(aliases.has("openai")).toBe(false);
    for (const provider of Object.values(AI_PROVIDERS).filter(p => p.noAuth)) {
      expect(aliases.has(provider.id), provider.id).toBe(true);
      expect(aliases.has(provider.alias), provider.alias).toBe(true);
    }
    const api = require("../../cli/src/cli/api/client.js");
    const providers = vi.spyOn(api, "getProviders").mockResolvedValue({ success: true, data: payload });
    const models = vi.spyOn(api, "getAvailableModels").mockResolvedValue({ success: true, data: { data: [
      { id: "zc/fixture", owned_by: "zc" },
      { id: "gb/fixture", owned_by: "gb" },
      { id: "fixture-prefix/model", owned_by: "fixture-prefix" },
      { id: "openai/fixture", owned_by: "openai" },
      { id: "oc/fixture", owned_by: "oc" },
      { id: "fixture-combo", owned_by: "combo" },
    ] } });
    try {
      expect(await getAvailableModelsGrouped()).toEqual({ combos: ["fixture-combo"], groups: {
        zc: ["zc/fixture"], gb: ["gb/fixture"], "fixture-prefix": ["fixture-prefix/model"], oc: ["oc/fixture"],
      } });
    } finally { providers.mockRestore(); models.mockRestore(); }
  });
  it("admits display aliases for every registered active provider, not just the first token", async () => {
    for (const provider of Object.values(AI_PROVIDERS)) {
      fixtures.connections = [{ provider: provider.id, isActive: true }];
      const payload = await (await GET()).json();
      const aliases = buildActiveAliases(payload);
      expect(aliases.has(provider.alias || provider.id), `${provider.id}/${provider.alias}`).toBe(true);
      for (const [alias, id] of Object.entries(REGISTRY_ALIAS_TO_ID)) {
        if (id === provider.id) expect(aliases.has(alias), alias).toBe(true);
      }
    }
  });
  it("offers OpenCode Go API-key creation through the existing CLI menu flow", async () => {
    const helper = require("../../cli/src/cli/utils/menuHelper.js");
    const spy = vi.spyOn(helper, "showMenuWithBack").mockResolvedValue(undefined);
    const list = vi.spyOn(helper, "showListMenu").mockResolvedValue(undefined);
    const input = require("../../cli/src/cli/utils/input.js");
    const prompt = vi.spyOn(input, "prompt").mockResolvedValueOnce("Fixture Go").mockResolvedValueOnce("fixture-go-key");
    const pause = vi.spyOn(input, "pause").mockResolvedValue(undefined);
    const display = require("../../cli/src/cli/utils/display.js");
    const clear = vi.spyOn(display, "clearScreen").mockImplementation(() => {});
    const status = vi.spyOn(display, "showStatus").mockImplementation(() => {});
    const api = require("../../cli/src/cli/api/client.js");
    const create = vi.spyOn(api, "createApiKeyProvider").mockResolvedValue({ success: true });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const file = require.resolve("../../cli/src/cli/menus/providers.js");
    delete require.cache[file];
    try {
      await require(file).showProvidersMenu();
      const entry = spy.mock.calls[0][0].items.find(item => item.provider?.id === "opencode-go");
      expect(entry).toMatchObject({ provider: { name: "OpenCode Go" }, authType: "apikey" });
      expect(entry.action).toBeTypeOf("function");
      await entry.action({ connections: [] });
      await list.mock.calls[0][0].createAction.action();
      expect(create).toHaveBeenCalledWith({ provider: "opencode-go", name: "Fixture Go", apiKey: "fixture-go-key" });
      expect(log.mock.calls.flat().join("")).not.toContain("fixture-go-key");
    } finally {
      for (const mock of [spy, list, prompt, pause, clear, status, create, log]) mock.mockRestore();
      delete require.cache[file];
    }
  });
});
