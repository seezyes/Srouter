// Exact original Pass8 request fixtures, isolated for field-by-field adjudication.
const text = "Pass8 user payload";
const toolName = "inspect";
const openai = {
  model: "fixture", stream: false, max_tokens: 256, temperature: 0.3,
  messages: [
    { role: "system", content: "Pass8 system" },
    { role: "user", content: text },
    { role: "assistant", content: "inspect first", tool_calls: [{ id: "call-fixture", type: "function", function: { name: toolName, arguments: '{"path":"/fixture"}' } }] },
    { role: "tool", tool_call_id: "call-fixture", content: "tool answer" },
    { role: "user", content: "continue" },
  ],
  tools: [{ type: "function", function: { name: toolName, description: "fixture", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
};
const claude = {
  model: "fixture", stream: false, max_tokens: 256, system: "Pass8 system",
  messages: [
    { role: "user", content: [{ type: "text", text }] },
    { role: "assistant", content: [{ type: "text", text: "inspect first" }, { type: "tool_use", id: "call-fixture", name: toolName, input: { path: "/fixture" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call-fixture", content: "tool answer" }, { type: "text", text: "continue" }] },
  ],
  tools: [{ name: toolName, description: "fixture", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
};
const gemini = {
  systemInstruction: { parts: [{ text: "Pass8 system" }] },
  contents: [
    { role: "user", parts: [{ text }] },
    { role: "model", parts: [{ functionCall: { id: "call-fixture", name: toolName, args: { path: "/fixture" } } }] },
    { role: "user", parts: [{ functionResponse: { id: "call-fixture", name: toolName, response: { result: "tool answer" } } }, { text: "continue" }] },
  ],
  tools: [{ functionDeclarations: [{ name: toolName, description: "fixture", parameters: { type: "object", properties: { path: { type: "string" } } } }] }],
  generationConfig: { maxOutputTokens: 256, temperature: 0.3 },
};
const responses = {
  instructions: "Pass8 system", max_output_tokens: 256, stream: false,
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text }] },
    { type: "function_call", call_id: "call-fixture", name: toolName, arguments: '{"path":"/fixture"}' },
    { type: "function_call_output", call_id: "call-fixture", output: "tool answer" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
  ],
  tools: [{ type: "function", name: toolName, description: "fixture", parameters: { type: "object", properties: { path: { type: "string" } } } }],
};
export const sources = { openai, claude, gemini, "openai-responses": responses,
  antigravity: { request: gemini, userAgent: "antigravity" } };
export const targets = {
  openai: ["gpt-4o", "openai"], claude: ["claude-sonnet-4-6", "anthropic"],
  gemini: ["gemini-2.5-pro", "gemini"], "gemini-cli": ["gemini-2.5-pro", "gemini-cli"],
  antigravity: ["gemini-2.5-pro", "antigravity"], "openai-responses": ["gpt-5.4", "codex"],
  kiro: ["claude-sonnet-4.6", "kiro"], cursor: ["claude-sonnet-4.6", "cursor"],
  commandcode: ["anthropic/claude-sonnet-4.6", "commandcode"], ollama: ["llama3", "ollama"],
  vertex: ["gemini-2.5-pro", "vertex"],
};
export const credential = () => ({
  apiKey: "fixture-key", accessToken: "fixture-token",
  providerSpecificData: { projectId: "fixture-project", accountId: "fixture-account" },
  rawHeaders: { "x-session-id": "12345678-1234-4234-8234-123456789012" },
});
