import { normalizeCustomSystemPrompts, customSystemPromptModelKey } from "@/shared/utils/customSystemPrompts.js";
import { FORMATS } from "open-sse/translator/formats.js";
import { ROLE, CLAUDE_BLOCK, RESPONSES_ITEM } from "open-sse/translator/schema/index.js";

const isInstruction = (item) => item?.role === ROLE.SYSTEM || item?.role === ROLE.DEVELOPER;

export function createPrivatePromptLogger() {
  return Object.fromEntries([
    "logClientRawRequest", "logRawRequest", "logOpenAIRequest", "logTargetRequest",
    "logProviderResponse", "appendProviderChunk", "appendOpenAIChunk",
    "logConvertedResponse", "appendConvertedChunk", "logError",
  ].map((key) => [key, () => {}]));
}

export function matchingCustomSystemPrompts(config, provider, model) {
  const normalized = normalizeCustomSystemPrompts(config);
  if (!normalized.enabled) return [];
  const target = customSystemPromptModelKey(`${provider}/${model}`);
  return normalized.prompts.filter((entry) =>
    entry.enabled && (entry.scope === "all" || entry.models.includes(target))
  );
}

/**
 * Source-format only, once per fresh attempt. Never changes the caller's history.
 * A disabled/nonmatching configuration returns the exact original object.
 */
export function applyCustomSystemPrompts(body, entries, format) {
  if (!entries.length) return body;
  const result = structuredClone(body);
  const wrappedGemini = [FORMATS.GEMINI_CLI, FORMATS.ANTIGRAVITY].includes(format);
  const native = wrappedGemini ? (result.request || result) : result;
  const gemini = wrappedGemini || format === FORMATS.GEMINI || format === FORMATS.VERTEX;
  for (const entry of entries) {
    if (entry.mode === "replace") {
      delete native.system;
      delete native.instructions;
      delete native.systemInstruction;
      delete native.system_instruction;
      if (Array.isArray(native.messages)) native.messages = native.messages.filter((item) => !isInstruction(item));
      if (Array.isArray(native.input)) native.input = native.input.filter((item) => !isInstruction(item));
    }
    if (format === FORMATS.CLAUDE) {
      const existing = typeof result.system === "string"
        ? [{ type: CLAUDE_BLOCK.TEXT, text: result.system }]
        : Array.isArray(result.system) ? result.system : [];
      result.system = [...existing, { type: CLAUDE_BLOCK.TEXT, text: entry.text }];
    } else if (format === FORMATS.OPENAI_RESPONSES || (!Array.isArray(result.messages) && result.input !== undefined)) {
      // Top-level instructions precede input history; retaining input items is
      // essential for tools and encrypted reasoning continuity.
      const last = Array.isArray(result.input) ? result.input.findLastIndex(isInstruction) : -1;
      if (last >= 0) {
        result.input.splice(last + 1, 0, {
          type: RESPONSES_ITEM.MESSAGE, role: ROLE.SYSTEM,
          content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: entry.text }],
        });
      } else {
        result.instructions = result.instructions
          ? `${result.instructions}\n\n${entry.text}` : entry.text;
      }
    } else if (gemini) {
      const instruction = native.systemInstruction || native.system_instruction || {};
      native.systemInstruction = {
        ...instruction, parts: [...(instruction.parts || []), { text: entry.text }],
      };
      delete native.system_instruction;
    } else {
      const messages = Array.isArray(result.messages) ? result.messages : [];
      // Place the appended system instruction after existing instruction
      // messages, but before conversational/tool history.
      const last = messages.findLastIndex(isInstruction);
      result.messages = [...messages.slice(0, last + 1),
        { role: ROLE.SYSTEM, content: entry.text }, ...messages.slice(last + 1)];
    }
  }
  return result;
}
