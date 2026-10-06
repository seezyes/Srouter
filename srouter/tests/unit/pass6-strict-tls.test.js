import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });
async function setup(fetch) {
  vi.resetModules();
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy"]) vi.stubEnv(name, "");
  vi.stubGlobal("fetch", fetch);
  return (await import("../../open-sse/utils/proxyFetch.js")).proxyAwareFetch;
}
describe("Pass6 strict egress/TLS adaptation", () => {
  it("refuses unresolved strict proxy before MITM DNS/socket bypass", async () => {
    const fetch = vi.fn();
    const proxyAwareFetch = await setup(fetch);
    await expect(proxyAwareFetch("https://api2.cursor.sh/chat", {}, { proxyPoolId: "fixture", strictProxy: true })).rejects.toThrow(/none resolved/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "SELF_SIGNED_CERT_IN_CHAIN"])("does not retry direct credential POST insecurely for %s", async (code) => {
    const error = Object.assign(new Error("TLS failed"), { cause: { code } });
    const fetch = vi.fn().mockRejectedValue(error);
    const proxyAwareFetch = await setup(fetch);
    await expect(proxyAwareFetch("https://provider.invalid/chat", { method: "POST", body: "fixture", headers: { Authorization: "Bearer fixture" } })).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].dispatcher).toBeUndefined();
  });
});
