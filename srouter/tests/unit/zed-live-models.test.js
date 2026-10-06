// Route-level acceptance for the Zed live-model wiring:
//   GET /api/providers/[connectionId]/models  →  resolveZedModels  →  UI rows
// Isolation is mandatory and installed before application imports.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

const isolatedDb = await vi.hoisted(async () => {
  vi.resetModules();
  const { createIsolatedZedDb } = await import("../helpers/isolatedZedDb.js");
  return createIsolatedZedDb();
});
// Pin both exports: the production resolver can fall back to working data on
// permission errors. Tests must fail instead, never resolve a fallback directory.
vi.mock("@/lib/dataDir.js", () => ({
  DATA_DIR: isolatedDb.dataDir,
  getDataDir: () => isolatedDb.dataDir,
}));

import { GET } from "@/app/api/providers/[id]/models/route.js";
import { createProviderConnection } from "@/models/index.js";

afterAll(() => isolatedDb.cleanup());

it("uses a fresh owned DB rather than inherited DATA_DIR", async () => {
  const { DATA_DIR, getDataDir } = await import("@/lib/dataDir.js");
  const { DATA_FILE } = await import("@/lib/db/paths.js");
  const { join } = await import("node:path");
  const { getProviderConnections } = await import("@/models/index.js");
  expect(DATA_DIR).toBe(isolatedDb.dataDir);
  expect(getDataDir()).toBe(isolatedDb.dataDir);
  expect(DATA_DIR).not.toBe(isolatedDb.inheritedDataDir);
  expect(DATA_FILE).toBe(join(isolatedDb.dataDir, "db", "data.sqlite"));
  expect(await getProviderConnections()).toEqual([]);
});

// Transport stub BELOW resolveZedModels: proxyAwareFetch captures the native
// fetch at import time, so stubbing globalThis.fetch cannot intercept it.
// Mock the module instead; unexpected requests must never hit live providers.
const stub = vi.hoisted(() => ({ mode: "ok", calls: [] }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: async (url) => {
    const u = String(url);
    stub.calls.push(u);
    if (u.includes("cloud.zed.dev/client/users/me")) {
      return Response.json({ default_organization_id: "org-1" });
    }
    if (u.includes("cloud.zed.dev/client/llm_tokens")) {
      return Response.json({ token: "llm-token" });
    }
    if (u.includes("cloud.zed.dev/models")) {
      if (stub.mode === "error") return new Response("boom", { status: 500 });
      if (stub.mode === "empty") return Response.json({ models: [] });
      return Response.json(stub.catalog);
    }
    throw new Error(`Unexpected network request in Zed models test: ${url}`);
  },
  default: async (url) => {
    throw new Error(`Unexpected network request in Zed models test: ${url}`);
  },
}));

stub.catalog = {
  models: [
    {
      id: "claude-opus-4-live",
      display_name: "Claude Opus Live",
      provider: "anthropic",
      max_token_count: 200000,
      max_output_tokens: 32000,
      supports_tools: true,
      supports_images: true,
      supports_thinking: true,
      is_disabled: false,
    },
    {
      id: "gpt-live",
      display_name: "GPT Live",
      provider: "openai",
      max_token_count: 128000,
      max_output_tokens: 16384,
      supports_tools: true,
      is_disabled: false,
    },
    {
      id: "retired-model",
      display_name: "Retired",
      provider: "openai",
      is_disabled: true,
    },
  ],
  default_model: "claude-opus-4-live",
};

beforeEach(() => {
  stub.mode = "ok";
  stub.calls.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function seedZed(n) {
  return createProviderConnection({
    provider: "zed",
    authType: "oauth",
    accessToken: `tok-live-${n}-${Date.now()}`,
    email: `zed-live-${n}-${Date.now()}@example.com`,
    providerSpecificData: { userId: `u-${n}`, systemId: `sys-${n}` },
    testStatus: "active",
  });
}

async function getModels(connectionId) {
  const req = new Request(`http://localhost/api/providers/${connectionId}/models`);
  return GET(req, { params: Promise.resolve({ id: connectionId }) });
}

describe("criterion 1+2 — active connection + live catalog → models with metadata", () => {
  it("returns enabled models with preserved metadata, no secrets", async () => {
    const conn = await seedZed("m1");
    const res = await getModels(conn.id);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.models.map((m) => m.id).sort()).toEqual(["claude-opus-4-live", "gpt-live"]);
    const opus = data.models.find((m) => m.id === "claude-opus-4-live");
    expect(opus.name).toBe("Claude Opus Live");
    expect(opus.contextLength).toBe(200000);
    expect(opus.maxOutputTokens).toBe(32000);
    expect(opus.supportsTools).toBe(true);
    expect(opus.supportsImages).toBe(true);
    expect(opus.supportsThinking).toBe(true);
    // Credentials must never leak into the client response.
    expect(JSON.stringify(data)).not.toContain(conn.accessToken);
    expect(JSON.stringify(data)).not.toContain("tok-live");
  });
});

describe("criterion 4 — disabled models excluded", () => {
  it("is_disabled entries never reach the UI", async () => {
    const conn = await seedZed("m2");
    const data = await (await getModels(conn.id)).json();
    expect(data.models.some((m) => m.id === "retired-model")).toBe(false);
  });
});

describe("criterion 4b — empty catalog → explicit warning", () => {
  it("returns warning instead of silent zero", async () => {
    stub.mode = "empty";
    const conn = await seedZed("m3");
    const res = await getModels(conn.id);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.models).toEqual([]);
    expect(data.warning).toMatch(/no live models/i);
  });
});

describe("criterion 5 — resolver failure → useful warning, no crash", () => {
  it("returns 200 with warning text", async () => {
    stub.mode = "error";
    const conn = await seedZed("m4");
    const res = await getModels(conn.id);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.models).toEqual([]);
    expect(data.warning).toMatch(/failed to fetch zed models/i);
  });
});

describe("criterion 6 (route) — unknown connection → 404", () => {
  it("rejects missing connections", async () => {
    const res = await getModels("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });
});

describe("criterion 5 (guard) — unsupported provider unchanged", () => {
  it("still 400s for providers without a models config", async () => {
    const conn = await createProviderConnection({
      provider: "kimchi-nope",
      authType: "oauth",
      accessToken: "x",
      email: `guard-${Date.now()}@example.com`,
      testStatus: "active",
    }).catch(() => null);
    // createProviderConnection may reject unknown providers; either way the
    // route must not have gained a zed-shaped branch for others.
    if (!conn) return;
    const res = await getModels(conn.id);
    expect(res.status).toBe(400);
  });
});
