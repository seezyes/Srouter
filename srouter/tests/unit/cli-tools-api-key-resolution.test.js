/**
 * Tests for #4399 — CLI Tools Apply writes placeholder "sk_9router" key.
 *
 * When requireApiKey=true, the written "sk_9router" caused 401 on every
 * CLI tool request. The fix: replace the literal fallback with
 * resolveCliApiKey(), which reads the first active key from the DB
 * (or returns "" if none exist — never the placeholder).
 */

import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";

vi.mock("@/lib/db", () => ({ getApiKeys: vi.fn() }));
import { getApiKeys } from "@/lib/db";
import { resolveCliApiKey } from "../../src/app/api/cli-tools/resolveApiKey.js";
async function resolveCliApiKeyLogic(callerKey, activeKeys = []) {
  getApiKeys.mockResolvedValue(activeKeys);
  return resolveCliApiKey(callerKey);
}

describe("resolveCliApiKey logic (#4399)", () => {
  it("returns the caller key when non-empty and not the placeholder", async () => {
    expect(await resolveCliApiKeyLogic("sk-real-key-123", [])).toBe("sk-real-key-123");
  });

  it("falls back to first active DB key when caller key is empty", async () => {
    const keys = [{ key: "sk-db-key", isActive: true }];
    expect(await resolveCliApiKeyLogic("", keys)).toBe("sk-db-key");
  });

  it("falls back to first active DB key when caller key is null", async () => {
    const keys = [{ key: "sk-db-key", isActive: true }];
    expect(await resolveCliApiKeyLogic(null, keys)).toBe("sk-db-key");
  });

  it("falls back to first active DB key when caller key is undefined", async () => {
    const keys = [{ key: "sk-db-key", isActive: true }];
    expect(await resolveCliApiKeyLogic(undefined, keys)).toBe("sk-db-key");
  });

  it("falls back to first active DB key when caller is the placeholder itself", async () => {
    const keys = [{ key: "sk-db-key", isActive: true }];
    expect(await resolveCliApiKeyLogic("sk_9router", keys)).toBe("sk-db-key");
  });

  it("skips inactive keys and picks the first active one", async () => {
    const keys = [
      { key: "sk-inactive", isActive: false },
      { key: "sk-active", isActive: true },
    ];
    expect(await resolveCliApiKeyLogic("", keys)).toBe("sk-active");
  });

  it("returns empty string when no active DB key exists and caller is empty", async () => {
    const keys = [{ key: "sk-inactive", isActive: false }];
    expect(await resolveCliApiKeyLogic("", keys)).toBe("");
  });

  it("returns empty string when DB is empty and caller is empty", async () => {
    expect(await resolveCliApiKeyLogic("", [])).toBe("");
  });

  it("trims whitespace from caller key", async () => {
    expect(await resolveCliApiKeyLogic("  sk-real  ", [])).toBe("sk-real");
  });

  it("never returns either placeholder", async () => {
    expect(await resolveCliApiKeyLogic("sk_9router", [])).not.toBe("sk_9router");
    expect(await resolveCliApiKeyLogic("sk_srouter", [])).not.toBe("sk_srouter");
    expect(await resolveCliApiKeyLogic("", [])).not.toBe("sk_9router");
  });
});

describe("resolveApiKey.js source checks (#4399)", () => {
  const src = fs.readFileSync(
    new URL("../../src/app/api/cli-tools/resolveApiKey.js", import.meta.url),
    "utf-8"
  );

  it("resolveApiKey.js exports resolveCliApiKey", () => {
    expect(src).toContain("resolveCliApiKey");
  });

  it("resolveApiKey.js imports getApiKeys from DB", () => {
    expect(src).toContain("getApiKeys");
  });

  it("resolveApiKey.js does not return sk_9router as a fallback value", () => {
    // The helper may reference "sk_9router" to guard against it, but must
    // never use it as a return / fallback value (e.g. `return "sk_9router"`).
    expect(src).not.toMatch(/return\s+"sk_9router"/);
    expect(src).not.toMatch(/\|\|\s*"sk_9router"/);
  });
});