import { describe, expect, it } from "vitest";
import { groupProviderCards } from "../../src/app/(dashboard)/dashboard/providers/components/providerCardGroups.js";

const entries = (...ids) => ids.map((id) => [id, { id, name: id }]);

describe("provider overview card groups", () => {
  it("keeps independent LlamaGate and Meta services separate", () => {
    expect(groupProviderCards(entries("llamagate", "meta")).map((group) => group.id))
      .toEqual(["llamagate", "meta"]);
  });
  it("groups the remaining visible variant pairs, keeping their original entries", () => {
    const source = entries(
      "cline", "clinepass", "codebuddy-cn", "codebuddy-intl", "grok-cli", "xai",
      "alibaba", "alicode", "alicode-intl", "alims-intl", "alitp-intl"
    );
    const grouped = groupProviderCards(source);
    expect(grouped.filter((group) => group.entries.length > 1).map((group) => group.name))
      .toEqual(["Cline", "CodeBuddy", "Alibaba"]);
    expect(grouped.flatMap((group) => group.entries)).toEqual(source);
    expect(grouped[0].entries[0]).toBe(source[0]);
  });

  it("places a group at its first variant without dropping unrelated cards", () => {
    const source = entries("other", "clinepass", "middle", "cline", "last");
    expect(groupProviderCards(source).map((group) => group.id))
      .toEqual(["other", "cline", "middle", "last"]);
    expect(source.map(([id]) => id)).toEqual(["other", "clinepass", "middle", "cline", "last"]);
  });

  it("keeps single visible variants as their own cards", () => {
    expect(groupProviderCards(entries("clinepass", "xai", "codebuddy-cn"))
      .map((group) => [group.id, group.entries.length]))
      .toEqual([["clinepass", 1], ["xai", 1], ["codebuddy-cn", 1]]);
  });

  it("never hides search or status-filter results behind a group", () => {
    const source = entries("cline", "clinepass", "xai", "grok-cli");
    expect(groupProviderCards(source, true).map((group) => group.entries)).toEqual(source.map((entry) => [entry]));
  });

  it("keeps grok-cli (OAuth) and xai (API key) separate after the category move", () => {
    expect(groupProviderCards(entries("xai", "grok-cli")).map((group) => group.id))
      .toEqual(["xai", "grok-cli"]);
  });

  it("collapses the five Alibaba adapters into one Alibaba card", () => {
    const source = entries("alibaba", "alicode", "alicode-intl", "alims-intl", "alitp-intl", "other");
    const grouped = groupProviderCards(source);
    const alibaba = grouped.find((group) => group.id === "alibaba");
    expect(alibaba.name).toBe("Alibaba");
    expect(alibaba.entries.map(([id]) => id))
      .toEqual(["alibaba", "alicode", "alicode-intl", "alims-intl", "alitp-intl"]);
    expect(grouped.flatMap((group) => group.entries)).toEqual(source);
    expect(grouped.map((group) => group.entries.length)).toEqual([5, 1]);
  });

  it("keeps every Alibaba adapter individually selectable while filtering", () => {
    const source = entries("alibaba", "alicode", "alicode-intl", "alims-intl", "alitp-intl");
    expect(groupProviderCards(source, true).map((group) => group.entries))
      .toEqual(source.map((entry) => [entry]));
  });

  it("does not enable or group the currently disabled Grok Web section", () => {
    expect(groupProviderCards(entries("xai", "grok-web")).map((group) => group.id))
      .toEqual(["xai", "grok-web"]);
    expect(groupProviderCards([])).toEqual([]);
  });
});
