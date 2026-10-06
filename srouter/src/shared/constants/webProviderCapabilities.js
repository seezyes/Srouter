// Official service capabilities are not automatically implemented by SRouter.
// T-0041, 2026-10-03: per-provider research evidence in the shared workspace.
// Smart Search specifically requires reasoning-off; general cited answers are
// therefore conditional unless the reviewed contract makes that distinction.
const item = (type, note, sources, status = "documented") => ({
  type, note, sources: Array.isArray(sources) ? sources : [sources], status,
});
const entry = (serviceTools, possibleConnections) => ({ serviceTools, possibleConnections });
const OPENAI_SEARCH = "https://developers.openai.com/api/docs/guides/tools-web-search";
const GEMINI_SEARCH = "https://ai.google.dev/gemini-api/docs/google-search";
const EXA_SEARCH = "https://docs.exa.ai/reference/search";
const EXA_MCP = "https://docs.exa.ai/reference/exa-mcp";
const YOU_MCP = "https://docs.you.com/agents/mcp-server";
const PPLX_PRESETS = "https://docs.perplexity.ai/docs/agent-api/presets";
const GLM_SEARCH = "https://docs.z.ai/guides/tools/web-search";
const KIMI_SEARCH = "https://platform.kimi.ai/docs/guide/use-web-search";
const MINIMAX_SEARCH = "https://platform.minimax.io/docs/guides/server-tools";
const XAI_SEARCH = "https://docs.x.ai/developers/tools/web-search";
const LINKUP_SEARCH = "https://docs.linkup.so/pages/documentation/endpoints/search/overview";
const PARALLEL_SEARCH = "https://docs.parallel.ai/api-reference/search/search";
const OCTEN_SEARCH = "https://docs.octen.ai/api-reference/search";
const NIMBLE_SEARCH = "https://docs.nimbleway.com/nimble-sdk/web-tools/search";
const KEENABLE_SEARCH = "https://docs.keenable.ai/api-reference/search";

export const WEB_PROVIDER_CAPABILITIES = {
  antigravity: entry([
    item("webSearch", "Google Search grounding through the Antigravity agent; no public standalone search API is documented.", ["https://antigravity.google/docs/home/", GEMINI_SEARCH], "conditional"),
    item("deepSearch", "Agent/browser research is described by the product; a third-party deep-research backend contract is not published.", "https://antigravity.google/docs/home/", "conditional"),
  ], [
    item("oauth", "Google-account authentication exists; third-party access to the IDE backend remains an unpublished contract.", "https://antigravity.google/docs/home/", "conditional"),
    item("hostedTool", "Account-bound Antigravity agent tools are a future backend surface, not the public Gemini API. External tool access must be verified.", "https://antigravity.google/docs/home/", "conditional"),
    item("chat", "Antigravity provides agent-chat clients; this is not a public chat/search API contract.", "https://antigravity.google/docs/home/", "conditional"),
  ]),
  gemini: entry([
    item("webSearch", "Google Search grounding returns a generated answer and citations rather than a standalone SERP response.", GEMINI_SEARCH, "conditional"),
    item("webFetch", "URL context reads supplied pages into model context; a standalone clean Markdown export still needs an adapter.", "https://ai.google.dev/gemini-api/docs/url-context", "conditional"),
    item("smartSearch", "Grounded summaries are available; a reasoning-off mode depends on the selected model and thinking controls.", GEMINI_SEARCH, "conditional"),
    item("deepSearch", "Thinking models can combine grounding and URL context; an agent workflow is separate configuration.", ["https://ai.google.dev/gemini-api/docs/thinking", GEMINI_SEARCH], "conditional"),
  ], [item("api", "Gemini API key for Google Search grounding and URL context.", GEMINI_SEARCH)]),
  openai: entry([
    item("webSearch", "Responses web_search returns search actions and cited results.", OPENAI_SEARCH),
    item("smartSearch", "The guide explicitly distinguishes non-reasoning web search for fast answers.", OPENAI_SEARCH),
    item("deepSearch", "Reasoning-model agentic search and long-running deep research are documented.", OPENAI_SEARCH),
    item("webFetch", "open_page/find_in_page read pages inside the search tool; no standalone clean-text export is documented.", OPENAI_SEARCH, "conditional"),
  ], [
    item("api", "Platform API key; Responses hosted search and Chat Completions search have different request contracts.", OPENAI_SEARCH),
    item("chat", "A ChatGPT account is separate from Platform API billing; a web-chat adapter requires separate verification.", "https://developers.openai.com/codex/web-search", "conditional"),
    item("hostedTool", "Codex has a first-party account/client search tool. Direct reuse of its proprietary backend is a future idea, not a published integration contract.", "https://developers.openai.com/codex/web-search", "conditional"),
  ]),
  glm: entry([
    item("webSearch", "Structured Web Search API results and webSearchPrime MCP are documented.", GLM_SEARCH),
    item("webFetch", "webReader MCP extracts webpage content, metadata and links.", "https://docs.z.ai/devpack/mcp/reader-mcp-server"),
    item("smartSearch", "Web Search in Chat can synthesize answers; reasoning-off behavior must be verified for the chosen model.", GLM_SEARCH, "conditional"),
    item("deepSearch", "Search Agent is referenced; its reasoning/agent contract needs further verification.", GLM_SEARCH, "conditional"),
  ], [
    item("api", "Z.AI API keys and Coding Plan MCP keys have separate entitlements.", [GLM_SEARCH, "https://docs.z.ai/devpack/mcp/search-mcp-server"]),
    item("oauth", "SRouter has dual-auth coding connections; OAuth entitlement for standalone web tools is not confirmed.", "https://docs.z.ai/devpack/overview", "conditional"),
  ]),
  kimi: entry([
    item("webSearch", "Standalone search/search_pro APIs return structured results and optional page content.", "https://platform.kimi.ai/docs/api/tools-search"),
    item("webFetch", "A page-fetch tool is referenced, but clean-text/Markdown output must be verified before integration.", KIMI_SEARCH, "conditional"),
    item("smartSearch", "Built-in search can produce answers; models that always reason do not satisfy Smart Search's reasoning-off contract.", KIMI_SEARCH, "conditional"),
    item("deepSearch", "Reasoning with built-in search is possible; no separate agentic research contract was verified.", KIMI_SEARCH, "conditional"),
  ], [
    item("api", "Moonshot API-key access to chat and standalone tools.", "https://platform.kimi.ai/docs/api/tools-search"),
    item("oauth", "Coding-account OAuth and standalone search-tool entitlements are different surfaces.", KIMI_SEARCH, "conditional"),
  ]),
  minimax: entry([
    item("webSearch", "Server web_search embeds source results in model responses; a standalone ranked-results endpoint is not documented.", MINIMAX_SEARCH, "conditional"),
    item("smartSearch", "Cited answers are available, but reasoning-off support is model-dependent and cannot be assumed for M2-family models.", [MINIMAX_SEARCH, "https://platform.minimax.io/docs/api-reference/text-chat-openai"], "conditional"),
    item("deepSearch", "Reasoning models and server search are available; a separate agentic research mode needs verification.", [MINIMAX_SEARCH, "https://platform.minimax.io/docs/api-reference/text-chat-openai"], "conditional"),
  ], [item("api", "Server search is documented on Messages/Responses; Token Plan MCP is another keyed surface.", [MINIMAX_SEARCH, "https://platform.minimax.io/docs/token-plan/mcp-guide"])]),
  perplexity: entry([
    item("webSearch", "Search API exposes ranked results independently of generated answers.", "https://docs.perplexity.ai/docs/search/quickstart"),
    item("webFetch", "Agent fetch_url extracts content from known URLs.", "https://docs.perplexity.ai/docs/agent-api/tools/fetch-url-content"),
    item("smartSearch", "Agent fast preset has reasoning effort none; availability depends on the selected API surface.", PPLX_PRESETS),
    item("deepSearch", "Research presets support multi-step search and reasoning.", PPLX_PRESETS),
  ], [item("api", "Perplexity API key; Sonar, Search API and Agent API contracts differ.", "https://docs.perplexity.ai/docs/agent-api/quickstart")]),
  "perplexity-agent": entry([
    item("webSearch", "Agent web_search produces source results plus a cited answer.", "https://docs.perplexity.ai/docs/agent-api/tools/web-search"),
    item("webFetch", "fetch_url extracts known-URL content with explicit failure markers.", "https://docs.perplexity.ai/docs/agent-api/tools/fetch-url-content"),
    item("smartSearch", "The fast preset explicitly requests reasoning effort none.", PPLX_PRESETS),
    item("deepSearch", "Higher-effort presets provide multi-hop browsing and agentic research.", PPLX_PRESETS),
  ], [item("api", "API-key access through the Agent API; model/tool/preset entitlements still apply.", "https://docs.perplexity.ai/docs/agent-api/quickstart")]),
  xai: entry([
    item("webSearch", "Responses web_search searches and browses web pages; x_search is a separate X tool.", XAI_SEARCH),
    item("webFetch", "The search tool can browse pages, but standalone clean-text extraction is not documented.", XAI_SEARCH, "conditional"),
    item("smartSearch", "Grounded model answers are available; a reasoning-model example is not proof of reasoning-off support.", XAI_SEARCH, "conditional"),
    item("deepSearch", "Reasoning with search is available; a dedicated deep-research endpoint was not verified.", XAI_SEARCH, "conditional"),
  ], [
    item("api", "xAI API-key access to the Responses web search tool.", XAI_SEARCH),
    item("oauth", "Grok Build/account transports are separate from xAI API keys; search entitlement needs verification.", XAI_SEARCH, "conditional"),
  ]),
  "brave-search": entry([
    item("webSearch", "Independent-index web/news/image/video/place search and query-driven LLM Context.", "https://api-dashboard.search.brave.com/documentation"),
    item("smartSearch", "Answers supplies cited synthesis; single-search mode alone does not guarantee reasoning off.", "https://api-dashboard.search.brave.com/documentation/services/answers", "conditional"),
    item("deepSearch", "Answers research mode performs iterative multi-search answering and requires its plan.", "https://api-dashboard.search.brave.com/documentation/services/answers"),
  ], [item("api", "Brave subscription API key. A self-hosted MCP wrapper is not an account-hosted proprietary backend.", "https://api-dashboard.search.brave.com/documentation")]),
  exa: entry([
    item("webSearch", "Search modes provide ranked results, highlights and optional content.", EXA_SEARCH),
    item("webFetch", "Contents extracts known URLs as clean text/Markdown and optional summaries.", "https://docs.exa.ai/reference/contents"),
    item("smartSearch", "Summaries and structured synthesis exist; a reasoning-off guarantee is not established for every mode.", [EXA_SEARCH, "https://docs.exa.ai/reference/contents"], "conditional"),
    item("deepSearch", "Exa Agent performs multi-step research; deep-reasoning search is a separate contract.", [EXA_SEARCH, "https://docs.exa.ai/reference/agent-api"]),
  ], [
    item("api", "REST API key; no MCP/OAuth integration is activated by these badges.", EXA_SEARCH),
    item("oauth", "Hosted MCP Agent supports account OAuth; REST remains API-key based.", EXA_MCP),
    item("free", "Rate-limited keyless MCP Search/Fetch; Agent runs require authentication.", EXA_MCP),
    item("hostedTool", "Exa Agent runs as a vendor-hosted tool with account/API authentication; future SRouter integration.", EXA_MCP),
  ]),
  "google-pse": entry([
    item("webSearch", "Programmable Search Engine web/image JSON results require an engine ID and API key.", "https://developers.google.com/custom-search/v1/overview"),
  ], [item("api", "Google API key plus search-engine cx; account access alone is insufficient.", "https://developers.google.com/custom-search/v1/overview")]),
  linkup: entry([
    item("webSearch", "Search returns ranked results with selectable depth.", LINKUP_SEARCH),
    item("webFetch", "Fetch is documented as URL-to-LLM-ready Markdown extraction.", "https://docs.linkup.so/"),
    item("smartSearch", "sourcedAnswer/structured output generates a summary; exact reasoning-off behavior is not confirmed.", LINKUP_SEARCH, "conditional"),
    item("deepSearch", "Research is an autonomous asynchronous agent; deep Search is multi-iteration.", "https://docs.linkup.so/pages/documentation/endpoints/research/overview"),
  ], [item("api", "Linkup API key; agent tool definitions do not establish a separate hosted account transport.", LINKUP_SEARCH)]),
  searchapi: entry([
    item("webSearch", "Multiple SERP engines return rich structured search data.", "https://www.searchapi.io/docs/google"),
    item("smartSearch", "AI-answer engines proxy third-party model output; reasoning-off synthesis is not a verified contract.", "https://www.searchapi.io/integrations/mcp", "conditional"),
  ], [
    item("api", "REST API key or MCP token are keyed access surfaces.", "https://www.searchapi.io/docs/google"),
    item("oauth", "MCP clients can sign in and authorize an account integration.", "https://www.searchapi.io/integrations/mcp"),
    item("hostedTool", "Account-authorized vendor MCP search tools; this surface is not wired into SRouter.", "https://www.searchapi.io/integrations/mcp"),
  ]),
  serper: entry([
    item("webSearch", "Google Search/News/Image/Maps/Places and other SERP endpoints.", "https://serper.dev/"),
  ], [item("api", "Serper API key; free credits still require a key.", "https://serper.dev/")]),
  youcom: entry([
    item("webSearch", "Search returns web/news results and optional extraction.", "https://docs.you.com/api-reference/search"),
    item("webFetch", "Contents returns page Markdown/HTML/metadata.", "https://docs.you.com/api-reference/contents"),
    item("fetch", "Contents can return HTML, but service crawling is not guaranteed to be an unmodified raw HTTP GET.", "https://docs.you.com/api-reference/contents", "conditional"),
    item("smartSearch", "Answer produces cited synthesis; reasoning-off execution must be verified separately.", "https://docs.you.com/api-reference/answer", "conditional"),
    item("deepSearch", "Research performs multi-search, multi-step reasoning with selectable effort.", "https://docs.you.com/api-reference/research"),
  ], [
    item("api", "REST API key.", "https://docs.you.com/api-reference/search"),
    item("oauth", "Remote MCP supports account OAuth; the local package does not.", YOU_MCP),
    item("free", "The keyless MCP free profile exposes a restricted Search/Discovery subset, not paid Research.", YOU_MCP),
    item("hostedTool", "Account-authenticated remote MCP exposes vendor Search/Contents/Research tools.", YOU_MCP),
  ]),
  xquik: entry([
    item("webSearch", "Searches X posts and related entities, not a general web index.", "https://docs.xquik.com/api-reference/overview"),
    item("webFetch", "Single X-entity retrieval is available; it is not a generic page-to-Markdown extractor.", "https://docs.xquik.com/api-reference/overview", "conditional"),
  ], [
    item("api", "Xquik account API key; public reads still require credits.", "https://docs.xquik.com/api-reference/overview"),
    item("oauth", "Account-scoped OAuth is documented; applicability to the existing public-search adapter needs verification.", "https://docs.xquik.com/api-reference/overview", "conditional"),
  ]),
  firecrawl: entry([
    item("webFetch", "Scrape converts known URLs to clean Markdown/text, with rendering and parsing.", "https://docs.firecrawl.dev/api-reference/endpoint/scrape"),
    item("webSearch", "Search returns ranked results and optional scraped page content.", "https://docs.firecrawl.dev/api-reference/endpoint/search"),
    item("deepSearch", "Agent performs agentic data extraction; a general research-report contract is not established.", "https://docs.firecrawl.dev/api-reference/endpoint/agent", "conditional"),
  ], [
    item("api", "API-key access; Agent/Extract require authentication.", "https://docs.firecrawl.dev/capabilities"),
    item("free", "The documented keyless Search/Scrape subset is rate-limited, not unlimited.", ["https://docs.firecrawl.dev/capabilities", "https://docs.firecrawl.dev/rate-limits"]),
  ]),
  "jina-reader": entry([
    item("webFetch", "Reader converts a supplied URL to model-friendly Markdown/text.", "https://jina.ai/reader/"),
    item("webSearch", "Search returns results with readable page content; unlike Reader it needs a key.", "https://jina.ai/reader/"),
    item("smartSearch", "Grounding moved to DeepSearch; a current standalone reasoning-off summary contract was not verified.", "https://jina.ai/news/fact-checking-with-new-grounding-api-in-jina-reader/", "conditional"),
    item("deepSearch", "DeepSearch iteratively searches, reads and reasons, returning a cited answer.", "https://jina.ai/deepsearch/"),
  ], [
    item("api", "Jina key for Search/DeepSearch and expanded Reader access.", ["https://jina.ai/reader/", "https://jina.ai/deepsearch/"]),
    item("free", "Keyless access is documented for Reader only, not Search or DeepSearch.", "https://jina.ai/reader/"),
  ]),
  ollama: entry([
    item("webSearch", "Ollama's cloud service also provides web_search; SRouter registers it under Ollama Search.", "https://docs.ollama.com/capabilities/web-search"),
    item("webFetch", "web_fetch returns page title, main content and links.", "https://docs.ollama.com/capabilities/web-search"),
  ], [item("api", "An Ollama account API key is required. A free account quota is not keyless access.", "https://docs.ollama.com/capabilities/web-search")]),
  "ollama-search": entry([
    item("webSearch", "web_search returns ranked titles, URLs and page content.", "https://docs.ollama.com/capabilities/web-search"),
    item("webFetch", "The same service has web_fetch; SRouter currently routes extraction through Ollama Cloud.", "https://docs.ollama.com/capabilities/web-search"),
  ], [item("api", "Same Ollama key; the existing SRouter adapter can reuse an Ollama Cloud connection.", "https://docs.ollama.com/capabilities/web-search")]),
  searxng: entry([
    item("webSearch", "Metasearch aggregates source-engine results; JSON must be enabled by the instance administrator.", ["https://docs.searxng.org/dev/search_api.html", "https://docs.searxng.org/admin/settings/settings_search.html"]),
  ], [item("free", "Keyless instance access; availability and response formats depend on the chosen instance.", "https://docs.searxng.org/dev/search_api.html")]),
  tavily: entry([
    item("webSearch", "Search returns ranked results with snippets and optional generated answers.", "https://docs.tavily.com/documentation/api-reference/endpoint/search"),
    item("webFetch", "Extract returns clean page content as text/Markdown.", "https://docs.tavily.com/documentation/api-reference/endpoint/extract"),
    item("smartSearch", "include_answer supplies synthesis, but the model and reasoning-off behavior are unspecified.", "https://docs.tavily.com/documentation/api-reference/endpoint/search", "conditional"),
    item("deepSearch", "Research performs multiple searches and source analysis to generate a cited report.", "https://docs.tavily.com/documentation/api-reference/endpoint/research"),
  ], [
    item("api", "API key for authenticated REST tools; research requires authentication.", "https://docs.tavily.com/documentation/api-reference/introduction"),
    item("oauth", "The remote MCP server supports an account OAuth flow.", "https://docs.tavily.com/documentation/mcp"),
    item("free", "Keyless Search/Extract are documented with a dedicated access-mode header; Research is excluded.", "https://docs.tavily.com/documentation/keyless"),
  ]),
  tinyfish: entry([
    item("webSearch", "Search returns structured ranked results with filters and pagination.", "https://docs.tinyfish.ai/search-api"),
    item("webFetch", "Fetch renders supplied URLs into clean Markdown/HTML/JSON with caching options.", "https://docs.tinyfish.ai/fetch-api"),
    item("deepSearch", "The beta Research API searches, evaluates sources and synthesizes reports; it uses paid wallet funds.", "https://docs.tinyfish.ai/research-api", "conditional"),
  ], [
    item("api", "Search/Fetch may be free of charge but still require an account API key.", "https://docs.tinyfish.ai/authentication"),
    item("oauth", "Remote MCP uses OAuth account authorization; its tool entitlements differ from REST.", "https://docs.tinyfish.ai/mcp-integration"),
  ]),
  "vercel-ai-gateway": entry([
    item("webSearch", "Gateway built-in/provider-native search tools run inside model calls; the current SRouter chat-search dispatcher is missing.", "https://vercel.com/docs/ai-gateway/models-and-providers/web-search"),
    item("webFetch", "Browserbase Fetch extracts page Markdown/JSON through the gateway tool loop.", "https://vercel.com/docs/ai-gateway/models-and-providers/web-search"),
    item("fetch", "Browserbase Fetch raw format returns page body inside the model-mediated tool loop.", "https://vercel.com/docs/ai-gateway/models-and-providers/web-search"),
  ], [
    item("api", "Gateway API key or deployment OIDC identity; OIDC is not an end-user OAuth flow.", "https://vercel.com/docs/ai-gateway/authentication-and-byok/authentication"),
    item("hostedTool", "Gateway-account search/fetch tools are vendor-executed and billed by Vercel, without per-search-vendor keys.", "https://vercel.com/docs/ai-gateway/models-and-providers/web-search"),
    item("chat", "Gateway tool calls are model-mediated; the existing SRouter web-search adapter still requires dispatcher wiring.", "https://vercel.com/docs/ai-gateway/models-and-providers/web-search", "conditional"),
  ]),
  parallel: entry([
    item("webSearch", "Search API returns ranked URLs with excerpts and publish dates; turbo/fast/basic/advanced modes change the search depth.", [PARALLEL_SEARCH, "https://parallel.ai/products/search"]),
    item("webFetch", "Extract converts known public URLs into LLM-ready content/Markdown.", "https://docs.parallel.ai/extract/extract-quickstart"),
    item("fetch", "No raw public-URL GET endpoint is documented; Extract parses page content instead.", "https://docs.parallel.ai/extract/extract-quickstart", "conditional"),
    item("smartSearch", "The Responses API returns cited live-web answers, but a reasoning-off control is not documented.", "https://docs.parallel.ai/responses-api/responses-quickstart", "conditional"),
    item("deepSearch", "The Task API runs multi-step deep research and returns cited output; higher tiers are priced separately.", "https://docs.parallel.ai/task-api/examples/task-deep-research"),
  ], [
    item("api", "Platform API key; the Search API authenticates with the x-api-key header.", PARALLEL_SEARCH),
    item("oauth", "Remote MCP clients authorize through OAuth; this is not REST API OAuth.", "https://docs.parallel.ai/integrations/mcp/search-mcp"),
    item("free", "The Search MCP is documented without an account or key; free-tier limits are not stated.", "https://docs.parallel.ai/getting-started/overview"),
    item("hostedTool", "Hosted Search MCP exposes vendor search/extract tools; this surface is not wired into SRouter.", "https://docs.parallel.ai/integrations/mcp/search-mcp"),
    item("chat", "The Chat API provides OpenAI-compatible web-research responses; SRouter has no adapter for it.", "https://docs.parallel.ai/chat-api/chat-quickstart"),
  ]),
  octen: entry([
    item("webSearch", "Search returns ranked results with query-relevant highlights by default; count, full_content and time_published filters are optional.", OCTEN_SEARCH),
    item("webFetch", "Extract converts known URLs to Markdown/text with query-focused highlighting.", "https://docs.octen.ai/api-reference/extract"),
    item("fetch", "No raw public-URL GET is documented; Extract cleans and parses page content.", "https://docs.octen.ai/api-reference/extract", "conditional"),
    item("smartSearch", "The Answer API synthesizes cited answers, but a reasoning-off control is not documented.", "https://docs.octen.ai/api-reference/answer", "conditional"),
    item("deepSearch", "Deep Research streams an agentic multi-round cited report over SSE.", "https://docs.octen.ai/api-reference/deep-research"),
  ], [
    item("api", "API key sent as x-api-key or Bearer.", OCTEN_SEARCH),
    item("oauth", "Google sign-in exists for account access; OAuth for API requests is not documented.", "https://docs.octen.ai/overview/introduction", "conditional"),
    item("free", "A $0 plan and starter credit exist, but a key is still required; this is not keyless access.", "https://docs.octen.ai/overview/pricing", "conditional"),
    item("hostedTool", "A hosted MCP server exists, but a vendor-hosted account-tool contract for SRouter is not established.", "https://docs.octen.ai/integrations/octen-mcp-server", "conditional"),
    item("chat", "The Answer API returns synthesized answers and docs show search as an LLM function-calling tool.", "https://docs.octen.ai/api-reference/answer"),
  ]),
  nimble: entry([
    item("webSearch", "Search returns structured agent-ready results with lite/standard depths and focus modes.", NIMBLE_SEARCH),
    item("webFetch", "Extract converts a known URL to Markdown/HTML/JSON.", "https://docs.nimbleway.com/nimble-sdk/web-tools/extract/quickstart"),
    item("fetch", "Extract can emit HTML, but a raw public-URL GET endpoint is not documented.", "https://docs.nimbleway.com/nimble-sdk/web-tools/extract/quickstart", "conditional"),
    item("smartSearch", "AI-generated synthetic insights exist (geo focus), but reasoning-off behavior is not documented.", NIMBLE_SEARCH, "conditional"),
    item("deepSearch", "Web Search Agents run asynchronous research and return cited output.", "https://docs.nimbleway.com/nimble-sdk/web-search-agents/overview"),
  ], [
    item("api", "Platform API key; the Search API authenticates with Bearer.", "https://docs.nimbleway.com/nimble-sdk/admin/account-management"),
    item("oauth", "Assistant connectors authorize with OAuth; this is not API OAuth for the Search REST API.", "https://docs.nimbleway.com/integrations/connectors/anthropic/claude-connectors", "conditional"),
    item("free", "A 5,000-page trial is documented; this is not keyless access or an ongoing free tier.", "https://docs.nimbleway.com/nimble-sdk/admin/pricing", "conditional"),
    item("hostedTool", "Hosted Streamable HTTP MCP server (mcp.nimbleway.com/mcp) with API-key auth.", "https://docs.nimbleway.com/integrations/mcp-server/mcp-server"),
    item("chat", "Assistant/plugin integrations are advertised, but no generic chat-answer endpoint is documented.", "https://www.nimbleway.com/search-api", "conditional"),
  ]),
  keenable: entry([
    item("webSearch", "Search returns ranked results with titles, URLs and descriptions; the official SDK also returns extracted page text.", [KEENABLE_SEARCH, "https://docs.keenable.ai/api-reference"]),
    item("webFetch", "Fetch/MCP returns indexed page content as clean Markdown; live=true fetches the source directly.", "https://docs.keenable.ai/mcp-server"),
    item("fetch", "A raw public-URL GET is not documented; Keenable Fetch extracts content instead.", "https://docs.keenable.ai/api-reference/fetch", "conditional"),
    item("smartSearch", "No vendor-synthesized answer mode is documented.", "https://docs.keenable.ai/api-reference", "conditional"),
    item("deepSearch", "No provider-side agentic research endpoint is documented; clients orchestrate repeated searches.", "https://docs.keenable.ai/mcp-server", "conditional"),
  ], [
    item("api", "Account API key sent as X-API-Key with a keen_ prefix.", "https://docs.keenable.ai/authentication"),
    item("oauth", "The CLI signs in through a browser device-authorization flow.", "https://docs.keenable.ai/cli"),
    item("free", "Keyless endpoints are documented with an unauthenticated 1,000/hour cap.", ["https://docs.keenable.ai/credits", "https://docs.keenable.ai/rate-limits"]),
    item("hostedTool", "Hosted Streamable HTTP MCP (api.keenable.ai/mcp) with search and fetch tools.", "https://docs.keenable.ai/mcp-server"),
    item("chat", "Assistant integrations exist, but no native chat-answer endpoint is documented.", "https://docs.keenable.ai/integrations", "conditional"),
  ]),
};

// Source-observed registration gaps, not a live availability probe. Keep the
// current provider settings reachable, but don't claim a working web adapter.
WEB_PROVIDER_CAPABILITIES.openai.adapterWarnings = {
  webSearch: "Search is registered, but searchViaChat has no endpoint; its Chat Completions web_search request also differs from the documented API.",
};
WEB_PROVIDER_CAPABILITIES["vercel-ai-gateway"].adapterWarnings = {
  webSearch: "Search is registered, but CHAT_SEARCH_CONFIG has no Vercel dispatcher. Gateway server-tool wiring is pending.",
};
WEB_PROVIDER_CAPABILITIES.parallel.adapterWarnings = {
  webSearch: "Search is registered, but SRouter has no Parallel dispatcher yet: the documented POST /v1/search contract (x-api-key, search_queries, modes) is not wired into callers/normalizers.",
};
WEB_PROVIDER_CAPABILITIES.octen.adapterWarnings = {
  webSearch: "Search is registered, but SRouter has no Octen dispatcher yet: POST /search (x-api-key or Bearer, highlight defaults) is documented and pending wiring.",
};
WEB_PROVIDER_CAPABILITIES.nimble.adapterWarnings = {
  webSearch: "Search is registered, but SRouter has no Nimble dispatcher yet: POST /v2/search (Bearer, depth/focus modes) is documented and pending wiring.",
};
WEB_PROVIDER_CAPABILITIES.keenable.adapterWarnings = {
  webSearch: "Search is registered, but SRouter has no Keenable dispatcher yet: POST /v1/search (X-API-Key) is documented; the Artificial Analysis pro/realtime labels stay unverified against documented API modes.",
};

export const WEB_TOOL_LABELS = {
  webSearch: "Search",
  webFetch: "Web Fetch",
  fetch: "Fetch",
  smartSearch: "Smart Search",
  deepSearch: "Deep Search",
};

export const WEB_CONNECTION_LABELS = {
  chat: "Chat adapter",
  oauth: "OAuth",
  api: "API",
  free: "Free",
  hostedTool: "Hosted tool",
};
