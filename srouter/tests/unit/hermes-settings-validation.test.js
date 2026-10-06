import { describe, expect, it, vi, beforeEach } from "vitest";
import { parseYAML } from "confbox";
import { writeFile } from "fs/promises";

// The POST handler used to write every `selections[].role` straight into
// `new RegExp(...)` (auxRoleRe) and into a YAML key, so a role of "(" threw an
// uncaught SyntaxError (500) and a crafted role/model could inject sibling YAML
// keys. This fork validates every role against /^[A-Za-z0-9_]+$/ before the
// config file is touched (400), and serializes model/base_url through
// JSON.stringify, so quotes/newlines stay inside the quoted scalar instead of
// breaking out of it.
const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

// The route imports the default from "fs/promises"; transitive helpers use
// "node:fs/promises". Mock both specifiers with one shared implementation.
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  fsMock.mkdir.mockResolvedValue(undefined);
  fsMock.readFile.mockResolvedValue("");
  fsMock.writeFile.mockResolvedValue(undefined);
  const overrides = { mkdir: fsMock.mkdir, readFile: fsMock.readFile, writeFile: fsMock.writeFile };
  return { ...actual, ...overrides, default: { ...(actual.default || actual), ...overrides } };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  const overrides = { mkdir: fsMock.mkdir, readFile: fsMock.readFile, writeFile: fsMock.writeFile };
  return { ...actual, ...overrides, default: { ...(actual.default || actual), ...overrides } };
});

const { POST } = await import("../../src/app/api/cli-tools/hermes-settings/route.js");

const post = (body) =>
  POST(
    new Request("http://127.0.0.1/api/cli-tools/hermes-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const writtenYaml = () => {
  const call = writeFile.mock.calls.at(-1);
  expect(call, "config.yaml must be written").toBeTruthy();
  return parseYAML(call[1]);
};

describe("hermes-settings POST input validation", () => {
  const base = { baseUrl: "http://127.0.0.1:20128" };

  beforeEach(() => {
    // Re-pin the implementations per test: the same hoisted fns back both the
    // "fs/promises" and "node:fs/promises" mocks, and relying on factory
    // evaluation order left readFile undefined in some multi-file runs.
    fsMock.readFile.mockReset().mockResolvedValue("");
    fsMock.writeFile.mockReset().mockResolvedValue(undefined);
    fsMock.mkdir.mockReset().mockResolvedValue(undefined);
  });

  it("rejects a role that would break the RegExp instead of throwing", async () => {
    const res = await post({
      ...base,
      selections: [
        { role: "default", model: "gpt-5" },
        { role: "(", model: "gpt-5" },
      ],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid Hermes settings/);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("rejects a role that would inject a sibling YAML key", async () => {
    const res = await post({
      ...base,
      selections: [
        { role: "default", model: "gpt-5" },
        { role: "vision:\n    x", model: "gpt-5" },
      ],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid Hermes settings/);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("keeps a crafted model inside the quoted scalar instead of injecting YAML", async () => {
    const crafted = 'gpt-5"\n    injected: "1';
    const res = await post({ ...base, selections: [{ role: "default", model: crafted }] });
    expect(res.status).toBe(200);

    const config = writtenYaml();
    expect(config.injected).toBeUndefined();
    expect(config.model.injected).toBeUndefined();
    expect(config.model.default).toBe(crafted);
  });

  it("keeps a crafted baseUrl inside the quoted scalar instead of injecting YAML", async () => {
    const crafted = 'http://x"\n    injected: "1';
    const res = await post({
      baseUrl: crafted,
      selections: [{ role: "default", model: "gpt-5" }],
    });
    expect(res.status).toBe(200);

    const config = writtenYaml();
    expect(config.injected).toBeUndefined();
    expect(config.model.injected).toBeUndefined();
    expect(config.model.base_url).toBe(`${crafted}/v1`);
  });

  it("still rejects a payload with no default role", async () => {
    const res = await post({ ...base, selections: [{ role: "vision", model: "gpt-5" }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/baseUrl and model are required/);
  });
});
