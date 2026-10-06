import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, vi } from "vitest";

// Durable proxy-pool fitness (schema + repo + service integration).
// The upstream unit test (unit/proxy-pool-fitness.test.js) mocks @/models and
// covers the service logic; this one exercises the real SQLite path: the
// additive schema table, the repo upsert/delete SQL and the read-through cache.
//
// The temp DATA_DIR is intentionally not removed — the sqlite driver keeps the
// file handle open for the life of the process (rmSync would fail with EPERM on
// Windows); the OS cleans up its own temp directory.

let db;

beforeAll(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-ppf-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

describe("proxy pool fitness (sqlite)", () => {
  it("round-trips unfit marks through the service into SQLite", async () => {
    const svc = await import("open-sse/services/proxyPoolFitness.js");
    const until = Date.now() + 60_000;
    const scope = "freebuff::openai/gpt-5";

    expect(await svc.markPoolUnfit("pool-1", scope, until, "429")).toBe(true);
    expect(svc.isPoolFit("pool-1", scope)).toBe(false);
    expect(svc.isPoolFit("pool-1", "freebuff::other-model")).toBe(true);
    expect(svc.isPoolFit("pool-1", "otherprovider::whatever")).toBe(true);
    expect(svc.fitPoolIds(["pool-1", "pool-2"], scope)).toEqual(["pool-2"]);

    const rows = await db.listProxyPoolFitness("pool-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ poolId: "pool-1", scope, reason: "429" });

    // a provider-wide mark blocks every model of that provider
    expect(await svc.markPoolUnfit("pool-1", "freebuff::*", until, "quota")).toBe(true);
    expect(svc.isPoolFit("pool-1", "freebuff::anything")).toBe(false);
    expect(await svc.clearPoolUnfit("pool-1", "freebuff::*")).toBe(true);

    expect(await svc.clearPoolUnfit("pool-1", scope)).toBe(true);
    expect(svc.isPoolFit("pool-1", scope)).toBe(true);
    expect(await db.listProxyPoolFitness("pool-1")).toHaveLength(0);
  });

  it("drops expired marks on load and keeps unknown pools fit", async () => {
    const svc = await import("open-sse/services/proxyPoolFitness.js");
    await db.upsertProxyPoolFitness("pool-3", "freebuff::old", Date.now() - 1000, "stale");
    await svc.loadPoolFitness("pool-3");
    expect(svc.isPoolFit("pool-3", "freebuff::old")).toBe(true);
    expect(await db.listProxyPoolFitness("pool-3")).toHaveLength(0);
    expect(svc.isPoolFit("pool-unknown", "freebuff::x")).toBe(true);
    expect(await svc.pruneExpired()).toBe(0);
  });
});
