import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import {
  FactoryExecutor,
  factoryOrgIdFromToken,
  factorySessionUuid,
  resolveFactoryUpstream,
  resolveFactoryWire,
} from "../../open-sse/executors/factory.js";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.js";
import { parseUpstreamError } from "../../open-sse/utils/error.js";

const COMPLETIONS = "https://api.factory.ai/api/llm/o/v1/chat/completions";
const RESPONSES = "https://api.factory.ai/api/llm/o/v1/responses";
const ANTHROPIC = "https://api.factory.ai/api/llm/a/v1/messages";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const executor = new FactoryExecutor();

function okResponse() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function credentials(extra = {}) {
  return { apiKey: "sk-test", connectionId: "conn-1", rawHeaders: {}, ...extra };
}

describe("factory executor registration", () => {
  it("is the specialized executor for the factory provider", () => {
    expect(hasSpecializedExecutor("factory")).toBe(true);
    expect(getExecutor("factory")).toBeInstanceOf(FactoryExecutor);
  });
});

describe("factory wire resolution", () => {
  it("maps model families to their wire and upstream", () => {
    expect(resolveFactoryWire("claude-opus-4-6")).toBe("claude");
    expect(resolveFactoryWire("gpt-6-sol")).toBe("openai-responses");
    expect(resolveFactoryWire("kimi-k3")).toBe("openai");
    expect(resolveFactoryWire("unknown-model")).toBe("openai");
    expect(resolveFactoryUpstream("claude-opus-4-6")).toBe("anthropic");
    expect(resolveFactoryUpstream("glm-5.2")).toBe("baseten");
    expect(resolveFactoryUpstream("mistral-medium-3.5")).toBe("mistral");
    expect(resolveFactoryUpstream("grok-4.6")).toBe("xai");
    expect(resolveFactoryWire("grok-4.6")).toBe("openai-responses");
    expect(resolveFactoryUpstream("unknown-model")).toBe("fireworks");
  });

  it("buildUrl picks the family endpoint when no runtime transport is set", () => {
    expect(executor.buildUrl("claude-opus-4-6", true, 0, {})).toBe(ANTHROPIC);
    expect(executor.buildUrl("gpt-6-luna", false, 0, null)).toBe(RESPONSES);
    expect(executor.buildUrl("glm-5.3", true, 0, null)).toBe(COMPLETIONS);
    expect(executor.buildUrl("custom-model", true, 0, null)).toBe(COMPLETIONS);
    // `provider/model` refs and thinking suffixes still resolve the family.
    expect(executor.buildUrl("factory/claude-opus-4-6(high)", true, 0, null)).toBe(ANTHROPIC);
  });

  it("buildUrl honors the chatCore runtime transport", () => {
    expect(executor.buildUrl("claude-opus-4-6", true, 0, {
      runtimeTransport: { baseUrl: ANTHROPIC },
    })).toBe(ANTHROPIC);
  });
});

describe("factory identity headers", () => {
  it("sends bearer auth + Factory client headers on the Claude wire", () => {
    const headers = executor.buildHeaders(credentials(), true, ANTHROPIC, "claude-opus-4-6");
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(headers["User-Agent"]).toBe("factory-cli/0.228.0");
    expect(headers["X-Client-Version"]).toBe("0.228.0");
    expect(headers["X-Factory-Client"]).toBe("cli");
    expect(headers["x-api-provider"]).toBe("anthropic");
    expect(headers["x-provider-routing-source"]).toBe("configured_order");
    expect(headers["x-session-id"]).toMatch(UUID_RE);
    expect(headers["x-assistant-message-id"]).toMatch(UUID_RE);
    expect(headers["x-api-key"]).toBe("placeholder");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["X-Stainless-Package-Version"]).toBe("0.70.1");
    expect(headers["X-Stainless-Timeout"]).toBe("600");
  });

  it("keeps the Responses wire free of the Stainless fingerprint", () => {
    const headers = executor.buildHeaders(credentials(), true, RESPONSES, "gpt-6-sol");
    expect(headers["x-api-provider"]).toBe("openai");
    expect(headers["OpenAI-Platform"]).toBe("org-bHuLtG1fGmYk5YaOihAAXFBw");
    expect(headers.Accept).toBe("application/json");
    expect(headers["X-Stainless-Lang"]).toBeUndefined();
  });

  it("sends the completions fingerprint and per-model upstream", () => {
    const headers = executor.buildHeaders(credentials(), true, COMPLETIONS, "kimi-k3");
    expect(headers["x-api-provider"]).toBe("fireworks");
    expect(headers["X-Stainless-Package-Version"]).toBe("6.25.0");
    expect(headers["OpenAI-Platform"]).toBeUndefined();
  });

  it("derives X-Factory-Org-Id from a WorkOS JWT only", () => {
    const jwt = `x.${Buffer.from(JSON.stringify({ external_org_id: "org_123" })).toString("base64url")}.y`;
    expect(factoryOrgIdFromToken(jwt)).toBe("org_123");
    expect(factoryOrgIdFromToken("fk-abc")).toBeNull();
    expect(factoryOrgIdFromToken(`x.${Buffer.from("{not json").toString("base64url")}.y`)).toBeNull();

    const headers = executor.buildHeaders(credentials({ apiKey: jwt }), true, ANTHROPIC, "claude-opus-4-6");
    expect(headers["X-Factory-Org-Id"]).toBe("org_123");
    const fkHeaders = executor.buildHeaders(credentials(), true, ANTHROPIC, "claude-opus-4-6");
    expect(fkHeaders["X-Factory-Org-Id"]).toBeUndefined();
  });

  it("derives a stable v4 session id", () => {
    expect(factorySessionUuid("session-a")).toBe(factorySessionUuid("session-a"));
    expect(factorySessionUuid("session-a")).not.toBe(factorySessionUuid("session-b"));
    expect(factorySessionUuid("session-a")).toMatch(UUID_RE);
  });
});

describe("factory request shaping", () => {
  it("pins temperature=1 on the completions wire and keeps explicit values", () => {
    const pinned = executor.transformRequest("kimi-k3", { model: "kimi-k3", messages: [] }, true, credentials());
    expect(pinned.temperature).toBe(1);
    const explicit = executor.transformRequest("kimi-k3", { model: "kimi-k3", messages: [], temperature: 0.2 }, true, credentials());
    expect(explicit.temperature).toBe(0.2);
  });

  it("does not add temperature on the responses wire", () => {
    const out = executor.transformRequest("gpt-6-sol", { model: "gpt-6-sol", input: [] }, false, credentials());
    expect(out.temperature).toBeUndefined();
  });
});

describe("factory inference-credential errors", () => {
  it("turns 401/403 into an actionable control-plane hint with the upstream message", async () => {
    const parsed = await parseUpstreamError(
      new Response(JSON.stringify({ error: { message: "Forbidden" } }), { status: 403 }),
      executor,
    );
    expect(parsed.statusCode).toBe(403);
    expect(parsed.message).toContain("Forbidden");
    expect(parsed.message).toMatch(/control-plane/);
    expect(parsed.message).toMatch(/session token/);
  });

  it("never echoes a raw non-JSON body on 401/403", async () => {
    const parsed = await parseUpstreamError(
      new Response("<html>gateway</html>", { status: 401 }),
      executor,
    );
    expect(parsed.message).not.toContain("gateway");
    expect(parsed.message).toMatch(/control-plane/);
  });

  it("leaves other statuses to the default parser", async () => {
    const parsed = await parseUpstreamError(
      new Response(JSON.stringify({ error: { message: "bad input" } }), { status: 400 }),
      executor,
    );
    expect(parsed.statusCode).toBe(400);
    expect(parsed.message).toContain("bad input");
  });
});

describe("factory executor execute()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts to the Claude wire with the identity headers", async () => {
    proxyAwareFetch.mockResolvedValueOnce(okResponse());
    const result = await executor.execute({
      model: "claude-opus-4-6",
      body: { model: "claude-opus-4-6", max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: credentials(),
      log: null,
    });

    expect(result.url).toBe(ANTHROPIC);
    const [url, opts] = proxyAwareFetch.mock.calls[0];
    expect(String(url)).toBe(ANTHROPIC);
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer sk-test");
    expect(opts.headers["x-api-provider"]).toBe("anthropic");
    expect(opts.headers["x-session-id"]).toMatch(UUID_RE);
  });

  it("pins temperature in the serialized completions body", async () => {
    proxyAwareFetch.mockResolvedValueOnce(okResponse());
    await executor.execute({
      model: "kimi-k3",
      body: { model: "kimi-k3", messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: credentials(),
      log: null,
    });

    const [, opts] = proxyAwareFetch.mock.calls[0];
    const sent = JSON.parse(opts.body);
    expect(sent.temperature).toBe(1);
    expect(opts.headers["x-api-provider"]).toBe("fireworks");
  });
});
