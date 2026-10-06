import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";

vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: vi.fn() }));
const previousDataDir = process.env.DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "srouter-search-persistence-"));
process.env.DATA_DIR = dataDir;
let api;
beforeAll(async () => { api = await import("@/app/api/settings/route"); });
afterAll(() => {
  try { globalThis._dbAdapter?.instance?.close?.(); } catch { /* temporary DB */ }
  delete globalThis._dbAdapter;
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows handle */ }
});
describe("SrouterSearch actual settings persistence", () => {
  it("keeps enabled after PATCH and a fresh GET, then persists disabled", async () => {
    expect((await (await api.GET()).json()).srouterSearch.enabled).toBe(false);
    for (const enabled of [true, false]) {
      const response = await api.PATCH(new Request("http://localhost/api/settings", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ srouterSearch: { enabled, searchProvider: "exa" } }),
      }));
      expect(response.status).toBe(200);
      expect((await response.json()).srouterSearch.enabled).toBe(enabled);
      const reloaded = await (await api.GET()).json();
      expect(reloaded.srouterSearch).toMatchObject({ enabled, searchProvider: "exa" });
    }
  });
  it("does not accept a persisted developer UI override", async () => {
    const response = await api.PATCH(new Request("http://localhost/api/settings", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ developerSettingsAvailable: true }),
    }));
    expect((await response.json()).developerSettingsAvailable).toBe(false);
    expect((await (await api.GET()).json()).developerSettingsAvailable).toBe(false);
  });
});
