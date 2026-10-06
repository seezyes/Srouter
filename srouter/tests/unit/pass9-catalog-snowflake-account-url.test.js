// Pass9 — Snowflake `{account}` base-URL substitution in the actual default
// executor. The registry declares `https://{account}.snowflakecomputing.com/api/v2`
// while the executor only substituted `{accountId}` (cloudflare-ai), so Snowflake
// requests went upstream with a literal `{account}` host.
import { describe, expect, it } from "vitest";
import { getExecutor } from "open-sse/executors/index.js";

describe("pass9 snowflake {account} substitution", () => {
  it("substitutes the Snowflake account into the base URL", () => {
    const executor = getExecutor("snowflake");
    expect(executor.buildUrl("llama3.1-70b", false, 0, { providerSpecificData: { account: "acme-xy" } }))
      .toBe("https://acme-xy.snowflakecomputing.com/api/v2");
    // `accountId` is accepted too — both placeholders read the same credential.
    expect(executor.buildUrl("claude-3-5-sonnet", true, 0, { providerSpecificData: { accountId: "acme-id" } }))
      .toBe("https://acme-id.snowflakecomputing.com/api/v2");
  });

  it("fails closed when the account is missing", () => {
    const executor = getExecutor("snowflake");
    expect(() => executor.buildUrl("llama3.1-70b", false, 0, { providerSpecificData: {} }))
      .toThrow(/requires accountId/);
  });

  it("still substitutes {accountId} for other providers (unchanged)", () => {
    const executor = getExecutor("cloudflare-ai");
    expect(executor.buildUrl("@cf/meta/llama-3.1-8b-instruct", false, 0,
      { providerSpecificData: { accountId: "cf123" } }))
      .toBe("https://api.cloudflare.com/client/v4/accounts/cf123/ai/v1/chat/completions");
  });
});
