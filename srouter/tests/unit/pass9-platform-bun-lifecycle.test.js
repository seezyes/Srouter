import { describe, it, expect, vi } from "vitest";

// P9-F5 positive regression: the Bun adapter must not leak process hooks across
// open/close cycles. Native `bun:sqlite` is unavailable in this Node test runner,
// so this is a labelled Node surrogate: the adapter module is exercised with a
// fake `bun:sqlite` Database. The lifecycle logic under test (register named
// handlers, remove them on close, stay idempotent) is runtime-independent.

const { FakeDatabase } = vi.hoisted(() => {
  class Stmt {
    run() { return { changes: 0, lastInsertRowid: 0 }; }
    get() { return undefined; }
    all() { return []; }
  }
  class FakeDatabase {
    constructor() { this.closed = false; }
    exec() {}
    prepare() { return new Stmt(); }
    transaction(fn) { return () => fn(); }
    close() { this.closed = true; }
  }
  return { FakeDatabase };
});

vi.mock("bun:sqlite", () => ({ Database: FakeDatabase }));

const { createBunSqliteAdapter } = await import("../../src/lib/db/adapters/bunSqliteAdapter.js");

const EVENTS = ["beforeExit", "SIGINT", "SIGTERM"];

describe("P9-F5 bun adapter process-hook lifecycle (Node surrogate)", () => {
  it("registers then removes beforeExit/SIGINT/SIGTERM listeners on close", async () => {
    const before = Object.fromEntries(EVENTS.map((e) => [e, process.listenerCount(e)]));

    const adapter = await createBunSqliteAdapter("fixture.sqlite");
    for (const e of EVENTS) expect(process.listenerCount(e)).toBe(before[e] + 1);

    adapter.close();
    for (const e of EVENTS) expect(process.listenerCount(e)).toBe(before[e]);
  });

  it("close is idempotent and does not remove foreign listeners twice", async () => {
    const before = Object.fromEntries(EVENTS.map((e) => [e, process.listenerCount(e)]));

    const adapter = await createBunSqliteAdapter("fixture.sqlite");
    adapter.close();
    expect(() => adapter.close()).not.toThrow();
    for (const e of EVENTS) expect(process.listenerCount(e)).toBe(before[e]);
  });
});
