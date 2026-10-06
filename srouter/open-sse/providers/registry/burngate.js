export default {
  id: "burngate",
  priority: 5,
  hasFree: true,
  alias: "burngate",
  category: "freeTier",
  authType: "apikey",
  authModes: ["apikey"],
  display: {
    name: "BurnGate",
    icon: "local_fire_department",
    color: "#FF6900",
    textIcon: "BG",
    website: "https://burngate.space",
    notice: {
      text: "Get your API key from the Telegram bot @burngateapiBot.",
      apiKeyUrl: "https://t.me/burngateapiBot",
    },
  },
  transport: {
    baseUrl: "https://burngate.space/api/v1/chat/completions",
    validateUrl: "https://burngate.space/api/v1/models",
    usage: {
      url: "https://burngate.space/api/v1/usage",
    },
  },
  models: [
    { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { id: "stealth/space-bunny-alpha", name: "Space Bunny Alpha" },
    { id: "xiaomi/mimo-v2.6-flash", name: "MiMo V2.6 Flash" },
    { id: "stealth/pixel-canary", name: "Pixel Canary" },
  ],
  // Off from a fresh DB until the owner explicitly enables them (owner decision
  // 2026-10-05, extended to all three after the dev probe). Derived into the
  // disabledModels store by src/shared/constants/disabledModelsDefaults.js.
  defaultDisabledModels: ["deepseek/deepseek-v4.1-flash", "stealth/space-bunny-alpha", "stealth/pixel-canary"],
  features: {
    usage: true,
    usageApikey: true,
  },
};
