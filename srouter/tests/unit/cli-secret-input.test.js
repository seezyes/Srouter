import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";

const require = createRequire(import.meta.url);
const { promptSecret } = require("../../cli/src/cli/utils/input.js");

describe("CLI secret input", () => {
  it("masks typed input, supports Unicode backspace and releases its listener", async () => {
    const input = new PassThrough();
    input.isTTY = true;
    input.setRawMode = vi.fn();
    const output = new PassThrough();
    let visible = "";
    output.on("data", (chunk) => { visible += chunk.toString(); });
    const pending = promptSecret("Password: ", { input, output });
    input.emit("keypress", "fixture", { name: "f" });
    input.emit("keypress", "😀", {});
    input.emit("keypress", undefined, { name: "backspace" });
    input.emit("keypress", undefined, { name: "return" });
    expect(await pending).toBe("fixture");
    expect(visible).not.toContain("fixture");
    expect(visible).not.toContain("😀");
    expect(visible).toContain("*******");
    expect(input.listenerCount("keypress")).toBe(0);
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
    input.destroy();
    output.destroy();
  });
});
