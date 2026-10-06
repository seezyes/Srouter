import { describe, expect, it } from "vitest";
import { compareModelVersions } from "../../src/shared/utils/modelVersionSort.js";

describe("pool model sorting", () => {
  it("keeps families alphabetical and puts newer versions first", () => {
    expect(["gpt-5.9-sol", "gpt-6-sol", "claude-4", "gpt-6.1-sol", "gpt-5.10-sol", "codex-auto-review", "gpt-6-astra", "gpt-6-luna"]
      .sort(compareModelVersions)).toEqual([
      "claude-4", "codex-auto-review", "gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-5.10-sol", "gpt-5.9-sol",
    ]);
  });
  it("supports multiple numeric segments and text-only models", () => {
    expect(["model-2.1", "model-2.11", "model-10.1", "alpha", "zeta"].sort(compareModelVersions))
      .toEqual(["alpha", "model-10.1", "model-2.11", "model-2.1", "zeta"]);
  });
});
