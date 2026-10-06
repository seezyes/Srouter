import { describe, it, expect, vi } from "vitest";

// Deterministic UA value: proves the executor uses the module, not the static
// registry header.
vi.mock("open-sse/utils/kimchiUserAgent.js", () => ({
  getKimchiUserAgent: () => "kimchi/1.2.3",
}));

import { getExecutor } from "open-sse/executors/index.js";
import { PROVIDERS } from "open-sse/config/providers.js";

describe("Kimchi User-Agent wiring", () => {
  it("registry auth descriptor declares the kimchiHeaders hook", () => {
    expect(PROVIDERS.kimchi.auth.hooks).toContain("kimchiHeaders");
  });

  it("kimchi executor builds headers with the live User-Agent, not the static fallback", () => {
    const executor = getExecutor("kimchi");
    const headers = executor.buildHeaders({ apiKey: "test-key" }, true);

    expect(headers["User-Agent"]).toBe("kimchi/1.2.3");
    expect(headers["User-Agent"]).not.toBe(PROVIDERS.kimchi.headers["User-Agent"]);
    expect(headers.Authorization).toBe("Bearer test-key");
  });
});
