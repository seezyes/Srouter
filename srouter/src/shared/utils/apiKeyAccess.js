// NULL means unrestricted; an explicit [] denies every target.
export const API_KEY_ACCESS_FIELDS = ["allowedProviders", "allowedCombos", "allowedKinds"];
export const API_KEY_ACCESS_KINDS = ["llm", "embedding", "image", "tts", "stt", "web", "video", "systemone"];

export function validateApiKeyAccess(data) {
  for (const field of API_KEY_ACCESS_FIELDS) {
    if (!(field in data)) continue;
    const list = data[field];
    if (list === null) continue;
    if (!Array.isArray(list) || list.length > 1000
      || list.some((item) => typeof item !== "string" || !item.trim() || item.length > 256)) {
      throw new TypeError(`${field} must be null or an array of nonempty strings`);
    }
    if (field === "allowedKinds" && list.some((kind) => !API_KEY_ACCESS_KINDS.includes(kind))) {
      throw new TypeError("allowedKinds contains an unsupported request kind");
    }
  }
}

export function parseAccessList(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    const list = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(list) && list.every((item) => typeof item === "string") ? list : [];
  } catch {
    return []; // Corrupt permissions must not grant access.
  }
}

export function serializeAccessList(list) {
  return list === null || list === undefined ? null : JSON.stringify(list);
}
