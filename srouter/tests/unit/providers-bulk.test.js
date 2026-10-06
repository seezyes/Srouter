/**
 * Batch provider-connection import: POST /api/providers/bulk → connectionsRepo
 * transaction → real SQLite. The repository itself has no upstream test, so this
 * exercises the whole path: validation, upsert-by-name semantics, per-item
 * results, authType labelling for web-cookie providers and priority renumbering.
 *
 * The temp DATA_DIR is intentionally not removed — the sqlite driver keeps the
 * file handle open for the life of the process (rmSync would fail with EPERM on
 * Windows); the OS cleans up its own temp directory.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, vi } from "vitest";

let db;
let bulkPost;

const post = (body) =>
  new Request("http://localhost/api/providers/bulk", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-bulk-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  ({ POST: bulkPost } = await import("@/app/api/providers/bulk/route.js"));
});

describe("POST /api/providers/bulk", () => {
  it("creates a batch of API-key connections in one transaction", async () => {
    const res = await bulkPost(post({
      items: [
        { provider: "anthropic", apiKey: "sk-a1", name: "bulk-a" },
        { provider: "ai21", apiKey: "sk-b1", name: "bulk-b", providerSpecificData: { region: "eu" } },
      ],
    }));
    expect(res.status).toBe(201);
    const { results } = await res.json();
    expect(results).toEqual([
      { name: "bulk-a", ok: true, id: expect.any(String), updated: false },
      { name: "bulk-b", ok: true, id: expect.any(String), updated: false },
    ]);

    const list = await db.getProviderConnections();
    expect(list.find((c) => c.name === "bulk-a")).toMatchObject({
      provider: "anthropic",
      authType: "apikey",
      testStatus: "unknown",
      priority: 1,
      isActive: true,
      apiKey: "sk-a1",
    });
    expect(list.find((c) => c.name === "bulk-b").providerSpecificData).toEqual({ region: "eu" });
  });

  it("upserts an existing provider/name instead of duplicating it", async () => {
    const res = await bulkPost(post({
      items: [{ provider: "anthropic", apiKey: "sk-a2", name: "bulk-a" }],
    }));
    expect(res.status).toBe(201);
    const { results } = await res.json();
    expect(results).toEqual([{ name: "bulk-a", ok: true, id: expect.any(String), updated: true }]);

    const rows = (await db.getProviderConnections()).filter((c) => c.provider === "anthropic" && c.name === "bulk-a");
    expect(rows).toHaveLength(1);
    expect(rows[0].apiKey).toBe("sk-a2");
  });

  it("labels web-cookie providers as cookie connections", async () => {
    const res = await bulkPost(post({
      items: [{ provider: "perplexity-web", apiKey: "session-cookie-value", name: "bulk-cookie" }],
    }));
    expect(res.status).toBe(201);
    const conn = (await db.getProviderConnections()).find((c) => c.name === "bulk-cookie");
    expect(conn).toMatchObject({ provider: "perplexity-web", authType: "cookie", apiKey: "session-cookie-value" });
  });

  it("accepts compatible-node ids that never appear in AI_PROVIDERS", async () => {
    const node = await db.createProviderNode({ id: "openai-compatible-bulk-node", type: "openai-compatible", name: "bulk-node", prefix: "bulk-node", baseUrl: "https://fixture.example/v1", apiType: "chat" });
    const nodeId = node.id;
    const res = await bulkPost(post({
      items: [{ provider: nodeId, apiKey: "sk-node", name: "bulk-node" }],
    }));
    expect(res.status).toBe(201);
    const conn = (await db.getProviderConnections()).find((c) => c.name === "bulk-node");
    expect(conn).toMatchObject({ provider: nodeId, authType: "apikey" });
    expect(conn.providerSpecificData).toMatchObject({ baseUrl: node.baseUrl, prefix: node.prefix, nodeName: node.name, apiType: node.apiType });
  });

  it("HR-12 rejects missing compatible nodes before persisting any item", async () => {
    const res = await bulkPost(post({ items: [
      { provider: "ai21", apiKey: "fixture", name: "not-written-before-invalid-node" },
      { provider: "openai-compatible-missing", apiKey: "fixture", name: "missing-node" },
    ] }));
    expect(res.status).toBe(400);
    expect((await db.getProviderConnections()).some(c => c.name === "not-written-before-invalid-node")).toBe(false);
  });

  it("renumbers priorities per provider after the batch", async () => {
    const res = await bulkPost(post({
      items: [
        { provider: "ai21", apiKey: "sk-p5", name: "bulk-p5", priority: 5 },
        { provider: "ai21", apiKey: "sk-p2", name: "bulk-p2", priority: 2 },
        { provider: "ai21", apiKey: "sk-p9", name: "bulk-p9", priority: 9 },
      ],
    }));
    expect(res.status).toBe(201);
    // Priorities are renumbered 1..N across every connection of the provider
    // (bulk-b was created by the first test with priority 1).
    const rows = (await db.getProviderConnections()).filter((c) => c.provider === "ai21");
    expect(rows.map((c) => [c.name, c.priority]).sort((a, b) => a[1] - b[1])).toEqual([
      ["bulk-b", 1],
      ["bulk-p2", 2],
      ["bulk-p5", 3],
      ["bulk-p9", 4],
    ]);
  });

  it("rejects malformed batches", async () => {
    expect((await bulkPost(post({}))).status).toBe(400);
    expect((await bulkPost(post({ items: [] }))).status).toBe(400);
    expect((await bulkPost(post({ items: "nope" }))).status).toBe(400);
    expect((await bulkPost(post({
      items: Array.from({ length: 501 }, (_, i) => ({ provider: "ai21", apiKey: "k", name: `n${i}` })),
    }))).status).toBe(400);
    // unknown provider, empty key, blank name
    expect((await bulkPost(post({ items: [{ provider: "no-such-provider", apiKey: "k", name: "n" }] }))).status).toBe(400);
    expect((await bulkPost(post({ items: [{ provider: "ai21", apiKey: "  ", name: "n" }] }))).status).toBe(400);
    expect((await bulkPost(post({ items: [{ provider: "ai21", apiKey: "k", name: "   " }] }))).status).toBe(400);

    const list = await db.getProviderConnections();
    expect(list.some((c) => c.provider === "no-such-provider")).toBe(false);
  });

  it("rejects duplicate provider/name pairs inside one batch", async () => {
    const res = await bulkPost(post({
      items: [
        { provider: "ai21", apiKey: "k1", name: "bulk-dup" },
        { provider: "ai21", apiKey: "k2", name: "bulk-dup" },
      ],
    }));
    expect(res.status).toBe(409);
    expect((await db.getProviderConnections()).some((c) => c.name === "bulk-dup")).toBe(false);
  });
});

describe("createProviderConnectionsBulk (repo)", () => {
  it("guards the batch size", async () => {
    await expect(db.createProviderConnectionsBulk([])).rejects.toThrow(/1-500/);
    await expect(db.createProviderConnectionsBulk("nope")).rejects.toThrow(/1-500/);
    await expect(
      db.createProviderConnectionsBulk(Array.from({ length: 501 }, (_, i) => ({ provider: "ai21", apiKey: "k", name: `big${i}` }))),
    ).rejects.toThrow(/1-500/);
  });

  it("reports per-item failures instead of aborting the batch", async () => {
    const results = await db.createProviderConnectionsBulk([
      { provider: "ai21", apiKey: "sk-ok", name: "repo-ok" },
      { provider: "ai21", name: "repo-missing-key" },
    ]);
    expect(results).toEqual([
      { name: "repo-ok", ok: true, id: expect.any(String), updated: false },
      { name: "repo-missing-key", ok: false, error: "provider, apiKey, and name are required" },
    ]);
    expect((await db.getProviderConnections()).some((c) => c.name === "repo-missing-key")).toBe(false);
  });
});
