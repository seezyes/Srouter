// Pass9 follow-up #4 — Muse shared-token ACL closure.
//
// Real persisted credential and real dispatch chain: a real SQLite `apiKeys`
// row is created through the actual repository, the request is authenticated by
// the actual `authenticateRequest`, the model string is resolved by the actual
// app-side `getModelInfo` (open-sse `parseModel` alias-claim priority) and the
// result goes through the actual `checkTargetAccess`
// (`isProviderAllowed` + `isModelAllowed`). Only the model catalog and the
// unrelated account-selection modules are mocked, exactly like the Pass8
// PERSISTED-* cases.
//
// Requires an owned isolated DATA_DIR (the same convention the Pass8 runs used):
//   $env:DATA_DIR=<fresh temp>; mkdir <DATA_DIR>\PASS8-OWNED
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sourceGraph, plain } from "../helpers/parity-pass8-source.js";

const marker = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "PASS8-OWNED") : null;
if (!marker || !fs.existsSync(marker)) throw new Error("Owned isolated DATA_DIR required (PASS8-OWNED marker)");

let db, dir, graph, keys, requests, appModel, access;
const unused = () => { throw new Error("Unrelated account selection invoked"); };

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(process.env.DATA_DIR, "muse-acl-"));
  db = new DatabaseSync(path.join(dir, "fixture.sqlite"));
  db.exec("CREATE TABLE apiKeys(id TEXT PRIMARY KEY,key TEXT,name TEXT,machineId TEXT,isActive INTEGER,createdAt TEXT,allowedProviders TEXT,allowedCombos TEXT,allowedKinds TEXT)");
  const adapter = {
    get: (sql, args = []) => db.prepare(sql).get(...args),
    all: (sql, args = []) => db.prepare(sql).all(...args),
    run: (sql, args = []) => db.prepare(sql).run(...args),
    transaction: (fn) => { db.exec("BEGIN"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } },
  };
  // The catalog is the mocked boundary: both Muse providers publish their own
  // prefix, which is what the real buildModelsList does for them.
  const catalog = [
    { id: "muse-web/muse-spark", kind: "llm" },
    { id: "muse-web/muse-spark-1.3", kind: "llm" },
    { id: "muse-api/muse-spark-1.3", kind: "llm" },
    { id: "muse-api/muse-spark-1.2", kind: "llm" },
  ];
  graph = sourceGraph("local", {
    "src/lib/db/driver.js": { getAdapter: async () => adapter },
    "src/shared/utils/apiKey": { generateApiKeyWithMachine: () => ({ key: "fixture-synthetic-key" }) },
    "src/lib/localDb": {
      getProviderConnections: unused, updateProviderConnection: unused, getProxyPools: unused,
      validateApiKey: async (k) => keys.validateApiKey(k), getApiKeyByKey: async (k) => keys.getApiKeyByKey(k),
      getSettings: async () => ({ requireApiKey: true }), getProviderNodes: async () => [],
      getModelAliases: async () => ({}), getComboByName: async () => null,
    },
    "src/lib/network/connectionProxy": { resolveConnectionProxyConfig: unused, pickProxyPoolId: unused },
    "src/sse/services/antigravityQuota.js": { getAntigravityQuotaCache: unused },
    "src/lib/db/index.js": { getProviderNodeById: async () => null },
    "src/lib/disabledModelsDb": { getDisabledModels: async () => ({}) },
    "src/shared/utils/machineId": { getConsistentMachineId: async () => "0123456789abcdef" },
    "src/app/api/v1/models/route.js": { buildModelsList: async () => catalog },
  });
  keys = await graph.load("src/lib/db/repos/apiKeysRepo.js");
  requests = await graph.load("src/sse/services/requestAccess.js");
  appModel = await graph.load("src/sse/services/model.js");
  access = await graph.load("src/sse/services/access.js");
});

afterAll(() => {
  db?.close();
  graph?.dispose();
});

// Real row → real authentication → real principal (no shortcuts). The fixture
// table is emptied first because the VM harness hands out deterministic ids.
async function principalFor(allowedProviders) {
  db.exec("DELETE FROM apiKeys");
  const created = await keys.createApiKey("muse fixture", "fixture-machine", { allowedProviders, allowedKinds: ["llm"] });
  const stored = db.prepare("SELECT allowedProviders FROM apiKeys WHERE id=?").get(created.id).allowedProviders;
  expect(plain(JSON.parse(stored))).toEqual(allowedProviders);
  const request = new Request("http://127.0.0.1/v1/chat/completions", { headers: { Authorization: `Bearer ${created.key}` } });
  const principal = await requests.authenticateRequest(request, { requireApiKey: true });
  expect(principal.error).toBeUndefined();
  expect(plain(principal.apiKeyInfo.allowedProviders)).toEqual(allowedProviders);
  return principal.apiKeyInfo;
}

// Same resolution the chat handler uses: model string → dispatched provider.
async function dispatch(modelStr) {
  return plain(await appModel.getModelInfo(modelStr));
}

describe("Muse explicit Web/API prefixes — persisted grants and provider separation", () => {
  it("a persisted ['muse'] grant authorizes the model the router actually dispatches", async () => {
    const info = await principalFor(["muse"]);
    // Legacy muse is now only the persisted API provider id, never a Web alias.
    expect(await dispatch("muse/muse-spark-1.3")).toEqual({ provider: "muse", model: "muse-spark-1.3" });

    const resolved = await dispatch("muse-api/muse-spark-1.3");
    expect(await requests.checkTargetAccess(info, resolved.provider, resolved.model, "llm")).toBeNull();
    expect(await access.isProviderAllowed(info, "muse-spark-web")).toBe(false);
    // And the API provider stays addressable through its own unique aliases.
    expect(await access.isProviderAllowed(info, "muse-code")).toBe(true);
  });

  it("an explicit Web grant authorizes the Web dispatch but not the API provider", async () => {
    const info = await principalFor(["muse-web"]);
    expect(await dispatch("muse-web/muse-spark")).toEqual({ provider: "muse-spark-web", model: "muse-spark" });
    expect(await dispatch("muse-spark-web/muse-spark")).toEqual({ provider: "muse-spark-web", model: "muse-spark" });
    expect(await access.isProviderAllowed(info, "muse-spark-web")).toBe(true);
    expect(await requests.checkTargetAccess(info, "muse-spark-web", "muse-spark", "llm")).toBeNull();

    // API provider aliases stay outside a Web-cookie grant (distinct upstreams).
    for (const alias of ["muse-api", "muse-code", "muse-ai", "meta-model-api", "muse-subscription"]) {
      expect(`${alias}:${await access.isProviderAllowed(info, alias)}`).toBe(`${alias}:false`);
    }
    expect((await requests.checkTargetAccess(info, "muse", "muse-spark-1.3", "llm"))?.status).toBe(403);
    expect((await requests.checkTargetAccess(info, "muse-code", "muse-spark-1.3", "llm"))?.status).toBe(403);
  });

  it("an explicit API grant does not authorize the Web provider", async () => {
    const info = await principalFor(["muse-api"]);
    expect(await access.isProviderAllowed(info, "muse")).toBe(true);
    expect(await access.isProviderAllowed(info, "muse-spark-web")).toBe(false);
    expect((await requests.checkTargetAccess(info, "muse-spark-web", "muse-spark", "llm"))?.status).toBe(403);
    const resolved = await dispatch("muse-code/muse-spark-1.3");
    expect(resolved).toEqual({ provider: "muse", model: "muse-spark-1.3" });
    expect(await requests.checkTargetAccess(info, resolved.provider, resolved.model, "llm")).toBeNull();
  });

  it("unrelated aliases and the empty grant never widen access", async () => {
    const info = await principalFor(["grok-cli"]);
    for (const target of ["muse", "muse-spark-web", "muse-code"]) {
      expect(`${target}:${await access.isProviderAllowed(info, target)}`).toBe(`${target}:false`);
    }
    const empty = { allowedProviders: [] };
    expect(await access.isProviderAllowed(empty, "muse-spark-web")).toBe(false);
    expect(await access.isProviderAllowed(empty, "muse")).toBe(false);
    // Unrestricted keys are unaffected.
    expect(await access.isProviderAllowed({ allowedProviders: null }, "muse-spark-web")).toBe(true);
    expect(await access.isProviderAllowed({ allowedProviders: null }, "muse")).toBe(true);
  });

  it("legacy ids and unique aliases never widen grants to the other transport", async () => {
    expect(await access.isProviderAllowed({ allowedProviders: ["muse-spark-web"] }, "muse")).toBe(false);
    expect(await access.isProviderAllowed({ allowedProviders: ["muse"] }, "muse-spark-web")).toBe(false);
    expect(await access.isProviderAllowed({ allowedProviders: ["muse-spark-web"] }, "muse-web")).toBe(true);
    expect(await access.isProviderAllowed({ allowedProviders: ["muse-code"] }, "muse-api")).toBe(true);
  });
});
