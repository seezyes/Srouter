export default {
  id: "tokenharbor",
  priority: 120,
  alias: "tokenharbor",
  aliases: [
    "th",
    "thh",
  ],
  uiAlias: "tokenharbor",
  display: {
    name: "Token Harbor",
    icon: "anchor",
    color: "#0F766E",
    textIcon: "TH",
    website: "https://tokenharbor.ai",
    notice: {
      text: "OpenAI-compatible aggregator. One API key reaches every model, billed per-token from a prepaid wallet. Model ids are bare (e.g. claude-opus-5.5, gpt-6-astra, deepseek-v4.1-flash:free) and are fetched live from the provider.",
      apiKeyUrl: "https://tokenharbor.ai/dashboard",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    // OpenAI-compatible. `format` is left at the shared "openai" default and
    // `thinkingFormat` is deliberately NOT declared: Token Harbor forwards
    // requests verbatim, so each model must resolve its own thinking wire
    // format through providers/capabilities.js. Setting a provider-wide value
    // would force one format (e.g. claude-adaptive) onto every model.
    baseUrl: "https://tokenharbor.ai/v1/chat/completions",
    validateUrl: "https://tokenharbor.ai/v1/models",
    retry: {
      429: 2,
    },
  },
  transports: [
    {
      format: "openai",
      baseUrl: "https://tokenharbor.ai/v1/chat/completions",
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
    },
    {
      format: "claude",
      baseUrl: "https://tokenharbor.ai/v1/messages",
      auth: { combined: true, header: "x-api-key", scheme: "raw", anthropicVersion: true },
    },
    {
      format: "openai-responses",
      baseUrl: "https://tokenharbor.ai/v1/responses",
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
    },
  ],
  serviceKinds: ["llm", "image"],
  imageConfig: { baseUrl: "https://tokenharbor.ai/v1/images/generations" },
  // Curated seed; the live catalogue is fetched via modelsFetcher and any other
  // id is accepted via passthroughModels. Their catalogue rotates (the :free set
  // in particular), so this stays deliberately small and is only the offline
  // fallback. Ids are bare — Token Harbor does not prefix them by upstream vendor.
  models: [
    { id: "claude-opus-5.5", name: "Claude Opus 5.5" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "gpt-6-astra", name: "GPT-6 Astra" },
    { id: "gpt-6-sol", name: "GPT-6 Sol" },
    { id: "deepseek-v4.1-flash:free", name: "DeepSeek V4.1 Flash (Free)", hasFree: true },
    { id: "grok-4.7", name: "Grok 4.7" },
    { id: "th-orchestra", name: "TokenHarbor Orchestra" },
    { id: "mimo-v2.6-flash:free", name: "MiMo V2.6 Flash (Free)", hasFree: true },
    { id: "mimo-v2.6-flash", name: "MiMo V2.6 Flash" },
    { id: "mimo-v2.6-pro", name: "MiMo V2.6 Pro" },
    { id: "qwen3.8-flash:free", name: "Qwen3.8 Flash (Free)", hasFree: true },
    { id: "qwen3.8-flash", name: "Qwen3.8 Flash" },
    { id: "qwen3.8-max", name: "Qwen3.8 Max" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
    { id: "glm-5.3", name: "GLM 5.3" },
    { id: "glm-5.2", name: "GLM 5.2" },
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
    { id: "gpt-6-luna", name: "GPT-6 Luna" },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.4", name: "GPT-5.4" },
    { id: "kimi-k3", name: "Kimi K3" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash" },
    { id: "minimax-m3", name: "MiniMax M3" },
  ],
  modelsFetcher: { url: "https://tokenharbor.ai/v1/models", type: "openai" },
  passthroughModels: true,
};
