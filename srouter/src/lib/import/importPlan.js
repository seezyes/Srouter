// Plan + execute the "Import from 9router" operation.
//
// Planning is read-only and drives both the preview (dry run) and the import
// (same plan, applied). Writes always go through the app's own repositories:
//   connections → createProviderConnection  (src/lib/db/repos/connectionsRepo.js)
//   API keys    → createApiKey / updateApiKey
//   combos      → createCombo / updateCombo
//   settings    → updateSettings
// so dedup, priority reordering and merge semantics are the app's, not ours.

import { parseJson } from "@/lib/db/helpers/jsonCol.js";
import {
  getProviderConnections, createProviderConnection,
  getApiKeys, createApiKey, updateApiKey,
  getCombos, createCombo, updateCombo,
  getSettings, updateSettings,
} from "@/lib/db/index.js";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { API_KEY_ACCESS_FIELDS, parseAccessList, validateApiKeyAccess } from "@/shared/utils/apiKeyAccess.js";
import { maskSecret, maskSecretsDeep } from "./secretMask.js";
import { credentialFingerprint, mapSourceConnection, matchesExistingConnection, normalizeSourceConnection } from "./connectionMapping.js";

// The repo's bulk API-key importer caps a batch at 500 items; mirror that here
// so one click can never fire an unbounded write loop.
export const MAX_IMPORT_ITEMS = 500;
// "A small preview list" — counts stay complete, the rendered list is capped.
export const MAX_PREVIEW_ITEMS = 50;

// Settings that must never be copied from another install, with the reason
// surfaced in the UI so the user knows they were skipped on purpose.
export const SETTINGS_DENYLIST = new Map([
  ["password", "credential"],
  ["newPassword", "credential"],
  ["mitmSudoEncrypted", "credential"],
  ["oidcClientSecret", "credential"],
  ["samlCert", "credential"],
  ["machineId", "credential"],
  ["authMode", "local security setting"],
  ["ssoType", "local security setting"],
  ["requireLogin", "local security setting"],
  ["requireApiKey", "local security setting"],
  ["oidcIssuerUrl", "local identity provider"],
  ["oidcClientId", "local identity provider"],
  ["oidcScopes", "local identity provider"],
  ["oidcLoginLabel", "local identity provider"],
  ["samlEntryPoint", "local identity provider"],
  ["samlIssuer", "local identity provider"],
  ["samlLoginLabel", "local identity provider"],
  ["samlAttributeEmail", "local identity provider"],
  ["samlAttributeName", "local identity provider"],
  ["cloudUrl", "local endpoint"],
  ["cloudEnabled", "local endpoint"],
  ["tunnelUrl", "local endpoint"],
  ["tunnelEnabled", "local endpoint"],
  ["tunnelProvider", "local endpoint"],
  ["tailscaleUrl", "local endpoint"],
  ["tailscaleEnabled", "local endpoint"],
  ["mitmRouterBaseUrl", "local endpoint"],
  ["headroomUrl", "local endpoint"],
]);

export function defaultImportOptions() {
  return { connections: true, apiKeys: false, combos: false, settings: false };
}

export function normalizeImportOptions(input) {
  const defaults = defaultImportOptions();
  if (!input || typeof input !== "object") return defaults;
  const out = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (typeof input[key] === "boolean") out[key] = input[key];
  }
  return out;
}

// A client-supplied selection can only ever reference plan keys of the form
// `connection:<sourceId>`. Cap the accepted key length and entry count so a
// hostile or buggy payload cannot make the planner allocate unbounded memory.
export const MAX_SELECTION_ENTRIES = MAX_IMPORT_ITEMS;
export const MAX_SELECTION_KEY_LENGTH = 256;

/**
 * Normalize the optional `selection` request field.
 * - absent / null            → null: everything the plan contains (legacy callers).
 * - { connections: [...] }   → Set of selected connection keys. Unknown keys
 *                              match no plan item, so a selection can only
 *                              ever narrow the import, never widen it.
 * - any other shape          → undefined, which the API turns into a 400
 *                              instead of silently falling back to "import all".
 * Non-string, empty and oversized entries are dropped rather than rejected.
 */
export function normalizeImportSelection(input) {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object" || Array.isArray(input)) return undefined;
  if (!Object.hasOwn(input, "connections")) return undefined;
  if (!Array.isArray(input.connections)) return undefined;
  const selected = new Set();
  for (const entry of input.connections.slice(0, MAX_SELECTION_ENTRIES)) {
    // Length check first so an oversized key is never copied by trim().
    if (typeof entry !== "string" || entry.length > MAX_SELECTION_KEY_LENGTH) continue;
    const key = entry.trim();
    if (!key) continue;
    selected.add(key);
  }
  return selected;
}

function countActions(items) {
  const counts = { total: items.length, selected: 0, create: 0, update: 0, skip: 0, error: 0 };
  for (const item of items) {
    // Rows excluded by a selection carry no action and are not counted as
    // "planned": counts describe exactly what an execute of this plan writes.
    if (!item.action) continue;
    counts.selected += 1;
    counts[item.action] += 1;
  }
  return counts;
}

function emptyGroup() {
  return { items: [], truncated: false, counts: countActions([]) };
}

/**
 * Identity used only for the *skip* decision ("this exact row is already
 * here"). create-vs-update is decided by matchesExistingConnection(), the
 * read-only mirror of the repo's dedup rules.
 */
function sameIdentity(candidate, existing) {
  if (candidate.authType !== existing.authType) return false;
  if (candidate.authType === "apikey") return Boolean(candidate.name) && candidate.name === existing.name;
  if (candidate.authType === "access_token") {
    // createProviderConnection never dedups access_token rows, so re-importing
    // them would duplicate the account. The import skips rows whose provider +
    // credential material already match (fingerprint is compared by the caller).
    return true;
  }
  if (candidate.authType === "oauth") {
    if (!candidate.email || candidate.email !== existing.email) return false;
    const incoming = candidate.providerSpecificData?.chatgptAccountId;
    const local = existing.providerSpecificData?.chatgptAccountId;
    if (incoming || local) return Boolean(incoming) && incoming === local;
    return true;
  }
  return false;
}

/**
 * Classify every source connection against the local DB, honoring an optional
 * `selection` (Set of connection keys). Rows outside the selection are still
 * reported (so the UI keeps its checkbox list stable) but carry `selected:
 * false` and no action/payload — they are invisible to the simulation and to
 * the import itself.
 * The simulation list starts with the real local rows and grows with the rows
 * this run is about to create, so duplicate rows inside one batch are
 * classified the same way the sequential repo calls will behave.
 */
export function planConnections(sourceRows, localConnections, selection = null) {
  const items = [];
  const source = Array.isArray(sourceRows) ? sourceRows : [];
  const limited = source.slice(0, MAX_IMPORT_ITEMS);
  const simulated = [...(localConnections || [])];

  limited.forEach((row, index) => {
    const normalized = normalizeSourceConnection(row);
    const key = `connection:${normalized.sourceId || index}`;
    const selected = selection === null || selection.has(key);
    const mapped = mapSourceConnection(row, index);
    const identity = {
      key,
      kind: "connection",
      sourceId: normalized.sourceId,
      provider: mapped.ok ? mapped.payload.provider : normalized.provider,
      authType: mapped.ok ? mapped.payload.authType : normalized.authType,
      name: mapped.ok ? (mapped.payload.name || null) : normalized.name,
      email: mapped.ok ? (mapped.payload.email || null) : normalized.email,
      priority: normalized.priority,
      isActive: normalized.isActive,
      selected,
    };

    if (!mapped.ok) {
      items.push({
        ...identity,
        action: selected ? "error" : null,
        reason: selected ? mapped.reason : null,
        notes: [],
        payload: null,
        fields: null,
      });
      return;
    }

    if (!selected) {
      items.push({ ...identity, action: null, reason: null, notes: [], payload: null, fields: null });
      return;
    }

    const payload = mapped.payload;
    const fingerprint = credentialFingerprint(payload);
    const identical = simulated.find((connection) =>
      connection.provider === payload.provider
      && sameIdentity(payload, connection)
      && credentialFingerprint(connection) === fingerprint);
    const matched = identical || simulated.find((connection) => matchesExistingConnection(payload, connection));

    const notes = [...mapped.notes];
    if (normalized.data.providerSpecificData && !payload.providerSpecificData) {
      notes.push("providerSpecificData became empty after dropping non-portable proxy fields");
    }

    let action = "create";
    let reason = null;
    if (identical) {
      action = "skip";
      reason = "already present with identical credentials";
    } else if (matched) {
      action = "update";
      reason = `matches local ${matched.authType} connection "${matched.name || matched.email || matched.id}"`;
    }
    if (payload.authType === "access_token" && action !== "skip") {
      notes.push("access_token rows are matched by credential material only (the app itself never dedups them)");
    }

    items.push({
      ...identity,
      action,
      reason,
      notes,
      payload,
      fields: { ...payload },
    });

    if (action !== "skip") simulated.push({ ...payload, id: matched?.id || `pending:${key}` });
  });

  return { items, truncated: source.length > limited.length, counts: countActions(items) };
}

function planApiKeys(rows, localApiKeys) {
  const items = [];
  const source = Array.isArray(rows) ? rows : [];
  const limited = source.slice(0, MAX_IMPORT_ITEMS);
  const localNames = new Set((localApiKeys || []).map((key) => key?.name).filter(Boolean));
  const seenNames = new Set();
  limited.forEach((row, index) => {
    const name = row?.name ? String(row.name) : `9router key ${String(row?.id || index).slice(0, 8)}`;
    const isActive = row?.isActive === 1 || row?.isActive === true || row?.isActive === "1";
    let action = "create";
    let reason = null;
    if (localNames.has(name)) {
      action = "skip";
      reason = "an API key with this name already exists locally";
    } else if (seenNames.has(name)) {
      action = "skip";
      reason = "duplicate of an earlier row in this import";
    }
    seenNames.add(name);
    const access = Object.fromEntries(API_KEY_ACCESS_FIELDS.map((field) => [field, parseAccessList(row?.[field])]));
    try { validateApiKeyAccess(access); } catch {
      action = "error";
      reason = "source API key has unsupported access permissions";
    }
    items.push({
      key: `apiKey:${row?.id || index}`,
      kind: "apiKey",
      access,
      name,
      isActive,
      sourceId: row?.id ? String(row.id) : null,
      action,
      reason,
      notes: [
        "the source key value is bound to the other install's machine ID and API-key secret, so a fresh local key is issued under the same name",
      ],
    });
  });
  return { items, truncated: source.length > limited.length, counts: countActions(items) };
}

function normalizeComboModels(raw) {
  const parsed = parseJson(raw, []);
  return Array.isArray(parsed) ? parsed : [];
}

function planCombos(rows, localCombos) {
  const items = [];
  const source = Array.isArray(rows) ? rows : [];
  const limited = source.slice(0, MAX_IMPORT_ITEMS);
  const byName = new Map((localCombos || []).map((combo) => [combo.name, combo]));
  const pending = new Map();

  limited.forEach((row, index) => {
    const name = row?.name ? String(row.name) : null;
    const comboKind = row?.kind ?? null;
    const models = normalizeComboModels(row?.models);
    const existing = (name && byName.get(name)) || (name && pending.get(name)) || null;

    let action = "create";
    let reason = null;
    if (!name) {
      action = "error";
      reason = "source combo has no name";
    } else if (existing) {
      const sameModels = JSON.stringify(existing.models || []) === JSON.stringify(models);
      if (sameModels && (existing.kind || null) === comboKind) {
        action = "skip";
        reason = "already present with identical models";
      } else {
        action = "update";
        reason = "local combo exists with different models/kind";
      }
    }

    if (name) pending.set(name, { name, kind: comboKind, models, id: existing?.id || null });
    items.push({
      key: `combo:${row?.id || index}`,
      kind: "combo",
      name,
      comboKind,
      models,
      action,
      reason,
      localId: existing?.id || null,
    });
  });

  return { items, truncated: source.length > limited.length, counts: countActions(items) };
}

export function planSettings(foreignSettings, localSettings) {
  const skipped = [];
  const unchanged = [];
  const updates = {};
  for (const [key, value] of Object.entries(foreignSettings || {})) {
    const denied = SETTINGS_DENYLIST.get(key);
    if (denied) {
      skipped.push({ key, reason: `not imported: ${denied}` });
      continue;
    }
    if (JSON.stringify(localSettings?.[key]) === JSON.stringify(value)) {
      unchanged.push(key);
      continue;
    }
    updates[key] = value;
  }
  return { changedKeys: Object.keys(updates), updates, unchanged, skipped };
}

/** Read everything the planner needs to classify items. */
export async function collectLocalState() {
  const [connections, apiKeys, combos, settings] = await Promise.all([
    getProviderConnections(),
    getApiKeys(),
    getCombos(),
    getSettings(),
  ]);
  return { connections, apiKeys, combos, settings };
}

/** Build the read-only plan used by both the preview and the import. */
export function buildPlan({ snapshot, localState, options, selection = null }) {
  const opts = normalizeImportOptions(options);
  const notes = [];
  const plan = {
    options: opts,
    notes,
    connections: emptyGroup(),
    apiKeys: emptyGroup(),
    combos: emptyGroup(),
    settings: null,
  };

  if (opts.connections) {
    plan.connections = planConnections(snapshot?.connections || [], localState?.connections || [], selection);
  }
  if (opts.apiKeys) plan.apiKeys = planApiKeys(snapshot?.apiKeys || [], localState?.apiKeys || []);
  if (opts.combos) plan.combos = planCombos(snapshot?.combos || [], localState?.combos || []);
  if (opts.settings) plan.settings = planSettings(snapshot?.settings, localState?.settings);

  if (plan.connections.truncated) notes.push(`Only the first ${MAX_IMPORT_ITEMS} source connections are imported per run.`);
  if (plan.apiKeys.truncated) notes.push(`Only the first ${MAX_IMPORT_ITEMS} source API keys are imported per run.`);
  if (plan.combos.truncated) notes.push(`Only the first ${MAX_IMPORT_ITEMS} source combos are imported per run.`);
  return plan;
}

/** Strip internal payloads and mask everything that reaches the browser. */
export function publicPlan(plan) {
  const connections = plan.connections.items.slice(0, MAX_PREVIEW_ITEMS).map((item) => ({
    key: item.key,
    provider: item.provider,
    authType: item.authType,
    name: item.name,
    email: item.email,
    priority: item.priority,
    isActive: item.isActive,
    selected: item.selected !== false,
    action: item.action,
    reason: item.reason,
    notes: item.notes || [],
    credentialKeys: item.fields ? Object.keys(item.fields).sort() : [],
    fields: item.fields ? maskSecretsDeep(item.fields) : null,
  }));
  return {
    options: plan.options,
    notes: plan.notes,
    counts: {
      connections: plan.connections.counts,
      apiKeys: plan.apiKeys.counts,
      combos: plan.combos.counts,
      settings: plan.settings
        ? { changed: plan.settings.changedKeys.length, unchanged: plan.settings.unchanged.length, skipped: plan.settings.skipped.length }
        : null,
    },
    truncated: {
      connections: plan.connections.truncated,
      apiKeys: plan.apiKeys.truncated,
      combos: plan.combos.truncated,
      connectionsPreview: plan.connections.items.length > MAX_PREVIEW_ITEMS,
    },
    connections,
    apiKeys: plan.apiKeys.items.map((item) => ({
      key: item.key,
      name: item.name,
      isActive: item.isActive,
      action: item.action,
      reason: item.reason,
      notes: item.notes || [],
    })),
    combos: plan.combos.items.map((item) => ({
      key: item.key,
      name: item.name,
      comboKind: item.comboKind,
      models: item.models,
      action: item.action,
      reason: item.reason,
    })),
    settings: plan.settings
      ? {
          changed: plan.settings.changedKeys,
          unchanged: plan.settings.unchanged,
          skipped: plan.settings.skipped,
        }
      : null,
  };
}

function connectionResult(item, status, reason, id) {
  return {
    key: item.key,
    provider: item.provider,
    authType: item.authType,
    name: item.name,
    email: item.email,
    status,
    reason: reason || null,
    id: id || null,
  };
}

function simpleResult(item, status, reason, extra = {}) {
  return {
    key: item.key,
    name: item.name,
    status,
    reason: reason || null,
    ...extra,
  };
}

/**
 * Apply the plan. Per-item failures are captured in the results instead of
 * aborting the whole run, so a single unusable row cannot block an import.
 * `selection` narrows the run to the chosen connection keys — the same
 * (already validated) shape `buildPlan` accepts.
 */
export async function runImport({ snapshot, options, selection = null }) {
  const localState = await collectLocalState();
  const plan = buildPlan({ snapshot, localState, options, selection });
  const results = { connections: [], apiKeys: [], combos: [], settings: null };

  const knownConnectionIds = new Set((localState.connections || []).map((connection) => connection.id));
  for (const item of plan.connections.items) {
    if (item.selected === false) continue; // excluded by the caller's selection
    if (item.action === "skip") {
      results.connections.push(connectionResult(item, "skipped", item.reason));
      continue;
    }
    if (item.action === "error") {
      results.connections.push(connectionResult(item, "failed", item.reason));
      continue;
    }
    try {
      const created = await createProviderConnection(item.payload);
      const updated = Boolean(created?.id) && knownConnectionIds.has(created.id);
      if (created?.id) knownConnectionIds.add(created.id);
      results.connections.push(connectionResult(item, updated ? "updated" : "created", null, created?.id || null));
    } catch (error) {
      results.connections.push(connectionResult(item, "failed", error?.message || String(error)));
    }
  }

  if (plan.options.apiKeys) {
    let machineId = null;
    for (const item of plan.apiKeys.items) {
      if (item.action !== "create") {
        results.apiKeys.push(simpleResult(item, item.action === "error" ? "failed" : "skipped", item.reason));
        continue;
      }
      try {
        if (!machineId) machineId = await getConsistentMachineId();
        const created = await createApiKey(item.name, machineId, item.access);
        if (item.isActive === false) await updateApiKey(created.id, { isActive: false });
        results.apiKeys.push(simpleResult(item, "created", null, { id: created.id, keyMasked: maskSecret(created.key) }));
      } catch (error) {
        results.apiKeys.push(simpleResult(item, "failed", error?.message || String(error)));
      }
    }
  }

  if (plan.options.combos) {
    for (const item of plan.combos.items) {
      if (item.action === "error") {
        results.combos.push(simpleResult(item, "failed", item.reason));
        continue;
      }
      if (item.action === "skip") {
        results.combos.push(simpleResult(item, "skipped", item.reason));
        continue;
      }
      try {
        if (item.action === "update" && item.localId) {
          const updated = await updateCombo(item.localId, { models: item.models, kind: item.comboKind });
          results.combos.push(simpleResult(item, updated ? "updated" : "failed", updated ? null : "combo disappeared during import"));
        } else {
          const created = await createCombo({ name: item.name, kind: item.comboKind, models: item.models });
          results.combos.push(simpleResult(item, "created", null, { id: created.id }));
        }
      } catch (error) {
        results.combos.push(simpleResult(item, "failed", error?.message || String(error)));
      }
    }
  }

  if (plan.settings) {
    try {
      if (plan.settings.changedKeys.length) await updateSettings(plan.settings.updates);
      results.settings = {
        status: plan.settings.changedKeys.length ? "updated" : "unchanged",
        changed: plan.settings.changedKeys,
        unchanged: plan.settings.unchanged,
        skipped: plan.settings.skipped,
      };
    } catch (error) {
      results.settings = {
        status: "failed",
        changed: [],
        unchanged: plan.settings.unchanged,
        skipped: plan.settings.skipped,
        reason: error?.message || String(error),
      };
    }
  }

  return { plan, results, counts: countResults(results) };
}

export function countResults(results) {
  const count = (items) => {
    const counts = { total: items.length, created: 0, updated: 0, skipped: 0, failed: 0 };
    for (const item of items) if (counts[item.status] !== undefined) counts[item.status] += 1;
    return counts;
  };
  return {
    connections: count(results.connections || []),
    apiKeys: count(results.apiKeys || []),
    combos: count(results.combos || []),
    settings: results.settings ? results.settings.status : null,
  };
}
