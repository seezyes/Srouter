import { getApiKeys } from "@/lib/db";

// Explicit keys retain their restrictions. Never replace them with a broader
// key, or emit an unusable placeholder. Database failures propagate before writes.
export async function resolveCliApiKey(callerKey) {
  if (callerKey != null && typeof callerKey !== "string") throw new Error("API key must be a string");
  const explicit = callerKey?.trim();
  if (explicit && explicit !== "sk_srouter" && explicit !== "sk_9router") return explicit;
  const keys = await getApiKeys();
  return keys.find((key) => key.isActive !== false)?.key || "";
}
