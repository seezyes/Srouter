"use client";

import { useState } from "react";
import Card from "./Card";
import Button from "./Button";
import Toggle from "./Toggle";
import CapacityBadges from "./CapacityBadges";
import { ModelSelectModal } from "./onDemandModals";
import { normalizeAdvisorModels as normalizeChain, visionAdvisorModelKey } from "@/shared/utils/visionAdvisorConfig";

const ADD_MODE = "add";
const REPLACE_MODE = "replace";

// Ordered advisor chain: #1 answers first, the rest are tried strictly in order.
function AdvisorChainTable({ chain, getCaps, disabled, emptyText, addLabel, onAdd, onReplace, onRemove, onMove }) {
  return (
    <div className="mt-2">
      {chain.length === 0 ? (
        <div className="rounded-lg border border-dashed border-black/10 px-3 py-3 text-center text-xs text-text-muted dark:border-white/10">
          {emptyText}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-black/5 dark:border-white/5">
          <div className="grid min-w-[320px] grid-cols-[2rem_minmax(0,1fr)_7rem] border-b border-black/5 px-3 py-1.5 text-[11px] text-text-muted dark:border-white/5">
            <span>#</span>
            <span>Model</span>
            <span className="text-center">Order</span>
          </div>
          {chain.map((model, index) => {
            const caps = getCaps?.(model);
            return (
              <div
                key={`${model}-${index}`}
                className="grid min-w-[320px] grid-cols-[2rem_minmax(0,1fr)_7rem] items-center border-b border-black/5 px-3 py-2 text-xs last:border-b-0 dark:border-white/5"
              >
                <span className="text-text-muted">#{index + 1}</span>
                <div className="flex min-w-0 items-center gap-1">
                  <code className="truncate" title={model}>{model}</code>
                  <CapacityBadges caps={caps} />
                  {index === 0 ? (
                    <span className="shrink-0 rounded bg-primary/10 px-1 py-px text-[9px] font-medium text-primary">primary</span>
                  ) : null}
                  {caps && caps.vision !== true ? (
                    <span className="shrink-0 text-[10px] text-red-500">no vision</span>
                  ) : null}
                </div>
                <div className="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => onReplace(index)}
                    disabled={disabled}
                    className="rounded p-0.5 text-text-muted hover:text-primary disabled:opacity-25"
                    title="Replace this model"
                    aria-label={`Replace ${model}`}
                  >
                    <span className="material-symbols-outlined text-[16px]">edit</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onMove(index, -1)}
                    disabled={disabled || index === 0}
                    className="rounded p-0.5 text-text-muted hover:text-primary disabled:opacity-25"
                    title="Move up"
                    aria-label={`Move ${model} up`}
                  >
                    <span className="material-symbols-outlined text-[16px]">arrow_upward</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onMove(index, 1)}
                    disabled={disabled || index === chain.length - 1}
                    className="rounded p-0.5 text-text-muted hover:text-primary disabled:opacity-25"
                    title="Move down"
                    aria-label={`Move ${model} down`}
                  >
                    <span className="material-symbols-outlined text-[16px]">arrow_downward</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove(index)}
                    disabled={disabled}
                    className="rounded p-0.5 text-text-muted hover:text-red-500 disabled:opacity-25"
                    title="Remove"
                    aria-label={`Remove ${model}`}
                  >
                    <span className="material-symbols-outlined text-[16px]">close</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <Button variant="ghost" size="sm" icon="add" className="mt-2" disabled={disabled} onClick={onAdd}>
        {addLabel}
      </Button>
    </div>
  );
}

export default function VisionAdvisorSection({ value, onChange, activeProviders, getCaps, disabled = false, error = "" }) {
  const enabled = !!value?.enabled;
  const globalChain = normalizeChain(value?.models);
  const overrides = value?.overrides && typeof value.overrides === "object" && !Array.isArray(value.overrides)
    ? value.overrides
    : {};
  const rules = Object.entries(overrides);

  const [globalPicker, setGlobalPicker] = useState(null); // { mode: "add" | "replace", index? }
  const [targetPickerOpen, setTargetPickerOpen] = useState(false);
  const [rulePicker, setRulePicker] = useState(null); // { target, mode: "add" | "replace", index? }
  const [selectionError, setSelectionError] = useState("");

  // The master toggle gates every chain; saving additionally locks all controls.
  const locked = disabled || !enabled;

  const patch = (p) => onChange({ enabled, models: globalChain, overrides, ...p });
  const patchRule = (target, chain) => patch({ overrides: { ...overrides, [target]: chain } });
  const dropRule = (target) => {
    const next = { ...overrides };
    delete next[target];
    patch({ overrides: next });
  };

  const handleGlobalSelect = (model) => {
    const picked = model?.value || model?.name || model;
    if (!picked || typeof picked !== "string") return;
    if (globalPicker?.mode === REPLACE_MODE) {
      const next = [...globalChain];
      next[globalPicker.index] = picked;
      patch({ models: next });
      setGlobalPicker(null);
      return;
    }
    patch({ models: [...globalChain, picked] });
    setGlobalPicker(null);
  };

  const handleGlobalRemove = (index) => patch({ models: globalChain.filter((_, i) => i !== index) });

  const handleGlobalMove = (index, delta) => {
    const to = index + delta;
    if (to < 0 || to >= globalChain.length) return;
    const next = [...globalChain];
    [next[index], next[to]] = [next[to], next[index]];
    patch({ models: next });
  };

  // A rule targets one concrete, non-vision, tools-capable provider/model.
  const validateTarget = (picked, key) => {
    if (!key || !picked.includes("/")) return "Pick a concrete provider/model — combos cannot have their own advisor rule.";
    const caps = getCaps?.(picked);
    if (caps?.vision === true) return "This model has vision, so it never uses the advisor. Pick a model without vision.";
    if (caps?.tools !== true) return "This model cannot call tools, so the advisor would never run. Pick a tools-capable model.";
    if (Object.hasOwn(overrides, key)) return "A rule for this model already exists below.";
    return "";
  };

  const handleTargetSelect = (model) => {
    setTargetPickerOpen(false);
    if (!model) return;
    const picked = model?.value || model?.name || model;
    if (!picked || typeof picked !== "string") return;
    const key = visionAdvisorModelKey(picked);
    const problem = validateTarget(picked, key);
    if (problem) {
      setSelectionError(problem);
      return;
    }
    setSelectionError("");
    // Start from the current global chain; edit or empty it for this model only.
    patch({ overrides: { ...overrides, [key]: [...globalChain] } });
  };

  const handleRuleSelect = (model) => {
    const picked = model?.value || model?.name || model;
    if (!picked || typeof picked !== "string" || !rulePicker) return;
    const chain = normalizeChain(overrides[rulePicker.target]);
    if (rulePicker.mode === REPLACE_MODE) {
      const next = [...chain];
      next[rulePicker.index] = picked;
      patchRule(rulePicker.target, next);
      setRulePicker(null);
      return;
    }
    patchRule(rulePicker.target, [...chain, picked]);
    setRulePicker(null);
  };

  const handleRuleMove = (target, chain, index, delta) => {
    const to = index + delta;
    if (to < 0 || to >= chain.length) return;
    const next = [...chain];
    [next[index], next[to]] = [next[to], next[index]];
    patchRule(target, next);
  };

  return (
    <Card padding="sm" className={locked ? "opacity-60" : undefined}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-text-muted">
            For image requests in Chat Completions, Responses, Anthropic Messages and Gemini:
            a model without vision may call a private vision tool, while the main model keeps answering.
            Models with vision never get the tool.
          </p>
        </div>
        <Toggle
          checked={enabled}
          onChange={(next) => { setSelectionError(""); patch({ enabled: next }); }}
          disabled={disabled}
          aria-label="Enable Vision Advisor"
        />
      </div>

      {error ? (
        <p role="alert" className="mt-3 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-500">
          {error}
        </p>
      ) : null}

      {/* Global chain */}
      <div className="mt-3 border-t border-black/5 pt-3 dark:border-white/5">
        <div className="min-w-0">
          <p className="text-xs font-medium text-text-main">Global chain</p>
          <p className="text-[11px] text-text-muted">
            The first model answers; the rest are tried in order when it fails, returns nothing, or errors.
          </p>
        </div>
        <AdvisorChainTable
          chain={globalChain}
          getCaps={getCaps}
          disabled={locked}
          emptyText={enabled
            ? "No advisor models — add a vision model, or configure a per-model rule below."
            : "No advisor models yet."}
          addLabel="Add advisor model"
          onAdd={() => { setSelectionError(""); setGlobalPicker({ mode: ADD_MODE }); }}
          onReplace={(index) => { setSelectionError(""); setGlobalPicker({ mode: REPLACE_MODE, index }); }}
          onRemove={handleGlobalRemove}
          onMove={handleGlobalMove}
        />
      </div>

      {/* Per-model rules */}
      <div className="mt-4 border-t border-black/5 pt-3 dark:border-white/5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-text-main">Per-model rules</p>
            <p className="text-[11px] text-text-muted">
              A rule replaces the global chain for one concrete model. An empty rule means no advisor for it;
              removing the rule returns the model to the global chain.
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            icon="add"
            disabled={locked}
            onClick={() => { setSelectionError(""); setTargetPickerOpen(true); }}
          >
            Add rule
          </Button>
        </div>

        {selectionError ? (
          <p role="alert" className="mt-2 text-xs text-red-500">{selectionError}</p>
        ) : null}

        {rules.length === 0 ? (
          <p className="mt-2 text-xs text-text-muted italic">No per-model rules — every model uses the global chain.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            {rules.map(([target, rawChain]) => {
              const chain = normalizeChain(rawChain);
              const sameAsGlobal = globalChain.length > 0 &&
                chain.length === globalChain.length && chain.every((m, i) => m === globalChain[i]);
              return (
                <div key={target} className="rounded-lg border border-black/5 bg-black/[0.015] p-3 dark:border-white/5 dark:bg-white/[0.02]">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="material-symbols-outlined text-[16px] text-text-muted">rule</span>
                        <code className="truncate font-mono text-xs font-medium text-text-main" title={target}>{target}</code>
                        <CapacityBadges caps={getCaps?.(target)} />
                      </div>
                      <p className="mt-0.5 text-[11px] text-text-muted">
                        {chain.length === 0
                          ? "No advisor for this model (explicitly disabled)."
                          : sameAsGlobal
                            ? "Same chain as the global one."
                            : "Replaces the global chain for this model."}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => dropRule(target)}
                      disabled={locked}
                      className="shrink-0 rounded p-0.5 text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:opacity-25"
                      title="Remove rule (inherit the global chain)"
                      aria-label={`Remove rule for ${target}`}
                    >
                      <span className="material-symbols-outlined text-[16px]">delete</span>
                    </button>
                  </div>
                  <AdvisorChainTable
                    chain={chain}
                    getCaps={getCaps}
                    disabled={locked}
                    emptyText="No advisor for this model. Add a vision model, or remove the rule to inherit the global chain."
                    addLabel="Add advisor model"
                    onAdd={() => setRulePicker({ target, mode: ADD_MODE })}
                    onReplace={(index) => setRulePicker({ target, mode: REPLACE_MODE, index })}
                    onRemove={(index) => patchRule(target, chain.filter((_, i) => i !== index))}
                    onMove={(index, delta) => handleRuleMove(target, chain, index, delta)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {globalPicker ? (
        <ModelSelectModal
          isOpen
          onClose={() => setGlobalPicker(null)}
          onSelect={handleGlobalSelect}
          activeProviders={activeProviders}
          title={globalPicker.mode === REPLACE_MODE ? "Replace advisor model" : "Add advisor model"}
          capFilter="vision"
          addedModelValues={globalChain}
          closeOnSelect
        />
      ) : null}

      {targetPickerOpen ? (
        <ModelSelectModal
          isOpen
          onClose={() => setTargetPickerOpen(false)}
          onSelect={handleTargetSelect}
          activeProviders={activeProviders}
          title="Add rule — pick the main model"
          capFilter="tools"
          addedModelValues={rules.map(([target]) => target)}
          closeOnSelect
        />
      ) : null}

      {rulePicker ? (
        <ModelSelectModal
          isOpen
          onClose={() => setRulePicker(null)}
          onSelect={handleRuleSelect}
          activeProviders={activeProviders}
          title={`${rulePicker.mode === REPLACE_MODE ? "Replace" : "Add"} advisor for ${rulePicker.target}`}
          capFilter="vision"
          addedModelValues={normalizeChain(overrides[rulePicker.target])}
          closeOnSelect
        />
      ) : null}
    </Card>
  );
}
