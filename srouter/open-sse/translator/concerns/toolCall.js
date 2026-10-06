// Tool call helper functions for translator

import { FORMATS } from "../formats.js";

// Anthropic tool_use.id must match: ^[a-zA-Z0-9_-]+$
const TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

// Anthropic allows 128 (^[a-zA-Z0-9_-]{1,128}$), but Gemini, Kiro, OpenAI and
// MCP all cap at 64 — so a client may send a name a legal Claude request rejects.
export const TOOL_NAME_MAX_LENGTH = 64;

// Never plain slice(0, n): two MCP tools sharing a prefix would collapse into one
// and the model would silently call the wrong tool. Same numeric-suffix scheme
// kiroConversation.uniqueName() already uses, so a retry keeps the same name and
// prompt caching still hits.
export function fitToolName(name, maxLength = TOOL_NAME_MAX_LENGTH, taken = new Set()) {
  if (typeof name !== "string" || !name) return name;
  if (name.length <= maxLength) return name;

  let suffix = 1;
  let candidate = name;
  do {
    const tail = `_${suffix++}`;
    candidate = `${name.slice(0, maxLength - tail.length)}${tail}`;
  } while (taken.has(candidate));
  return candidate;
}

// Fit tool names exceeding maxLength (default 64) and record reverse mapping.
// Updates body.tools, body.tool_choice, and body.messages / body.input history.
// Attaches or merges `_toolNameMap` (Map: fittedName -> originalName) on `body`.
export function ensureFittedToolNames(body, maxLength = TOOL_NAME_MAX_LENGTH) {
  if (!body || typeof body !== "object") return body;
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) return body;

  const toolNameMap = new Map();
  const fittedNames = new Map();
  const taken = new Set();

  for (const tool of tools) {
    const raw = tool?.function?.name || tool?.name;
    if (typeof raw === "string" && raw.length <= maxLength) {
      taken.add(raw);
    }
    // Gemini declarations share the same 64-char cap as OpenAI/Gemini/MCP, so
    // their names must occupy the uniqueness set too.
    for (const declaration of tool?.functionDeclarations || []) {
      if (typeof declaration?.name === "string" && declaration.name.length <= maxLength) {
        taken.add(declaration.name);
      }
    }
  }

  const fitHolder = (holder) => {
    const original = holder?.name;
    if (typeof original !== "string" || !original || original.length <= maxLength) return;
    const fitted = fitToolName(original, maxLength, taken);
    taken.add(fitted);
    toolNameMap.set(fitted, original);
    fittedNames.set(original, fitted);
    holder.name = fitted;
  };

  for (const tool of tools) {
    // Chat ({function:{name}}), flat ({name}) and Gemini declaration holders.
    if (tool?.function) fitHolder(tool.function);
    else fitHolder(tool);
    for (const declaration of tool?.functionDeclarations || []) fitHolder(declaration);
  }

  if (fittedNames.size === 0) return body;

  if (body.tool_choice && typeof body.tool_choice === "object") {
    if (body.tool_choice.function?.name && fittedNames.has(body.tool_choice.function.name)) {
      body.tool_choice.function.name = fittedNames.get(body.tool_choice.function.name);
    }
    if (body.tool_choice.name && fittedNames.has(body.tool_choice.name)) {
      body.tool_choice.name = fittedNames.get(body.tool_choice.name);
    }
  }

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (Array.isArray(msg?.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc?.function?.name && fittedNames.has(tc.function.name)) {
            tc.function.name = fittedNames.get(tc.function.name);
          }
        }
      }
      if (Array.isArray(msg?.content)) {
        for (const block of msg.content) {
          if (block?.type === "tool_use" && block.name && fittedNames.has(block.name)) {
            block.name = fittedNames.get(block.name);
          }
        }
      }
    }
  }

  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item?.type === "function_call" && item.name && fittedNames.has(item.name)) {
        item.name = fittedNames.get(item.name);
      }
    }
  }

  // Gemini history references the declaration by name in both directions; it has
  // to follow the fitted name or the provider sees a call to an undeclared tool.
  if (Array.isArray(body.contents)) {
    for (const content of body.contents) {
      for (const part of content?.parts || []) {
        for (const holder of [part?.functionCall, part?.functionResponse]) {
          if (holder && typeof holder.name === "string" && fittedNames.has(holder.name)) {
            holder.name = fittedNames.get(holder.name);
          }
        }
      }
    }
  }

  if (!body._toolNameMap) {
    body._toolNameMap = toolNameMap;
  } else {
    for (const [k, v] of toolNameMap) {
      body._toolNameMap.set(k, v);
    }
  }

  return body;
}

export function restoreToolName(stateOrData, name) {
  const raw = name || "";
  const map = stateOrData?.toolNameMap || stateOrData?._toolNameMap;
  return map && typeof map.get === "function" && map.has(raw) ? map.get(raw) : raw;
}

// Fallback streaming tool_call id when provider omits one (index optional)
export function fallbackToolCallId(index) {
  return index === undefined ? `call_${Date.now()}` : `call_${index}_${Date.now()}`;
}

// Generate deterministic tool call ID from position + tool name (cache-friendly)
export function generateToolCallId(msgIndex = 0, tcIndex = 0, toolName = "") {
  const name = toolName ? `_${toolName.replace(/[^a-zA-Z0-9_-]/g, "")}` : "";
  return `call_msg${msgIndex}_tc${tcIndex}${name}`;
}

// Sanitize ID to match Anthropic pattern: keep only alphanumeric, underscore, hyphen
function sanitizeToolId(id) {
  if (!id || typeof id !== "string") return null;
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "");
  return sanitized.length > 0 ? sanitized : null;
}

// Ensure all tool_calls have valid id field and arguments is string (some providers require it)
export function ensureToolCallIds(body) {
  if (!body.messages || !Array.isArray(body.messages)) return body;

  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    if (msg.role === "assistant" && msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (let j = 0; j < msg.tool_calls.length; j++) {
        const tc = msg.tool_calls[j];
        // Validate or regenerate ID for Anthropic compatibility
        if (!tc.id || !TOOL_ID_PATTERN.test(tc.id)) {
          const sanitized = sanitizeToolId(tc.id);
          tc.id = sanitized || generateToolCallId(i, j, tc.function?.name);
        }
        if (!tc.type) {
          tc.type = "function";
        }
        // Ensure arguments is JSON string, not object
        if (tc.function?.arguments && typeof tc.function.arguments !== "string") {
          tc.function.arguments = JSON.stringify(tc.function.arguments);
        }
      }
    }

    // Validate tool_call_id in tool messages (role: "tool")
    if (msg.role === "tool" && msg.tool_call_id && !TOOL_ID_PATTERN.test(msg.tool_call_id)) {
      const sanitized = sanitizeToolId(msg.tool_call_id);
      msg.tool_call_id = sanitized || generateToolCallId(i, 0);
    }

    // Also validate tool_use blocks in content (Claude format)
    if (Array.isArray(msg.content)) {
      for (let k = 0; k < msg.content.length; k++) {
        const block = msg.content[k];
        if (block.type === "tool_use" && block.id && !TOOL_ID_PATTERN.test(block.id)) {
          const sanitized = sanitizeToolId(block.id);
          block.id = sanitized || generateToolCallId(i, k, block.name);
        }
        // Validate tool_use_id in tool_result blocks
        if (block.type === "tool_result" && block.tool_use_id && !TOOL_ID_PATTERN.test(block.tool_use_id)) {
          const sanitized = sanitizeToolId(block.tool_use_id);
          block.tool_use_id = sanitized || generateToolCallId(i, k);
        }
      }
    }
  }

  return body;
}

// Get tool_call ids from assistant message (OpenAI format: tool_calls, Claude format: tool_use in content)
export function getToolCallIds(msg) {
  if (msg.role !== "assistant") return [];

  const ids = [];

  // OpenAI format: tool_calls array
  if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (tc.id) ids.push(tc.id);
    }
  }

  // Claude format: tool_use blocks in content
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.id) {
        ids.push(block.id);
      }
    }
  }

  return ids;
}

// Check if user message has tool_result for given ids (OpenAI format: role=tool, Claude format: tool_result in content)
export function hasToolResults(msg, toolCallIds) {
  if (!msg || !toolCallIds.length) return false;

  // OpenAI format: role = "tool" with tool_call_id
  if (msg.role === "tool" && msg.tool_call_id) {
    return toolCallIds.includes(msg.tool_call_id);
  }

  // Claude format: tool_result blocks in user message content
  if (msg.role === "user" && Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === "tool_result" && toolCallIds.includes(block.tool_use_id)) {
        return true;
      }
    }
  }

  return false;
}

// Fix missing tool responses - insert empty tool_result if assistant has tool_use but next message has no tool_result
export function fixMissingToolResponses(body) {
  if (!body.messages || !Array.isArray(body.messages)) return body;

  const newMessages = [];

  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    const nextMsg = body.messages[i + 1];

    newMessages.push(msg);

    // Check if this is assistant with tool_calls/tool_use
    const toolCallIds = getToolCallIds(msg);
    if (toolCallIds.length === 0) continue;

    // Check if next message has tool_result
    if (nextMsg && !hasToolResults(nextMsg, toolCallIds)) {
      // Insert tool responses for each tool_call
      for (const id of toolCallIds) {
        // OpenAI format: role = "tool"
        newMessages.push({
          role: "tool",
          tool_call_id: id,
          content: ""
        });
      }
    }
  }

  body.messages = newMessages;
  return body;
}

// Default `type: "custom"` on Claude-format tools that arrive without one.
// Anthropic's Claude tool schema requires `type` to be explicitly set; strict gateways
// (e.g., MiniMax Anthropic-compatible endpoint, error 2013) reject legacy payloads that
// omit it with HTTP 400. Tools that already carry a truthy `type` (e.g., `computer_use`,
// `bash`, `web_search_20250305`) are passed through untouched.
//
// Spread order matters: `{ ...tool, type: "custom" }` (spread first, override last)
// ensures that falsy `type` values (null, undefined, "") in the original tool don't
// overwrite the default. `{ type: "custom", ...tool }` would let `type: null` survive.
export function defaultClaudeToolType(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map(tool => tool?.type ? tool : { ...tool, type: "custom" });
}

// Whether Claude-format tools need explicit `type` defaulting before dispatch.
// Only gateways that declare the `requireClaudeToolType` quirk (MiniMax) reject typeless
// tools. Applying the default globally breaks Claude-format endpoints that only accept the
// legacy typeless tool shape — DeepSeek's Anthropic-compatible endpoint answers HTTP 400
// "unknown variant `custom`" and every Claude Code request routed there fails (#3905).
export function shouldDefaultClaudeToolType(provider, finalFormat, tools, PROVIDERS) {
  return (
    finalFormat === FORMATS.CLAUDE
    && Array.isArray(tools)
    && PROVIDERS?.[provider]?.quirks?.requireClaudeToolType === true
  );
}

