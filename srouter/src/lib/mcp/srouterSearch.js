import { getSettings } from "@/lib/localDb";
import { extractApiKey, getApiKeyInfo } from "@/sse/services/auth";
import { checkKindAccess } from "@/sse/services/requestAccess";
import { handleSearch } from "@/sse/handlers/search";
import { handleFetch } from "@/sse/handlers/fetch";
import { readBoundedJson, readBoundedText } from "@/sse/utils/boundedBody";
import { normalizeSrouterSearch } from "@/shared/utils/srouterSearchConfig";
import { EXTRA_TOOLS, extraToolDefinitions, callExtraTool } from "./srouterSearchExtraTools";

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const TOOL_KINDS = { srouter_web_search: "webSearch", srouter_web_fetch: "webFetch" };
const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
const rpcError = (id, code, message, status = 200) => json({ jsonrpc: "2.0", id, error: { code, message } }, status);
const toolError = (message) => ({ isError: true, content: [{ type: "text", text: message }] });

function tools(config, info) {
  const result = [];
  const provider = { type: "string", maxLength: 200, description: "SRouter provider ID or combo name. Omit to use the configured default." };
  if (config.searchEnabled && !checkKindAccess(info, "webSearch")) {
    result.push({
      name: "srouter_web_search",
      description: "Search the web using an existing SRouter provider or combo. Returns search results; chat adapters may normalize an LLM answer into sources.",
      inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: {
        query: { type: "string", minLength: 1, maxLength: 10000 },
        provider,
        max_results: { type: "integer", minimum: 1, maximum: config.maxResults },
      } },
    });
  }
  if (config.fetchEnabled && !checkKindAccess(info, "webFetch")) {
    result.push({
      name: "srouter_web_fetch",
      description: "Extract a public web URL through an existing SRouter fetch provider or combo. Private/internal targets are blocked by SRouter.",
      inputSchema: { type: "object", additionalProperties: false, required: ["url"], properties: {
        url: { type: "string", minLength: 1, maxLength: 8192 },
        provider,
        format: { type: "string", enum: ["text", "markdown"] },
        max_characters: { type: "integer", minimum: 1, maximum: config.maxCharacters },
      } },
    });
  }
  return [...result, ...extraToolDefinitions(config, info)];
}

async function callTool(request, params, config, info) {
  const name = params?.name;
  if (Object.hasOwn(EXTRA_TOOLS, name)) return callExtraTool(request, params, config, info);
  if (!Object.hasOwn(TOOL_KINDS, name)) return toolError("Unknown tool");
  const search = name === "srouter_web_search";
  if (!(search ? config.searchEnabled : config.fetchEnabled)) return toolError("Tool is disabled");
  if (checkKindAccess(info, TOOL_KINDS[name])) return toolError("Tool is not allowed for this API key");
  const args = params.arguments ?? {};
  if (!args || typeof args !== "object" || Array.isArray(args)) return toolError("Tool arguments must be an object");
  const allowed = search ? ["query", "provider", "max_results"] : ["url", "provider", "format", "max_characters"];
  if (Object.keys(args).some((key) => !allowed.includes(key))) return toolError("Unknown tool argument");
  const value = search ? args.query : args.url;
  if (typeof value !== "string" || !value.trim() || value.length > (search ? 10000 : 8192)) return toolError(search ? "Invalid query" : "Invalid URL");
  const provider = args.provider ?? (search ? config.searchProvider : config.fetchProvider);
  if (typeof provider !== "string" || !provider.trim() || provider.length > 200 || /[\x00-\x1f]/.test(provider)) return toolError("Choose a provider/combo or configure a default");
  const limit = search ? config.maxResults : config.maxCharacters;
  const count = args[search ? "max_results" : "max_characters"] ?? limit;
  if (!Number.isInteger(count) || count < 1 || count > limit) return toolError(`Requested limit must be between 1 and ${limit}`);
  if (!search && args.format !== undefined && !["text", "markdown"].includes(args.format)) return toolError("Unsupported output format");
  const body = search
    ? { provider, query: value, max_results: count }
    : { provider, url: value, format: args.format || "markdown", max_characters: count };
  // Only forward the caller's API key, never dashboard/internal trust headers.
  const forwarded = new Request(new URL(search ? "/api/v1/search" : "/api/v1/web/fetch", request.url), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${extractApiKey(request)}` },
    body: JSON.stringify(body),
    signal: request.signal,
  });
  try {
    const response = await (search ? handleSearch : handleFetch)(forwarded);
    // Upstream error text can contain credentials; expose only the status.
    if (!response.ok) {
      await response.body?.cancel();
      return toolError(`SRouter ${search ? "search" : "fetch"} failed (HTTP ${response.status})`);
    }
    if (!response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel();
      return toolError("This tool requires a JSON result");
    }
    const { raw, error } = await readBoundedText(response, 1024 * 1024);
    if (error) return toolError("Result exceeds the MCP output limit or could not be read");
    JSON.parse(raw);
    return { content: [{ type: "text", text: raw }] };
  } catch {
    return toolError("SRouter could not complete the request");
  }
}

export async function handleSrouterSearchMcp(request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return rpcError(null, -32001, "Cross-origin MCP request blocked", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return rpcError(null, -32600, "Content-Type must be application/json", 415);
  // A real API key is mandatory, independent of optional-key/trusted-local HTTP modes.
  const key = extractApiKey(request);
  const info = key ? await getApiKeyInfo(key) : null;
  if (!info) return rpcError(null, -32001, "A valid SRouter API key is required", 401);
  const config = normalizeSrouterSearch((await getSettings()).srouterSearch);
  if (!config.enabled) return rpcError(null, -32000, "SRouterSearch MCP is disabled", 503);
  const { body, error } = await readBoundedJson(request, 64 * 1024);
  if (error) return rpcError(null, -32700, "Invalid or oversized JSON body", error.status);
  if (!body || Array.isArray(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string" ||
    (Object.hasOwn(body, "id") && body.id !== null && typeof body.id !== "string" && typeof body.id !== "number")) {
    return rpcError(null, -32600, "Invalid JSON-RPC request", 400);
  }
  const id = body.id;
  if (!Object.hasOwn(body, "id")) {
    if (body.method === "notifications/initialized" || body.method === "notifications/cancelled") return new Response(null, { status: 202 });
    return rpcError(null, -32600, "Unsupported notification", 400);
  }
  const version = request.headers.get("mcp-protocol-version");
  if (version && !VERSIONS.includes(version)) return rpcError(id, -32600, "Unsupported MCP protocol version", 400);
  let result;
  switch (body.method) {
    case "initialize":
      result = {
        protocolVersion: VERSIONS.includes(body.params?.protocolVersion) ? body.params.protocolVersion : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "SRouterSearch", version: "1.0.0" },
        instructions: "Use saved SRouter providers or combos. Provider credentials remain in SRouter. This server is stateless and supports JSON responses, not SSE subscriptions.",
      };
      break;
    case "ping": result = {}; break;
    case "tools/list": result = { tools: tools(config, info) }; break;
    case "tools/call": result = await callTool(request, body.params, config, info); break;
    default: return rpcError(id, -32601, "Method not found");
  }
  return json({ jsonrpc: "2.0", id, result });
}
