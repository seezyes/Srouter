// Pass9 — registry alias canonicalization in the real ACL caller.
//
// `grok-cli` declares display alias `gcli` and registry aliases `grok-build` and
// `gb`. Before this pass only `gcli` was known to the app-side alias map, so a
// persisted grant stored under `gb`/`grok-build` could never authorize a request
// whose canonical target is `grok-cli` (and vice versa). These tests execute the
// actual `isProviderAllowed` caller with persisted-grant fixtures; only the
// provider-node DB read is stubbed (grok-cli is not a compatible node).
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/index.js", () => ({ getProviderNodeById: async () => null }));

const { isProviderAllowed } = await import("@/sse/services/access.js");
const { resolveProviderId, getProviderAliases } = await import("@/shared/constants/providers.js");

const grant = (allowedProviders) => ({ allowedProviders });

describe("pass9 provider alias canonicalization (grok-cli)", () => {
  it("resolves every declared alias form to the canonical provider id", () => {
    for (const token of ["grok-cli", "gcli", "gb", "grok-build"]) {
      expect(resolveProviderId(token), token).toBe("grok-cli");
    }
    expect(new Set(getProviderAliases("grok-cli").aliases))
      .toEqual(new Set(["grok-cli", "gcli", "gb", "grok-build"]));
    // An unknown token is returned unchanged.
    expect(resolveProviderId("not-a-provider")).toBe("not-a-provider");
  });

  it("alias-form persisted grant authorizes the canonical target", async () => {
    for (const stored of ["gb", "grok-build", "gcli", "grok-cli"]) {
      expect(await isProviderAllowed(grant([stored]), "grok-cli"), `grant ${stored}`).toBe(true);
    }
  });

  it("canonical grant authorizes an alias-form target (reciprocal)", async () => {
    for (const target of ["gb", "grok-build", "gcli"]) {
      expect(await isProviderAllowed(grant(["grok-cli"]), target), `target ${target}`).toBe(true);
    }
  });

  it("denies unrelated grants and targets", async () => {
    expect(await isProviderAllowed(grant(["openai"]), "grok-cli")).toBe(false);
    expect(await isProviderAllowed(grant(["gb"]), "openai")).toBe(false);
    expect(await isProviderAllowed(grant([]), "grok-cli")).toBe(false);
    expect(await isProviderAllowed(grant(["gb"]), "grok-web")).toBe(false);
  });

  it("treats null/undefined grant lists as unrestricted", async () => {
    expect(await isProviderAllowed(grant(null), "grok-cli")).toBe(true);
    expect(await isProviderAllowed({}, "grok-cli")).toBe(true);
  });
});
