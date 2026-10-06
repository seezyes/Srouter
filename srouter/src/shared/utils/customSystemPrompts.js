import { resolveProviderAlias } from "open-sse/services/model.js";

export const CUSTOM_SYSTEM_PROMPT_LIMITS = Object.freeze({
  prompts: 64, id: 128, name: 120, text: 32768,
  totalText: 262144, models: 256, model: 512,
});

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function customSystemPromptModelKey(value) {
  if (typeof value !== "string") return "";
  const key = value.trim();
  const slash = key.indexOf("/");
  if (slash < 1 || slash === key.length - 1 || /\s/.test(key)) return "";
  return `${resolveProviderAlias(key.slice(0, slash))}/${key.slice(slash + 1)}`;
}

// Error messages identify fields, never echo prompt contents.
export function validateCustomSystemPrompts(value) {
  const limits = CUSTOM_SYSTEM_PROMPT_LIMITS;
  if (!isRecord(value)) return "customSystemPrompts must be an object";
  if (Object.keys(value).some((key) => !["enabled", "prompts"].includes(key))) return "Unknown customSystemPrompts field";
  if (typeof value.enabled !== "boolean") return "customSystemPrompts.enabled must be boolean";
  if (!Array.isArray(value.prompts) || value.prompts.length > limits.prompts) return `customSystemPrompts.prompts must contain at most ${limits.prompts} entries`;
  const ids = new Set();
  let totalText = 0;
  for (const [index, entry] of value.prompts.entries()) {
    const prefix = `customSystemPrompts.prompts[${index}]`;
    if (!isRecord(entry)) return `${prefix} must be an object`;
    if (Object.keys(entry).some((key) => !["id", "name", "text", "enabled", "mode", "scope", "models"].includes(key))) return `${prefix} has an unknown field`;
    if (typeof entry.id !== "string" || !entry.id.trim() || entry.id.length > limits.id || ids.has(entry.id.trim())) return `${prefix}.id must be nonempty, bounded and unique`;
    ids.add(entry.id.trim());
    if (typeof entry.name !== "string" || entry.name.length > limits.name) return `${prefix}.name must be a string of at most ${limits.name} characters`;
    if (typeof entry.text !== "string" || entry.text.length > limits.text) return `${prefix}.text must be a string of at most ${limits.text} characters`;
    totalText += entry.text.length;
    if (totalText > limits.totalText) return "customSystemPrompts exceeds total text limit";
    if (typeof entry.enabled !== "boolean") return `${prefix}.enabled must be boolean`;
    if (!["append", "replace"].includes(entry.mode)) return `${prefix}.mode must be append or replace`;
    if (!["all", "models"].includes(entry.scope)) return `${prefix}.scope must be all or models`;
    if (!Array.isArray(entry.models) || entry.models.length > limits.models) return `${prefix}.models must contain at most ${limits.models} targets`;
    if (entry.models.some((model) => typeof model !== "string" || model.length > limits.model || !customSystemPromptModelKey(model))) return `${prefix}.models must contain provider/model targets`;
  }
  return null;
}

// Corrupt/legacy stored data fails closed; writes are validated before normalization.
export function normalizeCustomSystemPrompts(value) {
  if (validateCustomSystemPrompts(value)) return { enabled: false, prompts: [] };
  return {
    enabled: value.enabled,
    prompts: value.prompts.map((entry) => ({
      id: entry.id.trim(), name: entry.name, text: entry.text,
      enabled: entry.enabled, mode: entry.mode, scope: entry.scope,
      models: [...new Set(entry.models.map(customSystemPromptModelKey))],
    })),
  };
}
