// Format codecs for the Vision Advisor.
//
// The advisor keeps every client request in its native shape: Chat Completions
// messages, Anthropic content blocks, Responses `input` items. Translating the
// whole conversation through another format would lose signed thinking blocks,
// function_call/function_call_output pairing and store=false continuity.
//
// Gemini v1beta generateContent is handled with the "openai" codec: the v1beta
// route converts the native request through the canonical Gemini→OpenAI
// translator before calling handleChat, and converts the response back after.
import { FORMATS } from "open-sse/translator/formats.js";
import { initState } from "open-sse/translator/index.js";
import { openaiToOpenAIResponsesResponse } from "open-sse/translator/response/openai-responses.js";
import { OPENAI_BLOCK, RESPONSES_ITEM, OPENAI_FINISH } from "open-sse/translator/schema/index.js";

export function isAnthropicEndpoint(endpoint) {
  return endpoint?.endsWith("/messages") === true;
}

// POST /v1beta/models/{model}:generateContent | :streamGenerateContent
export function isGeminiGenerateEndpoint(endpoint) {
  return typeof endpoint === "string" && endpoint.includes("/models/") &&
    (endpoint.endsWith(":generateContent") || endpoint.endsWith(":streamGenerateContent"));
}

/**
 * Body shape the advisor manipulates for an endpoint, or null when the endpoint
 * is not a supported image-carrying chat surface.
 * @returns {"openai"|"anthropic"|"responses"|null}
 */
export function advisorBodyFormat(endpoint) {
  if (isAnthropicEndpoint(endpoint)) return "anthropic";
  if (typeof endpoint !== "string") return null;
  if (endpoint.endsWith("/responses")) return "responses";
  if (endpoint.endsWith("/chat/completions")) return "openai";
  // Native Gemini generateContent reaches handleChat already converted to the
  // internal Chat Completions body by the v1beta route.
  if (isGeminiGenerateEndpoint(endpoint)) return "openai";
  return null;
}

// URLs the advisor can forward to a vision model: inline base64 or a public URL.
// file_id-only images are deliberately unsupported (the canonical Responses→
// OpenAI bridge cannot carry a file id as an image URL either).
function isForwardableImageUrl(url) {
  return /^https?:\/\//i.test(url) || /^data:image\/(jpeg|png|gif|webp);/i.test(url);
}

export function isAdvisorImage(block, format = "openai") {
  if (format === "anthropic") {
    if (block?.type !== "image") return false;
    const source = block.source;
    return (source?.type === "base64" && typeof source.data === "string" && !!source.data &&
      ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(source.media_type)) ||
      (source?.type === "url" && typeof source.url === "string" && /^https?:\/\//.test(source.url));
  }
  if (format === "responses") {
    return block?.type === RESPONSES_ITEM.INPUT_IMAGE &&
      typeof block.image_url === "string" && isForwardableImageUrl(block.image_url);
  }
  return block?.type === OPENAI_BLOCK.IMAGE_URL && typeof block.image_url?.url === "string";
}

const RESPONSES_ITEM_TYPES = new Set([
  RESPONSES_ITEM.FUNCTION_CALL, RESPONSES_ITEM.FUNCTION_CALL_OUTPUT,
  RESPONSES_ITEM.CUSTOM_TOOL_CALL, RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT,
  RESPONSES_ITEM.ADDITIONAL_TOOLS, RESPONSES_ITEM.REASONING,
]);

function responsesItemType(item) {
  return item?.type || (item?.role ? RESPONSES_ITEM.MESSAGE : null);
}

function supportsResponsesBody(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.input)) return false;
  return body.input.every((item) => {
    if (!item || typeof item !== "object") return false;
    const type = responsesItemType(item);
    if (type === RESPONSES_ITEM.MESSAGE) {
      if (item.content === undefined || item.content === null) return true;
      if (typeof item.content === "string") return true;
      if (!Array.isArray(item.content)) return false;
      return item.content.every((block) =>
        block?.type === RESPONSES_ITEM.INPUT_TEXT ||
        block?.type === RESPONSES_ITEM.OUTPUT_TEXT ||
        isAdvisorImage(block, "responses"));
    }
    return RESPONSES_ITEM_TYPES.has(type);
  });
}

export function supportsAdvisorBody(body, format = "openai") {
  if (format === "responses") return supportsResponsesBody(body);
  const allowed = format === "anthropic"
    ? ["text", "tool_use", "tool_result", "thinking", "redacted_thinking"]
    : ["text"];
  return Array.isArray(body?.messages) && body.messages.every((message) =>
    message && (!Array.isArray(message.content) || message.content.every((block) =>
      allowed.includes(block?.type) || isAdvisorImage(block, format))) &&
    !message.images && !message.attachments && !message.experimental_attachments && !message.image_url &&
    // Nested media in tool results is not part of this bounded image tool.
    (format !== "anthropic" || !Array.isArray(message.content) || message.content.every((block) =>
      block.type !== "tool_result" || !Array.isArray(block.content) ||
      block.content.every((part) => part?.type === "text"))));
}

export function anthropicStream(payload) {
  const events = [];
  const emit = (type, fields = {}) => events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  emit("message_start", { message: {
    ...payload, content: [], stop_reason: null, stop_sequence: null,
    usage: { ...payload.usage, output_tokens: 0 },
  } });
  for (const [index, block] of (payload.content || []).entries()) {
    if (block.type === "text") {
      emit("content_block_start", { index, content_block: { ...block, text: "" } });
      emit("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
    } else if (block.type === "tool_use") {
      emit("content_block_start", { index, content_block: { ...block, input: {} } });
      emit("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } });
    } else if (block.type === "thinking") {
      emit("content_block_start", { index, content_block: { type: "thinking", thinking: "" } });
      emit("content_block_delta", { index, delta: { type: "thinking_delta", thinking: block.thinking } });
      if (block.signature) emit("content_block_delta", { index, delta: { type: "signature_delta", signature: block.signature } });
    } else {
      emit("content_block_start", { index, content_block: block });
    }
    emit("content_block_stop", { index });
  }
  emit("message_delta", {
    delta: { stop_reason: payload.stop_reason || "end_turn", stop_sequence: payload.stop_sequence ?? null },
    usage: { output_tokens: payload.usage?.output_tokens || 0 },
  });
  emit("message_stop");
  return new Response(events.join(""), {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

export function toArgumentsString(value) {
  if (typeof value === "string" && value) return value;
  if (value === undefined || value === null) return "{}";
  try { return JSON.stringify(value); } catch { return "{}"; }
}

function responsesMessageText(item) {
  if (typeof item?.content === "string") return item.content;
  if (!Array.isArray(item?.content)) return "";
  return item.content.filter((c) => c?.type === RESPONSES_ITEM.OUTPUT_TEXT).map((c) => c.text || "").join("");
}

/**
 * Normalize a buffered first-pass payload into a single OpenAI Chat Completions
 * chunk. Responses clients usually get `output` items; a non-streaming
 * Responses request whose provider target is Claude/Gemini comes back through
 * the Chat bridge (nonStreamingHandler.translateNonStreamingResponse), so the
 * `choices[0].message` shape is accepted as well.
 * @returns {{chunk: object, customToolNames: Set<string>}}
 */
function toResponsesChunk(payload) {
  if (Array.isArray(payload?.output)) {
    const delta = {};
    const toolCalls = [];
    const customToolNames = new Set();
    for (const item of payload.output) {
      const type = responsesItemType(item);
      if (type === RESPONSES_ITEM.MESSAGE) {
        const text = responsesMessageText(item);
        if (text) delta.content = (delta.content || "") + text;
      } else if (type === RESPONSES_ITEM.REASONING) {
        const text = (Array.isArray(item.summary) ? item.summary : []).map((s) => s?.text || "").filter(Boolean).join("\n");
        if (text) delta.reasoning_content = (delta.reasoning_content || "") + text;
      } else if (type === RESPONSES_ITEM.FUNCTION_CALL || type === RESPONSES_ITEM.CUSTOM_TOOL_CALL) {
        const custom = type === RESPONSES_ITEM.CUSTOM_TOOL_CALL;
        if (custom) customToolNames.add(item.name);
        toolCalls.push({
          index: toolCalls.length,
          id: item.call_id,
          type: OPENAI_BLOCK.FUNCTION,
          function: {
            name: item.name || "",
            arguments: custom ? JSON.stringify({ input: typeof item.input === "string" ? item.input : "" }) : toArgumentsString(item.arguments),
          },
        });
      }
      // Hosted/unknown output items have no Chat Completions equivalent, so a
      // buffered Responses stream cannot replay them. They stay visible in the
      // non-streaming JSON result; only the synthesized stream skips them.
    }
    if (toolCalls.length) delta.tool_calls = toolCalls;
    const usage = payload.usage || {};
    return {
      customToolNames,
      chunk: {
        id: typeof payload.id === "string" ? payload.id.replace(/^resp_/, "") : undefined,
        created: payload.created_at,
        model: payload.model,
        choices: [{ index: 0, delta, finish_reason: toolCalls.length ? OPENAI_FINISH.TOOL_CALLS : OPENAI_FINISH.STOP }],
        usage: {
          prompt_tokens: usage.input_tokens ?? usage.prompt_tokens,
          completion_tokens: usage.output_tokens ?? usage.completion_tokens,
          total_tokens: usage.total_tokens,
        },
      },
    };
  }

  const choice = payload?.choices?.[0];
  const message = choice?.message || {};
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((call, index) => ({ ...call, index }))
    : undefined;
  return {
    customToolNames: new Set(),
    chunk: {
      id: payload?.id,
      created: payload?.created,
      model: payload?.model,
      choices: [{
        index: 0,
        delta: { ...message, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
        finish_reason: choice?.finish_reason || (toolCalls ? OPENAI_FINISH.TOOL_CALLS : OPENAI_FINISH.STOP),
      }],
      usage: payload?.usage,
    },
  };
}

/**
 * Serialize a buffered Responses-format result as the native Responses SSE
 * event sequence (no OpenAI `chat.completion.chunk`, no `[DONE]` sentinel).
 * Reuses the canonical Chat→Responses event mapper so the wire shape cannot
 * drift from the streaming path.
 */
export function responsesStream(payload) {
  const { chunk, customToolNames } = toResponsesChunk(payload);
  const state = initState(FORMATS.OPENAI_RESPONSES);
  if (customToolNames.size) state.customToolNames = customToolNames;
  const events = [
    ...(openaiToOpenAIResponsesResponse(chunk, state) || []),
    ...(openaiToOpenAIResponsesResponse(null, state) || []),
  ];
  const body = events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
