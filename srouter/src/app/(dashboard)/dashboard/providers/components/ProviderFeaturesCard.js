"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Modal } from "@/shared/components";
import { getProviderFeatures } from "open-sse/config/providerFeatures.js";
import { chooseProviderFeature } from "@/shared/utils/providerFeatureConfirmation";

const LABELS = {
  accountPools: "Account Pools",
  serviceTier: "Service Tier",
  customHeaders: "Custom Headers",
};
const DESCRIPTIONS = {
  accountPools: "Apply pool model rules when selecting accounts. Switching off keeps pools and memberships saved.",
  serviceTier: "Apply saved account defaults. Explicit service_tier from the client always wins.",
  customHeaders: "Apply user header overrides. Built-in headers and authentication remain active. Turning off may affect endpoints that require your custom headers.",
};

export function useProviderFeatures(providerId) {
  const [loaded, setLoaded] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const saveLock = useRef(false);
  const current = loaded?.provider === providerId ? loaded : null;

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/providers/${encodeURIComponent(providerId)}/features`, {
      cache: "no-store", signal: controller.signal,
    }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load features");
      if (!controller.signal.aborted) {
        setLoaded({ provider: providerId, ...data });
        setError("");
      }
    }).catch((failure) => {
      if (!controller.signal.aborted) setError(failure.message || "Could not load features");
    });
    return () => controller.abort();
  }, [providerId]);

  const save = useCallback(async (key, value) => {
    if (saveLock.current) return false;
    saveLock.current = true;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/providers/${encodeURIComponent(providerId)}/features`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save features");
      setLoaded((previous) => ({ ...previous, provider: providerId, features: data.features }));
      return true;
    } catch (failure) {
      setError(failure.message || "Could not save features");
      return false;
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }, [providerId]);

  return {
    features: current?.features || getProviderFeatures(providerId),
    capabilities: current?.capabilities || {},
    ready: !!current,
    error,
    saving,
    save,
  };
}

function FeatureDialog({ providerName, controls, onClose }) {
  const [pending, setPending] = useState(null);
  const { features, capabilities, ready, error, saving, save } = controls;
  const choose = async (key) => {
    if (!ready || saving) return;
    const action = chooseProviderFeature(pending, key, features[key]);
    if (!action.confirm) {
      setPending({ key, value: action.value });
      return;
    }
    if (await save(key, action.value)) setPending(null);
  };

  return (
    <Modal isOpen title={`${providerName || "Provider"} features`} onClose={saving ? () => {} : onClose}>
      <div role="dialog" aria-label="Provider features" className="space-y-3">
        <p className="text-xs text-text-muted">Click a switch, then click it again to confirm. Saved settings are never deleted.</p>
        {Object.keys(LABELS).filter((key) => capabilities[key]).map((key) => (
          <div key={key} className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">{LABELS[key]}</span>
              <button
                type="button"
                aria-label={pending?.key === key ? `Confirm ${LABELS[key]} ${pending.value ? "enable" : "disable"}` : `Change ${LABELS[key]}`}
                disabled={!ready || saving}
                onClick={() => choose(key)}
                className={`rounded-md border px-3 py-1 text-xs font-medium disabled:opacity-50 ${
                  pending?.key === key ? "border-amber-400 text-amber-500" :
                    features[key] ? "border-primary/30 text-primary" : "border-border text-text-muted"
                }`}
              >
                {pending?.key === key ? `Confirm ${pending.value ? "enable" : "disable"}` : features[key] ? "Enabled" : "Disabled"}
              </button>
            </div>
            <p className="mt-2 text-xs text-text-muted">{DESCRIPTIONS[key]}</p>
            {pending?.key === key && (
              <button type="button" disabled={saving} onClick={() => setPending(null)} className="mt-2 text-xs text-text-muted hover:text-primary">Cancel change</button>
            )}
          </div>
        ))}
        {!ready && !error && <p className="text-xs text-text-muted">Loading…</p>}
        {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
        {saving && <p role="status" className="text-xs text-text-muted">Saving…</p>}
      </div>
    </Modal>
  );
}

export default function ProviderFeaturesCard({ providerName, controls }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="ml-auto flex shrink-0 items-center gap-2 rounded-xl border border-border bg-surface px-4 py-3 text-left transition-colors hover:border-primary/40"
      >
        <span className="material-symbols-outlined text-primary text-[20px]">tune</span>
        <span className="text-sm font-semibold">Provider features</span>
        <span className="material-symbols-outlined text-text-muted text-[18px]">expand_more</span>
      </button>
      {open && <FeatureDialog providerName={providerName} controls={controls} onClose={() => setOpen(false)} />}
    </>
  );
}

const controlsType = PropTypes.shape({
  features: PropTypes.object.isRequired,
  capabilities: PropTypes.object.isRequired,
  ready: PropTypes.bool.isRequired,
  saving: PropTypes.bool.isRequired,
  error: PropTypes.string,
  save: PropTypes.func.isRequired,
}).isRequired;
ProviderFeaturesCard.propTypes = { providerName: PropTypes.string, controls: controlsType };
FeatureDialog.propTypes = { providerName: PropTypes.string, controls: controlsType, onClose: PropTypes.func.isRequired };
