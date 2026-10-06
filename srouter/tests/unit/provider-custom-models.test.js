import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeAll, vi } from "vitest";
import { getProviderCustomModelRows } from "@/shared/utils/providerCustomModels.js";

describe("provider custom model rows", () => {
  it("keeps identical model IDs separate per provider", () => {
    const customModels = [
      { providerAlias: "ollama", id: "minimax-m2.5", type: "llm", name: "MiniMax M2.5" },
      { providerAlias: "opencode-go", id: "minimax-m2.5", type: "llm", name: "MiniMax M2.5" },
    ];

    expect(getProviderCustomModelRows({ customModels, providerAlias: "ollama" })).toEqual([
      {
        id: "minimax-m2.5",
        name: "MiniMax M2.5",
        fullModel: "ollama/minimax-m2.5",
        source: "custom",
        type: "llm",
      },
    ]);
    expect(getProviderCustomModelRows({ customModels, providerAlias: "opencode-go" })).toEqual([
      {
        id: "minimax-m2.5",
        name: "MiniMax M2.5",
        fullModel: "opencode-go/minimax-m2.5",
        source: "custom",
        type: "llm",
      },
    ]);
  });

  it("keeps legacy alias-backed models visible without duplicating custom models", () => {
    const rows = getProviderCustomModelRows({
      customModels: [
        { providerAlias: "ollama", id: "custom-a", type: "llm", name: "Custom A" },
      ],
      modelAliases: {
        "custom-a": "ollama/custom-a",
        "legacy-b": "ollama/legacy-b",
        "other-provider": "opencode-go/legacy-b",
      },
      providerAlias: "ollama",
    });

    expect(rows).toEqual([
      {
        id: "custom-a",
        name: "Custom A",
        fullModel: "ollama/custom-a",
        source: "custom",
        type: "llm",
      },
      {
        id: "legacy-b",
        alias: "legacy-b",
        fullModel: "ollama/legacy-b",
        source: "legacyAlias",
        type: "llm",
      },
    ]);
  });

  it("filters built-in models and typed custom models", () => {
    const rows = getProviderCustomModelRows({
      customModels: [
        { providerAlias: "ollama", id: "llama3", type: "llm", name: "Llama 3" },
        { providerAlias: "ollama", id: "custom-image", type: "image", name: "Custom Image" },
        { providerAlias: "ollama", id: "custom-llm", type: "llm", name: "Custom LLM" },
      ],
      providerAlias: "ollama",
      builtInModels: [{ id: "llama3" }],
      type: "llm",
    });

    expect(rows).toEqual([
      {
        id: "custom-llm",
        name: "Custom LLM",
        fullModel: "ollama/custom-llm",
        source: "custom",
        type: "llm",
      },
    ]);
  });
});

// Bulk custom-model import (POST /api/models/custom with { models: [...] }) against
// a real SQLite DATA_DIR. The upstream test file covers the same path with the
// process-wide database; here it gets a temp dir so no developer DB is touched.
describe("custom model bulk import (sqlite)", () => {
  let db;
  let post;

  const req = (body) =>
    new Request("http://localhost/api/models/custom", { method: "POST", body: JSON.stringify(body) });

  beforeAll(async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-custom-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    await db.initDb();
    ({ POST: post } = await import("@/app/api/models/custom/route.js"));
  });

  it("adds custom models in bulk atomically", async () => {
    const testModels = [
      { providerAlias: "test-bulk-prov", id: "bulk-m1", type: "llm" },
      { providerAlias: "test-bulk-prov", id: "bulk-m2", type: "llm" },
    ];
    expect(await db.addCustomModelsBulk(testModels)).toBe(2);

    const all = await db.getCustomModels();
    expect(all.find((m) => m.providerAlias === "test-bulk-prov" && m.id === "bulk-m1")).toMatchObject({
      providerAlias: "test-bulk-prov",
      id: "bulk-m1",
      type: "llm",
      name: "bulk-m1",
    });
    expect(all.find((m) => m.providerAlias === "test-bulk-prov" && m.id === "bulk-m2")).toMatchObject({
      providerAlias: "test-bulk-prov",
      id: "bulk-m2",
      type: "llm",
      name: "bulk-m2",
    });

    // Clean up
    await db.deleteCustomModel({ providerAlias: "test-bulk-prov", id: "bulk-m1", type: "llm" });
    await db.deleteCustomModel({ providerAlias: "test-bulk-prov", id: "bulk-m2", type: "llm" });
  });

  it("upserts existing entries and skips malformed ones", async () => {
    expect(await db.addCustomModelsBulk([{ providerAlias: "repo-bulk", id: "m1", name: "First" }])).toBe(1);
    expect(await db.addCustomModelsBulk([
      { providerAlias: "repo-bulk", id: "m1", name: "Second" },
      { providerAlias: "repo-bulk" },
      { id: "no-provider" },
      null,
    ])).toBe(1);

    const rows = (await db.getCustomModels()).filter((m) => m.providerAlias === "repo-bulk");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "m1", name: "Second" });

    expect(await db.addCustomModelsBulk([])).toBe(0);
    expect(await db.addCustomModelsBulk("nope")).toBe(0);
  });

  it("imports a batch through POST /api/models/custom", async () => {
    const res = await post(req({
      models: [
        { providerAlias: "route-bulk", id: "r1", name: "Route 1", caps: { vision: true, bogus: true } },
        { providerAlias: "route-bulk", id: "r2" },
        { id: "ignored" },
      ],
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, count: 2 });

    const rows = (await db.getCustomModels()).filter((m) => m.providerAlias === "route-bulk");
    expect(rows).toHaveLength(2);
    expect(rows.find((m) => m.id === "r1")).toMatchObject({ name: "Route 1", caps: { vision: true } });
    expect(rows.find((m) => m.id === "r2")).toMatchObject({ name: "r2", type: "llm" });
    expect(rows.find((m) => m.id === "r2").caps).toBeUndefined();
  });

  it("keeps the single-add path on the same endpoint", async () => {
    const res = await post(req({ providerAlias: "route-bulk", id: "s1", name: "Single 1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, added: true });

    const again = await post(req({ providerAlias: "route-bulk", id: "s1", name: "Single 2" }));
    expect(await again.json()).toEqual({ success: true, added: false });
    const rows = (await db.getCustomModels()).filter((m) => m.providerAlias === "route-bulk" && m.id === "s1");
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Single 2");

    expect((await post(req({ id: "no-provider" }))).status).toBe(400);
  });
});
