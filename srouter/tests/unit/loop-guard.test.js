import { describe, it, expect } from "vitest";
import { detectLoop } from "../../open-sse/utils/loopGuard.js";

function tc(name, args) {
  return { type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function assistantWith(...toolCalls) {
  return { role: "assistant", content: "", tool_calls: toolCalls };
}

describe("detectLoop", () => {
  it("empty messages → not detected", () => {
    expect(detectLoop({ messages: [] })).toEqual({ detected: false, hint: null });
  });

  it("3 identical tool_calls → detected", () => {
    const body = { messages: [
      assistantWith(tc("bash", { cmd: "ls" })),
      assistantWith(tc("bash", { cmd: "ls" })),
      assistantWith(tc("bash", { cmd: "ls" })),
    ] };
    expect(detectLoop(body).detected).toBe(true);
  });

  it("2 identical tool_calls → NOT detected (below threshold)", () => {
    const body = { messages: [
      assistantWith(tc("bash", { cmd: "ls" })),
      assistantWith(tc("bash", { cmd: "ls" })),
    ] };
    expect(detectLoop(body).detected).toBe(false);
  });

  it("3 calls with different args → NOT detected", () => {
    const body = { messages: [
      assistantWith(tc("bash", { cmd: "ls" })),
      assistantWith(tc("bash", { cmd: "pwd" })),
      assistantWith(tc("bash", { cmd: "whoami" })),
    ] };
    expect(detectLoop(body).detected).toBe(false);
  });

  it("3 calls with different names → NOT detected", () => {
    const body = { messages: [
      assistantWith(tc("bash", { cmd: "ls" })),
      assistantWith(tc("grep", { cmd: "ls" })),
      assistantWith(tc("find", { cmd: "ls" })),
    ] };
    expect(detectLoop(body).detected).toBe(false);
  });

  it("sequence [fetchA, fetchB] appearing 2 times → detected", () => {
    const body = { messages: [
      assistantWith(tc("fetchA", { url: "x" })),
      assistantWith(tc("fetchB", { url: "y" })),
      assistantWith(tc("fetchA", { url: "x" })),
      assistantWith(tc("fetchB", { url: "y" })),
    ] };
    expect(detectLoop(body).detected).toBe(true);
  });

  it("sequence appearing once → NOT detected", () => {
    const body = { messages: [
      assistantWith(tc("fetchA", { url: "x" })),
      assistantWith(tc("fetchB", { url: "y" })),
    ] };
    expect(detectLoop(body).detected).toBe(false);
  });

  it("args normalization: {b:1,a:2} same as {a:2,b:1}", () => {
    const body = { messages: [
      assistantWith({ type: "function", function: { name: "bash", arguments: '{"b":1,"a":2}' } }),
      assistantWith({ type: "function", function: { name: "bash", arguments: '{"a":2,"b":1}' } }),
      assistantWith({ type: "function", function: { name: "bash", arguments: '{"b":1,"a":2}' } }),
    ] };
    expect(detectLoop(body).detected).toBe(true);
  });

  it("keeps nested arguments distinct and sorts their keys recursively", () => {
    const different = [1, 2, 3].map((n) => assistantWith(tc("bash", { options: { id: n } })));
    expect(detectLoop({ messages: different }).detected).toBe(false);
    const same = [
      assistantWith(tc("bash", { options: { a: 1, b: 2 }, command: "ls" })),
      assistantWith(tc("bash", { command: "ls", options: { b: 2, a: 1 } })),
      assistantWith(tc("bash", { options: { a: 1, b: 2 }, command: "ls" })),
    ];
    expect(detectLoop({ messages: same }).detected).toBe(true);
  });

  it("stays bounded on a long history and ignores stale repeats", () => {
    const messages = Array.from({ length: 1200 }, (_, n) =>
      assistantWith(tc("step", { n })));
    messages.unshift(...Array.from({ length: 3 }, () => assistantWith(tc("stale", { n: 1 }))));
    const started = performance.now();
    expect(detectLoop({ messages }).detected).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("does not count a repeated sentence multiple times in one message", () => {
    const messages = [
      { role: "assistant", content: "Read the file. Read the file. Read the file." },
      { role: "assistant", content: "Something else entirely." },
      { role: "assistant", content: "Another different sentence." },
    ];
    expect(detectLoop({ messages }).detected).toBe(false);
  });

  it("no tool_calls in messages → NOT detected", () => {
    const body = { messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ] };
    expect(detectLoop(body).detected).toBe(false);
  });
});
