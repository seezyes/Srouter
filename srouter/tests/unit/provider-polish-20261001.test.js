import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { groupProviderCards } from "../../src/app/(dashboard)/dashboard/providers/components/providerCardGroups.js";
import { APIKEY_PROVIDERS, OAUTH_PROVIDERS } from "../../src/shared/constants/providers.js";
import { getProviderIconSrc } from "../../src/shared/utils/providerIcon.js";

// GLM moved to the OAuth section: glm + zcode are the international z.ai pair
// (dual-auth), while glm-cn stays API-key-only on its own.
const families = [
  { registry: APIKEY_PROVIDERS, id: "openai", name: "OpenAI", first: "openai", second: "azure" },
  { registry: APIKEY_PROVIDERS, id: "mistral", name: "Mistral", first: "mistral", second: "codestral" },
  { registry: APIKEY_PROVIDERS, id: "opencode", name: "OpenCode", first: "opencode-go", second: "opencode-zen" },
  { registry: OAUTH_PROVIDERS, id: "glm", name: "GLM", first: "glm", second: "zcode" },
  { registry: APIKEY_PROVIDERS, id: "perplexity", name: "Perplexity", first: "perplexity", second: "perplexity-agent" },
  { registry: APIKEY_PROVIDERS, id: "minimax", name: "MiniMax", first: "minimax", second: "minimax-cn" },
];

describe("provider card families", () => {
  it("uses the OpenAI icon even when Azure is the first card", () => {
    const source = ["azure", "openai"].map((id) => [id, APIKEY_PROVIDERS[id]]);
    const [group] = groupProviderCards(source);
    expect(group.iconSrc).toBe("/providers/openai.png");
    expect(group.entries).toEqual(source);
  });
  it("uses the Mistral icon even when Codestral is the first card", () => {
    const source = ["codestral", "mistral"].map((id) => [id, APIKEY_PROVIDERS[id]]);
    const [group] = groupProviderCards(source);
    expect(group.iconSrc).toBe("/providers/mistral.png");
    expect(group.entries).toEqual(source);
    const page = readFileSync(new URL("../../src/app/(dashboard)/dashboard/providers/page.js", import.meta.url), "utf8");
    expect(page.match(/iconSrc=\{item\.iconSrc\}/g)).toHaveLength(2);
  });
  it.each(families)("collapses $id variants without changing the provider records", ({ registry, id, name, first, second }) => {
    const source = [[first, registry[first]], ["unrelated", { id: "unrelated" }], [second, registry[second]]];
    expect(source[0][1]).toBeDefined();
    expect(source[2][1]).toBeDefined();
    const result = groupProviderCards(source);
    expect(result.map((g) => g.id)).toEqual([id, "unrelated"]);
    expect(result[0].name).toBe(name);
    expect(result[0].entries[0]).toBe(source[0]);
    expect(result[0].entries[1]).toBe(source[2]);
    expect(source.map(([providerId]) => providerId)).toEqual([first, "unrelated", second]);
  });

  it.each(families)("keeps $id variants independently selectable during filtering", ({ registry, first, second }) => {
    const source = [[first, registry[first]], [second, registry[second]]];
    expect(groupProviderCards(source, true)).toEqual(source.map((entry) => ({
      id: entry[0], entries: [entry],
    })));
    expect(groupProviderCards([source[0]])).toEqual([{ id: first, entries: [source[0]] }]);
    expect(groupProviderCards([source[1]])).toEqual([{ id: second, entries: [source[1]] }]);
  });

  it("keeps China-first grid ordering and all provider identities", () => {
    const ids = ["minimax-cn", "minimax", "perplexity", "perplexity-agent"];
    const source = ids.map((id) => [id, APIKEY_PROVIDERS[id]]);
    const result = groupProviderCards(source);
    expect(result.map((g) => g.name)).toEqual(["MiniMax", "Perplexity"]);
    expect(result.flatMap((g) => g.entries)).toEqual(source);
  });
});

describe("ZCode icon", () => {
  it("resolves the existing Hive WebP asset", () => {
    expect(getProviderIconSrc("hive")).toBe("/providers/hive.webp");
    const webp = readFileSync(new URL("../../public/providers/hive.webp", import.meta.url));
    expect(webp.toString("ascii", 0, 4)).toBe("RIFF");
    expect(webp.toString("ascii", 8, 12)).toBe("WEBP");
  });
  it("resolves a real 256px PNG rather than the ZC text fallback", () => {
    expect(getProviderIconSrc("zcode")).toBe("/providers/zcode.png");
    const png = readFileSync(new URL("../../public/providers/zcode.png", import.meta.url));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBe(256);
    expect(png.readUInt32BE(20)).toBe(256);
  });
});
