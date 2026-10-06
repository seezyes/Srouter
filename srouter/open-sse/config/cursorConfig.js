// Pinned Cursor model aliases, shared by ChatService and AgentService encoding.
export const CURSOR_LEGACY_MODELS = {
  "claude-3-5-sonnet": "claude-4.5-sonnet",
  "claude-3-5-haiku": "claude-4.5-haiku",
  "gpt-4o": "gpt-5.2",
  "gpt-4o-mini": "gpt-5.2",
};

export const CURSOR_DEFAULT_UPSTREAM_MODEL = process.env.CURSOR_DEFAULT_UPSTREAM_MODEL || "claude-4.5-sonnet";
export const CURSOR_AUTO_MODELS = new Set(["default", "auto"]);
