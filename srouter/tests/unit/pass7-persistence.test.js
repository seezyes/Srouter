import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: async () => "a1b2c3d4e5f6a7b8", getRawMachineId: async () => "fixture", isBrowser: () => false,
}));
// Network is an explicit fixture boundary. proxyFetch captures native fetch
// at module load, so spying on global fetch after catalog import is insufficient.
vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (url, options) => globalThis.fetch(url, options),
}));
afterEach(() => vi.restoreAllMocks());
let db, driver, root;
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-pass7-persistence-"));
  vi.stubEnv("DATA_DIR", root);
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  driver = await import("@/lib/db/driver.js");
  await db.initDb();
});
afterAll(() => {
  driver?.getAdapterSync()?.close();
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
describe("HR-18/20/27/28 real entrypoints with owned SQLite", () => {
  it("HR-20 same Cursor machine identity updates one row without email", async () => {
    const data = { provider: "cursor", authType: "oauth", accessToken: "fixture-opaque-old", email: null,
      providerSpecificData: { machineId: "fixture-machine" }, isActive: true };
    const a = await db.createProviderConnection(data);
    const b = await db.createProviderConnection({ ...data, accessToken: "fixture-opaque-new" });
    expect(a.id).toBe(b.id);
    expect(await db.getProviderConnections({ provider: "cursor" })).toHaveLength(1);
    expect((await db.getProviderConnectionById(a.id)).accessToken).toBe("fixture-opaque-new");
    await db.updateProviderConnection(a.id, { isActive: false });
  });
  it("HR-18 config-only TTS models honour kind, provider grants and disabled rows", async () => {
    await db.createProviderConnection({ provider: "elevenlabs", authType: "apikey", apiKey: "fixture", name: "fixture-tts", isActive: true });
    const catalog = await import("@/app/api/v1/models/route.js");
    const models = await catalog.buildModelsList(["tts"], { skipDynamicFetch: true });
    expect(models).toContainEqual(expect.objectContaining({ id: "el/eleven_multilingual_v2" }));
    expect(await catalog.buildModelsList(["tts"], { skipDynamicFetch: true, apiKeyInfo: { allowedKinds: [] } })).toEqual([]);
    expect(await catalog.buildModelsList(["tts"], { skipDynamicFetch: true, apiKeyInfo: { allowedProviders: [] } })).toEqual([]);
    const disabled = await import("@/lib/disabledModelsDb.js");
    await disabled.disableModels("el", ["eleven_multilingual_v2"]);
    expect((await catalog.buildModelsList(["tts"], { skipDynamicFetch: true })).some(m => m.id === "el/eleven_multilingual_v2")).toBe(false);
  });
  it("HR-27 Baidu registry endpoint works through bounded proxy-aware discovery", async () => {
    const conn = await db.createProviderConnection({ provider: "baidu", authType: "apikey", apiKey: "fixture-key", name: "fixture-baidu", isActive: true });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [{ id: "fixture-model" }] }));
    const discovery = await import("@/app/api/providers/[id]/models/route.js");
    const response = await discovery.GET(new Request("http://localhost/fixture"), { params: Promise.resolve({ id: conn.id }) });
    expect(response.status).toBe(200);
    expect((await response.json()).models).toEqual([{ id: "fixture-model" }]);
    expect(fetch.mock.calls[0][0]).toBe("https://qianfan.baidubce.com/v2/models");
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal), headers: { Authorization: "Bearer fixture-key" } });
    fetch.mockRestore();
  });
  it("HR-28 Freebuff tests use GET session without claiming inference quota", async () => {
    const probes = await import("@/app/api/providers/[id]/test/testUtils.js");
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const status of [200, 403, 404, 401]) {
      fetch.mockResolvedValueOnce(new Response("", { status }));
      const result = await probes.testOAuthConnection({ provider: "freebuff", authType: "oauth", accessToken: "fixture-token" });
      expect(result.valid).toBe(status !== 401);
      expect(result.refreshed).toBe(false);
    }
    expect(fetch.mock.calls.every(([url, init]) => url.endsWith("/api/v1/freebuff/session") && init.method === "GET" && !init.body)).toBe(true);
    fetch.mockRestore();
  });
});
