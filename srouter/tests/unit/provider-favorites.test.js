import { describe, expect, it } from "vitest";
import {
  buildProviderStrip,
  normalizeFavoriteIds,
  toggleFavoriteId,
} from "../../src/app/(dashboard)/dashboard/providers/components/providerFavorites.js";

describe("provider favorites storage contract", () => {
  it("normalizes whatever the settings document holds into a clean id list", () => {
    expect(normalizeFavoriteIds([" a ", "b", "a", "", null, 7, "b"])).toEqual(["a", "b"]);
    expect(normalizeFavoriteIds(undefined)).toEqual([]);
    expect(normalizeFavoriteIds("xai")).toEqual([]);
    expect(normalizeFavoriteIds({ xai: true })).toEqual([]);
  });

  it("toggles ids without mutating the stored list", () => {
    const original = ["a", "b"];
    expect(toggleFavoriteId(original, "c")).toEqual(["a", "b", "c"]);
    expect(toggleFavoriteId(original, "a")).toEqual(["b"]);
    expect(toggleFavoriteId(original, "")).toEqual(["a", "b"]);
    expect(toggleFavoriteId(null, "a")).toEqual(["a"]);
    expect(original).toEqual(["a", "b"]);
  });
});

describe("quick-access strip", () => {
  const providers = [
    { id: "a", name: "Alpha" },
    { id: "b", name: "Beta" },
    { id: "c", name: "Gamma" },
    { id: "d", name: "Delta" },
  ];

  it("is favorites in storage order followed by connected providers by name", () => {
    const connected = new Set(["a", "c", "d"]);
    const strip = buildProviderStrip(providers, ["d", "b"], (p) => connected.has(p.id));
    expect(strip.map((item) => item.id)).toEqual(["d", "b", "a", "c"]);
    expect(strip.map((item) => item.favorite)).toEqual([true, true, false, false]);
    expect(strip.find((item) => item.id === "b").connected).toBe(false);
    expect(strip.find((item) => item.id === "a").connected).toBe(true);
  });

  it("keeps providers without connections out unless they are favorites", () => {
    const strip = buildProviderStrip(providers, ["d"], (p) => p.id === "a");
    expect(strip.map((item) => item.id)).toEqual(["d", "a"]);
  });

  it("skips unknown or removed favorite ids but leaves them stored", () => {
    const strip = buildProviderStrip([{ id: "a", name: "Alpha" }], ["gone", "a"], () => false);
    expect(strip.map((item) => item.id)).toEqual(["a"]);
    expect(toggleFavoriteId(["gone", "a"], "b")).toEqual(["gone", "a", "b"]);
  });

  it("deduplicates repeated providers and repeated favorites", () => {
    const strip = buildProviderStrip(
      [
        { id: "a", name: "Alpha" },
        { id: "a", name: "Alpha again" },
        { id: "b", name: "Beta" },
      ],
      ["a", "a"],
      () => true,
    );
    expect(strip.map((item) => item.id)).toEqual(["a", "b"]);
    expect(strip[0].provider.name).toBe("Alpha");
  });

  it("tolerates missing arguments", () => {
    expect(buildProviderStrip(undefined, undefined)).toEqual([]);
    expect(buildProviderStrip(providers, [])).toEqual([]);
  });
});
