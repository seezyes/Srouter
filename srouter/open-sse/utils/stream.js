import { translateResponse, initState } from "../translator/index.js";
import { restoreToolNames } from "./opencodeFingerprint.js";
import { FORMATS } from "../translator/formats.js";
import { OPENAI_FINISH } from "../translator/schema/index.js";
import { trackPendingRequest, appendRequestLog } from "@/lib/usageDb.js";
import { extractUsage, mergeUsage, hasValidUsage, estimateUsage, logUsage, addBufferToUsage, filterUsageForFormat, COLORS } from "./usageTracking.js";
import { parseSSELine, hasValuableContent, fixInvalidId, formatSSE } from "./streamHelpers.js";
import { KIMI_MODEL_RE, KIMI_TOOL_MARKER, kimiMarkerPrefixLength, looksLikeKimiToolFragment, parseKimiToolRegion } from "./kimiToolParser.js";
import { getOpenAIResponsesEventName, isOpenAIResponsesTerminalEvent, formatIncompleteOpenAIResponsesStreamFailure } from "./responsesStreamHelpers.js";
import { dbg, isDebugEnabled } from "./debugLog.js";

import { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER } from "./sseConstants.js";

export { COLORS, formatSSE };
export { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER };

// sharedEncoder is stateless — safe to share across streams
const sharedEncoder = new TextEncoder();

/**
 * Stream modes
 */
const STREAM_MODE = {
  TRANSLATE: "translate",    // Full translation between formats
  PASSTHROUGH: "passthrough" // No translation, normalize output, extract usage
};

// Native Kimi tool-call markup that leaks into streamed `content` instead of
// being emitted as structured `tool_calls` is normalized through
// `normalizeKimiToolCalls` (utils/kimiToolParser.js). The parser is passed in
// per-stream by the caller and only active for Kimi models, so unrelated
// provider histories are never inspected.

/**
 * Client formats that can carry a normalized Kimi tool call as a real tool call.
 * Derived from the response-translator registry: openai→openai is the identity
 * route, openai→openai-responses / openai→claude / openai→antigravity are
 * registered converters, and openai→antigravity is also the serializer used for
 * the gemini-family clients (no openai→gemini response converter is registered).
 * Formats outside this set have no way to express the call, so their content is
 * left untouched instead of being stripped into nothing.
 */
const KIMI_TOOL_CALL_FORMATS = new Set([
  FORMATS.OPENAI,
  FORMATS.OPENAI_RESPONSES,
  FORMATS.CLAUDE,
  FORMATS.ANTIGRAVITY,
  FORMATS.GEMINI,
  FORMATS.GEMINI_CLI,
  FORMATS.VERTEX
]);

/**
 * Build an OpenAI-style terminal chunk carrying only a finish reason, used when
 * a Kimi terminal was held back but no tool call could be recovered from it.
 */
function buildOpenAIFinishChunk(finishReason, messageId, modelName) {
  const id = messageId?.startsWith("chatcmpl-") ? messageId : `chatcmpl-${messageId || Date.now()}`;
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: modelName || null,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  };
}

/**
 * Build an OpenAI-style SSE chunk that exposes structured tool_calls.
 * `index` is filled in per call because the response converters dedupe parallel
 * calls by it (a missing index collapses every call onto block 0).
 */
export function buildOpenAIToolCallsChunk(toolCalls, messageId, modelName) {
  const id = messageId?.startsWith("chatcmpl-") ? messageId : `chatcmpl-${messageId || Date.now()}`;
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: modelName || null,
    choices: [{
      index: 0,
      delta: {
        tool_calls: toolCalls.map((call, i) => ({
          ...call,
          index: Number.isInteger(call?.index) ? call.index : i
        }))
      },
      finish_reason: OPENAI_FINISH.TOOL_CALLS
    }],
  };
}

/**
 * Append newly parsed native Kimi tool calls to the accumulated list, dropping
 * repeats by call id so a chunk that re-emits an already-seen call cannot
 * duplicate the tool call in the client output.
 */
export function mergeKimiToolCalls(existing, incoming) {
  const merged = Array.isArray(existing) ? existing.slice() : [];
  const seen = new Set(merged.map((call) => call?.id));
  for (const call of incoming || []) {
    const key = call?.id;
    if (key !== undefined && seen.has(key)) continue;
    if (key !== undefined) seen.add(key);
    merged.push(call);
  }
  return merged;
}

/**
 * Pick an OpenAI-shaped usage object. `state.usage` is normalizeUsage()-shaped
 * for most providers but the Claude converter overwrites it with its own
 * `{input_tokens, output_tokens}` shape, which must not be fed back into an
 * OpenAI-shaped synthetic chunk as if it were the upstream usage.
 */
export function pickOpenAIUsage(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  if (Number.isFinite(candidate.prompt_tokens) || Number.isFinite(candidate.completion_tokens)) return candidate;
  return null;
}

// Upper bound on the deferred response.completed wait: a chat->responses stream
// that saw finish_reason without usage must not hold the client's terminal event
// forever when the upstream stalls with no usage trailer and no [DONE].
const PENDING_COMPLETION_FLUSH_MS = 3000;

/**
 * Create unified SSE transform stream
 * @param {object} options
 * @param {string} options.mode - Stream mode: translate, passthrough
 * @param {string} options.targetFormat - Provider format (for translate mode)
 * @param {string} options.sourceFormat - Client format (for translate mode)
 * @param {string} options.provider - Provider name
 * @param {object} options.reqLogger - Request logger instance
 * @param {string} options.model - Model name
 * @param {string} options.connectionId - Connection ID for usage tracking
 * @param {object} options.body - Request body (for input token estimation)
 * @param {function} options.onStreamComplete - Callback when stream completes (content, usage)
 * @param {string} options.apiKey - API key for usage tracking
 */
export function createSSEStream(options = {}) {
  const {
    mode = STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider = null,
    reqLogger = null,
    toolNameMap = null,
    customToolNames = null,
    model = null,
    connectionId = null,
    body = null,
    onStreamComplete = null,
    apiKey = null,
    normalizeKimiToolCalls = null,
    credentials = null
  } = options;

  let buffer = "";
  let usage = null;

  // Track native Kimi tool-call markup that leaks into streaming content.
  // When detected, a translated tool_calls frame is emitted before the terminal.
  const isKimiModel = KIMI_MODEL_RE.test(model || "");
  // Markup is only removed when this stream can express the call in the client's
  // own shape; otherwise the raw text is preserved.
  const kimiFormatSupported = KIMI_TOOL_CALL_FORMATS.has(sourceFormat);
  let kimiToolCalls = null;
  let kimiToolCallsEmitted = false;
  let kimiSawStructuredToolCalls = false;
  // Content held back because it may be the start of a Kimi markup fragment.
  let kimiHold = "";
  // Terminal chunk consumed while markup was still in flight.
  let kimiDeferredFinish = null;

  // Per-stream decoder with stream:true to correctly handle multi-byte chars split across chunks
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const state = mode === STREAM_MODE.TRANSLATE
    ? { ...initState(sourceFormat), provider, toolNameMap, customToolNames: new Set(customToolNames || []), model, sessionId: credentials?._clientSessionId || null,
        // Which upstream format this stream came from. A response translator can be
        // reached either directly (target === its registered source) or as the second
        // hop of a pivot, and on the terminal null chunk the pivot drops it — so a
        // translator that defers closing events until flush needs to know which case
        // it is in. Absent/undefined means "unknown", i.e. do not defer.
        targetFormat }
    : null;

  let totalContentLength = 0;
  let accumulatedContent = "";
  let accumulatedThinking = "";
  let ttftAt = null;
  let sseLineCount = 0;
  let sseEmittedCount = 0;
  const eventTypeCounts = {};

  // Track Responses API event framing for same-format passthrough (codex)
  let currentOpenAIResponsesEvent = null;
  let openAIResponsesTerminalSeen = false;
  let openAIResponsesDoneSent = false;
  let streamDoneSent = false;  // track duplicate [DONE] across transform + flush
  let finalized = false;
  let completionFlushTimer = null;

  // Usage/logging tail, callable from transform() as well as flush(): a client that
  // closes right after the terminal event cancels the reader, and flush() never runs.
  const finalizeStream = () => {
    if (completionFlushTimer) { clearTimeout(completionFlushTimer); completionFlushTimer = null; }
    if (finalized) return;
    finalized = true;

    const isPassthrough = mode === STREAM_MODE.PASSTHROUGH;
    let finalUsage = isPassthrough ? usage : state?.usage;

    if (!hasValidUsage(finalUsage) && totalContentLength > 0) {
      finalUsage = estimateUsage(body, totalContentLength, isPassthrough ? FORMATS.OPENAI : sourceFormat);
      if (isPassthrough) usage = finalUsage; else state.usage = finalUsage;
    }

    if (hasValidUsage(finalUsage)) {
      logUsage(isPassthrough ? provider : (state?.provider || targetFormat), finalUsage, model, connectionId, apiKey);
    } else {
      appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
    }

    if (onStreamComplete) {
      onStreamComplete({
        content: accumulatedContent,
        thinking: accumulatedThinking
      }, finalUsage, ttftAt);
    }
  };

  // Emit the deferred response.completed now — at [DONE], or when the watchdog
  // below gives up on a usage trailer that never arrives.
  const flushPendingCompletion = (controller) => {
    const completed = translateResponse(targetFormat, sourceFormat, null, state);
    for (const item of completed || []) {
      if (item === null || item === undefined) continue;
      const output = formatSSE(item, sourceFormat);
      reqLogger?.appendConvertedChunk?.(output);
      controller.enqueue(sharedEncoder.encode(output));
      sseEmittedCount++;
    }
    finalizeStream();
  };

  // Native Kimi markup arrives token-fragmented (`functions.` / `echo:0 {"pa` /
  // `th":1}`), so neither detection nor stripping can be per-delta. This gate
  // buffers content from the first possible markup start and returns only the
  // text that is safe to send: complete markup becomes a structured tool call,
  // a trailing partial marker stays held, and text that turns out not to be
  // markup is returned unchanged (never dropped).
  // `record` is false once the upstream has proven authoritative by sending its
  // own structured tool_calls: the markup is then duplicate text to strip, not a
  // call to synthesize.
  const gateKimiContent = (text, record = true) => {
    let pending = kimiHold + (typeof text === "string" ? text : "");
    kimiHold = "";

    const at = pending.indexOf(KIMI_TOOL_MARKER);
    if (at === -1) {
      // No markup start: hold only a trailing partial marker ("functio…").
      const hold = kimiMarkerPrefixLength(pending);
      if (hold > 0) {
        kimiHold = pending.slice(pending.length - hold);
        return pending.slice(0, pending.length - hold);
      }
      return pending;
    }

    // A marker inside a longer delta: the head is prose, so only the boundary
    // whitespace in front of a *real* call is dropped (same as the non-streaming
    // parser). When the "marker" turns out to be prose, every byte is kept.
    if (at > 0) {
      const head = pending.slice(0, at);
      const rest = pending.slice(at);
      const gatedRest = gateKimiContent(rest, record);
      return gatedRest === rest ? head + gatedRest : head.replace(/\s+$/, "") + gatedRest;
    }

    // The marker only starts a tool call when a plausible fragment head follows.
    // Prose that merely contains the word is released (and never held to the end
    // of the stream) — text is only withheld while a real call can still form.
    if (!looksLikeKimiToolFragment(pending)) return pending;

    const { calls, consumed } = parseKimiToolRegion(pending);
    if (calls.length === 0) {
      // Markup started but the fragment is incomplete: hold it all.
      kimiHold = pending;
      return "";
    }

    if (record && !kimiSawStructuredToolCalls && !kimiToolCallsEmitted) {
      kimiToolCalls = mergeKimiToolCalls(kimiToolCalls, calls);
    }

    const rest = pending.slice(consumed);
    return rest ? gateKimiContent(rest, record) : "";
  };

  // Log OpenAI intermediate chunks (if available)
  const logOpenAIIntermediate = (translated) => {
    if (!translated?._openaiIntermediate) return;
    for (const item of translated._openaiIntermediate) {
      reqLogger?.appendOpenAIChunk?.(formatSSE(item, FORMATS.OPENAI));
    }
  };

  // Emit translated items to the client. Shared by the transform loop and the
  // synthetic Kimi tool-call frame so both go through the same usage injection,
  // empty-chunk filter and terminal detection.
  const emitTranslatedItems = (controller, translated) => {
    if (!translated?.length) return;
    for (const item of translated) {
      if (item === null || item === undefined) continue;

      const isFinishChunk = item.type === "message_delta" || item.choices?.[0]?.finish_reason;

      // Filter empty chunks
      if (!hasValuableContent(item, sourceFormat)) {
        continue; // Skip this empty chunk
      }

      // Inject estimated usage if finish chunk has no valid usage
      if (state.finishReason && isFinishChunk && !hasValidUsage(item.usage) && totalContentLength > 0) {
        const estimated = estimateUsage(body, totalContentLength, sourceFormat);
        item.usage = filterUsageForFormat(estimated, sourceFormat); // Filter + already has buffer
        state.usage = estimated;
      } else if (state.finishReason && isFinishChunk && state.usage) {
        // Add buffer and filter usage for client (but keep original in state.usage for logging)
        const buffered = addBufferToUsage(state.usage);
        item.usage = filterUsageForFormat(buffered, sourceFormat);
      }

      const output = formatSSE(item, sourceFormat);
      reqLogger?.appendConvertedChunk?.(output);
      controller.enqueue(sharedEncoder.encode(output));
      sseEmittedCount++;
      if (item.event === "response.completed" || item.data?.type === "response.completed") finalizeStream();
    }
  };

  // Translate the synthetic OpenAI-shaped Kimi chunk into the client format.
  // The synthetic chunk is always OpenAI-shaped, so the pivot starts at OpenAI;
  // every registered OpenAI→client response translator (Claude, Responses,
  // Antigravity, Gemini-family) then applies through the same registry the
  // regular content frames use.
  const translateKimiSynthetic = (synthetic) => translateResponse(FORMATS.OPENAI, sourceFormat, synthetic, state);

  // Emit the accumulated native Kimi tool calls as a client-shaped tool call.
  // The chunk travels through the response translator and the inverse tool-name
  // map, so a fitted (shortened) provider name reaches the client as the
  // original tool name.
  const emitKimiToolCalls = (controller, toolCalls, usage) => {
    if (!toolCalls?.length) return false;
    const synthetic = buildOpenAIToolCallsChunk(toolCalls, state?.messageId, model);
    const openAIUsage = pickOpenAIUsage(usage) || pickOpenAIUsage(state?.usage);
    if (openAIUsage) synthetic.usage = openAIUsage;
    emitTranslatedItems(controller, translateKimiSynthetic(synthetic));
    kimiToolCallsEmitted = true;
    return true;
  };

  // Emit text that the content gate was still holding at end of stream (an
  // incomplete fragment that never became a tool call) so it is not lost. Runs
  // through the normal response translation, so each client gets its own shape.
  // The reconstructed chunk is OpenAI-shaped, so the pivot starts at OpenAI —
  // the same direction the synthetic tool-call chunk uses.
  const emitHeldKimiText = (controller, text) => {
    if (!text) return;
    accumulatedContent += text;
    totalContentLength += text.length;
    emitTranslatedItems(controller, translateResponse(FORMATS.OPENAI, sourceFormat, {
      ...buildOpenAIFinishChunk(null, state?.messageId, model),
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
    }, state));
  };

  // A native-markup stream has no upstream tool_calls, so its terminal chunk
  // must not reach the client before the recovered call: the terminal is
  // replaced when the call is already recognized, and deferred (finished in
  // flush()) while markup is still in flight, so the tool call always precedes
  // the end-of-stream boundary. Content/reasoning carried by that same chunk is
  // emitted first (non-terminal), preserving the streaming content order.
  const handleKimiFinishReplacement = (parsed, controller) => {
    if (!isKimiModel || !normalizeKimiToolCalls || !kimiFormatSupported || kimiSawStructuredToolCalls) return false;
    const finishReason = parsed.choices?.[0]?.finish_reason;
    if (!finishReason) return false;
    const hasCalls = kimiToolCalls?.length > 0;
    if (!hasCalls && !kimiHold) return false;

    const choice = parsed.choices[0];
    const usage = parsed.usage;
    choice.finish_reason = null;
    const pendingItems = translateResponse(targetFormat, sourceFormat, parsed, state);
    logOpenAIIntermediate(pendingItems);
    emitTranslatedItems(controller, pendingItems);
    choice.finish_reason = finishReason;

    if (hasCalls) emitKimiToolCalls(controller, kimiToolCalls, usage);
    else kimiDeferredFinish = { finishReason, usage };
    return true;
  };

  // End-of-stream resolution for native Kimi markup: recover whatever the gate
  // was holding, then release the terminal that was held back with it. Text that
  // never became a tool call is emitted as content, never dropped, so a
  // truncated fragment degrades to plain text instead of disappearing.
  const flushKimiMarkup = (controller) => {
    const held = kimiHold;
    kimiHold = "";
    // Once the upstream itself sent structured tool_calls there is nothing to
    // recover: the held text was only ever duplicate markup text.
    const active = isKimiModel && normalizeKimiToolCalls && kimiFormatSupported && !kimiSawStructuredToolCalls;
    const region = active && held ? parseKimiToolRegion(held) : { calls: [], start: -1, consumed: 0 };
    const calls = active ? mergeKimiToolCalls(kimiToolCalls, region.calls) : [];
    const remainder = region.calls.length > 0 ? held.slice(region.start + region.consumed) : held;

    if (remainder) emitHeldKimiText(controller, remainder);

    if (calls.length > 0 && !kimiToolCallsEmitted) {
      emitKimiToolCalls(controller, calls, kimiDeferredFinish?.usage || state?.usage);
      kimiDeferredFinish = null;
    }

    if (kimiDeferredFinish) {
      const terminal = buildOpenAIFinishChunk(kimiDeferredFinish.finishReason, state?.messageId, model);
      if (pickOpenAIUsage(kimiDeferredFinish.usage)) terminal.usage = kimiDeferredFinish.usage;
      emitTranslatedItems(controller, translateResponse(FORMATS.OPENAI, sourceFormat, terminal, state));
      kimiDeferredFinish = null;
    }
  };

  return new TransformStream({
    cancel() {
      if (completionFlushTimer) { clearTimeout(completionFlushTimer); completionFlushTimer = null; }
    },
    transform(chunk, controller) {
      if (state?.completedSent) return;
      if (!ttftAt) ttftAt = Date.now();
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      reqLogger?.appendProviderChunk?.(text);

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (state?.completedSent) break;
        const trimmed = line.trim();
        if (isDebugEnabled && trimmed) {
          sseLineCount++;
          if (trimmed.startsWith("event:")) {
            const evt = trimmed.slice(6).trim();
            eventTypeCounts[evt] = (eventTypeCounts[evt] || 0) + 1;
          }
        }

        // Capture Responses API event name to preserve framing in same-format passthrough
        if (mode === STREAM_MODE.TRANSLATE && targetFormat === FORMATS.OPENAI_RESPONSES && trimmed.startsWith("event:")) {
          currentOpenAIResponsesEvent = trimmed.slice(6).trim();
        }

        // Passthrough mode: normalize and forward
        if (mode === STREAM_MODE.PASSTHROUGH) {
          let output;
          let injectedUsage = false;
          let responsesTerminal = false;

          if (trimmed.startsWith("data:") && trimmed.slice(5).trim() !== "[DONE]") {
            try {
              const parsed = JSON.parse(trimmed.slice(5).trim());

              const idFixed = fixInvalidId(parsed);

              // Ensure OpenAI-required fields are present on streaming chunks (Letta compat)
              let fieldsInjected = false;

              // Same-format streams never call translateResponse(), so the inverse
              // tool-name map has to be applied here or a fitted/cloaked provider
              // name reaches the client while the JSON path restores it. Frames
              // without a mapped name keep the byte-preserving path below.
              if (toolNameMap?.size) {
                const restored = restoreToolNames(parsed, toolNameMap);
                // Only frames whose payload really changed are re-serialized;
                // anything else keeps the byte-preserving path below.
                if (restored !== parsed && JSON.stringify(restored) !== JSON.stringify(parsed)) {
                  Object.assign(parsed, restored);
                  fieldsInjected = true;
                }
              }

              if (parsed.choices !== undefined) {
                if (!parsed.object) { parsed.object = "chat.completion.chunk"; fieldsInjected = true; }
                if (!parsed.created) { parsed.created = Math.floor(Date.now() / 1000); fieldsInjected = true; }
              }

              // Strip Azure-specific non-standard fields from streaming chunks
              if (parsed.prompt_filter_results !== undefined) {
                delete parsed.prompt_filter_results;
                fieldsInjected = true;
              }
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice.content_filter_results !== undefined) {
                    delete choice.content_filter_results;
                    fieldsInjected = true;
                  }
                }
              }

              // Strip empty tool_calls arrays that break AI SDK reasoning tracking.
              // Some providers (e.g. CodeBuddy CN) include `"tool_calls": []` in
              // every streaming delta. @ai-sdk/openai-compatible checks
              // `delta.tool_calls != null` — an empty array passes this check,
              // causing premature `reasoning-end` on every chunk.
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice.delta?.tool_calls && Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length === 0) {
                    delete choice.delta.tool_calls;
                    fieldsInjected = true;
                  }
                }
              }

              if (!hasValuableContent(parsed, FORMATS.OPENAI)) {
                continue;
              }

              const delta = parsed.choices?.[0]?.delta;
              const content = delta?.content;
              const reasoning = delta?.reasoning_content;
              if (content && typeof content === "string") {
                totalContentLength += content.length;
                accumulatedContent += content;
              }
              if (reasoning && typeof reasoning === "string") {
                totalContentLength += reasoning.length;
                accumulatedThinking += reasoning;
              }

              const extracted = extractUsage(parsed);
              if (extracted) {
                usage = mergeUsage(usage, extracted);
              }

              responsesTerminal = isOpenAIResponsesTerminalEvent(currentOpenAIResponsesEvent, parsed);

              const isFinishChunk = parsed.choices?.[0]?.finish_reason;
              if (isFinishChunk && !hasValidUsage(parsed.usage)) {
                const estimated = estimateUsage(body, totalContentLength, FORMATS.OPENAI);
                parsed.usage = filterUsageForFormat(estimated, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                usage = estimated;
                injectedUsage = true;
              } else if (isFinishChunk && usage) {
                const buffered = addBufferToUsage(usage);
                parsed.usage = filterUsageForFormat(buffered, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              } else if (idFixed || fieldsInjected) {
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              }
            } catch {
              // Skip non-JSON data lines silently — don't forward garbage to clients.
              // Upstream providers sometimes return plain-text errors (HTML, rate-limit
              // messages) in the SSE stream that would break downstream JSON decoders.
              continue;
            }
          }

          if (!injectedUsage) {
            if (line.startsWith("data:") && !line.startsWith("data: ")) {
              output = "data: " + line.slice(5) + "\n";
            } else {
              output = line + "\n";
            }
          }

          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          // Responses clients (codex CLI) close on response.completed instead of [DONE]
          if (responsesTerminal) finalizeStream();
          continue;
        }

        // Translate mode
        if (!trimmed) continue;

        const parsed = parseSSELine(trimmed, targetFormat);
        if (!parsed) continue;

        // Responses API same-format passthrough: preserve event framing + track terminal state
        const isOpenAIResponsesStream = targetFormat === FORMATS.OPENAI_RESPONSES;
        const keepsOpenAIResponsesFormat = isOpenAIResponsesStream && sourceFormat === FORMATS.OPENAI_RESPONSES;
        const openAIResponsesEventName = isOpenAIResponsesStream
          ? getOpenAIResponsesEventName(currentOpenAIResponsesEvent, parsed)
          : null;

        if (isOpenAIResponsesStream && isOpenAIResponsesTerminalEvent(openAIResponsesEventName, parsed)) {
          openAIResponsesTerminalSeen = true;
        }

        // For Ollama: done=true is the final chunk with finish_reason/usage, must translate
        // For other formats: done=true is the [DONE] sentinel, skip
        if (parsed && parsed.done && targetFormat !== FORMATS.OLLAMA) {
          // A direct Chat-to-Responses translation can defer response.completed
          // while waiting for a usage trailer. [DONE] ends that opportunity even
          // if the upstream keeps the HTTP connection open, so finish now.
          if (targetFormat === FORMATS.OPENAI && sourceFormat === FORMATS.OPENAI_RESPONSES &&
              state.completionPending && !state.completedSent) {
            flushPendingCompletion(controller);
          }

          // Synthesize response.failed if the Responses stream never sent a terminal event
          if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
            const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
            reqLogger?.appendConvertedChunk?.(failedOutput);
            controller.enqueue(sharedEncoder.encode(failedOutput));
            openAIResponsesTerminalSeen = true;
            sseEmittedCount++;
          }

          if (keepsOpenAIResponsesFormat && !streamDoneSent) {
            const doneOutput = "data: [DONE]\n\n";
            reqLogger?.appendConvertedChunk?.(doneOutput);
            controller.enqueue(sharedEncoder.encode(doneOutput));
          }
          streamDoneSent = true;
          if (keepsOpenAIResponsesFormat) openAIResponsesDoneSent = true;
          continue;
        }

        // Detect and correct native Kimi tool-call markup that leaks into the
        // streamed content instead of being emitted as structured tool_calls.
        // Runs before content accumulation so the stripped prose (not the raw
        // markup) is what gets counted and logged. The markup is only removed
        // when a call can be emitted in the client's own shape
        // (kimiFormatSupported) — otherwise the raw text is preserved rather
        // than deleted with nothing to replace it.
        if (isKimiModel && normalizeKimiToolCalls && kimiFormatSupported && parsed.choices?.[0]?.delta) {
          // An upstream that already sends structured tool_calls is
          // authoritative: any markup left in content is a duplicate of a call
          // the normal pipeline emits, so recovered calls are dropped instead of
          // turning into a second (synthetic) call.
          if (Array.isArray(parsed.choices[0].delta.tool_calls) && parsed.choices[0].delta.tool_calls.length > 0) {
            kimiSawStructuredToolCalls = true;
            kimiToolCalls = null;
          }

          if (typeof parsed.choices[0].delta.content === "string") {
            const gated = gateKimiContent(parsed.choices[0].delta.content, !kimiSawStructuredToolCalls);
            // Replace the raw markup with the safe text; drop it entirely when
            // there is only markup so the client never sees the token soup.
            if (gated) parsed.choices[0].delta.content = gated;
            else delete parsed.choices[0].delta.content;
          }
        }

        // Claude format - content
        if (parsed.delta?.text) {
          totalContentLength += parsed.delta.text.length;
          accumulatedContent += parsed.delta.text;
        }
        // Claude format - thinking
        if (parsed.delta?.thinking) {
          totalContentLength += parsed.delta.thinking.length;
          accumulatedThinking += parsed.delta.thinking;
        }
        
        // OpenAI format - content
        if (parsed.choices?.[0]?.delta?.content) {
          totalContentLength += parsed.choices[0].delta.content.length;
          accumulatedContent += parsed.choices[0].delta.content;
        }
        // OpenAI format - reasoning
        if (parsed.choices?.[0]?.delta?.reasoning_content) {
          totalContentLength += parsed.choices[0].delta.reasoning_content.length;
          accumulatedThinking += parsed.choices[0].delta.reasoning_content;
        }
        
        // Gemini format
        if (parsed.candidates?.[0]?.content?.parts) {
          for (const part of parsed.candidates[0].content.parts) {
            if (part.text && typeof part.text === "string") {
              totalContentLength += part.text.length;
              // Check if this is thinking content
              if (part.thought === true) {
                accumulatedThinking += part.text;
              } else {
                accumulatedContent += part.text;
              }
            }
          }
        }

        // Extract usage
        const extracted = extractUsage(parsed);
        if (extracted) state.usage = mergeUsage(state.usage, extracted); // Keep original usage for logging

        // Responses same-format passthrough: re-emit with original event framing
        if (keepsOpenAIResponsesFormat && openAIResponsesEventName) {
          const output = formatSSE({ event: openAIResponsesEventName, data: parsed }, sourceFormat);
          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          currentOpenAIResponsesEvent = null;
          sseEmittedCount++;
          // Responses clients (codex) close on response.completed instead of [DONE]
          if (openAIResponsesTerminalSeen) finalizeStream();
          continue;
        }

        currentOpenAIResponsesEvent = null;

        // Native Kimi markup produced structured calls but the upstream never
        // sent tool_calls: the terminal chunk is replaced by the synthetic
        // client-shaped tool_calls frame.
        if (handleKimiFinishReplacement(parsed, controller)) {
          continue;
        }

        // Translate: targetFormat -> openai -> sourceFormat
        const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

        logOpenAIIntermediate(translated);

        emitTranslatedItems(controller, translated);

        // The completion deferral can outlive the upstream: a broken chat upstream
        // may stall after finish_reason with no usage trailer and no [DONE], holding
        // the connection open. Bound the wait so the client still gets a terminal event.
        if (targetFormat === FORMATS.OPENAI && sourceFormat === FORMATS.OPENAI_RESPONSES &&
            state?.completionPending && !state?.completedSent && !completionFlushTimer) {
          completionFlushTimer = setTimeout(() => {
            completionFlushTimer = null;
            if (state?.completedSent) return;
            try { flushPendingCompletion(controller); } catch { /* controller already closed */ }
          }, PENDING_COMPLETION_FLUSH_MS);
        }
      }
    },

    flush(controller) {
      const evtSummary = Object.entries(eventTypeCounts).map(([k, v]) => `${k}=${v}`).join(",") || "none";
      dbg("SSE", `flush | provider=${provider} | model=${model} | recvLines=${sseLineCount} | emitted=${sseEmittedCount} | events=[${evtSummary}]`);
      trackPendingRequest(model, provider, connectionId, false);
      try {
        const remaining = decoder.decode();
        if (remaining) buffer += remaining;

        if (mode === STREAM_MODE.PASSTHROUGH) {
          if (buffer) {
            let output = buffer;
            if (buffer.startsWith("data:") && !buffer.startsWith("data: ")) {
              output = "data: " + buffer.slice(5);
            }
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }

          // IMPORTANT: In passthrough mode we still must terminate the SSE stream.
          // Some clients (e.g. OpenClaw) expect the OpenAI-style sentinel:
          //   data: [DONE]\n\n
          // Without it they can hang until timeout and trigger failover.
          // Gemini-family clients (Antigravity, Vertex, Gemini) reject this sentinel with 400 syntax errors.
          const isGeminiFamily = provider === "antigravity" || provider === "gemini" || provider === "vertex";
          if (!streamDoneSent && !isGeminiFamily) {
            const doneOutput = "data: [DONE]\n\n";
            reqLogger?.appendConvertedChunk?.(doneOutput);
            controller.enqueue(sharedEncoder.encode(doneOutput));
          }

          finalizeStream();
          return;
        }

        if (buffer.trim()) {
          // Same parse as the transform loop: without targetFormat this only
          // accepts "data: " lines, so an NDJSON provider (Ollama) lost whatever
          // arrived without its closing newline.
          const parsed = parseSSELine(buffer.trim(), targetFormat);
          // parseSSELine turns the SSE sentinel "data: [DONE]" into { done: true },
          // which must not be translated. An Ollama chunk also carries done:true,
          // but it is the real final chunk — it holds finish_reason and the token
          // counts — so it has to go through.
          const isDoneSentinel = parsed?.done && targetFormat !== FORMATS.OLLAMA;
          if (parsed && !isDoneSentinel) {
            // Same accumulation the transform loop does, so finalizeStream() can
            // log a tail chunk's tokens instead of falling back to null.
            const extracted = extractUsage(parsed);
            if (extracted) state.usage = mergeUsage(state.usage, extracted);

            const replaced = handleKimiFinishReplacement(parsed, controller);

            if (!replaced) {
              const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

              if (translated?._openaiIntermediate) {
                for (const item of translated._openaiIntermediate) {
                  const openaiOutput = formatSSE(item, FORMATS.OPENAI);
                  reqLogger?.appendOpenAIChunk?.(openaiOutput);
                }
              }

              if (translated?.length > 0) {
                for (const item of translated) {
                  if (item === null || item === undefined) continue;
                  const output = formatSSE(item, sourceFormat);
                  reqLogger?.appendConvertedChunk?.(output);
                  controller.enqueue(sharedEncoder.encode(output));
                }
              }
            }
          }
        }

        // Native Kimi markup resolution: release whatever the content gate was
        // still holding and emit the recovered call BEFORE the terminal events
        // below, so the client sees the tool call inside the turn. Held text that
        // never became a call, plus a terminal that was held back with it, are
        // resolved here too — no content and no finish boundary is lost.
        flushKimiMarkup(controller);

        const flushed = translateResponse(targetFormat, sourceFormat, null, state);

        if (flushed?._openaiIntermediate) {
          for (const item of flushed._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (flushed?.length > 0) {
          for (const item of flushed) {
            if (item === null || item === undefined) continue;
            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }
        }

        // Synthesize response.failed if a Responses passthrough stream never reached a terminal event
        const keepsOpenAIResponsesFormat = targetFormat === FORMATS.OPENAI_RESPONSES && sourceFormat === FORMATS.OPENAI_RESPONSES;
        if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
          const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
          reqLogger?.appendConvertedChunk?.(failedOutput);
          controller.enqueue(sharedEncoder.encode(failedOutput));
          openAIResponsesTerminalSeen = true;
        }

        if (keepsOpenAIResponsesFormat && !openAIResponsesDoneSent && !streamDoneSent) {
          const doneOutput = "data: [DONE]\n\n";
          reqLogger?.appendConvertedChunk?.(doneOutput);
          controller.enqueue(sharedEncoder.encode(doneOutput));
          openAIResponsesDoneSent = true;
          streamDoneSent = true;
        }

        finalizeStream();
      } catch (error) {
        console.log("Error in flush:", error);
        finalizeStream();
      }
    }
  });
}

export function createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider = null, reqLogger = null, toolNameMap = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, customToolNames = null, credentials = null, normalizeKimiToolCalls = null) {
  return createSSEStream({
    mode: STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider,
    reqLogger,
    toolNameMap,
    customToolNames,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
    credentials,
    normalizeKimiToolCalls
  });
}

export function createPassthroughStreamWithLogger(provider = null, reqLogger = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, normalizeKimiToolCalls = null, toolNameMap = null) {
  return createSSEStream({
    mode: STREAM_MODE.PASSTHROUGH,
    provider,
    reqLogger,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
    normalizeKimiToolCalls,
    toolNameMap
  });
}
