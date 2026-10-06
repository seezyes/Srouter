import { describe, expect, it } from "vitest";
import { groupProviderCards } from "../../src/app/(dashboard)/dashboard/providers/components/providerCardGroups.js";
import { OAUTH_PROVIDERS } from "../../src/shared/constants/providers.js";

const entries = (...ids) => ids.map((id) => [id, OAUTH_PROVIDERS[id] || { id, name: id }]);

describe("Qoder provider card collapse", () => {
  it("groups the real OAuth entries at their first position, preserving both cards", () => {
    const source = entries("claude", "qoder", "github", "qoder-cn", "zed");
    const result = groupProviderCards(source);
    expect(result.map((g) => g.id)).toEqual(["claude", "qoder", "github", "zed"]);
    const qoder = result[1];
    expect(qoder.name).toBe("Qoder");
    expect(qoder.entries.map(([, provider]) => provider.name)).toEqual(["Qoder", "Qoder CN"]);
    expect(qoder.entries[0]).toBe(source[1]);
    expect(qoder.entries[1]).toBe(source[3]);
    expect(qoder.entries.map(([, provider]) => provider.authModes)).toEqual([
      ["oauth", "apikey"], ["oauth", "apikey"],
    ]);
    expect(source.map(([id]) => id)).toEqual(["claude", "qoder", "github", "qoder-cn", "zed"]);
  });

  it("keeps the original variant order even if CN appears first", () => {
    const source = entries("qoder-cn", "other", "qoder");
    expect(groupProviderCards(source)[0]).toMatchObject({
      id: "qoder", name: "Qoder", entries: [source[0], source[2]],
    });
    expect(groupProviderCards(source)).toHaveLength(2);
  });

  it.each(["qoder", "qoder-cn"])("does not collapse a lone visible %s variant", (id) => {
    const source = entries(id);
    expect(groupProviderCards(source)).toEqual([{ id, entries: source }]);
  });

  it("keeps both variants individually accessible during search, status filtering or favorite editing", () => {
    const source = entries("qoder", "qoder-cn");
    expect(groupProviderCards(source, true)).toEqual(source.map((entry) => ({
      id: entry[0], entries: [entry],
    })));
  });

  it("leaves Cline and CodeBuddy collapse groups intact", () => {
    const source = entries("cline", "clinepass", "qoder", "qoder-cn", "codebuddy-intl", "codebuddy-cn");
    const result = groupProviderCards(source);
    expect(result.map((g) => g.name)).toEqual(["Cline", "Qoder", "CodeBuddy"]);
    expect(result.flatMap((g) => g.entries)).toEqual(source);
  });
});
