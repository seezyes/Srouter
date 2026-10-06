import { describe, expect, it } from "vitest";
import { HOSTED_TOOLS_WIP, HOSTED_TOOLS_WIP_MESSAGE } from "@/shared/constants/hostedTools.js";

describe("production hosted tools policy", () => {
  it("is unavailable by default, with an explicit model-independent backend requirement", () => {
    expect(HOSTED_TOOLS_WIP).toBe(true);
    expect(HOSTED_TOOLS_WIP_MESSAGE).toContain("WIP");
    expect(HOSTED_TOOLS_WIP_MESSAGE).toContain("without invoking a model");
  });
});
