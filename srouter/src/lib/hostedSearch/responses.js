import { CodexExecutor } from "open-sse/executors/codex.js";
import { DefaultExecutor } from "open-sse/executors/default.js";
import REGISTRY from "open-sse/providers/registry/index.js";
import { HOSTED_TOOLS_WIP, HOSTED_TOOLS_WIP_MESSAGE } from "@/shared/constants/hostedTools.js";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

// Consume native Responses, not Chat Completions: the Codex executor supplies
// account headers and switches Responses Lite off when web_search is present.
export async function searchResponses({ query, model, credentials, signal, providerId }) {
  if (HOSTED_TOOLS_WIP) return { status: 503, error: HOSTED_TOOLS_WIP_MESSAGE };
  const executor = providerId === "codex" ? new CodexExecutor() : new DefaultExecutor("openai");
  const runtimeTransport = providerId === "openai"
    ? REGISTRY.find((provider) => provider.id === "openai")?.transports?.find((transport) => transport.format === "openai-responses")
    : null;
  if (providerId !== "codex" && !runtimeTransport) throw new Error("No registered Responses transport");
  const { response } = await executor.execute({
    model, stream: true, credentials: runtimeTransport ? { ...credentials, runtimeTransport } : credentials, signal,
    body: {
      model, stream: true, store: false,
      input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
      tools: [{ type: "web_search" }],
      tool_choice: "required",
      include: ["web_search_call.action.sources"],
    },
  });
  if (!response.ok) return { status: response.status, error: `Hosted search returned HTTP ${response.status}` };
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty Responses stream");
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  let completed = null;
  const consumeLine = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    const event = JSON.parse(payload);
    if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") {
      throw new Error("Hosted search did not complete");
    }
    if (event.type === "response.completed") completed = event.response;
  };
  const abort = () => { void reader.cancel(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new Error("Hosted search timed out");
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Responses stream too large");
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        consumeLine(line);
      }
    }
    consumeLine((buffer + decoder.decode()).trim());
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!completed || completed.status === "failed" || completed.status === "incomplete") {
    throw new Error("Missing completed Responses stream");
  }
  const results = new Map();
  const texts = [];
  for (const item of completed.output || []) {
    for (const source of item.action?.sources || []) {
      if (source.url) results.set(source.url, { url: source.url, title: source.title || "", snippet: "" });
    }
    for (const part of item.content || []) {
      if (part.type === "output_text") texts.push(part.text || "");
      for (const annotation of part.annotations || []) {
        if (annotation.type === "url_citation" && annotation.url) {
          results.set(annotation.url, { url: annotation.url, title: annotation.title || "", snippet: part.text || "" });
        }
      }
    }
  }
  // Text alone is not evidence that a hosted search ran.
  if (!(completed.output || []).some((item) => item.type === "web_search_call")) {
    throw new Error("Provider did not execute the hosted search tool");
  }
  return { results: [...results.values()], answer: texts.join("\n"), usage: completed.usage || {} };
}
