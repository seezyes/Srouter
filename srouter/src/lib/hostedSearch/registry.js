import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";
import { AI_PROVIDERS } from "@/shared/constants/providers.js";
import REGISTRY from "open-sse/providers/registry/index.js";
import { normalizeSearchResponse } from "open-sse/handlers/search/normalizers.js";
import { CHAT_SEARCH_CONFIG } from "open-sse/handlers/search/chatSearch.js";
import { getHostedSearchPlugins } from "./plugins.js";
import { HOSTED_TOOLS_WIP, HOSTED_TOOLS_WIP_MESSAGE } from "@/shared/constants/hostedTools.js";

export const HOSTED_SEARCH_PLUGIN_DIR = path.join(DATA_DIR, "plugins", "hosted-search");
const TIMEOUT_MS = 60000;
const MAX_RESULTS = 50;

export async function getHostedSearchAdapters() {
  const adapters = new Map();
  for (const provider of Object.values(AI_PROVIDERS)) {
    if (provider.searchViaChat && CHAT_SEARCH_CONFIG[provider.id] && (provider.serviceKinds || ["llm"]).includes("llm")) {
      adapters.set(`builtin:${provider.id}`, {
        id: `builtin:${provider.id}`, name: `${provider.name} hosted search`,
        providerIds: [provider.id], defaultModel: provider.searchViaChat.defaultModel || "", legacy: true,
      });
    }
  }
  const codex = REGISTRY.find((entry) => entry.id === "codex");
  if (codex) {
    adapters.set("builtin:codex", {
      id: "builtin:codex", name: "Codex native web_search", providerIds: ["codex"],
      defaultModel: codex.models.find((model) => !model.kind && !model.id.includes("review"))?.id || "",
    });
  }
  const openai = REGISTRY.find((entry) => entry.id === "openai");
  if (openai?.transports?.some((transport) => transport.format === "openai-responses")) {
    adapters.set("builtin:openai", {
      id: "builtin:openai", name: "OpenAI native web_search", providerIds: ["openai"],
      defaultModel: openai.models.find((model) => !model.kind && !model.targetFormat)?.id || "",
    });
  }
  for (const [id, plugin] of await getHostedSearchPlugins()) adapters.set(id, plugin);
  return adapters;
}

export function adapterSupportsProvider(adapter, providerId) {
  return !!adapter && (adapter.providerIds.includes("*") || adapter.providerIds.includes(providerId));
}

export async function getHostedSearchMetadata() {
  const adapters = await getHostedSearchAdapters();
  return [...adapters.values()].filter((adapter) => !HOSTED_TOOLS_WIP || adapter.id.startsWith("plugin:"))
    .map(({ id, name, providerIds, defaultModel }) => ({
    id, name, providerIds, ...(defaultModel !== undefined ? { defaultModel } : {}),
    kind: id.startsWith("plugin:") ? "local-plugin" : "builtin",
  }));
}

export async function runHostedSearch({ adapter, body, provider, credentials, attributionId, model }) {
  const isPlugin = typeof adapter?.id === "string" && adapter.id.startsWith("plugin:");
  if (HOSTED_TOOLS_WIP && !isPlugin) {
    return { success: false, status: 503, error: HOSTED_TOOLS_WIP_MESSAGE,
      response: Response.json({ error: { message: HOSTED_TOOLS_WIP_MESSAGE } }, { status: 503 }) };
  }
  const startTime = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let abort;
  try {
    const query = body.query.normalize("NFKC").trim().replace(/\s+/g, " ");
    if (!query || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(query)) throw new Error("Invalid query");
    const maxResults = Math.min(MAX_RESULTS, Math.max(1, Number.isFinite(body.max_results) ? Math.floor(body.max_results) : 5));
    const search = ["builtin:codex", "builtin:openai"].includes(adapter.id)
      ? (await import("./responses.js")).searchResponses : adapter.search;
    if (typeof search !== "function") throw new Error("Missing hosted search implementation");
    const timeout = new Promise((_, reject) => {
      abort = () => reject(new Error("Hosted search timed out"));
      controller.signal.addEventListener("abort", abort, { once: true });
      if (controller.signal.aborted) abort();
    });
    // Plugins do not receive the caller's body/provider_options, code paths or
    // credentials of other accounts. This is least exposure, not a sandbox.
    const output = await Promise.race([
      search({ query, maxResults, ...(isPlugin ? {} : { model }), providerId: provider.id, credentials, signal: controller.signal }),
      timeout,
    ]);
    if (output?.error) {
      const status = Number.isInteger(output.status) && output.status >= 400 && output.status <= 599 ? output.status : 502;
      return { success: false, status, error: "Hosted search adapter failed", response: Response.json({ error: { message: "Hosted search adapter failed" } }, { status }) };
    }
    if (!output || !Array.isArray(output.results)) throw new Error("Invalid plugin result");
    const normalized = normalizeSearchResponse(
      { id: attributionId, normalizer: "custom-json" }, { results: output.results }, query, "web"
    );
    const data = {
      provider: attributionId, query, results: normalized.results.slice(0, maxResults),
      answer: { source: attributionId, text: typeof output.answer === "string" ? output.answer : "", ...(isPlugin ? {} : { model }) },
      usage: { queries_used: 1, search_cost_usd: null, llm_tokens: Number(output.usage?.total_tokens) || 0 },
      metrics: {
        response_time_ms: Date.now() - startTime,
        upstream_latency_ms: Date.now() - startTime,
        total_results_available: normalized.totalResults,
      },
      errors: [],
    };
    return { success: true, response: Response.json(data, { headers: { "Access-Control-Allow-Origin": "*" } }) };
  } catch {
    const status = controller.signal.aborted ? 504 : 502;
    // Arbitrary plugin exceptions may contain credentials, never return them.
    const error = status === 504 ? "Hosted search timed out" : "Hosted search adapter failed";
    return { success: false, status, error, response: Response.json({ error: { message: error } }, { status }) };
  } finally {
    clearTimeout(timer);
    if (abort) controller.signal.removeEventListener("abort", abort);
  }
}
