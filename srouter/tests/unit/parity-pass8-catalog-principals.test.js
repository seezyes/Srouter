import { afterAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sourceGraph, plain, contractSuite, evidence } from "../helpers/parity-pass8-source.js";

const test = contractSuite("catalog-principals"), graphs = [];
afterAll(() => {
  fs.writeFileSync(path.join(evidence, "source-hashes-catalog-principals.json"),
    JSON.stringify(graphs.map(graph => ({ label: graph.label, loaded: Object.fromEntries(graph.loaded) })), null, 2));
  graphs.forEach(graph => graph.dispose());
});

// Actual key repository → authentication → canonical model resolution →
// provider authorization → availability. Only credential storage, dynamic
// catalogs and unrelated account-selection operations are fixture boundaries.
for (const grant of ["mmf", "mimo-free", null]) {
  for (const requested of ["mmf", "mimo-free"]) {
    const denied = grant === null;
    test(`P8C-MMF-PRINCIPAL-${grant || "deny-all"}-${requested}`,
      `Persisted ${grant || "deny-all"} grant serves ${requested}/mimo-auto without widening access`,
      [{ pin: "local", path: "src/lib/db/repos/apiKeysRepo.js", symbol: "createApiKey" },
        { pin: "local", path: "src/sse/services/requestAccess.js", symbol: "checkTargetAccess" },
        { pin: "local", path: "src/app/api/v1/models/route.js", symbol: "buildModelsList" }],
      ["Real SQLite grant storage and actual auth/access/availability/canonical resolution",
        "Both MiMo ids share permission; empty grants remain denied"], async () => {
        if (!process.env.DATA_DIR || !fs.existsSync(path.join(process.env.DATA_DIR, "PASS8-OWNED"))) {
          throw new Error("Owned isolated DATA_DIR required");
        }
        const folder = fs.mkdtempSync(path.join(process.env.DATA_DIR, "mmf-principal-"));
        const db = new DatabaseSync(path.join(folder, "fixture.sqlite"));
        db.exec("CREATE TABLE apiKeys(id TEXT PRIMARY KEY,key TEXT,name TEXT,machineId TEXT,isActive INTEGER,createdAt TEXT,allowedProviders TEXT,allowedCombos TEXT,allowedKinds TEXT)");
        const adapter = {
          get: (sql, args = []) => db.prepare(sql).get(...args),
          all: (sql, args = []) => db.prepare(sql).all(...args),
          run: (sql, args = []) => db.prepare(sql).run(...args),
          transaction: fn => {
            db.exec("BEGIN");
            try { const result = fn(); db.exec("COMMIT"); return result; }
            catch (error) { db.exec("ROLLBACK"); throw error; }
          },
        };
        let keys, api;
        const unused = () => { throw new Error("Unrelated account operation invoked"); };
        const localDb = {
          getProviderConnections: async () => [{ provider: requested, id: "fixture", isActive: true, providerSpecificData: {} }],
          getCombos: async () => [], getCustomModels: async () => [], getModelAliases: async () => ({}),
          validateApiKey: async key => keys.validateApiKey(key), getApiKeyByKey: async key => keys.getApiKeyByKey(key),
          updateProviderConnection: unused, getSettings: async () => ({ requireApiKey: true }), getProxyPools: unused,
        };
        const graph = sourceGraph("local", {
          "src/lib/db/driver.js": { getAdapter: async () => adapter },
          "src/shared/utils/apiKey": { generateApiKeyWithMachine: () => ({ key: "fixture-synthetic-key" }) },
          "src/lib/localDb": localDb,
          "src/lib/network/connectionProxy": { resolveConnectionProxyConfig: unused, pickProxyPoolId: unused },
          "src/sse/services/antigravityQuota.js": { getAntigravityQuotaCache: unused },
          "src/lib/db/index.js": { getProviderNodeById: async () => null },
          "src/lib/disabledModelsDb": { getDisabledModels: async () => ({}) },
          "src/shared/utils/machineId": { getConsistentMachineId: async () => "0123456789abcdef" },
          // Run the actual API builder in its independent graph. Dynamic fetch
          // is explicitly disabled; do not invent a catalog fixture response.
          "src/app/api/v1/models/route.js": {
            buildModelsList: async kinds => api.buildModelsList(kinds, { skipDynamicFetch: true }),
          },
        });
        const catalogGraph = sourceGraph("local", {
          "src/lib/localDb": localDb,
          "src/lib/disabledModelsDb": { getDisabledModels: async () => ({}) },
          "src/lib/db/index.js": { getProviderNodeById: async () => null },
          "src/sse/services/requestAccess.js": { authenticateRequest: unused },
          "src/sse/services/allowedModels.js": { fetchModelsFetcherIds: unused },
          "src/sse/services/tokenRefresh": { updateProviderCredentials: unused },
          "src/lib/network/connectionProxy": { resolveConnectionProxyConfig: unused },
          "open-sse/services/kiroModels.js": { resolveKiroModels: unused },
          "open-sse/services/kimchiModels.js": { resolveKimchiModels: unused },
          "open-sse/services/qoderModels.js": { resolveQoderModels: unused, routableQoderModels: unused },
          "open-sse/services/copilotModels.js": { resolveCopilotModels: unused },
          "open-sse/services/clinepassModels.js": { resolveClinepassModels: unused, resolveClineModels: unused },
          "open-sse/services/grokCliModels.js": { resolveGrokCliModels: unused },
          "open-sse/services/cursorModels.js": { resolveCursorModels: unused },
          "open-sse/shared/zedAuth.js": { resolveZedModels: unused },
        });
        graphs.push(graph, catalogGraph);
        try {
          keys = await graph.load("src/lib/db/repos/apiKeysRepo.js");
          api = await catalogGraph.load("src/app/api/v1/models/route.js");
          const grants = denied ? [] : [grant];
          const created = await keys.createApiKey("fixture MiMo grant", "fixture-machine",
            { allowedProviders: grants, allowedKinds: ["llm"] });
          expect(db.prepare("SELECT allowedProviders FROM apiKeys WHERE id=?").get(created.id).allowedProviders)
            .toBe(JSON.stringify(grants));
          const requests = await graph.load("src/sse/services/requestAccess.js");
          const principal = await requests.authenticateRequest(new Request("http://127.0.0.1/v1/chat/completions",
            { headers: { Authorization: `Bearer ${created.key}` } }), { requireApiKey: true });
          expect(principal.error).toBeUndefined();
          expect(plain(principal.apiKeyInfo.allowedProviders)).toEqual(grants);
          const model = await graph.load("open-sse/services/model.js");
          const target = await model.getModelInfoCore(`${requested}/mimo-auto`, {});
          const result = await requests.checkTargetAccess(principal.apiKeyInfo, target.provider, target.model, "llm");
          expect(result?.status ?? 200).toBe(denied ? 403 : 200);
        } finally {
          db.close();
        }
      });
  }
}
