"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, CardSkeleton, ConfirmModal, Toggle } from "@/shared/components";
import { cn } from "@/shared/utils/cn";
import { useNotificationStore } from "@/store/notificationStore";
import useUIStore from "@/store/uiStore";

const DEFAULT_OPTIONS = { connections: true, apiKeys: false, combos: false, settings: false };

const OPTION_DEFS = [
  {
    key: "connections",
    label: "Provider connections",
    hint: "Accounts with provider, auth type, name, email, priority and the credential payload (API key / OAuth tokens / provider-specific data).",
  },
  {
    key: "apiKeys",
    label: "API keys",
    hint: "Names are copied and a fresh key is issued for this machine — the source key value is bound to the other install and cannot be reused.",
  },
  {
    key: "combos",
    label: "Combos",
    hint: "Combo names with their model lists. An existing combo with the same name is updated only when its models or kind differ.",
  },
  {
    key: "settings",
    label: "Settings",
    hint: "Routing and feature settings. Credentials, login/SSO, tunnel and endpoint settings are never copied.",
  },
];

const ACTION_VARIANT = {
  create: "success",
  update: "info",
  skip: "default",
  error: "error",
  created: "success",
  updated: "info",
  skipped: "default",
  failed: "error",
};

// One entry per import source rendered on this page.
// - 9router: the sibling installation, always available (local installs).
// - main: the main (non-dev) Srouter instance; the panel appears only when
//   Developer settings is on AND the dev-launcher mode is active (the API
//   reports `active`), so production stays unchanged.
const IMPORT_SOURCES = {
  "9router": {
    endpoint: "/api/import/9router",
    heading: "h1",
    title: "Import from 9router",
    intro: "Copy accounts, combos and settings from the sibling 9router installation. The source database is read read-only, credentials are never displayed in full, and every write goes through the same code paths the Providers page uses (so dedup and priority rules match).",
    sourceCardSubtitle: "9router data directory",
    devSection: false,
    confirmTitle: "Import from 9router",
    confirmMessage: (count) =>
      `Import ${count} item(s) into this Srouter install? Existing accounts matched by the app's dedup rules are updated in place. Credentials are copied locally and never leave this machine.`,
  },
  main: {
    endpoint: "/api/import/main",
    heading: "h2",
    title: "Import from Srouter main instance",
    intro: "Copy accounts, API keys, combos and settings from the main (non-dev) Srouter installation this dev instance mirrors. The source database is read read-only and every write goes through the same code paths the Providers page uses. This section is shown only in the dev instance with Developer settings enabled.",
    sourceCardSubtitle: "Main instance data directory",
    devSection: true,
    confirmTitle: "Import from the main Srouter instance",
    confirmMessage: (count) =>
      `Import ${count} item(s) from the main Srouter instance into this dev install? Existing accounts matched by the app's dedup rules are updated in place. Credentials are copied locally and never leave this machine.`,
  },
};

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function ActionBadge({ action }) {
  if (!action) return null;
  return (
    <Badge variant={ACTION_VARIANT[action] || "default"} size="sm">
      {action}
    </Badge>
  );
}

function ResultCounts({ counts }) {
  if (!counts) return null;
  const cells = [
    ["created", counts.created, "success"],
    ["updated", counts.updated, "info"],
    ["skipped", counts.skipped, "default"],
    ["failed", counts.failed, "error"],
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      {cells
        .filter(([, value]) => value > 0)
        .map(([label, value, variant]) => (
          <Badge key={label} variant={variant} size="sm">
            {value} {label}
          </Badge>
        ))}
    </div>
  );
}

function ImportSourcePanel({ sourceKey }) {
  const meta = IMPORT_SOURCES[sourceKey];
  const notify = useNotificationStore();
  // Dev-only sources stay hidden until the API reports this install can use
  // them ("checking" and "inactive" both render nothing).
  const [available, setAvailable] = useState(meta.devSection ? null : true);
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [source, setSource] = useState(null);
  const [preview, setPreview] = useState(null);
  const [results, setResults] = useState(null);
  const [resultCounts, setResultCounts] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [stale, setStale] = useState(false);
  // Keys of connection rows the user unchecked. Everything else is selected,
  // and the same selection is sent on preview and execute so the plan the page
  // shows is exactly the plan the server will run.
  const [deselected, setDeselected] = useState(() => new Set());
  const previewRef = useRef(null);
  const deselectedRef = useRef(deselected);
  const toggleTimer = useRef(null);
  const previewSeq = useRef(0);

  const applyPreview = useCallback((nextPreview) => {
    previewRef.current = nextPreview;
    setPreview(nextPreview);
  }, []);

  // Build the `selection` payload for a request. `null` means "no filter" —
  // the backwards-compatible "import the whole group" behaviour.
  const selectionFrom = useCallback((items, skip) => {
    const connections = items?.connections || [];
    if (!connections.length) return null;
    return { connections: connections.filter((item) => !skip.has(item.key)).map((item) => item.key) };
  }, []);

  const refreshPreview = useCallback(async (nextOptions, selection) => {
    if (toggleTimer.current) {
      clearTimeout(toggleTimer.current);
      toggleTimer.current = null;
    }
    const seq = ++previewSeq.current;
    setPreviewing(true);
    setError(null);
    try {
      const res = await fetch(meta.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ mode: "preview", options: nextOptions, ...(selection ? { selection } : {}) }),
      });
      const data = await res.json().catch(() => null);
      if (seq !== previewSeq.current) return; // a newer preview superseded this one
      if (!data) {
        setError("Import API returned an unreadable response");
        return;
      }
      setSource(data.source || null);
      if (!res.ok || data.ok === false) {
        applyPreview(null);
        setError(data.error || `Preview failed (${res.status})`);
        return;
      }
      const nextPreview = data.preview || null;
      applyPreview(nextPreview);
      // Drop unchecked keys the source no longer offers, so a later request
      // never carries stale rows.
      if (nextPreview?.connections) {
        const keys = new Set(nextPreview.connections.map((item) => item.key));
        const pruned = new Set([...deselectedRef.current].filter((key) => keys.has(key)));
        if (pruned.size !== deselectedRef.current.size) {
          deselectedRef.current = pruned;
          setDeselected(pruned);
        }
      }
      setStale(false);
    } catch (err) {
      if (seq === previewSeq.current) setError(err?.message || "Preview failed");
    } finally {
      if (seq === previewSeq.current) {
        setPreviewing(false);
        setLoading(false);
      }
    }
  }, [applyPreview, meta.endpoint]);

  // Preview with the current checkbox selection applied.
  const previewWithSelection = useCallback(
    (nextOptions = options) => refreshPreview(nextOptions, selectionFrom(previewRef.current, deselectedRef.current)),
    [options, refreshPreview, selectionFrom],
  );

  // Checkbox toggles re-run the dry run (debounced) so planned actions and
  // counts always describe exactly what an execute would write.
  const schedulePreview = useCallback((nextOptions) => {
    if (toggleTimer.current) clearTimeout(toggleTimer.current);
    toggleTimer.current = setTimeout(() => {
      toggleTimer.current = null;
      refreshPreview(nextOptions, selectionFrom(previewRef.current, deselectedRef.current));
    }, 250);
  }, [refreshPreview, selectionFrom]);

  useEffect(() => () => {
    if (toggleTimer.current) clearTimeout(toggleTimer.current);
  }, []);

  // Dev-only sources: ask the API whether the import is active before anything
  // is rendered (it is refused outside the dev launcher and in production).
  useEffect(() => {
    if (!meta.devSection) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(meta.endpoint, { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (!cancelled) setAvailable(Boolean(data?.active));
      } catch {
        if (!cancelled) setAvailable(false);
      }
    })();
    return () => { cancelled = true; };
  }, [meta.devSection, meta.endpoint]);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch(meta.endpoint, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (data?.source) setSource(data.source);
    } catch {
      // keep the last known status
    }
  }, [meta.endpoint]);

  useEffect(() => {
    if (available !== true) return;
    // Initial dry run so the page opens with "what would be imported".
    // Same escape hatch as dashboard/proxy-fitness: the fetch owns the state,
    // there is no external system to synchronize here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshPreview(DEFAULT_OPTIONS, null);
  }, [available, refreshPreview]);

  const toggleOption = (key) => {
    setOptions((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      setStale(true);
      return next;
    });
  };

  const toggleAccount = (key) => {
    const next = new Set(deselectedRef.current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    deselectedRef.current = next;
    setDeselected(next);
    schedulePreview(options);
  };

  const connectionItems = preview?.connections || [];
  const selectedCount = connectionItems.filter((item) => !deselected.has(item.key)).length;
  const allSelected = connectionItems.length > 0 && selectedCount === connectionItems.length;

  const toggleAllAccounts = () => {
    const next = allSelected ? new Set(connectionItems.map((item) => item.key)) : new Set();
    deselectedRef.current = next;
    setDeselected(next);
    schedulePreview(options);
  };

  const importNow = async () => {
    setConfirmOpen(false);
    setImporting(true);
    setError(null);
    const selection = selectionFrom(previewRef.current, deselectedRef.current);
    try {
      const res = await fetch(meta.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "execute", options, ...(selection ? { selection } : {}) }),
      });
      const data = await res.json().catch(() => null);
      if (!data) {
        setError("Import API returned an unreadable response");
        return;
      }
      setSource(data.source || source);
      if (!res.ok || data.ok === false) {
        setError(data.error || `Import failed (${res.status})`);
        notify.error(data.error || "Import failed");
        return;
      }
      setResults(data.results || null);
      setResultCounts(data.counts || null);
      const created = data.counts?.connections?.created || 0;
      const updated = data.counts?.connections?.updated || 0;
      notify.success(`Connections: ${created} created, ${updated} updated`);
      await refreshPreview(options, selection);
    } catch (err) {
      setError(err?.message || "Import failed");
      notify.error("Import failed");
    } finally {
      setImporting(false);
    }
  };

  const pendingCount = useMemo(() => {
    if (!preview?.counts) return 0;
    const connections = preview.counts.connections || {};
    const apiKeys = preview.counts.apiKeys || {};
    const combos = preview.counts.combos || {};
    const settings = preview.counts.settings || {};
    return (connections.create || 0) + (connections.update || 0)
      + (apiKeys.create || 0)
      + (combos.create || 0) + (combos.update || 0)
      + (settings.changed || 0);
  }, [preview]);

  if (available !== true) return null;

  if (loading) {
    return (
      <>
        <CardSkeleton />
        <CardSkeleton />
      </>
    );
  }

  const Heading = meta.heading;

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Heading className="text-xl font-semibold sm:text-2xl">{meta.title}</Heading>
            {meta.devSection ? <Badge variant="primary" size="sm">Developer</Badge> : null}
          </div>
          <p className="mt-1 text-sm text-text-muted">{meta.intro}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 sm:items-center">
          <Button variant="secondary" size="sm" icon="refresh" className="whitespace-nowrap" onClick={refreshStatus} disabled={previewing || importing}>
            Re-check source
          </Button>
          <Button variant="secondary" size="sm" icon="visibility" className="whitespace-nowrap" onClick={() => previewWithSelection(options)} disabled={previewing || importing}>
            {previewing ? "Reading…" : "Preview"}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-[10px] border border-red-500/20 bg-red-500/5 px-3 py-2">
          <span className="material-symbols-outlined text-[18px] text-red-500">error</span>
          <p className="text-sm text-text-main">{error}</p>
        </div>
      ) : null}

      <Card title="Source" subtitle={meta.sourceCardSubtitle} icon="database">
        {source ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={source.found ? "success" : "error"} dot>
                {source.found ? "found" : "not found"}
              </Badge>
              {source.driver ? <Badge variant="default" size="sm">{source.driver}</Badge> : null}
              {source.dbFileExists ? <Badge variant="default" size="sm">{formatBytes(source.dbSizeBytes)}</Badge> : null}
              {source.tables?.map((table) => (
                <Badge key={table.name} variant="primary" size="sm">
                  {table.name}: {table.rows}
                </Badge>
              ))}
            </div>
            <div>
              <p className="text-xs text-text-muted">Database</p>
              <code className="block break-all font-mono text-xs text-text-main">{source.dbFile}</code>
            </div>
            {source.legacyJsonFileExists ? (
              <div>
                <p className="text-xs text-text-muted">Legacy JSON</p>
                <code className="block break-all font-mono text-xs text-text-main">{source.legacyJsonFile}</code>
              </div>
            ) : null}
            {source.warnings?.length ? (
              <ul className="flex flex-col gap-1">
                {source.warnings.map((warning) => (
                  <li key={warning} className="flex items-start gap-2 text-xs text-text-muted">
                    <span className="material-symbols-outlined text-[14px] text-yellow-500">warning</span>
                    <span>{warning}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-text-muted">Source status unavailable.</p>
        )}
      </Card>

      <Card title="What to import" subtitle="Credentials are never displayed in full" icon="checklist">
        <div className="flex flex-col gap-3">
          {OPTION_DEFS.map((def) => (
            <div
              key={def.key}
              className="flex flex-col gap-3 rounded-[10px] border border-border-subtle p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-main">{def.label}</p>
                <p className="text-xs text-text-muted">{def.hint}</p>
              </div>
              <Toggle checked={options[def.key] === true} onChange={() => toggleOption(def.key)} disabled={importing} />
            </div>
          ))}
        </div>
      </Card>

      {stale ? (
        <div className="flex items-center gap-2 rounded-[10px] border border-brand-500/20 bg-brand-500/5 px-3 py-2">
          <span className="material-symbols-outlined text-[18px] text-brand-500">info</span>
          <p className="text-sm text-text-main">Options changed — run Preview again to refresh this plan.</p>
          <Button size="sm" variant="secondary" className="whitespace-nowrap" onClick={() => previewWithSelection(options)} disabled={previewing}>
            Preview
          </Button>
        </div>
      ) : null}

      <Card
        title="Preview"
        subtitle={preview ? `${pendingCount} item(s) would be written` : "Run a preview to see what would be imported"}
        icon="preview"
        action={preview ? <Badge variant="default" size="sm">dry run</Badge> : null}
      >
        {!preview ? (
          <p className="text-sm text-text-muted">No preview yet.</p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="success" size="sm">connections: {preview.counts.connections.create} create</Badge>
              <Badge variant="info" size="sm">connections: {preview.counts.connections.update} update</Badge>
              <Badge variant="default" size="sm">connections: {preview.counts.connections.skip} skip</Badge>
              {preview.counts.connections.error > 0 ? (
                <Badge variant="error" size="sm">connections: {preview.counts.connections.error} unusable</Badge>
              ) : null}
              {preview.counts.apiKeys ? (
                <Badge variant="primary" size="sm">api keys: {preview.counts.apiKeys.create} re-issued</Badge>
              ) : null}
              {preview.counts.combos ? (
                <Badge variant="primary" size="sm">
                  combos: {preview.counts.combos.create} create / {preview.counts.combos.update} update / {preview.counts.combos.skip} skip
                </Badge>
              ) : null}
              {preview.counts.settings ? (
                <Badge variant="primary" size="sm">
                  settings: {preview.counts.settings.changed} change / {preview.counts.settings.skipped} skipped
                </Badge>
              ) : null}
            </div>

            {preview.notes?.length ? (
              <ul className="flex flex-col gap-1">
                {preview.notes.map((note) => (
                  <li key={note} className="flex items-start gap-2 text-xs text-text-muted">
                    <span className="material-symbols-outlined text-[14px] text-yellow-500">warning</span>
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            {connectionItems.length ? (
              <div className="flex flex-col">
                <label className="flex cursor-pointer select-none items-center gap-2 pb-1 text-xs text-text-muted">
                  <input
                    type="checkbox"
                    className="size-3.5 cursor-pointer accent-primary"
                    checked={allSelected}
                    onChange={toggleAllAccounts}
                    disabled={importing}
                  />
                  {selectedCount} of {connectionItems.length} accounts selected
                </label>
                <div className="flex flex-col divide-y divide-black/[0.04] dark:divide-white/[0.05]">
                  {connectionItems.map((item) => {
                    const checked = !deselected.has(item.key);
                    const subtitle = item.email && item.email !== item.name ? item.email : null;
                    return (
                      <label
                        key={item.key}
                        title={[item.name, item.email, item.reason].filter(Boolean).join(" — ") || undefined}
                        data-streamer-private-attributes
                        className={cn(
                          "flex cursor-pointer items-center gap-2 py-1.5",
                          !checked && "opacity-60"
                        )}
                      >
                        <input
                          type="checkbox"
                          className="size-3.5 shrink-0 cursor-pointer accent-primary"
                          checked={checked}
                          onChange={() => toggleAccount(item.key)}
                          disabled={importing}
                        />
                        {checked ? (
                          item.action ? (
                            <ActionBadge action={item.action} />
                          ) : (
                            <span className="text-[10px] font-semibold uppercase text-text-muted">pending</span>
                          )
                        ) : (
                          <span className="text-[10px] font-semibold uppercase text-text-muted">not selected</span>
                        )}
                        <span data-streamer-sensitive className="min-w-0 flex-1 truncate text-sm text-text-main">
                          {item.name || item.email || "(unnamed)"}
                        </span>
                        {subtitle ? (
                          <span data-streamer-sensitive className="hidden max-w-[16rem] truncate text-xs text-text-muted md:block">{subtitle}</span>
                        ) : null}
                        <Badge variant="default" size="sm">{item.provider || "unknown"}</Badge>
                        {item.authType ? (
                          <Badge variant="default" size="sm" className="hidden sm:inline-flex">{item.authType}</Badge>
                        ) : null}
                        {item.priority !== null && item.priority !== undefined ? (
                          <Badge variant="default" size="sm" className="hidden sm:inline-flex">priority {item.priority}</Badge>
                        ) : null}
                        <Badge variant={item.isActive ? "success" : "default"} size="sm">
                          {item.isActive ? "active" : "inactive"}
                        </Badge>
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {preview.truncated.connectionsPreview ? (
              <p className="text-xs text-text-muted">Showing the first 50 connections only.</p>
            ) : null}

            {preview.apiKeys.length ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium text-text-main">API keys</p>
                {preview.apiKeys.map((item) => (
                  <div key={item.key} className="flex flex-wrap items-center gap-2">
                    <ActionBadge action={item.action} />
                    <span className="text-sm text-text-main">{item.name}</span>
                    <span className="text-[11px] text-text-muted">{item.notes?.[0]}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {preview.combos.length ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium text-text-main">Combos</p>
                {preview.combos.map((item) => (
                  <div key={item.key} className="flex flex-wrap items-center gap-2">
                    <ActionBadge action={item.action} />
                    <span className="text-sm text-text-main">{item.name}</span>
                    {item.comboKind ? <Badge variant="default" size="sm">{item.comboKind}</Badge> : null}
                    <span className="text-[11px] text-text-muted">{item.models.length} model(s){item.reason ? ` — ${item.reason}` : ""}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {preview.settings ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium text-text-main">Settings</p>
                {preview.settings.changed.length ? (
                  <p className="text-xs text-text-muted">Will change: {preview.settings.changed.join(", ")}</p>
                ) : (
                  <p className="text-xs text-text-muted">Nothing to change.</p>
                )}
                {preview.settings.unchanged.length ? (
                  <p className="text-xs text-text-muted">Already identical: {preview.settings.unchanged.join(", ")}</p>
                ) : null}
                {preview.settings.skipped.length ? (
                  <p className="text-xs text-text-muted">
                    Not copied: {preview.settings.skipped.map((entry) => `${entry.key} (${entry.reason})`).join(", ")}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Button onClick={() => setConfirmOpen(true)} disabled={pendingCount === 0 || previewing || importing} icon="download">
                {importing ? "Importing…" : `Import ${pendingCount} item(s)`}
              </Button>
              <p className="text-xs text-text-muted">
                Existing accounts matched by the app&apos;s dedup rules are updated in place, never duplicated.
              </p>
            </div>
          </div>
        )}
      </Card>

      {results ? (
        <Card title="Results" subtitle="Per-item outcome of the last import" icon="task_alt">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-text-main">Connections</span>
                <ResultCounts counts={resultCounts?.connections} />
              </div>
              <div className="flex flex-col divide-y divide-black/[0.04] dark:divide-white/[0.05]">
                {results.connections.map((item) => (
                  <div key={item.key} className="flex flex-wrap items-center gap-2 py-2">
                    <ActionBadge action={item.status} />
                    <span data-streamer-sensitive className="text-sm text-text-main">{item.name || item.email || "(unnamed)"}</span>
                    <Badge variant="default" size="sm">{item.provider}</Badge>
                    <Badge variant="default" size="sm">{item.authType}</Badge>
                    {item.reason ? <span className="text-[11px] text-text-muted">{item.reason}</span> : null}
                  </div>
                ))}
              </div>
            </div>

            {results.apiKeys.length ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-text-main">API keys</span>
                  <ResultCounts counts={resultCounts?.apiKeys} />
                </div>
                {results.apiKeys.map((item) => (
                  <div key={item.key} className="flex flex-wrap items-center gap-2">
                    <ActionBadge action={item.status} />
                    <span className="text-sm text-text-main">{item.name}</span>
                    {item.keyMasked ? <span className="font-mono text-[11px] text-text-muted">new key {item.keyMasked}</span> : null}
                    <span className="text-[11px] text-text-muted">copy it from Endpoint &amp; Key</span>
                  </div>
                ))}
              </div>
            ) : null}

            {results.combos.length ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-text-main">Combos</span>
                  <ResultCounts counts={resultCounts?.combos} />
                </div>
                {results.combos.map((item) => (
                  <div key={item.key} className="flex flex-wrap items-center gap-2">
                    <ActionBadge action={item.status} />
                    <span className="text-sm text-text-main">{item.name}</span>
                    {item.reason ? <span className="text-[11px] text-text-muted">{item.reason}</span> : null}
                  </div>
                ))}
              </div>
            ) : null}

            {results.settings ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-text-main">Settings</span>
                  <ActionBadge action={results.settings.status === "updated" ? "updated" : results.settings.status === "failed" ? "failed" : "skipped"} />
                </div>
                {results.settings.changed?.length ? (
                  <p className="text-xs text-text-muted">Changed: {results.settings.changed.join(", ")}</p>
                ) : null}
                {results.settings.skipped?.length ? (
                  <p className="text-xs text-text-muted">
                    Not copied: {results.settings.skipped.map((entry) => entry.key).join(", ")}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={importNow}
        title={meta.confirmTitle}
        message={meta.confirmMessage(pendingCount)}
        confirmText="Import"
        cancelText="Cancel"
        variant="primary"
        loading={importing}
      />
    </>
  );
}

export default function ImportPage() {
  // Developer settings (Settings -> Developer) gates the dev-only section; the
  // API additionally reports whether this install may use it at all, so the
  // main instance stays unchanged even with the toggle on.
  const developerMode = useUIStore((s) => s.developerMode);
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:gap-6 sm:px-0">
      {developerMode ? <ImportSourcePanel sourceKey="main" /> : null}
      <ImportSourcePanel sourceKey="9router" />
    </div>
  );
}
