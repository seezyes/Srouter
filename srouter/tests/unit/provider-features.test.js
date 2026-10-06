import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { getProviderFeatures, getEffectiveProviderOverride } from "../../open-sse/config/providerFeatures.js";
import { applyProviderOverride } from "../../open-sse/utils/providerOverrides.js";
import { applyCodexServiceTier } from "../../open-sse/config/codexServiceTier.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { chooseProviderFeature } from "../../src/shared/utils/providerFeatureConfirmation.js";

const originalDataDir = process.env.DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "srouter-provider-features-"));
process.env.DATA_DIR = dataDir;
let settingsRepo, connectionsRepo, api, auth;
const params = (id) => ({ params: Promise.resolve({ id }) });
const patch = (body) => new Request("http://localhost/api/providers/codex/features", {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

beforeAll(async () => {
  settingsRepo = await import("@/lib/db/repos/settingsRepo.js");
  connectionsRepo = await import("@/lib/db/repos/connectionsRepo.js");
  api = await import("@/app/api/providers/[id]/features/route.js");
  auth = await import("@/sse/services/auth.js");
});
afterAll(() => {
  try { globalThis._dbAdapter?.instance?.close?.(); } catch { /* Windows handle */ }
  delete globalThis._dbAdapter;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* temporary only */ }
});

describe("provider feature defaults and runtime", () => {
  it("keeps custom headers on everywhere, OpenAI/Codex pools/tier on", () => {
    for (const provider of ["openai", "codex"]) {
      expect(getProviderFeatures(provider)).toEqual({ accountPools: true, serviceTier: true, customHeaders: true });
    }
    expect(getProviderFeatures("burngate")).toEqual({ accountPools: false, serviceTier: false, customHeaders: true });
  });
  it("preserves existing non-OpenAI pools until explicitly disabled", () => {
    const settings = { accountPools: { burngate: [{ id: "p" }] } };
    expect(getProviderFeatures("burngate", settings).accountPools).toBe(true);
    settings.providerFeatures = { burngate: { accountPools: false } };
    expect(getProviderFeatures("burngate", settings).accountPools).toBe(false);
  });
  it("ignores malformed flags and isolates each provider", () => {
    const settings = { providerFeatures: { codex: { customHeaders: false, accountPools: "false" } } };
    expect(getProviderFeatures("codex", settings).accountPools).toBe(true);
    expect(getProviderFeatures("openai", settings).customHeaders).toBe(true);
  });
  it("disabled custom headers restore built-ins without changing saved overrides or auth", () => {
    const settings = {
      providerFeatures: { codex: { customHeaders: false } },
      providerOverrides: { codex: { headers: { "user-agent": "mine", "x-fixture": "extra" } } },
    };
    const before = structuredClone(settings);
    const builtin = { "User-Agent": "builtin", Authorization: "Bearer fixture" };
    expect(applyProviderOverride(builtin, getEffectiveProviderOverride("codex", settings))).toEqual(builtin);
    settings.providerFeatures.codex.customHeaders = true;
    expect(applyProviderOverride(builtin, getEffectiveProviderOverride("codex", settings))).toEqual({
      Authorization: "Bearer fixture", "user-agent": "mine", "x-fixture": "extra",
    });
    expect(settings.providerOverrides).toEqual(before.providerOverrides);
    expect(builtin["User-Agent"]).toBe("builtin");
  });
  it("disabled service tier bypasses account default, not explicit request values", () => {
    const credentials = { providerSpecificData: { serviceTier: "ultrafast", serviceTierEnabled: false } };
    const body = {};
    applyCodexServiceTier(body, credentials);
    expect(body).toEqual({});
    expect(new CodexExecutor().transformRequest("gpt-5.5", {
      model: "gpt-5.5", input: "Fixture",
    }, true, credentials).service_tier).toBeUndefined();
    for (const value of ["ultrafast", "priority", null, ""]) {
      const explicit = { service_tier: value };
      applyCodexServiceTier(explicit, credentials);
      expect(explicit.service_tier).toBe(value);
    }
    const fast = { service_tier: "fast" };
    applyCodexServiceTier(fast, credentials);
    expect(fast.service_tier).toBe("priority");
    credentials.providerSpecificData.serviceTierEnabled = true;
    applyCodexServiceTier(body, credentials);
    expect(body.service_tier).toBe("ultrafast");
  });
  it("disabled pools ignore both membership and assignedModels without mutation", () => {
    const connections = [{ id: "a", providerSpecificData: { accountPoolId: "p", assignedModels: ["other"] } }];
    const settings = {
      accountPools: { codex: [{ id: "p", models: ["other"] }] },
      providerFeatures: { codex: { accountPools: false } },
    };
    expect(auth.filterConnectionsForAccountPools("codex", connections, "target", settings)).toBe(connections);
    settings.providerFeatures.codex.accountPools = true;
    expect(auth.filterConnectionsForAccountPools("codex", connections, "target", settings)).toEqual([]);
    expect(connections[0].providerSpecificData.accountPoolId).toBe("p");
  });
});

describe("atomic provider feature API and credential integration", () => {
  it("returns defaults/capabilities and no-store without revealing credentials", async () => {
    const response = await api.GET(null, params("codex"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      features: { accountPools: true, serviceTier: true, customHeaders: true },
      capabilities: { accountPools: true, serviceTier: true, customHeaders: true },
    });
  });
  it("rejects unknown providers and unsupported tiers", async () => {
    expect((await api.GET(null, params("not-a-provider"))).status).toBe(404);
    expect((await api.PATCH(patch({ serviceTier: true }), params("burngate"))).status).toBe(400);
  });
  it("stores alias changes under the canonical provider only", async () => {
    expect((await api.PATCH(patch({ customHeaders: false }), params("cc"))).status).toBe(200);
    const settings = await settingsRepo.getSettings();
    expect(settings.providerFeatures.claude.customHeaders).toBe(false);
    expect(settings.providerFeatures.cc).toBeUndefined();
    expect(getProviderFeatures("codex", settings).customHeaders).toBe(true);
  });
  it.each([null, [], {}, { customHeaders: "false" }, { typo: true }, { customHeaders: false, accountPools: false }])(
    "rejects malformed updates %j", async (body) => {
      expect((await api.PATCH(patch(body), params("codex"))).status).toBe(400);
    },
  );
  it("does not lose same-provider or cross-provider concurrent updates", async () => {
    const responses = await Promise.all([
      api.PATCH(patch({ customHeaders: false }), params("codex")),
      api.PATCH(patch({ accountPools: false }), params("codex")),
      api.PATCH(patch({ accountPools: true }), params("burngate")),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    const settings = await settingsRepo.getSettings();
    expect(settings.providerFeatures.codex).toMatchObject({ customHeaders: false, accountPools: false });
    expect(settings.providerFeatures.burngate.accountPools).toBe(true);
  });
  it("selects accounts with pools disabled, gates tier transiently and preserves saved configs", async () => {
    await settingsRepo.updateSettings({
      accountPools: { codex: [{ id: "pool", name: "Fixture", models: ["other"] }] },
      providerOverrides: { codex: { headers: { "user-agent": "saved" } } },
    });
    const created = await connectionsRepo.createProviderConnection({
      provider: "codex", authType: "apikey", name: "fixture", apiKey: "fixture",
      providerSpecificData: { accountPoolId: "pool", serviceTier: "ultrafast", assignedModels: ["other"] },
    });
    expect((await api.PATCH(patch({ serviceTier: false }), params("codex"))).status).toBe(200);
    const credentials = await auth.getProviderCredentials("codex", null, "target");
    expect(credentials.connectionId).toBe(created.id);
    expect(credentials.providerSpecificData).toMatchObject({ serviceTierEnabled: false, serviceTier: "ultrafast" });
    const body = {};
    applyCodexServiceTier(body, credentials);
    expect(body).toEqual({});
    const settings = await settingsRepo.getSettings();
    expect(settings.providerOverrides.codex.headers["user-agent"]).toBe("saved");
    expect(settings.accountPools.codex[0].id).toBe("pool");
    const persisted = await connectionsRepo.getProviderConnectionById(created.id);
    expect(persisted.providerSpecificData).toEqual({
      accountPoolId: "pool", serviceTier: "ultrafast", assignedModels: ["other"],
    });
    await api.PATCH(patch({ accountPools: true }), params("codex"));
    expect(await auth.getProviderCredentials("codex", null, "target")).toBeNull();
  });
});

describe("two-click feature confirmation", () => {
  it("arms first, confirms second and replaces pending changes for a different feature", () => {
    const first = chooseProviderFeature(null, "accountPools", true);
    expect(first).toEqual({ confirm: false, key: "accountPools", value: false });
    expect(chooseProviderFeature(first, "accountPools", true).confirm).toBe(true);
    expect(chooseProviderFeature(first, "customHeaders", true).confirm).toBe(false);
    expect(chooseProviderFeature(null, "accountPools", false)).toEqual({
      confirm: false, key: "accountPools", value: true,
    });
  });
  it("re-arms instead of confirming stale intent", () => {
    expect(chooseProviderFeature({ key: "accountPools", value: false }, "accountPools", false).confirm).toBe(false);
  });
  it("wires header controls, runtime override gate and conditional feature blocks", () => {
    const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    const page = read("src/app/(dashboard)/dashboard/providers/[id]/page.js");
    expect(page).toContain("<ProviderFeaturesCard");
    expect(page).toContain('providerId === "codex" && featureControls.features.serviceTier');
    expect(page).toContain("featureControls.features.customHeaders && <CustomConfigCard");
    expect(read("src/sse/handlers/chat.js")).toContain("providerOverrides: getEffectiveProviderOverride(provider, chatSettings)");
    const card = read("src/app/(dashboard)/dashboard/providers/components/ProviderFeaturesCard.js");
    expect(card).toContain("if (!action.confirm)");
    expect(card).toContain("if (await save(key, action.value)) setPending(null)");
    expect(card).toContain("{open && <FeatureDialog");
  });
});
