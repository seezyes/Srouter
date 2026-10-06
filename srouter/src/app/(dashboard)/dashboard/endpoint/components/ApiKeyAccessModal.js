"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Button, Modal } from "@/shared/components";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { API_KEY_ACCESS_FIELDS, API_KEY_ACCESS_KINDS } from "@/shared/utils/apiKeyAccess.js";
import { buildProviderList } from "@/shared/utils/aclProviderList.js";

const LABELS = { allowedProviders: "Providers", allowedCombos: "Combos", allowedKinds: "Request kinds" };

export default function ApiKeyAccessModal({ apiKey, onClose, onSaved }) {
  const [draft, setDraft] = useState(() => Object.fromEntries(API_KEY_ACCESS_FIELDS.map((field) => [field, apiKey[field] ?? null])));
  const [choices, setChoices] = useState({ allowedProviders: [], allowedCombos: [],
    allowedKinds: API_KEY_ACCESS_KINDS.map((id) => ({ id, label: id })) });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const responses = await Promise.all(["/api/providers", "/api/provider-nodes", "/api/combos"]
          .map((url) => fetch(url, { signal: controller.signal })));
        if (responses.some((response) => !response.ok)) throw new Error("Could not load access choices");
        const [providers, nodes, combos] = await Promise.all(responses.map((response) => response.json()));
        if (controller.signal.aborted) return;
        const registered = Object.values(AI_PROVIDERS).map((provider) => ({ ...provider, displayName: provider.name }));
        const providerChoices = buildProviderList(providers.connections, nodes.nodes, registered);
        setChoices((current) => ({ ...current,
          allowedProviders: providerChoices.map((provider) => ({
            id: provider.id, label: provider.prefix ? `${provider.displayName} (${provider.prefix})` : provider.displayName,
            aliases: [provider.alias, provider.prefix].filter(Boolean),
          })),
          allowedCombos: (combos.combos || []).map((combo) => ({ id: combo.name, label: combo.name })),
        }));
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause.message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    load();
    return () => controller.abort();
  }, []);

  async function save() {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/keys/${apiKey.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save access");
      onSaved(data.key);
      onClose();
    } catch (cause) {
      setError(cause.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal isOpen title={<>Access: <span data-streamer-sensitive>{apiKey.name}</span></>} size="lg" onClose={() => !saving && onClose()}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-text-muted">All grants unrestricted access. Selected with no checks denies all. Combo targets and advisors must also pass provider and kind restrictions.</p>
        {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
        {loading ? <p className="text-sm text-text-muted">Loading choices...</p> : API_KEY_ACCESS_FIELDS.map((field) => {
          const value = draft[field];
          const known = new Set(choices[field].flatMap((choice) => [choice.id, ...(choice.aliases || [])]));
          // Preserve stale/unknown permissions instead of silently broadening or
          // dropping them merely by opening and saving the dialog.
          const entries = [...choices[field], ...(value || []).filter((id) => !known.has(id)).map((id) => ({ id, label: `${id} (saved)` }))];
          return (
            <fieldset key={field} className="border border-border-subtle rounded-lg p-3">
              <legend className="text-sm font-medium">{LABELS[field]}</legend>
              <div className="flex gap-4 mb-2 text-sm">
                <label><input type="radio" name={field} checked={value === null}
                  onChange={() => setDraft((current) => ({ ...current, [field]: null }))} /> All</label>
                <label><input type="radio" name={field} checked={value !== null}
                  onChange={() => setDraft((current) => ({ ...current, [field]: [] }))} /> Selected</label>
              </div>
              {value !== null && <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto">
                {entries.map((choice) => {
                  const ids = [choice.id, ...(choice.aliases || [])];
                  return <label key={choice.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={ids.some((id) => value.includes(id))} onChange={(event) => {
                      const checked = event.target.checked;
                      setDraft((current) => ({ ...current, [field]: checked
                        ? [...current[field].filter((id) => !ids.includes(id)), choice.id]
                        : current[field].filter((id) => !ids.includes(id)) }));
                    }} />
                    {choice.label}
                  </label>;
                })}
              </div>}
            </fieldset>
          );
        })}
        <div className="flex gap-2">
          <Button onClick={save} disabled={loading || saving}>{saving ? "Saving..." : "Save access"}</Button>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

ApiKeyAccessModal.propTypes = { apiKey: PropTypes.object.isRequired, onClose: PropTypes.func.isRequired, onSaved: PropTypes.func.isRequired };
