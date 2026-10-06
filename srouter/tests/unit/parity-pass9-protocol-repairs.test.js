// Pass9 protocol-repair regressions. New, independent positive assertions that
// execute the unchanged local production dispatcher/serializers (no translator or
// executor class mocks except the injected crypto boundary). These are SEPARATE
// from the immutable Pass8 defect-existence suites and never rewrite their
// expected results.
import crypto from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { localGraph, disposeGraphs, writeEvidence } from "../helpers/parity-pass9-protocol-harness.js";

afterAll(() => disposeGraphs());

const credential = () => ({
  apiKey: "fixture-key",
  accessToken: "fixture-token",
  providerSpecificData: { projectId: "fixture-project", accountId: "fixture-account" },
  rawHeaders: { "x-session-id": "12345678-1234-4234-8234-123456789012" },
});

// Loading the translator engine pulls the DB layer; the Pass8 VM loader forbids
// the bare node:path import it reaches. A synthetic kvStore short-circuits it,
// exactly as the historical protocol helper does.
const kv = () => ({ get: async () => null, getAll: async () => ({}), set: async () => {}, remove: async () => {} });
const withKv = { "src/lib/db/helpers/kvStore.js": { makeKv: kv } };

function openaiBody() {
  return {
    model: "fixture",
    stream: false,
    max_tokens: 256,
    temperature: 0.3,
    messages: [
      { role: "system", content: "Pass9 system" },
      { role: "user", content: "Pass9 user payload" },
      { role: "assistant", content: "inspect first", tool_calls: [{ id: "call-fixture", type: "function", function: { name: "inspect", arguments: '{"path":"/fixture"}' } }] },
      { role: "tool", tool_call_id: "call-fixture", content: "tool answer" },
      { role: "user", content: "continue" },
    ],
    tools: [{ type: "function", function: { name: "inspect", description: "fixture", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
  };
}

function parseSSE(raw) {
  return raw.split(/\n\n/).filter(Boolean).map((block) => {
    const type = block.split("\n").find((l) => l.startsWith("event: "))?.slice(7);
    const data = block.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
    return { type, data: data === "[DONE]" ? "[DONE]" : JSON.parse(data) };
  });
}

it("Responses keeps a system instruction plus a later developer directive without loss or inversion", async () => {
  const g = localGraph(withKv);
  const { translateRequest } = await g.load("open-sse/translator/index.js");
  const body = openaiBody();
  body.messages.splice(1, 0, { role: "developer", content: "developer directive" });
  body.messages.find((m) => m.role === "assistant").tool_calls[0].function.arguments = "{broken";

  const out = translateRequest("openai", "openai-responses", "gpt-5.4", body, true, credential(), "codex");
  const instructionText = [
    out.instructions || "",
    ...out.input.filter((i) => i.role === "system" || i.role === "developer").map((i) => i.content.map((c) => c.text).join("\n")),
  ].join("\n");

  expect(instructionText).toContain("Pass9 system");
  expect(instructionText).toContain("developer directive");
  expect(instructionText.indexOf("Pass9 system")).toBeLessThan(instructionText.indexOf("developer directive"));
  expect(out.input.find((i) => i.type === "function_call")).toMatchObject({ call_id: "call-fixture", name: "inspect", arguments: "{}" });
  expect(out.input.find((i) => i.type === "function_call_output")).toMatchObject({ call_id: "call-fixture", output: "tool answer" });
  expect(out.input.filter((i) => i.role === "user").map((i) => i.content[0].text)).toEqual(["Pass9 user payload", "continue"]);
  writeEvidence("pass9-responses-request-out", { instructions: out.instructions, input: out.input });
});

it("Responses keeps reasoning and message items distinct and preserves them in the terminal output", async () => {
  const kv = () => ({ get: async () => null, getAll: async () => ({}), set: async () => {}, remove: async () => {} });
  const g = localGraph({
    "src/lib/db/helpers/kvStore.js": { makeKv: kv },
    "src/lib/usageDb.js": { trackPendingRequest() {}, appendRequestLog: async () => {}, saveRequestDetail: async () => {} },
  });
  const { createSSEStream } = await g.load("open-sse/utils/stream.js");
  const chunk = (delta, index = 0, finish_reason = null, usage = undefined) => ({
    id: "chatcmpl-1", model: "gpt-4o", object: "chat.completion.chunk",
    choices: [{ index, delta, finish_reason }], ...(usage ? { usage } : {}),
  });
  const frames = [
    chunk({ reasoning_content: "thinking" }, 0),
    chunk({ content: "answer" }, 0),
    chunk({}, 0, "stop", { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }),
  ];
  const encoded = new TextEncoder().encode(frames.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n");
  const source = new ReadableStream({ start(c) { for (let i = 0; i < encoded.length; i += 13) c.enqueue(encoded.slice(i, i + 13)); c.close(); } });
  const output = source.pipeThrough(createSSEStream({ targetFormat: "openai", sourceFormat: "openai-responses", model: "gpt-4o", provider: "openai", onStreamComplete() {} }));
  const events = parseSSE(await new Response(output).text());

  const terminals = events.filter((e) => e.type === "response.completed");
  expect(terminals).toHaveLength(1);
  const response = terminals[0].data.response;
  const done = events.filter((e) => e.type === "response.output_item.done").map((e) => e.data.item);
  expect(response.output.map((i) => i.type)).toEqual(["reasoning", "message"]);
  expect(response.output).toEqual(done);
  expect(response.output.find((i) => i.type === "message").content[0]).toMatchObject({ type: "output_text", text: "answer" });
  expect(response.usage).toMatchObject({ input_tokens: 3, output_tokens: 1, total_tokens: 4 });
  expect(events.some((e) => e.data === "[DONE]")).toBe(false);

  // Reasoning and message must occupy distinct output indices.
  const addedIdx = events.filter((e) => e.type === "response.output_item.added").map((e) => e.data.output_index);
  expect(new Set(addedIdx).size).toBe(addedIdx.length);
  writeEvidence("pass9-responses-stream-out", { events });
});

function antigravityBody() {
  return {
    model: "gemini-2.5-pro",
    request: {
      contents: [
        { role: "user", parts: [{ text: "Use echo for /fixture" }] },
        { role: "model", parts: [{ functionCall: { name: "echo", args: { path: "/fixture" } } }] },
        { role: "user", parts: [{ functionResponse: { name: "echo", response: { output: "fixture result" } } }, { text: "User-owned extra directive" }] },
      ],
      tools: [{ functionDeclarations: [{ name: "echo", description: "fixture", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] }],
    },
  };
}

it("Antigravity keeps user text co-located with a functionResponse as user and associates the tool result", async () => {
  const g = localGraph(withKv);
  const ns = await g.load("open-sse/translator/request/antigravity-to-openai.js");
  const out = ns.antigravityToOpenAIRequest("gemini-2.5-pro", antigravityBody(), false, {});
  const call = out.messages.find((m) => m.tool_calls)?.tool_calls[0];
  const tool = out.messages.find((m) => m.role === "tool");
  const follow = out.messages.find((m) => m.content === "User-owned extra directive");

  expect(call?.id?.length).toBeGreaterThan(0);
  expect(tool.tool_call_id).toBe(call.id);
  expect(tool.content).toContain("fixture result");
  expect(follow?.role).toBe("user");
  writeEvidence("pass9-antigravity-role-out", { messages: out.messages });
});

it("Gemini implicit default requests thoughts while explicit off/intent and output caps stay intact", async () => {
  const g = localGraph(withKv);
  const { translateRequest } = await g.load("open-sse/translator/index.js");
  const base = () => ({ messages: [{ role: "user", content: "fixture user" }], max_tokens: 1024 });
  const req = (body, model = "gemini-2.5-pro") => translateRequest("openai", "gemini", model, body, true, credential(), "gemini");

  const implicit = req(base());
  expect(implicit.generationConfig.thinkingConfig).toEqual({ thinkingBudget: -1, includeThoughts: true });

  const off = req({ ...base(), reasoning_effort: "none" });
  expect(off.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0, includeThoughts: false });

  const high = req({ ...base(), reasoning_effort: "high" });
  expect(high.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 24576, includeThoughts: true });
  // Explicit high keeps the local output-room floor (own cap preserved).
  expect(high.generationConfig.maxOutputTokens).toBe(32768);

  const suffix = req(base(), "gemini-2.5-pro(low)");
  expect(suffix.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 1024, includeThoughts: true });

  for (const target of ["antigravity", "gemini-cli"]) {
    const out = translateRequest("openai", target, "gemini-2.5-pro", base(), true, credential(), target);
    expect(out.request.generationConfig.thinkingConfig).toEqual({ thinkingBudget: -1, includeThoughts: true });
  }
  writeEvidence("pass9-gemini-thinking-out", { implicit, off, high, suffix });
});

it("Zed decrypt accepts real RSA tokens and rejects empty/control/garbage crypto output", async () => {
  const g = localGraph();
  const auth = await g.load("open-sse/shared/zedAuth.js");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const original = "fixture-valid-zed-token";
  const oaep = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(original));
  expect(auth.decryptZedAccessToken(oaep.toString("base64url"), auth.encodeZedPrivateKeyVerifier(privateKey))).toBe(original);
  const pkcs = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(original));
  expect(auth.decryptZedAccessToken(pkcs.toString("base64url"), auth.encodeZedPrivateKeyVerifier(privateKey))).toBe(original);

  const negatives = [
    ["empty", Buffer.alloc(0)],
    ["control", Buffer.from([0, 1, 2])],
    ["clean-ascii-garbage", Buffer.from("clean ASCII non-token garbage")],
    ["invalid-utf8", Buffer.from([255, 254])],
  ];
  const seen = [];
  for (const [name, buf] of negatives) {
    const ng = localGraph({}, { crypto: { privateDecrypt() { return buf; } } });
    const nauth = await ng.load("open-sse/shared/zedAuth.js");
    expect(() => nauth.decryptZedAccessToken(Buffer.from("AQID").toString("base64url"), nauth.encodeZedPrivateKeyVerifier(privateKey)), name).toThrow(/decrypt/i);
    seen.push(name);
  }
  writeEvidence("pass9-zed-negative-out", { negatives: seen });
});
