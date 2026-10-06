import { FORMATS } from "../../translator/formats.js";
import { SSE_HEADERS_CORS, SSE_DONE } from "../../utils/sseConstants.js";

const encoder = new TextEncoder();

function frame(eventName, data) {
  const head = eventName ? `event: ${eventName}\n` : "";
  return `${head}data: ${JSON.stringify(data)}\n\n`;
}

/**
 * Build a synthetic SSE body from a non-streaming OpenAI `chat.completion`.
 * Mirrors the pinned Vans coercion: role, optional reasoning, content,
 * structured tool_calls, then a finish chunk carrying usage and `[DONE]`.
 */
function buildOpenAIFrames(jsonResponse) {
  const choice = jsonResponse?.choices?.[0];
  const msg = choice?.message;

  if (!msg) {
    return `data: ${JSON.stringify(jsonResponse)}\n\n${SSE_DONE}`;
  }

  const id = jsonResponse.id || `chatcmpl-${Date.now()}`;
  const created = jsonResponse.created || Math.floor(Date.now() / 1000);
  const model = jsonResponse.model || "unknown";

  const chunks = [];
  chunks.push({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null, logprobs: null }] });

  if (msg.reasoning_content) {
    chunks.push({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { reasoning_content: msg.reasoning_content }, finish_reason: null, logprobs: null }] });
  }
  if (msg.content) {
    chunks.push({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: msg.content }, finish_reason: null, logprobs: null }] });
  }
  if (msg.tool_calls?.length > 0) {
    chunks.push({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { tool_calls: msg.tool_calls }, finish_reason: null, logprobs: null }] });
  }

  const finishChunk = { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || "stop", logprobs: null }] };
  if (jsonResponse.usage) finishChunk.usage = jsonResponse.usage;
  chunks.push(finishChunk);

  return chunks.map((chunk) => frame(null, chunk)).join("") + SSE_DONE;
}

/**
 * Build a synthetic Responses-API SSE body from a `object:"response"` JSON.
 * Clients (Codex) close on a terminal event, so the coercion emits
 * `response.created` + `response.completed` and deliberately NO `[DONE]`.
 */
function buildResponsesFrames(jsonResponse) {
  const response = jsonResponse && typeof jsonResponse === "object" ? jsonResponse : {};
  const created = { ...response, status: response.status || "completed" };
  return frame("response.created", { type: "response.created", response: created })
    + frame("response.completed", { type: "response.completed", response });
}

/**
 * Build a synthetic Anthropic Messages SSE body from a `type:"message"` JSON.
 * Emits message_start, one start/delta/stop per content block, then
 * message_delta (stop_reason + usage) and message_stop.
 */
function buildClaudeFrames(jsonResponse) {
  const message = jsonResponse && typeof jsonResponse === "object" ? jsonResponse : {};
  const blocks = Array.isArray(message.content) ? message.content : [];
  let out = frame("message_start", {
    type: "message_start",
    message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage: message.usage || { input_tokens: 0, output_tokens: 0 } },
  });

  blocks.forEach((block, index) => {
    out += frame("content_block_start", { type: "content_block_start", index, content_block: block });
    if (block?.type === "text" && typeof block.text === "string") {
      out += frame("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else if (block?.type === "thinking" && typeof block.thinking === "string") {
      out += frame("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
    } else if (block?.type === "tool_use") {
      out += frame("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input || {}) } });
    }
    out += frame("content_block_stop", { type: "content_block_stop", index });
  });

  out += frame("message_delta", { type: "message_delta", delta: { stop_reason: message.stop_reason || "end_turn", stop_sequence: null }, usage: message.usage || {} });
  out += frame("message_stop", { type: "message_stop" });
  return out;
}

/**
 * Build a synthetic Gemini/Antigravity SSE body. These clients consume a single
 * `data:` chunk and do NOT use the `[DONE]` sentinel.
 */
function buildGeminiFrames(jsonResponse) {
  return `data: ${JSON.stringify(jsonResponse)}\n\n`;
}

/**
 * Convert a non-streaming chat.completion JSON into a synthetic SSE stream.
 * Used when upstream was coerced to stream:false but the client expects SSE.
 * Serializes in the client's own SSE format. Returns a Response with SSE headers.
 *
 * @param {object} jsonResponse - response body already translated to the client format
 * @param {string} sourceFormat - client format (FORMATS.*)
 */
export function buildCoercedSSEResponse(jsonResponse, sourceFormat = FORMATS.OPENAI) {
  let body;
  if (sourceFormat === FORMATS.OPENAI_RESPONSES) body = buildResponsesFrames(jsonResponse);
  else if (sourceFormat === FORMATS.CLAUDE) body = buildClaudeFrames(jsonResponse);
  else if (sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI || sourceFormat === FORMATS.ANTIGRAVITY || sourceFormat === FORMATS.VERTEX) body = buildGeminiFrames(jsonResponse);
  else body = buildOpenAIFrames(jsonResponse);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS_CORS });
}
