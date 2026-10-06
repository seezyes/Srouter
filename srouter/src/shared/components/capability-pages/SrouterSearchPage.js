"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Badge, Button, Card, Toggle } from "@/shared/components";
import { getWebProviders } from "@/shared/utils/webProviderCards";
import { DEFAULT_SROUTER_SEARCH, normalizeSrouterSearch } from "@/shared/utils/srouterSearchConfig";

const ConnectModal = dynamic(() => import("../SrouterSearchConnectModal"), { ssr: false });

export default function SrouterSearchPage() {
  const [config, setConfig] = useState({ ...DEFAULT_SROUTER_SEARCH });
  const [savedConfig, setSavedConfig] = useState({ ...DEFAULT_SROUTER_SEARCH });
  const [connectOpen, setConnectOpen] = useState(false);
  const [combos, setCombos] = useState([]);
  const [customNodes, setCustomNodes] = useState([]);
  const [origin, setOrigin] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetch("/api/settings", { cache: "no-store", signal: controller.signal }),
      fetch("/api/combos", { cache: "no-store", signal: controller.signal }),
      fetch("/api/provider-nodes", { cache: "no-store", signal: controller.signal }),
    ]).then(async ([settingsRes, combosRes, nodesRes]) => {
      if (!settingsRes.ok || !combosRes.ok) throw new Error("Could not load settings");
      const settings = await settingsRes.json();
      const comboData = await combosRes.json();
      const nodeData = nodesRes.ok ? await nodesRes.json() : { nodes: [] };
      if (controller.signal.aborted) return;
      setOrigin(window.location.origin);
      const loadedConfig = normalizeSrouterSearch(settings.srouterSearch);
      setConfig(loadedConfig);
      setSavedConfig(loadedConfig);
      setCombos(comboData.combos || []);
      setCustomNodes((nodeData.nodes || []).filter((node) => node.type === "custom-websearch"));
    }).catch(() => {
      if (!controller.signal.aborted) {
        setLoadError(true);
        setMessage("Could not load settings. Reload before saving.");
      }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  const update = (key, value) => {
    setConfig((current) => ({ ...current, [key]: value }));
    setMessage("");
  };
  const save = async () => {
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ srouterSearch: config }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Save failed");
      if (!data.srouterSearch) throw new Error("Server did not return saved MCP settings. Reload and try again.");
      const saved = normalizeSrouterSearch(data.srouterSearch);
      setConfig(saved);
      setSavedConfig(saved);
      setMessage("Settings saved.");
    } catch (error) { setMessage(error.message || "Save failed"); }
    finally { setSaving(false); }
  };
  // Custom web search provider nodes join the static catalog in the tool
  // target pickers (webSearch kind only).
  const providers = [
    ...customNodes.map((node) => ({ id: node.id, name: node.name, kinds: ["webSearch"] })),
    ...getWebProviders(),
  ];
  const targetPicker = (kind, key, label) => {
    const available = providers.filter((provider) => provider.kinds.includes(kind));
    const matchingCombos = combos.filter((combo) => combo.kind === kind);
    const known = new Set([...available.map((p) => p.id), ...matchingCombos.map((c) => c.name)]);
    return (
      <label className="flex flex-col gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <select value={config[key]} onChange={(event) => update(key, event.target.value)} disabled={loading || loadError || saving}
          className="rounded-lg border border-border bg-surface px-3 py-2">
          <option value="">Require provider in each tool call</option>
          {config[key] && !known.has(config[key]) && <option value={config[key]}>{config[key]} (unavailable)</option>}
          <optgroup label="Providers">{available.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>
          <optgroup label="Combos">{matchingCombos.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}</optgroup>
        </select>
      </label>
    );
  };
  const dirty = JSON.stringify(config) !== JSON.stringify(savedConfig);
  const disabled = loading || loadError || saving;
  const modelPicker = (key, label) => (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      <input value={config[key]} list="srouter-search-chat-combos" disabled={disabled}
        onChange={(event) => update(key, event.target.value)}
        placeholder="provider/model or chat combo"
        className="rounded-lg border border-border bg-surface px-3 py-2" />
    </label>
  );
  const toolPanels = [
    { name: "Web Search", tool: "srouter_web_search", key: "searchEnabled", icon: "search",
      description: "Find URLs, titles and snippets.",
      settings: targetPicker("webSearch", "searchProvider", "Default search provider / combo") },
    { name: "Web Fetch", tool: "srouter_web_fetch", key: "fetchEnabled", icon: "article",
      description: "Extract a clean page as text or Markdown.",
      settings: targetPicker("webFetch", "fetchProvider", "Default fetch provider / combo") },
    { name: "Fetch", tool: "srouter_fetch", key: "rawFetchEnabled", icon: "code",
      description: "Get raw page text / HTML. No cleaning or browser rendering.",
      settings: <p className="text-xs text-text-muted">Public GET only. No provider, custom headers or cookies. Requires Web Fetch access; provider-restricted keys must also allow the raw target <code>srouter-fetch</code>.</p> },
    { name: "Smart Search", tool: "srouter_smart_search", key: "smartEnabled", icon: "summarize",
      description: "Ask a model for a summary, with reasoning requested off.",
      settings: modelPicker("smartModel", "Default summary model / combo") },
    { name: "Deep Search", tool: "srouter_deep_search", key: "deepEnabled", icon: "psychology",
      description: "Ask a reasoning model or configured combo for a deeper answer.",
      settings: modelPicker("deepModel", "Default reasoning model / combo") },
  ];
  const selectedCount = toolPanels.filter((tool) => config[tool.key]).length;
  return (
    <div className="flex flex-col gap-4">
      <Link href="/dashboard/search" className="text-sm text-text-muted hover:text-primary">Back to Web Search</Link>
      <Card padding="sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Toggle label="Enable SrouterSearch MCP" checked={config.enabled} onChange={(value) => update("enabled", value)} disabled={disabled} />
            <Badge size="sm" variant={config.enabled ? "success" : "default"} dot>{config.enabled ? "Enabled" : "Disabled"}</Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setConnectOpen(true)} disabled={loading || loadError}>Connect</Button>
            <Button onClick={save} disabled={disabled || !dirty}>{saving ? "Saving..." : "Save settings"}</Button>
          </div>
        </div>
        <p className="mt-2 text-xs text-text-muted">{selectedCount} of 5 tools selected · Save, then reconnect your harness to refresh tools · Active SRouter API key required</p>
        {dirty && <p role="status" className="mt-2 text-sm text-text-muted"><span className="srouter-search-unsaved-wave">Unsaved changes. Click Save settings to apply.</span></p>}
        {message && <p role="status" className="mt-2 text-sm">{message}</p>}
      </Card>
      <div>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold">Tools exposed to your agent</h2>
          <span className="text-xs text-text-muted">Independent toggles. Deep Search alone is allowed.</span>
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {toolPanels.map((tool) => (
            <Card key={tool.tool} padding="sm">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span aria-hidden="true" className="material-symbols-outlined text-primary text-[20px]">{tool.icon}</span>
                  <h3 className="font-semibold">{tool.name}</h3>
                </div>
                <Toggle checked={config[tool.key]} onChange={(value) => update(tool.key, value)} disabled={disabled} aria-label={`Enable ${tool.name}`} />
              </div>
              <code className="mt-1 block text-xs text-primary">{tool.tool}</code>
              <p className="mt-2 text-sm text-text-muted">{tool.description}</p>
              <div className="mt-3 border-t border-border pt-3">{tool.settings}</div>
            </Card>
          ))}
        </div>
        <datalist id="srouter-search-chat-combos">
          {combos.filter((combo) => !combo.kind || combo.kind === "chat").map((combo) => <option key={combo.id} value={combo.name} />)}
        </datalist>
        <p className="mt-2 text-xs text-text-muted">Smart / Deep require Chat permissions. Reasoning controls depend on the chosen model and adapter. These tools do not add web retrieval or an agent loop. Research workflows belong in combos (planned).</p>
      </div>
      <Card padding="sm" title="Limits">
        <div className="grid gap-3 sm:grid-cols-3">
          {[["maxResults", "Search results", 1, 100], ["maxCharacters", "Fetch / Web Fetch characters", 1000, 200000], ["maxOutputTokens", "Smart / Deep output tokens", 256, 32768]].map(([key, label, min, max]) => (
            <label key={key} className="flex flex-col gap-1.5 text-sm">
              <span>{label}</span>
              <input type="number" min={min} max={max} value={config[key]} disabled={disabled}
                onChange={(event) => update(key, Number(event.target.value))}
                className="rounded-lg border border-border bg-surface px-3 py-2" />
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-text-muted">Raw Fetch: 20s timeout, 1 MiB response cap, text only. Deep needs at least 2048 output tokens. Provider-specific limits may be lower.</p>
      </Card>
      <p className="text-xs text-text-muted">Without MCP, a harness can call <code>POST /v1/search</code> and <code>POST /v1/web/fetch</code> directly. Use Connect above for MCP instructions.</p>
      {connectOpen && <ConnectModal origin={origin} dirty={dirty} enabled={savedConfig.enabled} onClose={() => setConnectOpen(false)} />}
    </div>
  );
}
