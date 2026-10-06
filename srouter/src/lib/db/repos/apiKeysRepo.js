import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseAccessList, serializeAccessList, validateApiKeyAccess } from "@/shared/utils/apiKeyAccess.js";

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    allowedProviders: parseAccessList(row.allowedProviders),
    allowedCombos: parseAccessList(row.allowedCombos),
    allowedKinds: parseAccessList(row.allowedKinds),
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function getApiKeyByKey(key) {
  if (!key) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId, access = {}) {
  if (!machineId) throw new Error("machineId is required");
  validateApiKeyAccess(access);
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    allowedProviders: access.allowedProviders ?? null,
    allowedCombos: access.allowedCombos ?? null,
    allowedKinds: access.allowedKinds ?? null,
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, allowedProviders, allowedCombos, allowedKinds) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt,
      serializeAccessList(apiKey.allowedProviders), serializeAccessList(apiKey.allowedCombos), serializeAccessList(apiKey.allowedKinds)]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  validateApiKeyAccess(data);
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row) };
    for (const field of ["name", "isActive", "allowedProviders", "allowedCombos", "allowedKinds"]) {
      if (field in data) merged[field] = data[field];
    }
    db.run(
      `UPDATE apiKeys SET name = ?, isActive = ?, allowedProviders = ?, allowedCombos = ?, allowedKinds = ? WHERE id = ?`,
      [merged.name, merged.isActive ? 1 : 0, serializeAccessList(merged.allowedProviders),
        serializeAccessList(merged.allowedCombos), serializeAccessList(merged.allowedKinds), id]
    );
    result = merged;
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}
