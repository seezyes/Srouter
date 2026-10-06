import { describe, expect, it } from "vitest";
import { testOAuthConnection } from "../../src/app/api/providers/[id]/test/testUtils.js";
const token = (payload) => `test.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;

describe("Cursor token validation", () => {
  it.each([Math.floor(Date.now() / 1000) - 60, Date.now() - 60000])("rejects expired seconds or milliseconds exp: %s", async (exp) => {
    expect(await testOAuthConnection({ provider: "cursor", accessToken: token({ exp }) }))
      .toMatchObject({ valid: false, error: expect.stringContaining("expired") });
  });

  it.each([token({}), token({ exp: null }), "legacy-test-token", token({ exp: Math.floor(Date.now() / 1000) + 3600 })])
  ("does not claim an opaque or unexpired token is expired", async (accessToken) => {
    expect(await testOAuthConnection({ provider: "cursor", accessToken })).toMatchObject({ valid: true });
  });
});
