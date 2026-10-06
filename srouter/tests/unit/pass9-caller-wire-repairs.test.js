// Pass9 caller-closure repairs (follow-up #4) — production code paths only.
//
// Every case runs the real `translateRequest`, the real executor body
// preparation / header building, and (for the Kimchi gateway) the real
// `BaseExecutor.execute`: only the network edge is replaced (`proxyAwareFetch`)
// so the captured URL/headers/JSON body are exactly what the executor would
// send, with no outbound request. The live CLI User-Agent hook is pinned to a
// fixed version instead of calling GitHub. No DB, no clones, no stubs of the
// logic under test. These are Pass9 current facts; the immutable Pass8 pins are
// untouched and the before/after bodies live in
//    ../docs/work/T-0030-upstream-parity/evidence/pass9-catalog-repairs/preimages/
//      thinking-wire-{before4,after4}.json        (zcode/glm-cn intent matrix)
//      kimchi-wire-{before,after4}.json           (kimchi credentials + Claude models)
//      glm-cn-effort-crosspin-{before,after4}.json (local vs nine vs vans)
import { beforeAll, describe, expect, it, vi } from "vitest";
import { translateRequest } from "open-sse/translator/index.js";
import { getExecutor } from "open-sse/executors/index.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { PROVIDERS } from "open-sse/providers/index.js";
import { refreshKimchiUserAgent, DEFAULT_VERSION } from "open-sse/utils/kimchiUserAgent.js";
import { ZCODE_CONFIG } from "open-sse/config/zcodeConfig.js";

// Outbound request capture: the real executors call this exact function.
const sent = vi.hoisted(() => []);
vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: async (url, options = {}) => {
    sent.push({
      url: String(url),
      headers: { ...(options.headers || {}) },
      body: options.body ? JSON.parse(options.body) : null,
    });
    return new Response(JSON.stringify({
      id: "fixture", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  },
}));

const UA_STATE_KEY = "srouter.kimchiUserAgent.state";
const kimchiUserAgentState = () => (globalThis[UA_STATE_KEY] || {}).value;

const openaiBody = (effort) => ({
  model: "x", messages: [{ role: "user", content: "hi" }],
  ...(effort === null ? {} : { reasoning_effort: effort }),
});
const claudeBudgetBody = (budget) => ({
  model: "x", max_tokens: 1024, messages: [{ role: "user", content: "hi" }],
  thinking: { type: "enabled", budget_tokens: budget },
});
const claudeOffBody = () => ({
  model: "x", max_tokens: 1024, messages: [{ role: "user", content: "hi" }],
  thinking: { type: "disabled" },
});

// The provider's declared wire format as the router reads it (the built
// PROVIDERS entry flattens the registry transport; buildTransport always
// defaults `format` to "openai").
const wire = (provider) => PROVIDERS[provider]?.format || "openai";
const run = (source, target, provider, model, body) =>
  translateRequest(source, target, model, structuredClone(body), false, null, provider);
const prepare = (provider, model, body) => getExecutor(provider).transformRequest(model, structuredClone(body));
const THINKING_KEYS = ["thinking", "reasoning_effort", "enable_thinking", "thinking_budget", "output_config"];
const thinkingShape = (body) => Object.fromEntries(THINKING_KEYS.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));

describe("1. zcode (native Claude transport): GLM-5.2 uses symbolic effort", () => {
  it("client level → output_config.effort, without invented budgets", () => {
    expect(wire("zcode")).toBe("claude");
    const high = run("openai", wire("zcode"), "zcode", "GLM-5.2", openaiBody("high"));
    expect(thinkingShape(high)).toEqual({ thinking: { type: "enabled" }, output_config: { effort: "high" } });

    const prepared = prepare("zcode", "GLM-5.2", high);
    expect(thinkingShape(prepared)).toEqual({ thinking: { type: "enabled" }, output_config: { effort: "high" } });
  });

  it("an explicit Claude budget is preserved, an explicit off is Anthropic disabled", () => {
    const budgeted = run("claude", wire("zcode"), "zcode", "GLM-5.2", claudeBudgetBody(12000));
    expect(budgeted.thinking).toEqual({ type: "enabled", budget_tokens: 12000 });
    expect(thinkingShape(prepare("zcode", "GLM-5.2", budgeted))).toEqual({ thinking: { type: "enabled", budget_tokens: 12000 } });

    expect(thinkingShape(run("openai", wire("zcode"), "zcode", "GLM-5.2", openaiBody("none")))).toEqual({ thinking: { type: "disabled" } });
    expect(run("claude", wire("zcode"), "zcode", "GLM-5.2", claudeOffBody()).thinking).toEqual({ type: "disabled" });
    expect(thinkingShape(run("openai", wire("zcode"), "zcode", "GLM-5.2", openaiBody(null)))).toEqual({});
  });

  it("caps keep today's numerics/features and only change the wire claim", () => {
    const caps = getCapabilitiesForModel("zcode", "GLM-5.2");
    expect(caps.thinkingFormat).toBe("glm-messages");
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingCanDisable).toBe(true);
    expect(caps.thinkingEffortSupported).toBe(true);
    // Preserved as resolved before the repair (the pinned Model API numerics
    // 128000/128000 stay deferred to T-0039).
    expect(caps.contextWindow).toBe(200000);
    expect(caps.maxOutput).toBe(128000);
    // The registry declares GLM-5.2; a lowercase client token must not fall back
    // to the zai pattern.
    expect(getCapabilitiesForModel("zcode", "glm-5.2").thinkingFormat).toBe("glm-messages");
    expect(thinkingShape(run("openai", wire("zcode"), "zcode", "glm-5.2", openaiBody("none")))).toEqual({ thinking: { type: "disabled" } });
  });

  it("Max and Turbo variants use Messages controls and preserve explicit client intent", () => {
    const maxHigh = run("openai", wire("zcode"), "zcode", "GLM-5.2-Max", openaiBody("high"));
    expect(getCapabilitiesForModel("zcode", "GLM-5.2-Max").thinkingFormat).toBe("glm-messages");
    expect(maxHigh.reasoning_effort).toBeUndefined();
    expect(maxHigh.thinking).toEqual({ type: "enabled" });
    expect(maxHigh.output_config).toEqual({ effort: "high" });
    const maxPrepared = prepare("zcode", "GLM-5.2-Max", maxHigh);
    expect(maxPrepared.model).toBe("GLM-5.2");
    expect(maxPrepared.thinking).toEqual(maxHigh.thinking);
    expect(maxPrepared.reasoning_effort).toBeUndefined();

    expect(getCapabilitiesForModel("zcode", "GLM-5-Turbo").thinkingFormat).toBe("glm-messages");
    expect(thinkingShape(run("openai", wire("zcode"), "zcode", "GLM-5-Turbo", openaiBody("high")))).toEqual({ thinking: { type: "enabled" } });
    expect(thinkingShape(run("openai", wire("zcode"), "zcode", "GLM-5-Turbo", openaiBody("none")))).toEqual({ thinking: { type: "disabled" } });
  });

  it.each(["GLM-5.2-Max", "GLM-5-Turbo-Max"])("applies Max defaults only without controls: %s", (model) => {
    const absent = prepare("zcode", model, run("openai", wire("zcode"), "zcode", model, openaiBody(null)));
    expect(absent.thinking).toEqual({ type: "enabled" });
    expect(absent.output_config).toEqual(model === "GLM-5.2-Max" ? { effort: ZCODE_CONFIG.maxDefaultEffort } : undefined);
    const off = prepare("zcode", model, run("openai", wire("zcode"), "zcode", model, openaiBody("none")));
    expect(thinkingShape(off)).toEqual({ thinking: { type: "disabled" } });
    const budget = prepare("zcode", model, run("claude", wire("zcode"), "zcode", model, claudeBudgetBody(12000)));
    expect(budget.thinking).toEqual({ type: "enabled", budget_tokens: 12000 });
    expect(budget.max_tokens).toBeGreaterThan(12000);
  });
});

describe("2. glm-cn: glm-5.2 keeps reasoning_effort (z.ai reads it from 5.2 onward)", () => {
  it("uses documented 5.2 Coding Plan normalization", () => {
    const low = run("openai", wire("glm-cn"), "glm-cn", "glm-5.2", openaiBody("low"));
    expect(thinkingShape(low)).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "high" });
    expect(thinkingShape(prepare("glm-cn", "glm-5.2", low))).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "high" });
    expect(run("openai", wire("glm-cn"), "glm-cn", "glm-5.2", openaiBody("high")).reasoning_effort).toBe("high");
    expect(thinkingShape(run("openai", wire("glm-cn"), "glm-cn", "glm-5.2", openaiBody("none")))).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "none" });
    expect(run("openai", wire("glm-cn"), "glm-cn", "glm-5.2", openaiBody("minimal")).reasoning_effort).toBe("none");
    expect(run("claude", wire("glm-cn"), "glm-cn", "glm-5.2", claudeOffBody()).reasoning_effort).toBe("none");
  });

  it("only the exact version gains the flag — 4.x/5.0/5.1/turbo keep dropping it", () => {
    expect(getCapabilitiesForModel("glm-cn", "glm-5.2").thinkingEffortSupported).toBe(true);
    expect(getCapabilitiesForModel("glm-cn", "glm-5.2").thinkingCanDisable).toBe(true);
    expect(getCapabilitiesForModel("glm-cn", "glm-5.3").thinkingEffortSupported).toBe(true);
    for (const older of ["glm-4.7", "glm-4.6", "glm-5.1", "glm-5-turbo", "glm-5.0-turbo", "glm-4.5-air"]) {
      expect(`${older}:${getCapabilitiesForModel("glm-cn", older).thinkingEffortSupported}`).toBe(`${older}:false`);
    }
    expect(thinkingShape(run("openai", wire("glm-cn"), "glm-cn", "glm-4.7", openaiBody("low")))).toEqual({ thinking: { type: "enabled" } });
    expect(thinkingShape(run("openai", wire("glm-cn"), "glm-cn", "glm-4.6", openaiBody("none")))).toEqual({ enable_thinking: false });
  });

  it("does not widen the CN contract to other GLM gateways", () => {
    expect(getCapabilitiesForModel("glm", "glm-5.2").thinkingEffortSupported).toBe(true);
    expect(getCapabilitiesForModel("zai", "glm-5.2").thinkingEffortSupported).toBe(true);
    expect(run("openai", wire("zai"), "zai", "glm-5.2", openaiBody("high")).reasoning_effort).toBe("high");
    expect(run("openai", wire("glm"), "glm", "glm-5.2", openaiBody("low")).reasoning_effort).toBe("low");
  });

  it.each(["glm-5.3", "glm-5.3-flash"])("%s off is minimum reasoning; explicit effort outranks toggle", (model) => {
    const off = run("openai", wire("glm-cn"), "glm-cn", model, openaiBody("none"));
    expect(thinkingShape(off)).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "low" });
    const explicit = run("claude", wire("glm-cn"), "glm-cn", model, {
      ...claudeOffBody(), output_config: { effort: "high" },
    });
    expect(thinkingShape(explicit)).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "high" });
    expect(getCapabilitiesForModel("glm-cn", model).thinkingCanDisable).toBe(false);
  });
});

describe("3. kimchi gateway: credentials, user agent and reasoning effort on the real execute path", () => {
  const KIMCHI_URL = "https://llm.kimchi.dev/openai/v1/chat/completions";

  beforeAll(async () => {
    // Pin the live CLI version hook instead of calling the GitHub releases API.
    await refreshKimchiUserAgent(async () => ({ ok: true, json: async () => ({ tag_name: "v9.9.9" }) }), { force: true });
    expect(kimchiUserAgentState()).toBe("kimchi/9.9.9");
  });

  async function execute(model, credentials, body) {
    sent.length = 0;
    const wired = translateRequest("openai", wire("kimchi"), model, structuredClone(body), false, credentials, "kimchi");
    const result = await getExecutor("kimchi").execute({ model, body: wired, stream: false, credentials });
    expect(sent.length).toBe(1); // exactly one outbound request, captured instead of sent
    return { result, request: sent[0] };
  }

  it("apiKey and OAuth accessToken are transmitted as the same exact Bearer header", async () => {
    const withKey = await execute("kimi-k2.7", { apiKey: "castai_fixture_api_key" }, openaiBody("high"));
    expect(withKey.request.url).toBe(KIMCHI_URL);
    expect(withKey.request.headers.Authorization).toBe("Bearer castai_fixture_api_key");
    expect(withKey.request.headers["x-api-key"]).toBeUndefined();
    expect(withKey.request.headers["Content-Type"]).toBe("application/json");
    expect(withKey.request.headers["User-Agent"]).toBe("kimchi/9.9.9");
    expect(withKey.result.transformedBody.reasoning_effort).toBe("high");

    const withToken = await execute("kimi-k2.7", { accessToken: "castai_fixture_oauth_token" }, openaiBody("high"));
    expect(withToken.request.url).toBe(KIMCHI_URL);
    expect(withToken.request.headers.Authorization).toBe("Bearer castai_fixture_oauth_token");
    expect(withToken.request.headers["User-Agent"]).toBe("kimchi/9.9.9");

    // Both credentials present: the combined descriptor takes the API key.
    const both = await execute("kimi-k2.7", { apiKey: "castai_fixture_api_key", accessToken: "castai_fixture_oauth_token" }, openaiBody("high"));
    expect(both.request.headers.Authorization).toBe("Bearer castai_fixture_api_key");
  });

  it("anthropic-backed models keep the authorized reasoning effort (it was deleted before the repair)", async () => {
    for (const model of ["claude-opus-4-6", "claude-sonnet-4-6"]) {
      const high = await execute(model, { apiKey: "k" }, openaiBody("high"));
      expect(`${model}:${high.result.transformedBody.reasoning_effort}`).toBe(`${model}:high`);
      expect(high.result.transformedBody.thinking).toBeUndefined();

      const none = await execute(model, { apiKey: "k" }, openaiBody("none"));
      expect(none.result.transformedBody.reasoning_effort).toBe("none");
      expect(none.result.transformedBody.thinking).toBeUndefined();

      // Claude-shaped client: budget → effort level, thinking object never leaks.
      const budgeted = await execute(model, { apiKey: "k" }, claudeBudgetBody(12000));
      expect(budgeted.result.transformedBody.reasoning_effort).toBe("medium");
      expect(budgeted.result.transformedBody.thinking).toBeUndefined();

      const off = await execute(model, { apiKey: "k" }, claudeOffBody());
      expect(off.result.transformedBody.reasoning_effort).toBe("none");
      expect(off.request.body.thinking).toBeUndefined();
      expect(off.result.transformedBody.reasoning).toBeUndefined();
      expect(off.result.transformedBody.anthropic_version).toBeUndefined();
      expect(off.result.transformedBody.top_k).toBeUndefined();
      expect(off.result.transformedBody.stop_sequences).toBeUndefined();
      expect(off.result.transformedBody.mcp_servers).toBeUndefined();
    }
  });

  it("native vendor thinking objects are still dropped for every model", async () => {
    const leak = { ...openaiBody("low"), thinking: { type: "enabled", budget_tokens: 4096 }, anthropic_version: "2023-06-01", top_k: 40, stop_sequences: ["x"], mcp_servers: [] };
    for (const model of ["kimi-k2.7", "minimax-m3", "claude-opus-4-6"]) {
      const out = await execute(model, { apiKey: "k" }, leak);
      expect(out.request.url).toBe(KIMCHI_URL);
      expect(out.result.transformedBody.thinking).toBeUndefined();
      expect(out.result.transformedBody.anthropic_version).toBeUndefined();
      expect(out.result.transformedBody.top_k).toBeUndefined();
      expect(out.result.transformedBody.stop_sequences).toBeUndefined();
      expect(out.result.transformedBody.mcp_servers).toBeUndefined();
    }
    // Non-anthropic models keep their level too (no regression).
    const kimi = await execute("kimi-k2.7", { apiKey: "k" }, openaiBody("high"));
    expect(kimi.result.transformedBody.reasoning_effort).toBe("high");
  });
});

describe("4. declared defaults", () => {
  it("kimchi fallback User-Agent version and the transports under test", () => {
    expect(DEFAULT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(wire("zcode")).toBe("claude");
    expect(wire("kimchi")).toBe("openai");
  });
});
