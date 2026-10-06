import os from "node:os";
import { ZCODE_CONFIG } from "../config/zcodeConfig.js";

export function buildZCodeSourceHeaders() {
  const platform = os.platform();
  return {
    "User-Agent": `ZCode/${ZCODE_CONFIG.version}`,
    "HTTP-Referer": ZCODE_CONFIG.website,
    "X-Title": "Z Code@electron",
    "X-ZCode-App-Version": ZCODE_CONFIG.version,
    "X-ZCode-Agent": "glm",
    "X-Platform": `${platform}-${os.arch()}`,
    "X-Client-Language": "en",
    "X-Client-Timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    "X-Os-Category": platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux",
    "X-Os-Version": os.release(),
  };
}
