/**
 * Native Kimi tool-call markup parser.
 *
 * Kimi K2.6/K2.7 (served through Kimchi / Cast AI / NVIDIA NIM) occasionally
 * leaks its native token-based tool-call format into the OpenAI `content` field
 * instead of populating the structured `tool_calls` array. This module detects
 * that markup and extracts normalized OpenAI-style tool_calls.
 *
 * Observed raw markup shape:
 *
 *   <optional prose / whitespace>functions.NAME:ID {"arg": "value"}functions.NAME:ID {"arg": "value"}
 *
 * Where:
 *   - `functions.` is the literal prefix.
 *   - `NAME` is the tool name (the prefix is stripped: `functions.foo` → `foo`).
 *   - `:ID` is an optional call identifier (e.g. `:0`).
 *   - The argument block is a JSON object.
 *
 * The parser is intentionally conservative: it only extracts tool calls when the
 * content matches the native Kimi pattern. It returns the original content when
 * no markup is found, and never throws for malformed input.
 */

// The token sequence Kimi emits before each tool call. In upstream responses
// this is the literal string "functions." preceded by the control tokens.
const KIMI_TOOL_PREFIX = "functions.";

/**
 * Models that serve native Kimi tool markup (Kimi K2.6 / K2.7 through Kimchi and
 * NVIDIA NIM). Shared by the streaming/non-streaming handlers so all three call
 * sites select the same models.
 */
export const KIMI_MODEL_RE = /kimi-k2\./i;

/**
 * Literal marker that starts every native Kimi tool call. Exported for the
 * streaming content gate, which must hold a partial marker split across deltas.
 */
export const KIMI_TOOL_MARKER = KIMI_TOOL_PREFIX;

// Maximum recursion / iteration guard for malformed payloads.
const MAX_CALLS = 64;

/**
 * Detect whether a string contains native Kimi tool-call markup.
 *
 * @param {string|null|undefined} content
 * @returns {boolean}
 */
export function hasKimiToolMarkup(content) {
  if (typeof content !== "string" || content.length === 0) return false;
  return content.includes(KIMI_TOOL_PREFIX);
}

/**
 * Split content into a leading prose portion and the raw tool-call tail.
 *
 * Everything from the first "functions." occurrence onward is considered the
 * tool-call region. Leading whitespace is trimmed; if the leading prose is empty
 * the result is an empty string.
 *
 * @param {string} content
 * @returns {{ prefix: string, tail: string }}
 */
export function splitKimiToolRegion(content) {
  const idx = content.indexOf(KIMI_TOOL_PREFIX);
  if (idx === -1) return { prefix: content, tail: "" };
  return {
    prefix: content.slice(0, idx).trim(),
    tail: content.slice(idx),
  };
}

/**
 * Parse a single Kimi tool-call fragment of the form `NAME:ID {JSON}` or
 * `NAME {JSON}`.
 *
 * Returns null if the fragment cannot be parsed. The returned object matches
 * the OpenAI tool_calls item shape:
 *
 *   {
 *     id: string,
 *     type: "function",
 *     function: { name: string, arguments: string }
 *   }
 *
 * @param {string} raw
 * @param {number} index
 * @returns {{id: string, type: "function", function: {name: string, arguments: string}}|null}
 */
export function parseKimiToolCallFragment(raw, index) {
  if (typeof raw !== "string" || raw.length === 0) return null;

  // Find the JSON object: it starts with the first '{' and ends at the
  // matching '}'. We avoid naive regex parsing so nested objects and quoted
  // braces are handled correctly.
  const jsonStart = raw.indexOf("{");
  if (jsonStart === -1) return null;

  const header = raw.slice(0, jsonStart).trim();
  const argsRaw = raw.slice(jsonStart);

  // Header is either "NAME" or "NAME:ID". The "functions." prefix has already
  // been stripped by extractKimiToolCalls, so NAME is the bare tool name.
  const headerMatch = header.match(/^([a-zA-Z0-9_\-/.]+)(?::([a-zA-Z0-9_\-]+))?$/);
  if (!headerMatch) return null;

  const name = headerMatch[1];
  const providedId = headerMatch[2];

  let args;
  try {
    args = parseJsonObject(argsRaw);
  } catch {
    return null;
  }

  const id = providedId ? `functions.${name}:${providedId}` : `functions.${name}:${index}`;

  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

/**
 * Parse a balanced JSON object from the start of a string.
 *
 * Scans character-by-character, respecting string escaping and nested braces.
 * Accepts nested objects/arrays and numeric object keys unchanged; callers
 * stringify the parsed value as-is so an unexpected array/primitive shape
 * cannot throw.
 *
 * @param {string} text
 * @returns {object}
 */
export function parseJsonObject(text) {
  const end = scanJsonObjectEnd(text);
  if (end === -1) throw new Error("unbalanced JSON object");
  return JSON.parse(text.slice(0, end));
}

/**
 * Index just past the first balanced JSON object in `text`, or -1 when the
 * object is still incomplete. Shared by parseJsonObject() and
 * parseKimiToolRegion() so the brace/string scan exists once.
 *
 * @param {string} text
 * @returns {number}
 */
function scanJsonObjectEnd(text) {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth++;
      continue;
    }

    if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
      continue;
    }
  }

  return -1;
}

/**
 * Parse the leading run of native Kimi tool calls in `text`.
 *
 * Unlike extractKimiToolCalls(), this reports WHERE the markup is, which the
 * streaming content gate needs: Kimi markup arrives split across deltas, so the
 * gate holds text from the first marker until the fragment completes and must
 * know how much of the held text the parsed calls actually consumed.
 *
 * Returns:
 *   { calls, start, consumed }
 * where `start` is the index of the first marker (-1 when absent) and
 * `consumed` is the length of the parsed markup run starting at `start`. Text
 * before `start` (prose) and after `start + consumed` (a trailing partial
 * fragment or unrelated tail) is never consumed, so callers can re-hold it.
 *
 * @param {string} text
 * @returns {{calls: Array, start: number, consumed: number}}
 */
export function parseKimiToolRegion(text) {
  const start = typeof text === "string" ? text.indexOf(KIMI_TOOL_PREFIX) : -1;
  if (start === -1) return { calls: [], start: -1, consumed: 0 };

  const calls = [];
  let cursor = start;
  let end = start;

  while (cursor < text.length && calls.length < MAX_CALLS) {
    if (!text.startsWith(KIMI_TOOL_PREFIX, cursor)) break;

    const headerStart = cursor + KIMI_TOOL_PREFIX.length;
    const jsonStart = text.indexOf("{", headerStart);
    if (jsonStart === -1) break;

    const jsonEnd = scanJsonObjectEnd(text.slice(jsonStart));
    if (jsonEnd === -1) break; // JSON still incomplete — hold it

    const header = text.slice(headerStart, jsonStart).trim();
    const call = parseKimiToolCallFragment(`${header} ${text.slice(jsonStart, jsonStart + jsonEnd)}`, calls.length);
    if (!call) break;

    calls.push(call);
    end = jsonStart + jsonEnd;
    cursor = end;
  }

  return { calls, start, consumed: end - start };
}

/**
 * Whether text starting at a markup marker can still become a real tool call.
 *
 * A live stream is judged by the fragment head only: `NAME` (optionally `:ID`)
 * followed by optional whitespace and then either the JSON object or the end of
 * the text so far. Prose that merely contains the word `functions.` (`"call
 * functions. The result is {"`) fails this test, so the streaming gate releases
 * it as content immediately instead of holding it until end of stream.
 *
 * @param {string} text text starting with the marker
 * @returns {boolean}
 */
export function looksLikeKimiToolFragment(text) {
  if (typeof text !== "string" || !text.startsWith(KIMI_TOOL_PREFIX)) return false;
  const rest = text.slice(KIMI_TOOL_PREFIX.length);
  // Marker alone: the name has not arrived yet, the stream is still open.
  if (rest === "") return true;
  // Name, optional ":id", then either nothing yet (still streaming) or "{".
  return /^[a-zA-Z0-9_\-/.]{1,64}(?::[a-zA-Z0-9_\-]{1,64})?\s*(?:\{|$)/.test(rest);
}

/**
 * Length of the longest suffix of `text` that is a proper prefix of the markup
 * marker (`"f"`, `"fu"`, … `"functions"`). The streaming gate holds that suffix
 * back so a marker split across deltas is never emitted as content.
 *
 * @param {string} text
 * @returns {number}
 */
export function kimiMarkerPrefixLength(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  const max = Math.min(text.length, KIMI_TOOL_PREFIX.length - 1);
  for (let len = max; len > 0; len--) {
    if (text.endsWith(KIMI_TOOL_PREFIX.slice(0, len))) return len;
  }
  return 0;
}

/**
 * Extract all native Kimi tool calls from a content string.
 *
 * Returns an empty array when no markup is present or when parsing fails.
 *
 * @param {string} content
 * @returns {Array<{id: string, type: "function", function: {name: string, arguments: string}}>}
 */
export function extractKimiToolCalls(content) {
  if (!hasKimiToolMarkup(content)) return [];
  return parseKimiToolRegion(content).calls;
}

/**
 * Normalize an assistant message that may contain leaked native Kimi markup.
 *
 * If native tool-call markup is detected, the content is trimmed to the leading
 * prose (or empty string) and a structured `tool_calls` array is attached. The
 * caller can also set `finish_reason` to `"tool_calls"` based on the returned
 * `hasTools` flag.
 *
 * Returns an object with the normalized message and metadata:
 *
 *   {
 *     message: { role: "assistant", content: string, tool_calls?: array },
 *     hasTools: boolean,
 *     originalContent: string
 *   }
 *
 * @param {{role?: string, content?: string, tool_calls?: array|null}} message
 * @returns {{message: object, hasTools: boolean, originalContent: string}}
 */
export function normalizeKimiToolCalls(message) {
  const original = message?.content;
  const originalContent = typeof original === "string" ? original : "";

  // Respect already-structured tool_calls.
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
    return {
      message: { ...message },
      hasTools: true,
      originalContent,
    };
  }

  const calls = extractKimiToolCalls(originalContent);
  if (calls.length === 0) {
    return {
      message: { ...message },
      hasTools: false,
      originalContent,
    };
  }

  const { prefix } = splitKimiToolRegion(originalContent);

  return {
    message: {
      ...message,
      content: prefix,
      tool_calls: calls,
    },
    hasTools: true,
    originalContent,
  };
}

/**
 * Convenience wrapper that returns the OpenAI-style tool_calls array, or null
 * when no native markup is present.
 *
 * @param {string|null|undefined} content
 * @returns {array|null}
 */
export function parseKimiToolCalls(content) {
  const calls = extractKimiToolCalls(content);
  return calls.length > 0 ? calls : null;
}
