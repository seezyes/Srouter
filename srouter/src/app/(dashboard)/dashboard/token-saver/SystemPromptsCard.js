"use client";

import { useEffect, useRef, useState } from "react";
import { ModelSelectModal } from "@/shared/components/onDemandModals";
import Badge from "@/shared/components/Badge";
import Button from "@/shared/components/Button";
import Toggle from "@/shared/components/Toggle";
import { getProviderAlias } from "@/shared/constants/providers";
import {
  CUSTOM_SYSTEM_PROMPT_LIMITS as LIMITS,
  customSystemPromptModelKey,
  normalizeCustomSystemPrompts,
  validateCustomSystemPrompts,
} from "@/shared/utils/customSystemPrompts";
import { PluginCard, pluginStyles as styles } from "./PluginCards";
import { mergePromptTargets, promptPickerValues, promptTargetKey } from "./promptModelSelection";

const EMPTY = { enabled: false, prompts: [] };

export default function SystemPromptsCard() {
  const [draft, setDraft] = useState(EMPTY);
  const [saved, setSaved] = useState(JSON.stringify(EMPTY));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const [providers, setProviders] = useState([]);
  const [providerNodes, setProviderNodes] = useState([]);
  const [modelAliases, setModelAliases] = useState({});
  const [picker, setPicker] = useState(null);
  const [manualModels, setManualModels] = useState({});
  const [previewModel, setPreviewModel] = useState("");
  const saveLock = useRef(false);
  const draftRef = useRef(EMPTY);
  const dirty = JSON.stringify(draft) !== saved;
  const blocked = loading || saving;
  const prefixes = [
    ...providers.map((item) => ({ provider: item.provider, prefix: item.providerSpecificData?.prefix })),
    ...providerNodes.map((item) => ({ provider: item.id, prefix: item.prefix })),
  ].filter((item) => item.prefix);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/settings", { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Unable to load system prompts.");
        const data = await response.json();
        if (controller.signal.aborted) return;
        const value = normalizeCustomSystemPrompts(data.customSystemPrompts ?? EMPTY);
        draftRef.current = value;
        setDraft(value);
        setSaved(JSON.stringify(value));
        setLoading(false);
      } catch (failure) {
        if (controller.signal.aborted) return;
        setError(failure.message);
        setLoading(false);
        // Never allow a failed GET to overwrite saved settings with empty defaults.
        setSaved("");
      }
    }
    load();
    fetch("/api/providers", { signal: controller.signal, cache: "no-store" })
      .then((response) => response.ok ? response.json() : {})
      .then((data) => {
        if (!controller.signal.aborted) setProviders((data.connections || []).filter((connection) => connection.isActive !== false));
      })
      .catch(() => { /* Manual provider/model entry remains available. */ });
    fetch("/api/provider-nodes", { signal: controller.signal, cache: "no-store" })
      .then((response) => response.ok ? response.json() : {})
      .then((data) => {
        if (!controller.signal.aborted) setProviderNodes(data.nodes || []);
      })
      .catch(() => { /* Canonical IDs remain available in Advanced. */ });
    fetch("/api/models/alias", { signal: controller.signal, cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Unable to load model aliases.");
        return response.json();
      })
      .then((data) => {
        if (!controller.signal.aborted) setModelAliases(data.aliases || {});
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Unable to load model aliases. Some models may be missing from the picker; use Advanced IDs or reload the page.");
      });
    return () => controller.abort();
  }, [reload]);

  function edit(update) {
    if (blocked || !saved || saveLock.current) return;
    const next = typeof update === "function" ? update(draftRef.current) : { ...draftRef.current, ...update };
    draftRef.current = next;
    setDraft(next);
    setNotice("");
    setError("");
  }
  function editEntry(id, patch) {
    edit((current) => ({ ...current, prompts: current.prompts.map((entry) => entry.id === id ? { ...entry, ...patch } : entry) }));
  }
  function addEntry() {
    const id = crypto.randomUUID();
    edit((current) => current.prompts.length >= LIMITS.prompts ? current : ({
      ...current,
      prompts: [...current.prompts, {
        id, name: `Prompt ${current.prompts.length + 1}`, text: "",
        enabled: true, mode: "append", scope: "all", models: [],
      }],
    }));
  }
  function moveEntry(index, delta) {
    edit((current) => {
      const prompts = [...current.prompts];
      const target = index + delta;
      if (target < 0 || target >= prompts.length) return current;
      [prompts[index], prompts[target]] = [prompts[target], prompts[index]];
      return { ...current, prompts };
    });
  }
  function addModel(id, raw) {
    if (blocked || !saved || saveLock.current) return;
    // Synchronous draft ref makes rapid picker clicks and validation atomic.
    const entry = draftRef.current.prompts.find((item) => item.id === id);
    if (!entry) return;
    const result = mergePromptTargets(entry.models, raw, customSystemPromptModelKey, LIMITS, prefixes);
    if (result.error) { setError(result.error); return; }
    editEntry(id, { models: result.models });
    setManualModels((current) => ({ ...current, [id]: "" }));
  }
  function removeModel(id, raw) {
    const key = promptTargetKey(raw, customSystemPromptModelKey, prefixes);
    edit((current) => ({
      ...current, prompts: current.prompts.map((entry) => entry.id === id
        ? { ...entry, models: entry.models.filter((model) => model !== key) } : entry),
    }));
  }
  async function save() {
    if (saveLock.current || blocked || !dirty || !saved) return;
    const problem = validateCustomSystemPrompts(draftRef.current);
    if (problem) { setError(problem); return; }
    const submitted = normalizeCustomSystemPrompts(draftRef.current);
    saveLock.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customSystemPrompts: submitted }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Unable to save system prompts.");
      // Editing is locked during PATCH; failure leaves the whole draft intact.
      // Do not replace the draft from an unrelated/stale settings response.
      draftRef.current = submitted;
      setDraft(submitted);
      setSaved(JSON.stringify(submitted));
      setNotice("Saved.");
    } catch (failure) {
      setError(failure.message);
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }

  const target = promptTargetKey(previewModel, customSystemPromptModelKey, prefixes);
  const needsTarget = draft.prompts.some((entry) => entry.enabled && entry.scope === "models" && entry.models.length);
  const matching = draft.enabled
    ? draft.prompts.filter((entry) => entry.enabled && (entry.scope === "all" || (target && entry.models.includes(target))))
    : [];
  const lastReplace = matching.findLastIndex((entry) => entry.mode === "replace");
  const pickerEntry = draft.prompts.find((entry) => entry.id === picker);

  return (
    <PluginCard id="system-prompts" title="System Prompts" description={
      <>
        <span className={styles.compactSummary}>
          {loading || !saved ? <span>{loading ? "Loading settings…" : "Settings not loaded"}</span> : <>
            <Badge variant={draft.enabled ? "success" : "default"} size="sm" dot>{draft.enabled ? "Enabled" : "Disabled"}</Badge>
            <span>{draft.prompts.length} prompts · {draft.prompts.filter((entry) => entry.enabled).length} enabled{dirty ? " · unsaved" : ""}</span>
          </>}
        </span>
      </>
    } icon="format_list_bulleted">
      <div className={styles.editor}>
        <fieldset disabled={blocked || !saved} className={styles.editor}>
          <div className={`${styles.toolbar} ${styles.promptControls}`}>
            <Toggle size="lg" checked={draft.enabled} disabled={blocked || !saved} label="System prompts" aria-label="Enable custom system prompts" onChange={(enabled) => edit({ enabled })} />
            <div className={styles.toolbar}>
              <span className={styles.muted}>{draft.prompts.length}/{LIMITS.prompts}</span>
              <Button type="button" icon="add" onClick={addEntry} disabled={blocked || !saved || draft.prompts.length >= LIMITS.prompts}>Add prompt</Button>
            </div>
          </div>
          {!draft.prompts.length && <p className={styles.muted}>No custom prompts yet. Add one to build your instruction sequence.</p>}
          {draft.prompts.map((entry, index) => (
            <section className={styles.entry} key={entry.id} aria-label={`Prompt ${index + 1}`}>
              <div className={styles.toolbar}>
                <Toggle size="md" checked={entry.enabled} disabled={blocked || !saved} label={`#${index + 1} ${entry.enabled ? "Enabled" : "Disabled"}`} aria-label={`Enable prompt ${index + 1}`} onChange={(enabled) => editEntry(entry.id, { enabled })} />
                <input className={styles.name} aria-label={`Prompt ${index + 1} name`} maxLength={LIMITS.name} value={entry.name} onChange={(e) => editEntry(entry.id, { name: e.target.value })} placeholder="Prompt name" />
                <button type="button" className={styles.button} disabled={index === 0} onClick={() => moveEntry(index, -1)} aria-label={`Move prompt ${index + 1} up`}>Move up</button>
                <button type="button" className={styles.button} disabled={index === draft.prompts.length - 1} onClick={() => moveEntry(index, 1)} aria-label={`Move prompt ${index + 1} down`}>Move down</button>
                <button type="button" className={`${styles.button} ${styles.danger}`} onClick={() => edit((current) => ({ ...current, prompts: current.prompts.filter((item) => item.id !== entry.id) }))}>Delete</button>
              </div>
              <label className={styles.muted} htmlFor={`prompt-text-${entry.id}`}>Instructions · {entry.text.length}/{LIMITS.text}</label>
              <textarea id={`prompt-text-${entry.id}`} maxLength={LIMITS.text} value={entry.text} onChange={(e) => editEntry(entry.id, { text: e.target.value })} placeholder="Write system instructions…" />
              <div className={styles.fields}>
                <label>Apply to<select value={entry.scope} onChange={(e) => editEntry(entry.id, { scope: e.target.value })}><option value="all">All models</option><option value="models">Selected models only</option></select></label>
                <label>Instruction behavior<select value={entry.mode} onChange={(e) => editEntry(entry.id, { mode: e.target.value })}><option value="append">Add to instructions</option><option value="replace">Replace instructions</option></select></label>
              </div>
              {entry.mode === "replace" && <p className={styles.muted}>Replaces client system/developer instructions and earlier matching prompts. Later prompts can still add instructions.</p>}
              {entry.scope === "models" && (
                <div className={styles.models}>
                  <button type="button" className={styles.button} onClick={() => setPicker(entry.id)}>Select models · {entry.models.length}/{LIMITS.models}</button>
                  {entry.models.map((model) => <span key={model} className={styles.modelChip}>{model}<button type="button" aria-label={`Remove ${model}`} onClick={() => removeModel(entry.id, model)}>×</button></span>)}
                  {!entry.models.length && <span className={styles.muted}>No targets · this prompt matches no models.</span>}
                </div>
              )}
              {entry.scope === "models" && <details className={styles.advanced}>
                <summary>Advanced · paste model IDs</summary>
                <div className={styles.toolbar}>
                  <textarea rows={2} aria-label={`Model IDs for prompt ${index + 1}`} placeholder="provider/model, provider/another-model" maxLength={LIMITS.models * (LIMITS.model + 1)} value={manualModels[entry.id] || ""} onChange={(e) => setManualModels((current) => ({ ...current, [entry.id]: e.target.value }))} />
                  <button type="button" className={styles.button} onClick={() => addModel(entry.id, manualModels[entry.id])}>Add IDs</button>
                </div>
                <p className={styles.muted}>Separate IDs with commas, spaces or newlines. Aliases resolve and duplicates are removed. Invalid batches leave existing targets unchanged.</p>
              </details>}
            </section>
          ))}
        </fieldset>
        <div className={styles.toolbar}>
          <button type="button" className={`${styles.button} ${styles.primary}`} onClick={save} disabled={blocked || !saved || !dirty}>{saving ? "Saving…" : "Save prompts"}</button>
          <span role="status" className={styles.muted}>{loading ? "Loading settings…" : notice || (dirty && saved ? "Unsaved changes" : saved ? "Saved configuration" : "Settings not loaded")}</span>
          {!saved && !loading && <button type="button" className={styles.button} onClick={() => { setLoading(true); setError(""); setReload((current) => current + 1); }}>Retry loading</button>}
        </div>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <details className={styles.preview}>
        <summary>Application sequence · preview draft</summary>
        <div className={styles.editor}>
        <div className={styles.toolbar}>
          <strong>Application sequence</strong>
          <input aria-label="Preview provider/model" placeholder="provider/model to preview" value={previewModel} onChange={(e) => setPreviewModel(e.target.value)} />
          <button type="button" className={styles.button} onClick={() => setPicker("preview")} disabled={blocked || !saved}>Choose preview model</button>
          {previewModel && <button type="button" className={styles.button} onClick={() => setPreviewModel("")}>Clear target</button>}
        </div>
        <p className={styles.muted}>Not a live request. {!draft.enabled ? "Global switch is off: no custom prompts apply." : target ? `${matching.length} matching enabled prompt(s) for ${target}.` : needsTarget ? "Showing all-model prompts only. Choose a target to include its selected-model prompts." : "Same chain for all models; no preview target needed."} Disabled prompts are omitted.</p>
        <div className={styles.sequence}>
          <div className={`${styles.node} ${lastReplace >= 0 ? styles.replaced : ""}`}>Client system / developer instructions{lastReplace >= 0 ? " · cleared by replacement" : " · preserved"}</div>
          {matching.map((entry, index) => (
            <div key={entry.id}>
              <div className={styles.connector} aria-hidden="true" />
              <div className={`${styles.node} ${index < lastReplace ? styles.replaced : ""} ${entry.mode === "replace" ? styles.replacement : ""}`}>
                {entry.mode === "replace" ? "REPLACE · clear everything above" : "APPEND"} · {entry.name || "Untitled prompt"}{index < lastReplace ? " · cleared by a later replacement" : ""}
              </div>
            </div>
          ))}
          <div className={styles.connector} aria-hidden="true" />
          <div className={styles.node}>Effective instructions{!target && needsTarget && draft.enabled ? " (all-model chain only)" : ""} · {matching.length ? lastReplace >= 0 ? `${matching.length - lastReplace} custom prompt(s), without client instructions` : `client + ${matching.length} custom prompt(s)` : "client instructions unchanged"}</div>
        </div>
        </div>
        </details>
      </div>
      {picker && !blocked && saved && <div className={styles.draftPicker}><ModelSelectModal isOpen title={picker === "preview" ? "Preview a target model" : "Draft targets · select / deselect, then Save prompts"} activeProviders={providers} modelAliases={modelAliases} kindFilter="llm" closeOnSelect={picker === "preview"} selectedModel={picker === "preview" ? previewModel : undefined} addedModelValues={picker === "preview" ? [] : promptPickerValues(pickerEntry?.models || [], getProviderAlias, prefixes)} onClose={() => setPicker(null)} onDeselect={picker === "preview" ? undefined : (model) => removeModel(picker, model)} onSelect={(model) => {
        if (picker === "preview") {
          const key = promptTargetKey(model, customSystemPromptModelKey, prefixes);
          if (!key || key.length > LIMITS.model) { setError("Choose an exact LLM model, not a combo."); return; }
          setPreviewModel(typeof model === "string" ? model : model.value);
          setPicker(null);
        }
        else addModel(picker, model);
      }} /></div>}
    </PluginCard>
  );
}
