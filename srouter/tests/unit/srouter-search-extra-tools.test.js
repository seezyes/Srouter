import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  kind: vi.fn(), target: vi.fn(), fetchPublic: vi.fn(), chat: vi.fn(), settings: vi.fn(), key: vi.fn(),
}));
vi.mock("@/sse/services/requestAccess", () => ({ checkKindAccess: mocks.kind, checkTargetAccess: mocks.target }));
vi.mock("@/shared/utils/ssrfGuard", () => ({ fetchPublic: mocks.fetchPublic }));
vi.mock("@/sse/handlers/chat", () => ({ handleChat: mocks.chat }));
vi.mock("@/sse/services/auth", () => ({
  extractApiKey: (request) => request.headers.get("authorization")?.slice(7), getApiKeyInfo: mocks.key,
}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.settings }));
vi.mock("@/sse/handlers/search", () => ({ handleSearch: vi.fn() }));
vi.mock("@/sse/handlers/fetch", () => ({ handleFetch: vi.fn() }));
import { callExtraTool } from "@/lib/mcp/srouterSearchExtraTools";
import { handleSrouterSearchMcp } from "@/lib/mcp/srouterSearch";
import { DEFAULT_SROUTER_SEARCH } from "@/shared/utils/srouterSearchConfig";
const config = () => ({ ...DEFAULT_SROUTER_SEARCH, enabled: true, rawFetchEnabled: true, smartEnabled: true, deepEnabled: true, smartModel: "openai/summary", deepModel: "reasoning-combo" });
const request = () => new Request("http://localhost:20129/api/v1/mcp/search", {
  method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer caller-key", cookie: "never-forward" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
const call = (name, args, settings = config()) => callExtraTool(request(), { name, arguments: args }, settings, {});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.kind.mockReturnValue(null);
  mocks.target.mockResolvedValue(null);
  mocks.key.mockResolvedValue({ isActive: true });
  mocks.settings.mockResolvedValue({ srouterSearch: config() });
  mocks.fetchPublic.mockImplementation(async () => new Response("<html>raw page</html>", { headers: { "Content-Type": "text/html" } }));
  mocks.chat.mockImplementation(async () => Response.json({ choices: [{ message: { content: "answer", reasoning_content: "private trace" } }], usage: { total_tokens: 12 } }));
});
describe("five independently exposed MCP tools", () => {
  it("can advertise only Deep Search", async () => {
    mocks.settings.mockResolvedValue({ srouterSearch: { ...config(), searchEnabled: false, fetchEnabled: false, rawFetchEnabled: false, smartEnabled: false } });
    const response = await handleSrouterSearchMcp(request());
    expect((await response.json()).result.tools.map((tool) => tool.name)).toEqual(["srouter_deep_search"]);
  });
  it("lists separate raw and cleaned fetch and separate model tools", async () => {
    const response = await handleSrouterSearchMcp(request());
    expect((await response.json()).result.tools.map((tool) => tool.name)).toEqual([
      "srouter_web_search", "srouter_web_fetch", "srouter_fetch", "srouter_smart_search", "srouter_deep_search",
    ]);
  });
  it("filters model tools by Chat permissions", async () => {
    mocks.kind.mockImplementation((_, kind) => kind === "chat" ? {} : null);
    const response = await handleSrouterSearchMcp(request());
    expect((await response.json()).result.tools.map((tool) => tool.name)).not.toContain("srouter_deep_search");
    expect((await call("srouter_smart_search", { query: "x" })).isError).toBe(true);
    expect(mocks.chat).not.toHaveBeenCalled();
  });
  it("disabled tools cannot be invoked even if the client cached the list", async () => {
    expect((await call("srouter_fetch", { url: "https://example.com" }, { ...config(), rawFetchEnabled: false })).isError).toBe(true);
    expect(mocks.fetchPublic).not.toHaveBeenCalled();
  });
});
describe("raw Fetch", () => {
  it("returns untouched HTML with status and MIME, without credentials", async () => {
    const result = await call("srouter_fetch", { url: "https://example.com" });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: 200, content_type: "text/html", content: "<html>raw page</html>", format: "raw", truncated: false });
    const [, init, guards] = mocks.fetchPublic.mock.calls[0];
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.headers.cookie).toBeUndefined();
    expect(guards.maxRedirects).toBe(3);
    expect(mocks.target).toHaveBeenCalledWith({}, "srouter-fetch", null, "webFetch");
  });
  it("truncates raw text at the configured/requested limit", async () => {
    const result = await call("srouter_fetch", { url: "https://example.com", max_characters: 6 });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ content: "<html>", truncated: true });
  });
  it("fails closed for provider-restricted keys", async () => {
    mocks.target.mockResolvedValue({});
    expect((await call("srouter_fetch", { url: "https://example.com" })).isError).toBe(true);
    expect(mocks.fetchPublic).not.toHaveBeenCalled();
  });
  it("honors existing SSRF guard rejection without leaking its error", async () => {
    mocks.fetchPublic.mockRejectedValue(new Error("blocked internal sensitive address"));
    const result = await call("srouter_fetch", { url: "http://127.0.0.1" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });
  it("rejects binary and oversized pages", async () => {
    mocks.fetchPublic.mockResolvedValue(new Response("binary", { headers: { "Content-Type": "image/png" } }));
    expect((await call("srouter_fetch", { url: "https://example.com" })).isError).toBe(true);
    mocks.fetchPublic.mockResolvedValue(new Response("x".repeat(1024 * 1024 + 1), { headers: { "Content-Type": "text/plain" } }));
    expect((await call("srouter_fetch", { url: "https://example.com" })).isError).toBe(true);
  });
  it("aborts network work at its deadline", async () => {
    vi.useFakeTimers();
    try {
      mocks.fetchPublic.mockImplementation((_, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
      }));
      const pending = call("srouter_fetch", { url: "https://example.com" });
      await vi.advanceTimersByTimeAsync(20000);
      expect((await pending).isError).toBe(true);
      expect(mocks.fetchPublic.mock.calls[0][1].signal.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it.each([{ url: "" }, { url: "https://example.com", headers: { Authorization: "forbidden" } }, { url: "https://example.com", max_characters: 999999 }])("rejects unsafe arguments %j", async (args) => {
    expect((await call("srouter_fetch", args)).isError).toBe(true);
    expect(mocks.fetchPublic).not.toHaveBeenCalled();
  });
});
describe("Smart / Deep model queries without embedded workflows", () => {
  it.each([["srouter_smart_search", "none", "disabled", "openai/summary"], ["srouter_deep_search", "high", "enabled", "reasoning-combo"]])("dispatches %s with explicit reasoning controls", async (name, effort, thinking, model) => {
    const result = await call(name, { query: "summarize", context: "untrusted sources" });
    const forwarded = mocks.chat.mock.calls[0][0];
    const body = await forwarded.json();
    expect(body).toMatchObject({ model, stream: false, reasoning_effort: effort, thinking: { type: thinking }, max_tokens: 4096 });
    expect(body.messages.at(-1).content).toContain("untrusted sources");
    expect(forwarded.headers.get("authorization")).toBe("Bearer caller-key");
    expect(forwarded.headers.get("cookie")).toBeNull();
    expect(body.tools).toBeUndefined();
    expect(JSON.parse(result.content[0].text).answer).toBe("answer");
    expect(JSON.stringify(result)).not.toContain("private trace");
  });
  it("uses explicit model/combo overrides and requires a target", async () => {
    await call("srouter_smart_search", { query: "x", model: "my-combo" });
    expect((await mocks.chat.mock.calls[0][0].json()).model).toBe("my-combo");
    expect((await call("srouter_deep_search", { query: "x" }, { ...config(), deepModel: "" })).isError).toBe(true);
  });
  it("reserves a valid reasoning budget", async () => {
    expect((await call("srouter_deep_search", { query: "x" }, { ...config(), maxOutputTokens: 1024 })).isError).toBe(true);
    expect(mocks.chat).not.toHaveBeenCalled();
  });
  it("hides upstream errors and refuses tool-call-only/non-JSON responses", async () => {
    mocks.chat.mockResolvedValue(new Response("upstream secret", { status: 403 }));
    expect(JSON.stringify(await call("srouter_deep_search", { query: "x" }))).not.toContain("upstream secret");
    mocks.chat.mockResolvedValue(Response.json({ choices: [{ message: { tool_calls: [{}] } }] }));
    expect((await call("srouter_deep_search", { query: "x" })).isError).toBe(true);
    mocks.chat.mockResolvedValue(new Response("data: anything", { headers: { "Content-Type": "text/event-stream" } }));
    expect((await call("srouter_deep_search", { query: "x" })).isError).toBe(true);
  });
});
