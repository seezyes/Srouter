import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { DEFAULT_DISABLED_MODELS, getDefaultDisabledModels } from "@/shared/constants/disabledModelsDefaults.js";

const SCOPE = "disabledModels";

// Stored rows win; a provider that was never touched falls back to its
// code-level defaults (e.g. BurnGate's off-by-default models).
export async function getDisabledModels() {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [SCOPE]);
  const out = {};
  for (const r of rows) out[r.key] = parseJson(r.value, []);
  for (const [alias, ids] of Object.entries(DEFAULT_DISABLED_MODELS)) {
    // An explicit empty row ("Active All") must not resurrect the defaults.
    if (!(alias in out)) out[alias] = [...ids];
  }
  return out;
}

export async function getDisabledByProvider(providerAlias) {
  const db = await getAdapter();
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
  if (row) return parseJson(row.value, []) || [];
  return [...getDefaultDisabledModels(providerAlias)];
}

// Atomic read-merge-write inside a transaction (no JS yield mid-transaction).
export async function disableModels(providerAlias, ids) {
  if (!providerAlias || !Array.isArray(ids)) return;
  const db = await getAdapter();
  db.transaction(() => {
    const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
    const current = row ? (parseJson(row.value, []) || []) : [];
    const merged = [...new Set([...current, ...ids])];
    db.run(
      `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      [SCOPE, providerAlias, stringifyJson(merged)]
    );
  });
}

export async function enableModels(providerAlias, ids) {
  if (!providerAlias) return;
  const db = await getAdapter();
  db.transaction(() => {
    if (!Array.isArray(ids) || ids.length === 0) {
      writeEmptyOrDelete(db, providerAlias);
      return;
    }
    const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
    const current = row ? (parseJson(row.value, []) || []) : [];
    const removeSet = new Set(ids);
    const next = current.filter((id) => !removeSet.has(id));
    if (next.length === 0) {
      writeEmptyOrDelete(db, providerAlias);
    } else {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [SCOPE, providerAlias, stringifyJson(next)]
      );
    }
  });
}

// "Nothing disabled" has two different meanings and they must not be conflated:
// for a provider WITHOUT code defaults the row is simply dropped (legacy
// behavior), while a provider WITH defaults needs an explicit empty row —
// otherwise deleting it would make the defaults apply again and silently
// re-disable the model the owner just enabled ("Active All" included).
function writeEmptyOrDelete(db, providerAlias) {
  if (getDefaultDisabledModels(providerAlias).length > 0) {
    db.run(
      `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      [SCOPE, providerAlias, stringifyJson([])]
    );
    return;
  }
  db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
}
