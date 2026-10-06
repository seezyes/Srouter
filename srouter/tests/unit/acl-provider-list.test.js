// Regression tests for #86 review notes:
// - show only ACL-eligible no-auth providers (not every registered provider)
// - resolve dict payloads by requested provider ID/alias, not first value
// - preserve provider aliases and custom provider-node prefixes
// - keep external model fetches fail-soft with bounded timeout
// - ACL allow/deny behavior for no-auth providers without connections
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { buildProviderList } from "../../src/shared/utils/aclProviderList.js";
import { fetchModelsFetcherIds } from "../../src/sse/services/allowedModels.js";

describe("buildProviderList (ACL provider list)", () => {
  it("includes connected providers with connection count", () => {
    const list = buildProviderList(
      [
        { provider: "deepseek" },
        { provider: "deepseek" },
        { provider: "antigravity" },
      ],
      [],
      []
    );
    const deepseek = list.find((p) => p.id === "deepseek");
    const ag = list.find((p) => p.id === "antigravity");
    expect(deepseek.count).toBe(2);
    expect(ag.count).toBe(1);
  });

  it("includes registered noAuth providers with zero connections", () => {
    const list = buildProviderList([], [], [
      { id: "opencode", alias: "oc", noAuth: true, displayName: "OpenCode Free" },
      { id: "mimo-free", alias: "mmf", noAuth: true, displayName: "MiMo Code Free" },
    ]);
    expect(list.find((p) => p.id === "opencode")).toMatchObject({
      id: "opencode", alias: "oc", count: 0,
    });
    expect(list.find((p) => p.id === "mimo-free").count).toBe(0);
  });

  it("excludes auth-requiring registered providers with zero connections", () => {
    const list = buildProviderList([], [], [
      { id: "deepseek", alias: "ds", noAuth: false, displayName: "DeepSeek" },
    ]);
    expect(list.find((p) => p.id === "deepseek")).toBeUndefined();
  });

  it("preserves custom provider-node prefixes in display", () => {
    const list = buildProviderList(
      [{ provider: "openai-compatible-chat-abc123" }],
      [{ id: "openai-compatible-chat-abc123", name: "Shiteru", prefix: "st", type: "openai-compatible" }],
      []
    );
    expect(list.find((p) => p.id === "openai-compatible-chat-abc123")).toMatchObject({
      displayName: "Shiteru",
      prefix: "st",
    });
  });

  it("keeps alias when resolving node names", () => {
    const list = buildProviderList(
      [{ provider: "opencode", alias: "oc" }],
      [],
      []
    );
    expect(list.find((p) => p.id === "opencode").alias).toBe("oc");
  });
});

describe("fetchModelsFetcherIds dict resolution", () => {
  const originalFetch = globalThis.fetch;
  let key;
  beforeEach(() => { key = `test-${Math.random()}`; globalThis.fetch = vi.fn(); });
  afterEach(() => { globalThis.fetch = originalFetch; vi.useRealTimers(); });

  it("resolves multi-provider dict by provider id", async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        opencode: { models: { "deepseek-v4-flash-free": { id: "deepseek-v4-flash-free" } } },
        "another-provider": { models: { "not-free": { id: "not-free" } } },
      }),
    });
    const ids = await fetchModelsFetcherIds("opencode", {
      id: "opencode",
      alias: "oc",
      modelsFetcher: { url: "https://models.dev/api.json", type: "opencode-free" },
    });
    expect(ids).toEqual(["deepseek-v4-flash-free"]);
  });

  it("resolves dict by alias when provider id absent", async () => {
    const pid = "opencode-alias-test";
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        oc: { models: { "ling-3.0-flash-free": { id: "ling-3.0-flash-free" } } },
      }),
    });
    const ids = await fetchModelsFetcherIds(pid, {
      id: pid,
      alias: "oc",
      modelsFetcher: { url: "https://models.dev/api.json", type: "opencode-free" },
    });
    expect(ids).toEqual(["ling-3.0-flash-free"]);
  });

  it("returns empty on missing provider key (no first-value fallback)", async () => {
    const pid = "opencode-missing-key-test";
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        "other-provider": { models: { "x-free": { id: "x-free" } } },
      }),
    });
    const ids = await fetchModelsFetcherIds(pid, {
      id: pid,
      alias: "oc",
      modelsFetcher: { url: "https://models.dev/api.json", type: "opencode-free" },
    });
    expect(ids).toEqual([]);
  });

  it("fail-soft on network error returns []", async () => {
    const pid = "opencode-neterr-test";
    globalThis.fetch.mockRejectedValue(new Error("network down"));
    const ids = await fetchModelsFetcherIds(pid, {
      id: pid,
      alias: "oc",
      modelsFetcher: { url: "https://models.dev/api.json", type: "opencode-free" },
    });
    expect(ids).toEqual([]);
  });

  it("fail-soft on non-ok response returns []", async () => {
    const pid = "opencode-nonok-test";
    globalThis.fetch.mockResolvedValue({ ok: false });
    const ids = await fetchModelsFetcherIds(pid, {
      id: pid,
      alias: "oc",
      modelsFetcher: { url: "https://models.dev/api.json", type: "opencode-free" },
    });
    expect(ids).toEqual([]);
  });

  it("uses bounded timeout for fetches", async () => {
    const pid = "opencode-timeout-test";
    globalThis.fetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    await fetchModelsFetcherIds(pid, {
      id: pid,
      alias: "oc",
      modelsFetcher: { url: "https://models.dev/api.json", type: "opencode-free" },
    });
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("https://models.dev/api.json");
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps dictionary cache entries isolated by provider at the same URL", async () => {
    const first = `${key}-first`;
    const second = `${key}-second`;
    globalThis.fetch.mockResolvedValue({ ok: true, json: async () => ({
      [first]: { models: { a: { id: "a-free" } } },
      [second]: { models: { b: { id: "b-free" } } },
    }) });
    const config = { modelsFetcher: { url: "https://models.dev/api.json", type: "opencode-free" } };
    expect(await fetchModelsFetcherIds(first, { ...config, id: first })).toEqual(["a-free"]);
    expect(await fetchModelsFetcherIds(second, { ...config, id: second })).toEqual(["b-free"]);
    expect(await fetchModelsFetcherIds(first, { ...config, id: first })).toEqual(["a-free"]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("refreshes after five minutes and retains only that provider's stale cache on failure", async () => {
    vi.useFakeTimers();
    const config = { id: key, modelsFetcher: { url: "https://models.dev/api.json", type: "opencode-free" } };
    globalThis.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: "a-free" }, { id: "paid" }] }) });
    expect(await fetchModelsFetcherIds(key, config)).toEqual(["a-free"]);
    globalThis.fetch.mockRejectedValue(new Error("fixture unavailable"));
    await vi.advanceTimersByTimeAsync(300001);
    expect(await fetchModelsFetcherIds(key, config)).toEqual(["a-free"]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("actually aborts an unresolved fetch at eight seconds", async () => {
    vi.useFakeTimers();
    globalThis.fetch.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("fixture abort")), { once: true });
    }));
    const pending = fetchModelsFetcherIds(key, {
      id: key, modelsFetcher: { url: "https://models.dev/api.json", type: "opencode-free" },
    });
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toEqual([]);
    expect(globalThis.fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
});
