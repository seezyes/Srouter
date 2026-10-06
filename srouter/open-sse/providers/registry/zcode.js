import { CLAUDE_API_HEADERS } from "../shared.js";
import { ZCODE_CONFIG } from "../../config/zcodeConfig.js";

export default {
  id: "zcode",
  priority: 141,
  alias: "zc",
  display: {
    name: "ZCode",
    icon: "smart_toy",
    color: "#0EA5E9",
    textIcon: "ZC",
    website: "https://z.ai",
    notice: {
      signupUrl: "https://chat.z.ai",
    },
  },
  category: "oauth",
  hasOAuth: true,
  authModes: ["apikey", "oauth"],
  oauth: {
    clientId: "client_P8X5CMWmlaRO9gyO-KSqtg",
    authorizeUrl: "https://chat.z.ai/api/oauth/authorize",
    tokenUrl: "https://zcode.z.ai/api/v1/oauth/token",
    redirectUri: ZCODE_CONFIG.redirectUri,
    businessLoginUrl: ZCODE_CONFIG.businessLoginUrl,
  },
  transport: {
    baseUrl: `${ZCODE_CONFIG.apiBaseUrl}/v1/messages`,
    format: "claude",
    headers: { ...CLAUDE_API_HEADERS },
    auth: {
      combined: true,
      header: "x-api-key",
      scheme: "raw",
    },
  },
  models: [
    { id: "GLM-5.2", name: "GLM 5.2" },
    { id: "GLM-5.2-Max", name: "GLM 5.2 Max", quotaFamily: "max" },
    { id: "GLM-5-Turbo", name: "GLM 5 Turbo" },
    { id: "GLM-5-Turbo-Max", name: "GLM 5 Turbo Max", quotaFamily: "max" },
  ],
};
