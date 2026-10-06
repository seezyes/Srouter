import { describe, expect, it } from "vitest";
import {
  STATUS_FILTER_OPTIONS,
  WIP_PROVIDER_IDS,
  getConnectionStatus,
  isWipFilter,
  isWipProvider,
  matchesStatusFilter,
} from "@/app/(dashboard)/dashboard/providers/utils.js";

describe("providers status filter", () => {
  it("exposes all/active/inactive/none/wip options", () => {
    expect(STATUS_FILTER_OPTIONS.map((o) => o.value)).toEqual([
      "all",
      "active",
      "inactive",
      "none",
      "wip",
    ]);
    expect(STATUS_FILTER_OPTIONS.at(-1)).toEqual({ value: "wip", label: "WIP" });
  });

  it("keeps Factory in the WIP list and out of every connection status", () => {
    expect(WIP_PROVIDER_IDS).toContain("factory");
    expect(isWipProvider("factory")).toBe(true);
    expect(isWipProvider("opencode-go")).toBe(false);
    expect(isWipFilter("wip")).toBe(true);
    expect(isWipFilter("all")).toBe(false);
  });

  it("classifies a provider with no connections as none", () => {
    expect(getConnectionStatus({ total: 0, allDisabled: false })).toBe("none");
  });

  it("classifies a provider whose only connections are disabled as inactive", () => {
    expect(getConnectionStatus({ total: 2, allDisabled: true })).toBe(
      "inactive",
    );
  });

  it("classifies a provider with at least one enabled connection as active", () => {
    expect(getConnectionStatus({ total: 1, allDisabled: false })).toBe(
      "active",
    );
  });

  it("treats noAuth providers as active even with no stored connection", () => {
    expect(getConnectionStatus({ total: 0, allDisabled: false }, true)).toBe(
      "active",
    );
  });

  it("matchesStatusFilter always passes for 'all'", () => {
    expect(matchesStatusFilter("all", { total: 0, allDisabled: false })).toBe(
      true,
    );
  });

  it("matchesStatusFilter compares against the derived status", () => {
    const disabledStats = { total: 3, allDisabled: true };
    expect(matchesStatusFilter("inactive", disabledStats)).toBe(true);
    expect(matchesStatusFilter("active", disabledStats)).toBe(false);
    expect(matchesStatusFilter("none", disabledStats)).toBe(false);
  });
});
