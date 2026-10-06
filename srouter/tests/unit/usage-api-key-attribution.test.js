import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
let db;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-api-key-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  if (globalThis._dbAdapter?.instance) globalThis._dbAdapter.instance.close();
  delete globalThis._dbAdapter;
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterEach(() => {
  globalThis._dbAdapter?.instance?.close();
  delete globalThis._dbAdapter;
  delete process.env.DATA_DIR;
});

describe("Usage stats API key attribution", () => {
  it.each(["24h", "today", "7d", "30d"])("keeps identically masked keys separate without exposing secrets (%s)", async (period) => {
    const apiKeyA = "sk-machine-aaaaaa-11111111";
    const apiKeyB = "sk-machine-bbbbbb-11111111";

    await db.saveRequestUsage({
      provider: "openai",
      model: "gpt-4",
      connectionId: "c1",
      apiKey: apiKeyA,
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      endpoint: "/v1/chat",
      status: "ok",
    });

    await db.saveRequestUsage({
      provider: "openai",
      model: "gpt-4",
      connectionId: "c1",
      apiKey: apiKeyB,
      tokens: { prompt_tokens: 20, completion_tokens: 10 },
      endpoint: "/v1/chat",
      status: "ok",
    });

    const stats = await db.getUsageStats(period);
    const apiKeyEntries = Object.values(stats.byApiKey);

    expect(apiKeyEntries).toHaveLength(2);
    expect(new Set(apiKeyEntries.map((entry) => entry.apiKeyKey)).size).toBe(2);
    expect(JSON.stringify(stats)).not.toContain(apiKeyA);
    expect(JSON.stringify(stats)).not.toContain(apiKeyB);

    expect(
      apiKeyEntries
        .map((entry) => entry.promptTokens)
        .sort((a, b) => a - b)
    ).toEqual([10, 20]);
  });
});
