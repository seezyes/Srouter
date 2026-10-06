import { describe, expect, it, vi } from "vitest";
import {
  matchesQuotaProviderFilter,
  parseQuotaProviderFilter,
  toggleQuotaProviderFilter,
} from "../../src/shared/utils/quotaProviderFilter.js";

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: async () => [
    { id: "c1", provider: "codex", authType: "oauth", priority: 1 },
    { id: "f1", provider: "factory", authType: "oauth", priority: 2 },
    { id: "c2", provider: "codex", authType: "oauth", priority: 3, isActive: false },
    { id: "g1", provider: "github", authType: "oauth", priority: 4 },
  ],
}));
vi.mock("@/lib/oauth/providers", () => ({ backfillCodexEmails: async () => {} }));

import { GET } from "../../src/app/api/providers/client/route.js";

describe("quota provider multiselect", () => {
  it("adds and removes independent selections, with no selection meaning all", () => {
    expect(toggleQuotaProviderFilter("all", "codex")).toBe("codex");
    expect(toggleQuotaProviderFilter("codex", "factory")).toBe("codex,factory");
    expect(toggleQuotaProviderFilter("codex,factory", "codex")).toBe("factory");
    expect(toggleQuotaProviderFilter("factory", "factory")).toBe("all");
  });

  it("normalizes selections and preserves the old single-provider contract", () => {
    expect(parseQuotaProviderFilter("codex, factory,codex,")).toEqual(["codex", "factory"]);
    expect(matchesQuotaProviderFilter("codex", "factory")).toBe(false);
    expect(matchesQuotaProviderFilter("codex", "codex")).toBe(true);
    expect(matchesQuotaProviderFilter("all", "factory")).toBe(true);
    expect(matchesQuotaProviderFilter("", "factory")).toBe(true);
  });

  it("filters the provider union before account filtering and pagination", async () => {
    const response = await GET(new Request(
      "http://localhost/api/providers/client?provider=codex,factory&accountStatus=active&pageSize=1&page=2",
    ));
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.connections.map((row) => row.id)).toEqual(["f1"]);
    expect(data.totals.providerFilteredConnections).toBe(3);
    expect(data.pagination).toMatchObject({ total: 2, page: 2, totalPages: 2 });
    expect(data.providerOptions).toContain("codex");
    expect(data.providerOptions).toContain("factory");
  });

  it("keeps single-provider URLs and all-provider reset compatible", async () => {
    const single = await (await GET(new Request(
      "http://localhost/api/providers/client?provider=codex",
    ))).json();
    expect(single.connections.map((row) => row.id)).toEqual(["c1", "c2"]);
    const all = await (await GET(new Request(
      "http://localhost/api/providers/client",
    ))).json();
    expect(all.connections.some((row) => row.provider === "factory")).toBe(true);
  });
});
