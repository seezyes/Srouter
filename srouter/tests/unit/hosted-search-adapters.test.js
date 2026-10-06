import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), openaiExecute: vi.fn(), accounts: vi.fn(), node: vi.fn(), hostedWip: false }));
// Internal adapter regressions run with the gate off; no production opt-in
// exists. WIP boundary tests explicitly enable the gate.
vi.mock("@/shared/constants/hostedTools.js", () => ({
  get HOSTED_TOOLS_WIP() { return mocks.hostedWip; },
  HOSTED_TOOLS_WIP_MESSAGE: "Hosted tools connector is WIP and unavailable.",
}));
vi.mock("open-sse/executors/codex.js", () => ({
  CodexExecutor: class { execute(options) { return mocks.execute(options); } },
}));
vi.mock("open-sse/executors/default.js", () => ({
  DefaultExecutor: class { execute(options) { return mocks.openaiExecute(options); } },
}));
vi.mock("@/models", () => ({ getProviderConnections: mocks.accounts, getProviderNodeById: mocks.node }));

import { initializeHostedSearchPlugins, getHostedSearchPlugins, loadHostedSearchPlugins } from "@/lib/hostedSearch/plugins.js";
import { getHostedSearchAdapters, getHostedSearchMetadata, runHostedSearch } from "@/lib/hostedSearch/registry.js";
import { validateLinkedSearchSource } from "@/lib/hostedSearch/validate.js";
import { GET as getMetadata } from "@/app/api/hosted-search-adapters/route.js";
import { searchResponses } from "@/lib/hostedSearch/responses.js";
const searchCodex = (options) => searchResponses({ ...options, providerId: "codex" });

const state = Symbol.for("srouter.hostedSearch.plugins.v1");
let directory;
beforeEach(async () => {
  mocks.hostedWip = false;
  delete globalThis[state];
  vi.clearAllMocks();
  directory = await mkdtemp(path.join(os.tmpdir(), "srouter-hosted-plugins-"));
  mocks.accounts.mockResolvedValue([{ id: "own", provider: "codex" }]);
  mocks.node.mockResolvedValue(null);
});
afterEach(async () => {
  delete globalThis[state];
  await rm(directory, { recursive: true, force: true });
});
const writePlugin = (filename, code) => writeFile(path.join(directory, filename), code);
const plugin = (id) => `export default {
  id: '${id}', name: 'Local search', providerIds: ['*'],
  search: async ({query, credentials}) => ({ results: [{url: 'https://example.org', title: query}], answer: 'ok' })
};`;

describe("WIP blocks builtins but leaves direct local plugins available", () => {
  it("initializes local plugins and exposes only their metadata", async () => {
    mocks.hostedWip = true;
    await writePlugin("a.mjs", plugin("disabled"));
    expect((await initializeHostedSearchPlugins(directory)).size).toBe(1);
    expect(globalThis[state]).toBeDefined();
    const metadata = await (await getMetadata()).json();
    expect(metadata.adapters.map((adapter) => adapter.id)).toEqual(["plugin:disabled"]);
    expect(metadata.available).toBe(true);
    expect(metadata.status).toBe("local-plugins-only");
    expect(metadata.builtinsAvailable).toBe(false);
  });

  it("refuses builtin and native Responses execution before calling any model backend", async () => {
    mocks.hostedWip = true;
    const search = vi.fn();
    expect((await runHostedSearch({
      adapter: { id: "builtin:codex", search }, body: { query: "hello" },
      provider: { id: "codex" }, credentials: {}, attributionId: "node",
    })).status).toBe(503);
    expect((await searchResponses({ providerId: "codex" })).status).toBe(503);
    expect(search).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.openaiExecute).not.toHaveBeenCalled();
  });

  it("validates a direct plugin under the production gate and rejects builtin/model options", async () => {
    mocks.hostedWip = true;
    await writePlugin("a.mjs", plugin("direct"));
    await initializeHostedSearchPlugins(directory);
    const source = { mode: "plugin", sourceProviderId: "codex", sourceAdapterId: "plugin:direct", sourceConnectionId: "own" };
    expect(await validateLinkedSearchSource(source)).toMatchObject({ sourceAdapterId: "plugin:direct", sourceModel: null });
    expect(await validateLinkedSearchSource({ ...source, sourceAdapterId: "builtin:codex" })).toHaveProperty("error");
    expect(await validateLinkedSearchSource({ ...source, sourceAdapterId: "plugin:missing" })).toHaveProperty("error");
    expect(await validateLinkedSearchSource({ ...source, sourceModel: "gpt-test" })).toHaveProperty("error");
    expect(await validateLinkedSearchSource({ ...source, mode: "linked" })).toHaveProperty("status", 503);
    mocks.accounts.mockResolvedValue([{ id: "own", provider: "openai" }]);
    expect(await validateLinkedSearchSource(source)).toHaveProperty("error", "Account does not belong to the selected provider");
  });
});

describe("trusted local plugin startup snapshot", () => {
  it("does not load plugins from a dashboard request before instrumentation", async () => {
    expect((await getHostedSearchPlugins()).size).toBe(0);
    const data = await (await getMetadata()).json();
    expect(data.adapters.some((adapter) => adapter.id.startsWith("plugin:"))).toBe(false);
    expect(data.restartRequired).toBe(true);
  });

  it("loads once at startup and does not see added or changed files until another process", async () => {
    await writePlugin("a.mjs", plugin("first"));
    const first = await initializeHostedSearchPlugins(directory);
    await writePlugin("b.mjs", plugin("second"));
    await writePlugin("a.mjs", plugin("changed"));
    expect(await initializeHostedSearchPlugins(directory)).toBe(first);
    expect([...first.keys()]).toEqual(["plugin:first"]);
    expect((await getHostedSearchPlugins()).has("plugin:second")).toBe(false);
  });

  it("ignores invalid manifests, nested files, non-mjs files and duplicate ids", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await writePlugin("a.mjs", plugin("valid"));
      await writePlugin("b.mjs", plugin("valid"));
      await writePlugin("bad.mjs", "export default { id: '../escape', search() {} };");
      await writePlugin("ignored.js", plugin("ignored"));
      await mkdir(path.join(directory, "nested"));
      await writeFile(path.join(directory, "nested", "nested.mjs"), plugin("nested"));
      const loaded = await loadHostedSearchPlugins(directory);
      expect([...loaded.keys()]).toEqual(["plugin:valid"]);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally { warn.mockRestore(); }
  });

  it("metadata contains no executable functions, code, credentials or file paths", async () => {
    await writePlugin("a.mjs", plugin("local"));
    await initializeHostedSearchPlugins(directory);
    const data = await getHostedSearchMetadata();
    expect(data.find((adapter) => adapter.id === "plugin:local")).toEqual({
      id: "plugin:local", name: "Local search", providerIds: ["*"], kind: "local-plugin",
    });
    expect(JSON.stringify(data)).not.toContain(directory);
    expect(JSON.stringify(data)).not.toContain("credentials");
  });

  it("missing plugin directory is a valid empty startup snapshot", async () => {
    expect((await loadHostedSearchPlugins(path.join(directory, "missing"))).size).toBe(0);
  });
});

describe("linked adapter validation and dispatch", () => {
  it("Codex reuses the existing OAuth provider and gets an adapter without a new provider id", async () => {
    expect(await validateLinkedSearchSource({ sourceProviderId: "codex", sourceConnectionId: "own" })).toMatchObject({
      sourceProviderId: "codex", sourceConnectionId: "own", sourceAdapterId: "builtin:codex",
    });
  });

  it("rejects a pin belonging to another provider", async () => {
    mocks.accounts.mockResolvedValue([{ id: "api-key", provider: "openai" }]);
    expect(await validateLinkedSearchSource({
      sourceProviderId: "codex", sourceConnectionId: "api-key", sourceAdapterId: "builtin:codex",
    })).toHaveProperty("error", "Account does not belong to the selected provider");
  });

  it("wildcard plugin can serve an ordinary non-search OAuth provider", async () => {
    await writePlugin("a.mjs", plugin("any"));
    await initializeHostedSearchPlugins(directory);
    expect(await validateLinkedSearchSource({
      sourceProviderId: "claude", sourceAdapterId: "plugin:any",
    })).toMatchObject({ sourceProviderId: "claude", sourceAdapterId: "plugin:any" });
  });

  it("does not load client-supplied paths or accept unloaded adapters", async () => {
    expect(await validateLinkedSearchSource({
      sourceProviderId: "codex", sourceAdapterId: "../../bad.mjs",
    })).toHaveProperty("error");
    expect((await getHostedSearchPlugins()).size).toBe(0);
  });

  it("passes only controlled context and the selected credential, attributes results to the node", async () => {
    mocks.hostedWip = true;
    const search = vi.fn(async () => ({ results: [{ url: "https://example.org", title: "Result" }], answer: "Answer" }));
    const credentials = { accessToken: "synthetic-test-token", connectionId: "own" };
    const result = await runHostedSearch({
      adapter: { id: "plugin:test", search },
      body: { query: "hello", max_results: 2, provider_options: { baseUrl: "https://untrusted.invalid" } },
      provider: { id: "codex" }, credentials, attributionId: "custom-websearch-one", model: "test-model",
    });
    const context = search.mock.calls[0][0];
    expect(context.credentials).toBe(credentials);
    expect(Object.keys(context).sort()).toEqual(["credentials", "maxResults", "providerId", "query", "signal"]);
    const data = await result.response.json();
    expect(data.results[0].citation.provider).toBe("custom-websearch-one");
    expect(data.provider).toBe("custom-websearch-one");
    expect(data.metrics.response_time_ms).toBeGreaterThanOrEqual(0);
    expect(data.usage.search_cost_usd).toBeNull();
    expect(JSON.stringify(data)).not.toContain(credentials.accessToken);
    expect(data.answer).not.toHaveProperty("model");
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.openaiExecute).not.toHaveBeenCalled();
  });

  it("does not expose credentials in thrown plugin errors", async () => {
    const result = await runHostedSearch({
      adapter: { id: "plugin:test", search: async () => { throw new Error("secret-token"); } },
      body: { query: "hello" }, provider: { id: "codex" },
      credentials: {}, attributionId: "custom-websearch-one",
    });
    expect(result.status).toBe(502);
    expect(await result.response.text()).not.toContain("secret-token");
  });

  it("times out a plugin which ignores its abort signal", async () => {
    vi.useFakeTimers();
    try {
      const promise = runHostedSearch({
        adapter: { id: "plugin:test", search: () => new Promise(() => {}) },
        body: { query: "hello" }, provider: { id: "codex" }, credentials: {}, attributionId: "node",
      });
      await vi.advanceTimersByTimeAsync(60001);
      expect((await promise).status).toBe(504);
    } finally { vi.useRealTimers(); }
  });
});

const completed = {
  status: "completed",
  output: [
    { type: "web_search_call", action: { sources: [{ url: "https://example.org", title: "Source" }] } },
    { type: "message", content: [{ type: "output_text", text: "Answer", annotations: [
      { type: "url_citation", url: "https://example.org", title: "Citation" },
    ] }] },
  ],
  usage: { total_tokens: 42 },
};
function nativeResponse(data = completed) {
  return { response: new Response(`data: ${JSON.stringify({ type: "response.completed", response: data })}`, {
    headers: { "Content-Type": "text/event-stream" },
  }) };
}
describe("Codex native hosted search via the existing executor", () => {
  it("OpenAI API hosted search uses the registered Responses transport, not Codex OAuth", async () => {
    mocks.openaiExecute.mockResolvedValue(nativeResponse());
    const adapter = (await getHostedSearchAdapters()).get("builtin:openai");
    const credentials = { apiKey: "synthetic-api-key" };
    const result = await searchResponses({
      query: "hello", model: adapter.defaultModel, credentials, providerId: "openai",
    });
    expect(result.results).toHaveLength(1);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.openaiExecute.mock.calls[0][0].credentials).toMatchObject({
      apiKey: "synthetic-api-key",
      runtimeTransport: { format: "openai-responses", baseUrl: "https://api.openai.com/v1/responses" },
    });
  });
  it("uses native web_search with selected OAuth credentials and parses SSE citations", async () => {
    mocks.execute.mockResolvedValue(nativeResponse());
    const adapter = (await getHostedSearchAdapters()).get("builtin:codex");
    const credentials = { accessToken: "synthetic-token", connectionId: "own" };
    const result = await searchCodex({ query: "hello", model: adapter.defaultModel, credentials, signal: new AbortController().signal });
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({
      credentials, stream: true, body: expect.objectContaining({ tools: [{ type: "web_search" }] }),
    }));
    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toBe("Citation");
    expect(result.answer).toBe("Answer");
    expect(result.usage.total_tokens).toBe(42);
  });

  it("does not treat ungrounded model text as successful hosted search", async () => {
    mocks.execute.mockResolvedValue(nativeResponse({ ...completed, output: completed.output.slice(1) }));
    await expect(searchCodex({ query: "hello", model: "test", credentials: {} })).rejects.toThrow("did not execute");
  });

  it("preserves HTTP auth failures for the account-selection loop", async () => {
    mocks.execute.mockResolvedValue({ response: new Response("private upstream body", { status: 401 }) });
    expect(await searchCodex({ query: "hello", model: "test", credentials: {} })).toMatchObject({ status: 401 });
  });

  it("rejects incomplete native responses", async () => {
    mocks.execute.mockResolvedValue({ response: new Response('data: {"type":"response.incomplete"}\n\n') });
    await expect(searchCodex({ query: "hello", model: "test", credentials: {} })).rejects.toThrow("did not complete");
  });
});
