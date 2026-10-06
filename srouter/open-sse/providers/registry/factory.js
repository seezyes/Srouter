// Factory Droid — subscription LLM proxy (Droid Core + Standard credits).
//
// Protocol facts (wire paths, identity headers, billing/quota schema, model
// table) were reviewed against the Droid CLI 0.228.0 snapshot published in the
// public native-proxy reference
// https://github.com/can1357/oh-my-pi/pull/13276 (MIT):
//   - the proxy multiplexes four wire protocols by model family;
//   - every inference call needs `Authorization: Bearer <account session>`
//     plus the Factory client identity headers;
//   - Factory API keys (fk-...) are CONTROL-PLANE credentials: they work for
//     GET /api/billing/limits (quota rows) but are rejected (403) for model
//     inference, which uses the WorkOS session token from `droid login`.
//
// The model list mirrors the CLI's shipped table (ids, wires, upstream
// rotations, context/output limits). It is NOT an entitlement claim: Factory
// has no model-listing endpoint, and live account policy (Statsig feature
// flags, org allowlists, residency region) can narrow what one account sees.
// Fast-mode tiers are separate SKUs in the CLI table and preview codenames ride
// their own feature flags. `upstream` is the first entry of the global-region
// rotation — the `x-api-provider` value the CLI pins for non-EU accounts.
// No prices or entitlement claims are fabricated here.
//
// Google/Gemini wire (/api/llm/g/v1/generate) is intentionally not enabled yet:
// its path/suffix and request shape need live confirmation before shipping, so
// the Gemini/Garnet family is omitted from the catalog.

/** Client version reported to Factory's API (Droid CLI 0.228.0 snapshot). */
export const FACTORY_CLIENT_VERSION = "0.228.0";

/** Per-family inference endpoints. Values verified against the reference table. */
export const FACTORY_WIRE_URLS = {
  "openai": "https://api.factory.ai/api/llm/o/v1/chat/completions",
  "openai-responses": "https://api.factory.ai/api/llm/o/v1/responses",
  "claude": "https://api.factory.ai/api/llm/a/v1/messages",
};

// `upstream` is the first entry of the model's upstream rotation and is sent as
// the `x-api-provider` header so the proxy routes to the intended backend.
const FACTORY_MODELS = [
  // ── Anthropic Messages wire — Claude, plus MiniMax M2.7 (Core pool) ───────
  { id: "claude-opus-4-6", name: "Opus 4.6", targetFormat: "claude", supportedFormats: ["claude"], upstream: "anthropic", contextLength: 867000, maxOutputTokens: 128000 },
  { id: "claude-opus-4-7", name: "Opus 4.7", targetFormat: "claude", supportedFormats: ["claude"], upstream: "anthropic", contextLength: 867000, maxOutputTokens: 128000 },
  { id: "claude-opus-4-8", name: "Opus 4.8", targetFormat: "claude", supportedFormats: ["claude"], upstream: "anthropic", contextLength: 867000, maxOutputTokens: 128000 },
  { id: "claude-opus-4-8-fast", name: "Opus 4.8 Fast Mode", targetFormat: "claude", supportedFormats: ["claude"], upstream: "anthropic", contextLength: 867000, maxOutputTokens: 128000 },
  { id: "claude-opus-5", name: "Opus 5", targetFormat: "claude", supportedFormats: ["claude"], upstream: "anthropic", contextLength: 867000, maxOutputTokens: 128000 },
  { id: "claude-opus-5-fast", name: "Opus 5 Fast Mode", targetFormat: "claude", supportedFormats: ["claude"], upstream: "anthropic", contextLength: 867000, maxOutputTokens: 128000 },
  { id: "claude-opus-5-5", name: "Opus 5.5", targetFormat: "claude", supportedFormats: ["claude"], upstream: "anthropic", contextLength: 872000, maxOutputTokens: 128000 },
  { id: "claude-opus-5-5-fast", name: "Opus 5.5 Fast Mode", targetFormat: "claude", supportedFormats: ["claude"], upstream: "anthropic", contextLength: 872000, maxOutputTokens: 128000 },
  { id: "claude-sonnet-5", name: "Sonnet 5", targetFormat: "claude", supportedFormats: ["claude"], upstream: "anthropic", contextLength: 872000, maxOutputTokens: 128000 },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5", targetFormat: "claude", supportedFormats: ["claude"], upstream: "anthropic", contextLength: 872000, maxOutputTokens: 128000 },
  { id: "claude-sonnet-4-6", name: "Sonnet 4.6", targetFormat: "claude", supportedFormats: ["claude"], upstream: "anthropic", contextLength: 931000, maxOutputTokens: 64000 },
  { id: "claude-sonnet-4-5-20250929", name: "Sonnet 4.5", targetFormat: "claude", supportedFormats: ["claude"], upstream: "anthropic", contextLength: 180000, maxOutputTokens: 32000 },
  { id: "claude-opus-4-5-20251101", name: "Opus 4.5", targetFormat: "claude", supportedFormats: ["claude"], upstream: "anthropic", contextLength: 180000, maxOutputTokens: 64000 },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", targetFormat: "claude", supportedFormats: ["claude"], upstream: "anthropic", contextLength: 180000, maxOutputTokens: 32000 },
  // Opt-in previews: the CLI gates these behind explicit consent.
  { id: "claude-fable-5", name: "Fable 5", targetFormat: "claude", supportedFormats: ["claude"], upstream: "anthropic", contextLength: 867000, maxOutputTokens: 128000 },
  { id: "claude-fable-5.1", name: "Fable 5.1", targetFormat: "claude", supportedFormats: ["claude"], upstream: "anthropic", contextLength: 867000, maxOutputTokens: 128000 },
  { id: "atlas-07-21", name: "Atlas 07/21 (Preview)", targetFormat: "claude", supportedFormats: ["claude"], upstream: "anthropic", contextLength: 867000, maxOutputTokens: 128000 },
  { id: "aster-07-15", name: "Aster 07/15 (Preview)", targetFormat: "claude", supportedFormats: ["claude"], upstream: "anthropic", contextLength: 867000, maxOutputTokens: 128000 },
  { id: "minimax-m2.7", name: "MiniMax M2.7", targetFormat: "claude", supportedFormats: ["claude"], upstream: "fireworks", contextLength: 196600, maxOutputTokens: 64000 },

  // ── OpenAI Responses wire — GPT series + Grok ─────────────────────────────
  { id: "gpt-6-astra", name: "GPT-6 Astra", targetFormat: "openai-responses", supportedFormats: ["openai-responses"], upstream: "openai", contextLength: 922000, maxOutputTokens: 128000 },
  { id: "gpt-6-sol", name: "GPT-6 Sol", targetFormat: "openai-responses", supportedFormats: ["openai-responses"], upstream: "openai", contextLength: 922000, maxOutputTokens: 128000 },
  { id: "gpt-6-luna", name: "GPT-6 Luna", targetFormat: "openai-responses", supportedFormats: ["openai-responses"], upstream: "openai", contextLength: 922000, maxOutputTokens: 128000 },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", targetFormat: "openai-responses", supportedFormats: ["openai-responses"], upstream: "openai", contextLength: 922000, maxOutputTokens: 128000 },
  { id: "gpt-5.6-sol-fast", name: "GPT-5.6 Sol Fast Mode", targetFormat: "openai-responses", supportedFormats: ["openai-responses"], upstream: "openai", contextLength: 922000, maxOutputTokens: 128000 },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", targetFormat: "openai-responses", supportedFormats: ["openai-responses"], upstream: "openai", contextLength: 922000, maxOutputTokens: 128000 },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", targetFormat: "openai-responses", supportedFormats: ["openai-responses"], upstream: "openai", contextLength: 922000, maxOutputTokens: 128000 },
  { id: "gpt-5.5", name: "GPT-5.5", targetFormat: "openai-responses", supportedFormats: ["openai-responses"], upstream: "openai", contextLength: 922000, maxOutputTokens: 128000 },
  { id: "gpt-5.5-fast", name: "GPT-5.5 Fast Mode", targetFormat: "openai-responses", supportedFormats: ["openai-responses"], upstream: "openai", contextLength: 922000, maxOutputTokens: 128000 },
  { id: "gpt-5.5-pro", name: "GPT-5.5 Pro", targetFormat: "openai-responses", supportedFormats: ["openai-responses"], upstream: "openai", contextLength: 922000, maxOutputTokens: 128000 },
  { id: "gpt-5.4", name: "GPT-5.4", targetFormat: "openai-responses", supportedFormats: ["openai-responses"], upstream: "openai", contextLength: 922000, maxOutputTokens: 128000 },
  { id: "gpt-5.4-fast", name: "GPT-5.4 Fast Mode", targetFormat: "openai-responses", supportedFormats: ["openai-responses"], upstream: "openai", contextLength: 922000, maxOutputTokens: 128000 },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", targetFormat: "openai-responses", supportedFormats: ["openai-responses"], upstream: "openai", contextLength: 272000, maxOutputTokens: 128000 },
  { id: "gpt-5.4-mini-fast", name: "GPT-5.4 Mini Fast Mode", targetFormat: "openai-responses", supportedFormats: ["openai-responses"], upstream: "openai", contextLength: 272000, maxOutputTokens: 128000 },
  { id: "gpt-5.3-codex", name: "GPT-5.3-Codex", targetFormat: "openai-responses", supportedFormats: ["openai-responses"], upstream: "openai", contextLength: 272000, maxOutputTokens: 128000 },
  { id: "gpt-5.3-codex-fast", name: "GPT-5.3-Codex Fast Mode", targetFormat: "openai-responses", supportedFormats: ["openai-responses"], upstream: "openai", contextLength: 272000, maxOutputTokens: 128000 },
  { id: "gpt-5.2", name: "GPT-5.2", targetFormat: "openai-responses", supportedFormats: ["openai-responses"], upstream: "openai", contextLength: 272000, maxOutputTokens: 128000 },
  { id: "grok-4.7", name: "Grok 4.7", targetFormat: "openai-responses", supportedFormats: ["openai-responses"], upstream: "xai", contextLength: 436644, maxOutputTokens: 63356 },
  { id: "grok-4.6", name: "Grok 4.6", targetFormat: "openai-responses", supportedFormats: ["openai-responses"], upstream: "xai", contextLength: 200000, maxOutputTokens: 63356 },
  { id: "grok-4.5", name: "Grok 4.5", targetFormat: "openai-responses", supportedFormats: ["openai-responses"], upstream: "xai", contextLength: 200000, maxOutputTokens: 63356 },

  // ── OpenAI Chat Completions wire — Droid Core families ───────────────────
  { id: "kimi-k3", name: "Kimi K3", supportedFormats: ["openai"], upstream: "fireworks", contextLength: 196608, maxOutputTokens: 65536 },
  { id: "glm-5.3", name: "GLM-5.3", supportedFormats: ["openai"], upstream: "fireworks", contextLength: 908928, maxOutputTokens: 131072 },
  { id: "glm-5.3-flash", name: "GLM-5.3-Flash", supportedFormats: ["openai"], upstream: "fireworks", contextLength: 917504, maxOutputTokens: 131072 },
  { id: "glm-5.2", name: "GLM-5.2", supportedFormats: ["openai"], upstream: "baseten", contextLength: 908928, maxOutputTokens: 131072 },
  { id: "glm-5.2-fast", name: "GLM-5.2 Fast", supportedFormats: ["openai"], upstream: "baseten", contextLength: 393216, maxOutputTokens: 131072 },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", supportedFormats: ["openai"], upstream: "fireworks", contextLength: 908928, maxOutputTokens: 131072 },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", supportedFormats: ["openai"], upstream: "fireworks", contextLength: 908928, maxOutputTokens: 131072 },
  { id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash 0731", supportedFormats: ["openai"], upstream: "fireworks", contextLength: 908928, maxOutputTokens: 131072 },
  { id: "minimax-m3", name: "MiniMax M3", supportedFormats: ["openai"], upstream: "fireworks", contextLength: 448000, maxOutputTokens: 64000 },
  { id: "qwen3.8-max", name: "Qwen3.8 Max", supportedFormats: ["openai"], upstream: "fireworks", contextLength: 131072, maxOutputTokens: 131072 },
  { id: "nemotron-3-ultra", name: "Nemotron 3 Ultra", supportedFormats: ["openai"], upstream: "baseten", contextLength: 136464, maxOutputTokens: 65536 },
  { id: "mistral-medium-3.5", name: "Mistral Medium 3.5", supportedFormats: ["openai"], upstream: "mistral", contextLength: 192000, maxOutputTokens: 64000 },
  { id: "inkling", name: "Inkling", supportedFormats: ["openai"], upstream: "fireworks", contextLength: 1007232, maxOutputTokens: 32768 },
];

/** Model id → registry data, consumed by the executor for wire/upstream routing. */
export const FACTORY_MODEL_META = Object.fromEntries(FACTORY_MODELS.map((model) => [model.id, model]));

const BEARER_AUTH = { combined: true, header: "Authorization", scheme: "bearer" };

export default {
  id: "factory",
  priority: 215,
  alias: "factory",
  aliases: [
    "factory-droid",
  ],
  uiAlias: "factory",
  display: {
    name: "Factory",
    icon: "precision_manufacturing",
    color: "#F97316",
    textIcon: "FD",
    website: "https://factory.ai",
    notice: {
      text: "Factory API keys (fk-...) are control-plane credentials: they work here for quota tracking and validation, but model inference uses the WorkOS session token issued by the official Droid CLI login. The model list is a static CLI snapshot, not account entitlements.",
      apiKeyUrl: "https://app.factory.ai",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://api.factory.ai/api/llm/o/v1/chat/completions",
    auth: { ...BEARER_AUTH },
    usage: {
      url: "https://api.factory.ai/api/billing/limits",
    },
  },
  // Multi-endpoint: pick the transport matching the client's source format to
  // skip lossy translation. The per-model `supportedFormats` guard keeps a
  // Claude-only model off the OpenAI endpoints (and vice versa).
  transports: [
    { format: "openai", baseUrl: "https://api.factory.ai/api/llm/o/v1/chat/completions", auth: { ...BEARER_AUTH } },
    { format: "openai-responses", baseUrl: "https://api.factory.ai/api/llm/o/v1/responses", auth: { ...BEARER_AUTH } },
    { format: "claude", baseUrl: "https://api.factory.ai/api/llm/a/v1/messages", auth: { ...BEARER_AUTH } },
  ],
  models: FACTORY_MODELS,
  features: {
    usage: true,
    usageApikey: true,
  },
};
