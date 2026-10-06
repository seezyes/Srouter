// Source-backed ZCode 3.1.0 endpoints and identity (VansRouter ad591d72).
export const ZCODE_CONFIG = {
  version: "3.1.0",
  website: "https://zcode.z.ai",
  planBaseUrl: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
  apiBaseUrl: "https://api.z.ai/api/anthropic",
  businessLoginUrl: "https://api.z.ai/api/auth/z/login",
  redirectUri: "zcode://zai-auth/callback",
  captchaTtlMs: 4 * 60 * 1000,
  captchaTimeoutMs: 25000,
  captchaRegion: "sgp",
  captchaPrefix: "no8xfe",
  captchaSceneId: "11xygtvd",
  maxDefaultEffort: "max",
  thinkingOutputReserve: 4096,
};
