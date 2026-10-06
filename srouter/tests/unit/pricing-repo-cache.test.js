import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  getAll: vi.fn(async () => ({ custom: { model: { input: 1, output: 2 } } })),
}));
vi.mock("../../src/lib/db/helpers/kvStore.js", () => ({
  makeKv: () => ({ getAll: mocks.getAll, clear: vi.fn() }),
}));
vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: vi.fn() }));
afterEach(() => vi.useRealTimers());

describe("pricing repository cached resolution", () => {
  it("reuses pricing until the cache expires", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { getPricingForModel } = await import("../../src/lib/db/repos/pricingRepo.js");
    expect(await getPricingForModel("custom", "model")).toEqual({ input: 1, output: 2 });
    await getPricingForModel("custom", "model");
    expect(mocks.getAll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5001);
    await getPricingForModel("custom", "model");
    expect(mocks.getAll).toHaveBeenCalledTimes(2);
  });
});
