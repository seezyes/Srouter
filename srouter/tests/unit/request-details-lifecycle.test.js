import { afterEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  run: vi.fn(), get: vi.fn(() => ({ c: 1 })), transaction: vi.fn((fn) => fn()),
}));
vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: vi.fn(async () => db) }));
vi.mock("../../src/lib/db/repos/settingsRepo.js", () => ({
  getSettings: vi.fn(async () => ({ enableObservability: true, observabilityFlushIntervalMs: 100 })),
}));
const events = ["beforeExit", "SIGINT", "SIGTERM", "exit"];
const counts = () => events.map((event) => process.listenerCount(event));

afterEach(() => vi.useRealTimers());

describe("request details shutdown lifecycle", () => {
  it("repeated idle imports do not add process listeners", async () => {
    const baseline = counts();
    for (let i = 0; i < 15; i++) {
      vi.resetModules();
      await import("../../src/lib/db/repos/requestDetailsRepo.js");
    }
    expect(counts()).toEqual(baseline);
  });

  it("keeps shutdown hooks only while request details are pending", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { saveRequestDetail } = await import("../../src/lib/db/repos/requestDetailsRepo.js");
    const baseline = counts();
    await saveRequestDetail({ id: "test-detail", model: "test-model" });
    expect(counts()).toEqual(baseline.map((count) => count + 1));
    await vi.advanceTimersByTimeAsync(100);
    expect(db.run).toHaveBeenCalled();
    expect(counts()).toEqual(baseline);
  });
});
