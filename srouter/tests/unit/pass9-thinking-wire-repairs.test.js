// Pass9 thinking-wire repair acceptance — production code paths only.
//
// Every case runs the real `translateRequest` (open-sse/translator/index.js) and
// the real executor body preparation (`getExecutor(provider).transformRequest`),
// i.e. the same functions the router uses. No clones, no stubs, no DB, no
// network. These are Pass9 current facts; the immutable Pass8 pins are
// untouched and the before/after bodies are archived in
// evidence/pass9-catalog-repairs/preimages/thinking-wire-{before,after}.json.
import { describe, expect, it } from "vitest";
import { translateRequest } from "open-sse/translator/index.js";
import { getExecutor } from "open-sse/executors/index.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

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

const run = (source, target, provider, model, body) =>
  translateRequest(source, target, model, structuredClone(body), false, null, provider);

// The exact upstream payload shape, after the executor's own body preparation.
const prepare = (provider, model, body) => getExecutor(provider).transformRequest(model, structuredClone(body));

describe("1. Native Claude transport: agentrouter emits the Anthropic budget wire, not the zai wire", () => {
  it("claude-budget via the real translateRequest + executor", () => {
    const high = run("openai", "claude", "agentrouter", "glm-5.2", openaiBody("high"));
    expect(high.thinking).toEqual({ type: "enabled", budget_tokens: 24576, display: "summarized" });
    // The pre-repair zai shape had no budget_tokens and used enable_thinking for "off".
    expect(high.reasoning_effort).toBeUndefined();
    expect(high.enable_thinking).toBeUndefined();

    const prepared = prepare("agentrouter", "glm-5.2", high);
    expect(prepared.thinking).toEqual({ type: "enabled", budget_tokens: 24576, display: "summarized" });
    expect(prepared.enable_thinking).toBeUndefined();

    // A client that only sends a Claude budget keeps that budget (mode: budget).
    const budgeted = run("claude", "claude", "agentrouter", "glm-5.2", claudeBudgetBody(12000));
    expect(budgeted.thinking).toEqual({ type: "enabled", budget_tokens: 12000 });
  });

  it("zcode/GLM-5.2 uses official symbolic effort, independently of AgentRouter", () => {
    const repaired = run("openai", "claude", "zcode", "GLM-5.2", openaiBody("high"));
    const fixed = run("openai", "claude", "agentrouter", "glm-5.2", openaiBody("high"));
    expect(repaired.thinking).toEqual({ type: "enabled" });
    expect(repaired.output_config).toEqual({ effort: "high" });
    expect(repaired.thinking.budget_tokens).toBeUndefined();
    expect(fixed.thinking.budget_tokens).toBe(24576);
    expect(repaired.reasoning_effort).toBeUndefined();
    expect(repaired.enable_thinking).toBeUndefined();
    expect(run("openai", "claude", "zcode", "GLM-5.2", openaiBody("none")).thinking).toEqual({ type: "disabled" });
  });
});

describe("2. OpenAI transport: reasoning_effort only, no vendor-native thinking object, effort never dropped", () => {
  it("clinepass/deepseek-v4-pro", () => {
    const high = run("openai", "openai", "clinepass", "deepseek-v4-pro", openaiBody("high"));
    expect(high.reasoning_effort).toBe("high");
    expect(high.thinking).toBeUndefined();
    expect(prepare("clinepass", "deepseek-v4-pro", high).reasoning_effort).toBe("high");

    // A Claude-shaped client asking for 8000 budget maps onto the Vercel effort enum.
    const fromClaude = run("claude", "openai", "clinepass", "deepseek-v4-pro", claudeBudgetBody(8000));
    expect(fromClaude.reasoning_effort).toBe("medium");
    expect(fromClaude.thinking).toBeUndefined();
  });

  it("codebuddy-cn/glm-5.0-turbo keeps its effort (regression guard for the prior zai metadata)", () => {
    const high = run("openai", "openai", "codebuddy-cn", "glm-5.0-turbo", openaiBody("high"));
    expect(high.reasoning_effort).toBe("high");
    expect(high.thinking).toBeUndefined();
    const prepared = prepare("codebuddy-cn", "glm-5.0-turbo", high);
    expect(prepared.reasoning_effort).toBe("high");
    expect(prepared.thinking).toBeUndefined();

    const fromClaude = run("claude", "openai", "codebuddy-cn", "glm-5.0-turbo", claudeBudgetBody(8000));
    expect(fromClaude.reasoning_effort).toBe("medium");
    expect(fromClaude.thinking).toBeUndefined();
  });

  it("caps metadata agrees with the wire for all three repaired providers", () => {
    expect(getCapabilitiesForModel("clinepass", "deepseek-v4-pro").thinkingFormat).toBe("openai");
    expect(getCapabilitiesForModel("codebuddy-cn", "glm-5.0-turbo").thinkingFormat).toBe("openai");
    expect(getCapabilitiesForModel("agentrouter", "glm-5.2").thinkingFormat).toBe("claude-budget");
  });
});

describe("3. Explicit off respects thinkingCanDisable per wire", () => {
  it("disable-capable wires emit their real off signal", () => {
    expect(run("openai", "claude", "agentrouter", "glm-5.2", openaiBody("none")).thinking).toEqual({ type: "disabled" });
    expect(run("openai", "openai", "codex", "gpt-6.1-sol", openaiBody("none")).reasoning_effort).toBe("none");
  });

  it("non-disableable wires clamp off to the minimum instead of disabling", () => {
    const clinepass = run("openai", "openai", "clinepass", "deepseek-v4-pro", openaiBody("none"));
    expect(clinepass.reasoning_effort).toBe("minimal");
    expect(clinepass.thinking).toBeUndefined();

    const codebuddy = run("openai", "openai", "codebuddy-cn", "glm-5.0-turbo", openaiBody("none"));
    expect(codebuddy.reasoning_effort).toBe("minimal");
    expect(codebuddy.thinking).toBeUndefined();

    // kimchi kimi-k2.7 (kimi wire): no thinking.disabled, clamped kimi effort.
    const kimchi = run("openai", "openai", "kimchi", "kimi-k2.7", openaiBody("none"));
    expect(kimchi.thinking).toBeUndefined();
    expect(kimchi.reasoning_effort).toBe("low");
    expect(prepare("kimchi", "kimi-k2.7", kimchi).reasoning_effort).toBe("low");

    // The disable clamp is scoped to the kimchi gateway: the shared Kimi
    // platform row keeps its own disable semantics.
    expect(getCapabilitiesForModel("kimchi", "kimi-k2.7").thinkingCanDisable).toBe(false);
    expect(getCapabilitiesForModel("kimi", "kimi-k2.7").thinkingCanDisable).toBe(true);

    const kimchiHigh = run("openai", "openai", "kimchi", "kimi-k2.7", openaiBody("high"));
    expect(kimchiHigh.reasoning_effort).toBe("high");

    // Existing non-disableable openai override stays as it was.
    expect(run("openai", "openai", "opencode-go", "glm-5.3-flash", openaiBody("none")).reasoning_effort).toBe("minimal");
  });

  it("disabled thinking from a Claude client is not silently re-enabled", () => {
    const clinepass = run("claude", "openai", "clinepass", "deepseek-v4-pro", claudeOffBody());
    expect(clinepass.reasoning_effort).toBe("minimal");
    expect(clinepass.thinking).toBeUndefined();
    const agentrouter = run("claude", "claude", "agentrouter", "glm-5.2", claudeOffBody());
    expect(agentrouter.thinking).toEqual({ type: "disabled" });
    const kimchi = run("claude", "openai", "kimchi", "kimi-k2.7", claudeOffBody());
    expect(kimchi.reasoning_effort).toBe("low");
    expect(kimchi.thinking).toBeUndefined();
  });
});
