import { parseModel } from "open-sse/services/model.js";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import REGISTRY from "open-sse/providers/registry/index.js";

// DSH collapses Off to Default; unsupported SRouter-only levels are not declared.
export const DSH_REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
export const FALLBACK_REASONING_LEVELS = ["low", "medium", "high", "max"];
export const DSH_INPUT_MODALITIES = ["text", "image"];
const knownProviders = new Set(REGISTRY.map(entry => entry.id));

export function dshModelInput(modelId) {
  try {
    const { provider, model } = parseModel(String(modelId ?? "").trim());
    // The capability registry has a text-only floor even for unknown providers.
    // Do not turn that floor into a managed declaration for unresolved routes.
    if (!provider || !model || !knownProviders.has(provider)) return undefined;
    const caps = getCapabilitiesForModel(provider, model);
    if (caps.vision === true) return [...DSH_INPUT_MODALITIES];
    if (caps.vision === false) return ["text"];
    return undefined;
  } catch {
    // Unknown routes and registry failures leave Harness input metadata unmanaged.
    return undefined;
  }
}

export function dshModelVision(models) {
  return Object.fromEntries(models.flatMap(id => {
    const input = dshModelInput(id);
    return input ? [[id, input.includes("image")]] : [];
  }));
}

export function dshReasoningLevels(modelId) {
  try {
    const { provider, model } = parseModel(String(modelId ?? "").trim());
    if (!provider || !model) return FALLBACK_REASONING_LEVELS;
    const levels = getThinkingLevels(provider, model);
    if (levels === null) return false;
    if (!Array.isArray(levels)) return FALLBACK_REASONING_LEVELS;
    const supported = DSH_REASONING_LEVELS.filter(level => levels.includes(level));
    return supported.length ? supported : FALLBACK_REASONING_LEVELS;
  } catch {
    // Combo/alias resolution and registry failures must not block profile editing.
    return FALLBACK_REASONING_LEVELS;
  }
}

export function dshModelLevels(models) {
  return Object.fromEntries(models.map(id => [id, dshReasoningLevels(id)]));
}
