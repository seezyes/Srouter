import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as refresh from "open-sse/services/tokenRefresh.js";
import { registerCredentialMirror, resetCredentialMirror } from "open-sse/services/refreshPolicy.js";

const bareEntries = [
  "refreshAccessToken", "refreshKimiToken", "refreshClineToken",
  "refreshClaudeOAuthToken", "refreshGoogleToken", "refreshCodexToken",
  "refreshKiroToken", "refreshIflowToken", "refreshGitHubToken",
  "refreshCodebuddyToken", "refreshCodebuddyIntlToken", "refreshTraeToken",
  "refreshZedToken", "refreshWindsurfToken", "refreshVertexToken",
];

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("SROUTER_DEV_MIRROR_REFRESH", "1");
  vi.stubEnv("SROUTER_DEV_AUTHORITATIVE_DB", "");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Provider contact forbidden"); }));
});

afterEach(() => {
  resetCredentialMirror();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("dev public refresh facade", () => {
  for (const name of bareEntries) {
    it(`${name} refuses unidentified direct rotation`, async () => {
      const result = await refresh[name]("synthetic-token", {}, {});
      expect(result).toMatchObject({
        error: "dev_refresh_disabled", code: "dev_mirror_unidentified",
      });
      expect(fetch).not.toHaveBeenCalled();
    });
  }

  it("passes connection identity and freshness to the bulk credential mirror", async () => {
    const mirror = vi.fn(async (_provider, credentials) => {
      expect(credentials.connectionId).toBe("synthetic-connection");
      expect(credentials.expiresAt).toBe("2030-01-01T00:00:00.000Z");
      return { accessToken: "synthetic-mirrored-access" };
    });
    registerCredentialMirror(mirror);
    const result = await refresh.getAllAccessTokens({ connections: [{
      id: "synthetic-connection", provider: "codex", isActive: true,
      refreshToken: "synthetic-refresh", expiresAt: "2030-01-01T00:00:00.000Z",
    }] });
    expect(result.codex.accessToken).toBe("synthetic-mirrored-access");
    expect(mirror).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not publish mirror errors as usable bulk credentials", async () => {
    registerCredentialMirror(async () => ({ error: "dev_refresh_disabled" }));
    const result = await refresh.getAllAccessTokens({ connections: [{
      id: "synthetic-connection", provider: "codex", isActive: true,
      refreshToken: "synthetic-refresh",
    }] });
    expect(result).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
  });
});
