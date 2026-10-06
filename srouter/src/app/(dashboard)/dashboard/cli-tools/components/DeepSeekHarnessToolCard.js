"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, Button, ManualConfigModal } from "@/shared/components";
import { ModelSelectModal } from "@/shared/components/onDemandModals";
import Image from "next/image";
import ApiKeySelect from "./ApiKeySelect";

const ENDPOINT = "/api/cli-tools/deepseek-harness-settings";

// Declaring the levels is what makes the Effort control in DSH switch. The set
// is per model and comes from the Srouter registry (the GET payload's
// `modelLevels`), so a model that supports `xhigh` declares it while a narrow
// model declares only its own levels. DSH has no true Off: its adapter maps the
// Off level to "no reasoning option", exactly like Default, so `off` is never
// declared. `false` marks a non-reasoning model and declares no nested levels
// at all. A model the registry does not know yet (or an empty level list)
// keeps the conservative fallback set as a hint for manual edits.
const FALLBACK_REASONING_LEVELS = ["low", "medium", "high", "max"];

// Exported for the unit tests; not part of the component's public API.
export function reasoningEffortsLines(levels) {
  if (levels === false) return "            reasoningEfforts: false";
  const keys = Array.isArray(levels) && levels.length > 0 ? levels : FALLBACK_REASONING_LEVELS;
  return ["            reasoningEfforts:", ...keys.map((key) => `              ${key}: ${key}`)].join("\n");
}

// Vision is declared per model the same way the server writer does: an `input`
// line follows `- id:` and is only emitted for a model the registry resolves
// (the GET payload's `modelVision`), so a combo or alias keeps no input line.
// Exported for the unit tests; not part of the component's public API.
export function buildModelLines(models, modelLevels = {}, modelVision = {}) {
  if (!models.length) return `          - id: <model-or-combo-id>\n${reasoningEffortsLines()}`;
  return models
    .map((model) => {
      const vision = modelVision?.[model];
      const inputLine = typeof vision === "boolean" ? `\n            input: [${vision ? "text, image" : "text"}]` : "";
      return `          - id: ${model}${inputLine}\n${reasoningEffortsLines(modelLevels?.[model])}`;
    })
    .join("\n");
}

// Our provider's protocol from the GET payload, shown read-only next to
// Endpoint and used for the manual snippet's `api:` line. Unknown values stay
// raw instead of being guessed.
const PROTOCOL_LABELS = {
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
};

export default function DeepSeekHarnessToolCard({
  tool,
  isExpanded,
  onToggle,
  baseUrl,
  apiKeys,
  activeProviders = [],
  cloudEnabled = false,
}) {
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(true);
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState(null);
  const [apiKeyChoice, setApiKeyChoice] = useState(null);
  const [modelChoice, setModelChoice] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [showManualConfigModal, setShowManualConfigModal] = useState(false);
  const [applied, setApplied] = useState(false);
  const hasFetched = useRef(false);

  // Derive the defaults from props/status instead of syncing them in an effect.
  // `null` means "untouched by the user".
  const selectedApiKey = apiKeyChoice ?? apiKeys?.[0]?.key ?? "";
  const selectedModels = modelChoice ?? status?.models ?? [];
  const installed = Boolean(status?.installed);
  const hasSrouter = Boolean(status?.hasSrouter);
  const foreignRoute = Boolean(status?.foreignRoute);
  // A missing `models` array means an older server build returned no list at
  // all, not that the configuration is empty; `models: []` stays the empty state.
  const modelsUnreadable = modelChoice === null && !Array.isArray(status?.models);
  // An unparsable patch file makes both apply and reset return a conflict.
  const configUnsafe = status?.configReadable === false;
  // Only our own provider with a readable, non-empty model list can declare levels.
  const levelsMissing = hasSrouter && status?.levelsDeclared === false && status.models?.length > 0;
  // The patch file's protocol; a missing `api` means our default protocol.
  const protocolLabel = PROTOCOL_LABELS[status?.api] || status?.api || "OpenAI Chat Completions";
  // Reordering/removing a model is a local edit only, but it stays blocked in
  // the same states that block Apply and while a request is in flight.
  const modelsLocked = foreignRoute || modelsUnreadable || configUnsafe || applying || restoring;

  const checkStatus = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch(ENDPOINT);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to check DeepSeek Harness settings");
      setStatus(data);
    } catch (error) {
      console.log("Error checking DeepSeek Harness status:", error);
      setStatus({ installed: false, error: error.message });
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    // Fetch on mount and whenever the card is (re)expanded; skip the collapse itself.
    if (!isExpanded && hasFetched.current) return;
    hasFetched.current = true;
    checkStatus();
  }, [isExpanded, checkStatus]);

  const normalizeLocalhost = (url) => url.replace("://localhost", "://127.0.0.1");

  const getLocalBaseUrl = () => {
    if (typeof window !== "undefined") {
      return normalizeLocalhost(window.location.origin);
    }
    return baseUrl || "http://127.0.0.1:20127";
  };

  const getEffectiveBaseUrl = () => {
    const url = getLocalBaseUrl();
    return url.endsWith("/v1") ? url : `${url}/v1`;
  };

  // The modal hands back a full model object on pick and a raw id on row removal.
  const modelValue = (model) => model?.value || model?.name || model;

  const handleModelSelect = (model) => {
    const value = modelValue(model);
    if (!value || selectedModels.includes(value)) return;
    setModelChoice([...selectedModels, value]);
  };

  const handleModelDeselect = (model) => {
    const value = modelValue(model);
    if (!value) return;
    setModelChoice(selectedModels.filter((item) => item !== value));
  };

  // Swap two neighbours in the selection; the order of this array is the order
  // the model list is written to the patch file in.
  const handleModelMove = (index, direction) => {
    const target = index + direction;
    if (target < 0 || target >= selectedModels.length) return;
    const next = [...selectedModels];
    [next[index], next[target]] = [next[target], next[index]];
    setModelChoice(next);
  };

  // Compact trait line for a model row. Only data the server actually reports
  // is shown: no key means "unknown" and renders nothing at all.
  const modelTraits = (model) => {
    const traits = [];
    const vision = status?.modelVision?.[model];
    if (typeof vision === "boolean") traits.push(vision ? "vision" : "no vision");
    const levels = status?.modelLevels?.[model];
    if (levels === false) traits.push("no reasoning");
    else if (Array.isArray(levels) && levels.length > 0) traits.push(`effort ${levels.join("/")}`);
    return traits;
  };

  const handleApply = async () => {
    if (selectedModels.length === 0) {
      setMessage({ type: "error", text: "Choose at least one model first." });
      return;
    }
    setApplying(true);
    setMessage(null);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: getEffectiveBaseUrl(),
          apiKey: selectedApiKey?.trim() || undefined,
          models: selectedModels,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: data.message || "Srouter was added to DeepSeek Harness." });
        setApplied(true);
        checkStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to add Srouter to DeepSeek Harness" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setApplying(false);
    }
  };

  const handleReset = async () => {
    setRestoring(true);
    setMessage(null);
    try {
      const res = await fetch(ENDPOINT, { method: "DELETE" });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: data.message || "Srouter settings were removed from DeepSeek Harness." });
        setApplied(false);
        checkStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to remove Srouter settings" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setRestoring(false);
    }
  };

  const getManualConfigs = () => {
    const keyToUse = selectedApiKey.trim() || "<SROUTER_API_KEY>";
    const profile = status?.profile || "desktop";

    const credentialsContent = `version: 1
refs:
  SROUTER_API_KEY: '${keyToUse}'
`;

    // Each selected model declares the levels and the input modalities the
    // Srouter registry reports for it; a model with no registry data yet keeps
    // the fallback levels and no `input` line.
    const modelLines = buildModelLines(selectedModels, status?.modelLevels, status?.modelVision);

    const providerContent = `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      srouter:
        displayName: Srouter
        apiKeyEnv: SROUTER_API_KEY
        api: ${status?.api || "openai-completions"}
        baseURL: ${getEffectiveBaseUrl()}
        models:
${modelLines}
`;

    return [
      { filename: "~/.dsh/.credentials.yaml", content: credentialsContent },
      {
        filename: `~/.dsh/profiles/${profile}/cordis.patch.yml`,
        content: providerContent,
        // A second `llm-pi-ai` entry makes the whole patch file unreadable.
        note: "If an `llm-pi-ai` entry already exists, replace it instead of adding a second one.",
      },
    ];
  };

  return (
    <Card padding="xs" className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 hover:cursor-pointer sm:items-center" onClick={onToggle}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-8 flex items-center justify-center shrink-0">
            <Image src={tool.image || "/providers/deepseek-harness.png"} alt={tool.name} width={32} height={32} className="size-8 object-contain rounded-lg" sizes="32px" onError={(e) => { e.target.style.display = "none"; }} loading="lazy" decoding="async" />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="font-medium text-sm">{tool.name}</h3>
              {installed && hasSrouter && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-500/10 text-green-600 dark:text-green-400 rounded-full">Configured</span>}
              {installed && !hasSrouter && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 rounded-full">Not configured</span>}
            </div>
            <p className="text-xs text-text-muted truncate">{tool.description}</p>
          </div>
        </div>
        <span className={`material-symbols-outlined text-text-muted text-[20px] transition-transform ${isExpanded ? "rotate-180" : ""}`}>expand_more</span>
      </div>

      {isExpanded && (
        <div className="mt-4 pt-4 border-t border-border flex flex-col gap-4">
          {checking && (
            <div className="flex items-center gap-2 text-text-muted">
              <span className="material-symbols-outlined animate-spin">progress_activity</span>
              <span>Checking DeepSeek Harness...</span>
            </div>
          )}

          {!checking && status && !installed && (
            <div className="flex flex-col gap-3 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-yellow-500">warning</span>
                <div className="flex-1">
                  <p className="font-medium text-yellow-600 dark:text-yellow-400">DeepSeek Harness not detected on this machine</p>
                  <p className="text-sm text-text-muted mt-1">You can still copy the configuration below.</p>
                </div>
              </div>
              <div className="flex items-center gap-2 pl-9">
                <Button variant="secondary" size="sm" onClick={() => setShowManualConfigModal(true)} className="!bg-yellow-500/20 !border-yellow-500/40 !text-yellow-700 dark:!text-yellow-300 hover:!bg-yellow-500/30">
                  <span className="material-symbols-outlined text-[18px] mr-1">content_copy</span>
                  Manual Config
                </Button>
              </div>
            </div>
          )}

          {!checking && installed && (
            <>
              <div className="flex flex-col gap-2">
                {foreignRoute && (
                  <div className="flex items-start gap-2 p-2 rounded text-xs bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
                    <span className="material-symbols-outlined text-[14px] mt-0.5">warning</span>
                    <span>{"A different 'srouter' provider already exists in DeepSeek Harness. Rename or remove it there first; Srouter will not overwrite it."}</span>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Endpoint</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <span className="min-w-0 truncate rounded bg-surface/40 px-2 py-2 text-xs text-text-muted sm:py-1.5">{getEffectiveBaseUrl()}</span>
                </div>

                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Protocol</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <span className="min-w-0 truncate rounded bg-surface/40 px-2 py-2 text-xs text-text-muted sm:py-1.5">{protocolLabel}</span>
                </div>

                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">API Key</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <ApiKeySelect value={selectedApiKey} onChange={setApiKeyChoice} apiKeys={apiKeys} cloudEnabled={cloudEnabled} />
                </div>

                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Models</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <div className="flex min-w-0 flex-col gap-1">
                    {modelsUnreadable ? (
                      <span className="text-xs text-text-muted">The server returned no model list. Reload once the app server is updated.</span>
                    ) : selectedModels.length === 0 ? (
                      <span className="text-xs text-text-muted">No models selected yet</span>
                    ) : (
                      selectedModels.map((model, index) => {
                        const traits = modelTraits(model);
                        const upDisabled = modelsLocked || index === 0;
                        const downDisabled = modelsLocked || index === selectedModels.length - 1;
                        return (
                          <div key={model} className="group flex min-w-0 items-center gap-1.5 rounded-md bg-black/[0.02] px-2 py-1 transition-colors hover:bg-black/[0.04] dark:bg-white/[0.02] dark:hover:bg-white/[0.04]">
                            <span className="w-3 shrink-0 text-center text-[10px] font-medium text-text-muted">{index + 1}</span>
                            <div className="min-w-0 flex-1">
                              <div className="truncate rounded px-1.5 py-0.5 font-mono text-xs text-text-main" title={model}>{model}</div>
                              {traits.length > 0 && <div className="truncate px-1.5 text-[10px] text-text-muted">{traits.join(" · ")}</div>}
                            </div>
                            <div className="flex shrink-0 items-center gap-0.5">
                              <button
                                type="button"
                                onClick={() => handleModelMove(index, -1)}
                                disabled={upDisabled}
                                title="Move up"
                                className={`rounded p-0.5 ${upDisabled ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"}`}
                              >
                                <span className="material-symbols-outlined text-[12px]">arrow_upward</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => handleModelMove(index, 1)}
                                disabled={downDisabled}
                                title="Move down"
                                className={`rounded p-0.5 ${downDisabled ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"}`}
                              >
                                <span className="material-symbols-outlined text-[12px]">arrow_downward</span>
                              </button>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleModelDeselect(model)}
                              disabled={modelsLocked}
                              title={`Remove ${model}`}
                              className={`shrink-0 rounded p-0.5 transition-colors ${modelsLocked ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:bg-red-500/10 hover:text-red-500"}`}
                            >
                              <span className="material-symbols-outlined text-[12px]">close</span>
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setModalOpen(true)}
                    className="w-full rounded border border-border bg-surface px-2 py-2 text-xs text-text-main transition-colors hover:border-primary sm:w-auto sm:py-1.5 sm:shrink-0"
                  >
                    Select
                  </button>
                </div>
              </div>

              {message && (
                <div className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${message.type === "success" ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"}`}>
                  <span className="material-symbols-outlined text-[14px]">{message.type === "success" ? "check_circle" : "error"}</span>
                  <span>{message.text}</span>
                </div>
              )}

              {configUnsafe && (
                <p className="text-xs text-yellow-600 dark:text-yellow-400">DeepSeek Harness configuration cannot be read safely. Fix or remove the file before applying.</p>
              )}

              {levelsMissing && (
                <p className="text-xs text-yellow-600 dark:text-yellow-400">Some Srouter models declare no Effort levels. Press Add to DeepSeek Harness to declare them.</p>
              )}

              <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center">
                <Button variant="primary" size="sm" onClick={handleApply} disabled={foreignRoute || modelsUnreadable || configUnsafe} loading={applying}>
                  <span className="material-symbols-outlined text-[14px] mr-1">add</span>Add to DeepSeek Harness
                </Button>
                <Button variant="outline" size="sm" onClick={handleReset} disabled={!hasSrouter || foreignRoute || configUnsafe} loading={restoring}>
                  <span className="material-symbols-outlined text-[14px] mr-1">restore</span>Reset
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowManualConfigModal(true)}>
                  <span className="material-symbols-outlined text-[14px] mr-1">content_copy</span>Manual Config
                </Button>
              </div>

              {applied && (
                <p className="text-xs text-text-muted">{"Restart DeepSeek Harness to see the Srouter provider and its models in Settings → Models."}</p>
              )}
            </>
          )}
        </div>
      )}

      <ManualConfigModal
        isOpen={showManualConfigModal}
        onClose={() => setShowManualConfigModal(false)}
        title="DeepSeek Harness - Manual Configuration"
        configs={getManualConfigs()}
      />

      {modalOpen && (
        <ModelSelectModal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          onSelect={handleModelSelect}
          onDeselect={handleModelDeselect}
          activeProviders={activeProviders}
          title="Select models for DeepSeek Harness"
          closeOnSelect={false}
          addedModelValues={selectedModels}
        />
      )}
    </Card>
  );
}
