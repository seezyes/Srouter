import { describe, expect, it } from "vitest";
import { v5 } from "uuid";
import { buildCursorHeaders, generateSessionId } from "../../open-sse/utils/cursorChecksum.js";
import { CURSOR_IDE_COMMIT, CURSOR_IDE_VERSION } from "../../open-sse/providers/shared.js";

describe("Cursor release identity", () => {
  it.each(["test-token", "unicode-данные", ""])("preserves UUIDv5 DNS output for %s", (value) => {
    expect(generateSessionId(value)).toBe(v5(value, v5.DNS));
  });

  it("uses the pinned matched version/commit pair", () => {
    const headers = buildCursorHeaders("test-token");
    expect(headers["x-cursor-client-version"]).toBe(CURSOR_IDE_VERSION);
    expect(headers["x-cursor-client-commit"]).toBe(CURSOR_IDE_COMMIT);
    expect(CURSOR_IDE_VERSION).toBe("3.13.25");
    expect(CURSOR_IDE_COMMIT).toMatch(/^[a-f0-9]{40}$/);
  });
});
