import { describe, expect, it } from "vitest";
import REGISTRY from "open-sse/providers/registry/index.js";
import { PROVIDER_ID_TO_ALIAS, PROVIDER_MODELS } from "open-sse/config/providerModels.js";
import { parseModel, resolveModelAliasFromMap, resolveProviderAlias } from "open-sse/services/model.js";
import { getProviderAlias, resolveProviderId } from "@/shared/constants/providers.js";

describe("Muse public prefixes", () => {
  it.each([
    ["muse-api", "muse"],
    ["muse-web", "muse-spark-web"],
  ])("agrees across catalog, display and routing for %s", (prefix, id) => {
    expect(PROVIDER_ID_TO_ALIAS[id]).toBe(prefix);
    expect(PROVIDER_MODELS[prefix].length).toBeGreaterThan(0);
    expect(getProviderAlias(id)).toBe(prefix);
    expect(resolveProviderId(prefix)).toBe(id);
    expect(resolveProviderAlias(prefix)).toBe(id);
    expect(parseModel(`${prefix}/muse-spark`)).toMatchObject({ provider: id, model: "muse-spark" });
    expect(resolveModelAliasFromMap("saved", { saved: `${prefix}/muse-spark` })).toEqual({ provider: id, model: "muse-spark" });
  });

  it("keeps persisted IDs and old unique aliases without any shared Muse token", () => {
    const web = REGISTRY.find((entry) => entry.id === "muse-spark-web");
    const api = REGISTRY.find((entry) => entry.id === "muse");
    const tokens = (entry) => new Set([entry.id, entry.alias, entry.uiAlias, ...(entry.aliases || [])].filter(Boolean));
    expect([...tokens(web)].filter((token) => tokens(api).has(token))).toEqual([]);
    expect(parseModel("muse/muse-spark-1.3").provider).toBe("muse");
    expect(parseModel("muse-spark-web/muse-spark").provider).toBe("muse-spark-web");
    expect(parseModel("muse-code/muse-spark-1.3").provider).toBe("muse");
    expect(api.authModes).toEqual(["oauth", "apikey"]);
    expect(web.authType).toBe("cookie");
  });
});
