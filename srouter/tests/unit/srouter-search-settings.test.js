import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(async (settings) => settings),
}));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: vi.fn() }));
import { PATCH } from "@/app/api/settings/route";
import { updateSettings } from "@/lib/localDb";
import { DEFAULT_SROUTER_SEARCH } from "@/shared/utils/srouterSearchConfig";
import { mergeWithDefaults } from "@/lib/db/repos/settingsRepo.js";
const patch = (srouterSearch) => PATCH(new Request("http://localhost/api/settings", {
  method: "PATCH", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ srouterSearch }),
}));
beforeEach(() => vi.clearAllMocks());
describe("SRouterSearch settings API", () => {
  it("merges persisted configuration defaults without changing other settings", () => {
    const settings = mergeWithDefaults({ requireApiKey: false, srouterSearch: { enabled: true, searchProvider: "exa" } });
    expect(settings.requireApiKey).toBe(false);
    expect(settings.srouterSearch).toEqual({ ...DEFAULT_SROUTER_SEARCH, enabled: true, searchProvider: "exa" });
    expect(mergeWithDefaults({}).srouterSearch.enabled).toBe(false);
  });
  it("persists normalized settings without credentials", async () => {
    const response = await patch({ enabled: true, searchProvider: "search-combo", fetchProvider: "exa" });
    expect(response.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({
      srouterSearch: { ...DEFAULT_SROUTER_SEARCH, enabled: true, searchProvider: "search-combo", fetchProvider: "exa" },
    });
  });
  it.each([{ enabled: "yes" }, { maxResults: 0 }, { maxCharacters: 200001 }, { apiKey: "never-save" }])("rejects invalid settings %j before writes", async (config) => {
    expect((await patch(config)).status).toBe(400);
    expect(updateSettings).not.toHaveBeenCalled();
  });
});
