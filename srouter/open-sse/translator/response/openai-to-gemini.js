import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { OPENAI_FINISH } from "../schema/index.js";
import { openaiToAntigravityResponse } from "./openai-to-antigravity.js";

/**
 * Gemini-family client formats: they consume the bare GenerateContentResponse
 * (`{candidates, usageMetadata, modelVersion, responseId}`) on the wire. The
 * native `/v1beta/models/*:generateContent` route converts an OpenAI body back
 * with the same bare shape (see its `convertOpenAIResponseToGemini`), and the
 * real Gemini API never wraps candidates in a transport envelope.
 */
export const GEMINI_FAMILY_CLIENT_FORMATS = new Set([
  FORMATS.GEMINI,
  FORMATS.GEMINI_CLI,
  FORMATS.VERTEX,
]);

/**
 * The Gemini API marks every candidate with its position in the list. The shared
 * Antigravity projection omits `index`, so it is added here rather than there —
 * Antigravity frames stay byte-identical. Field order follows the native
 * `/v1beta` conversion: candidates first, then the metadata fields.
 */
function geminiFamilyBody(projected) {
  const candidates = projected.candidates;
  if (!Array.isArray(candidates)) return projected;
  return {
    candidates: candidates.map((candidate, index) => (candidate?.index === undefined ? { ...candidate, index } : candidate)),
    ...Object.fromEntries(Object.entries(projected).filter(([key]) => key !== "candidates")),
  };
}

/**
 * Project an OpenAI SSE chunk into the Gemini-family client shape.
 *
 * The Antigravity projection already builds the candidate/parts/usageMetadata
 * payload, so this reuses it and drops only the Cloud Code transport envelope
 * (`{response: …}`) that Antigravity clients keep.
 *
 * Without this registration a client whose request was detected as Gemini
 * format (`contents: [...]`) and routed to an OpenAI-native provider streamed
 * raw `chat.completion.chunk` frames — `choices[]`/`tool_calls` leaked instead
 * of `candidates[]`/`functionCall`. The response registry only held the
 * OpenAI→Antigravity projection, so every other frame (content, reasoning,
 * usage, finish) stayed OpenAI-shaped too.
 */
export function openaiToGeminiFamilyResponse(chunk, state) {
  const projected = openaiToAntigravityResponse(chunk, state);
  return projected?.response ? geminiFamilyBody(projected.response) : null;
}

/**
 * Non-streaming counterpart: an OpenAI `chat.completion` body → the same bare
 * GenerateContentResponse. The body is fed through the streaming projection as
 * one synthetic terminal chunk, so text/thought/functionCall parts, finishReason
 * and usageMetadata cannot drift between the streaming and JSON paths.
 *
 * `state` carries `toolNameMap`, so a provider-side (fitted or cloaked) tool name
 * is restored to the client's original name exactly as in the streaming path.
 * Returns null when the body has no `choices` (e.g. a provider error body) so the
 * caller can leave it untouched.
 */
export function openAICompletionToGeminiFamily(completion, state = {}) {
  const choice = completion?.choices?.[0];
  if (!choice) return null;

  const message = choice.message || {};
  const delta = {};
  if (message.reasoning_content) delta.reasoning_content = message.reasoning_content;
  if (typeof message.content === "string" && message.content.length > 0) delta.content = message.content;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    // A completion carries whole calls; the projection accumulates fragments by
    // index, so a single pass already yields the complete functionCall parts.
    delta.tool_calls = message.tool_calls.map((call, index) => ({
      index: call?.index ?? index,
      ...(call?.id ? { id: call.id } : {}),
      function: call?.function || {},
    }));
  }

  const projected = openaiToAntigravityResponse({
    id: completion.id,
    model: completion.model,
    choices: [{ index: 0, delta, finish_reason: choice.finish_reason || OPENAI_FINISH.STOP }],
    ...(completion.usage ? { usage: completion.usage } : {}),
  }, state);

  return projected?.response ? geminiFamilyBody(projected.response) : null;
}

// The request side of these pairs is registered by request/openai-to-gemini.js and
// request/openai-to-vertex.js with a `null` response slot, and register() only
// writes the map whose function is present — so adding the response side here
// cannot overwrite an existing request translator.
register(FORMATS.OPENAI, FORMATS.GEMINI, null, openaiToGeminiFamilyResponse);
register(FORMATS.OPENAI, FORMATS.GEMINI_CLI, null, openaiToGeminiFamilyResponse);
register(FORMATS.OPENAI, FORMATS.VERTEX, null, openaiToGeminiFamilyResponse);
