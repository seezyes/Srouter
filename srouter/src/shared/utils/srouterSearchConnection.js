export function getSrouterSearchConnection(origin) {
  const endpoint = `${origin}/v1/mcp/search`;
  const example = JSON.stringify({
    mcpServers: {
      SrouterSearch: {
        type: "http",
        url: endpoint,
        headers: { Authorization: "Bearer <SROUTER_API_KEY>" },
      },
    },
  }, null, 2);
  const agentPrompt = `Help me connect SrouterSearch MCP to the harness you are running in.
Server name: SrouterSearch
Endpoint: ${endpoint}
Transport: MCP Streamable HTTP (stateless JSON responses). Not legacy SSE or local STDIO.
Authentication: Authorization: Bearer <SROUTER_API_KEY>, using an active SRouter API key, not a provider key.
Ask me to supply the key securely; never print it or put it in chat, logs or a URL.
Inspect this harness's documented MCP config format and supported HTTP/auth options before editing.
Preserve existing MCP servers. Ask permission before changing harness configuration.
If its UI accepts only a URL, use its supported config/CLI to add the Authorization header.
If the harness only supports STDIO or legacy SSE, explain that a separately configured bridge is required; do not invent a native command or /sse endpoint.
The endpoint must be reachable from the harness. A localhost URL works only on the same machine; do not expose ports or tunnels without explicit permission.
In SRouter, enable MCP and the desired tools, then click Save settings. Reconnect the harness and verify initialize and tools/list.
Available tools (subject to enabled toggles and API key permissions): srouter_web_search, srouter_web_fetch, srouter_fetch, srouter_smart_search, srouter_deep_search.
Search/Web Fetch use configured providers or combos; without a default supply provider in each call.
Smart/Deep call a configured model/combo, not an automatic web retrieval or research agent loop.
Report actual verification results and errors. Do not claim a connection works from config alone.`;
  return { endpoint, example, agentPrompt };
}
