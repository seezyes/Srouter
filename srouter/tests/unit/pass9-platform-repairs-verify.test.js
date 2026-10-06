import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// P9-F6: structural regression guards for the platform repairs that are easiest
// to silently undo. This verifies the owned source keeps its required shape:
//   - ssrfGuard pins DNS through undici and enforces the HTTP(S)/userinfo boundary
//   - migrate records a retryable pending-import marker on abort
//   - bunSqliteAdapter keeps named process-hook references it can remove
// It complements the behavioural tests (pin/retry/lifecycle) without any network,
// DB, or process side effects beyond reading owned files.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

describe("P9-F6 platform repair structural guards", () => {
  it("ssrfGuard pins the transport address and bounds the target policy", () => {
    const src = read("src/shared/utils/ssrfGuard.js");
    expect(src).toMatch(/connect:\s*\{/);
    expect(src).toMatch(/lookup\(_hostname/);
    expect(src).toMatch(/PUBLIC_PROTOCOLS/);
    expect(src).toMatch(/embedded credentials/);
    expect(src).toMatch(/224\.0\.0\.0/); // multicast range
    expect(src).toMatch(/240\.0\.0\.0/); // reserved range
    // Cross-bundle marker letting proxyFetch recognise a pre-bound dispatcher.
    expect(src).toMatch(/PINNED_DISPATCHER = Symbol\.for\("srouter\.ssrf\.pinned-target"\)/);
  });

  it("proxyFetch pins guarded requests through the proxy and fails closed on opaque relays", () => {
    const src = read("open-sse/utils/proxyFetch.js");
    expect(src).toMatch(/Symbol\.for\("srouter\.ssrf\.pinned-target"\)/);
    expect(src).toMatch(/options\.dispatcher\?\.\[PINNED_DISPATCHER\]/);
    // Opaque relay has no bound-target contract -> fail closed.
    expect(src).toMatch(/opaque relay has no bound-target contract/);
    // Custom tunnel connector that keeps the origin identity as the hostname.
    expect(src).toMatch(/export function createPinnedProxyConnect/);
    expect(src).toMatch(/CONNECT \$\{authority\} HTTP\/1\.1/);
    // Hardening (pass 9d): callers cannot smuggle a port/bracketed literal into SNI.
    expect(src).toMatch(/function toTlsServername\(value\)/);
    expect(src).toMatch(/const originServername = toTlsServername\(opts\.servername\)/);
    expect(src).not.toMatch(/servername: opts\.servername \|\| opts\.host/);
    // Bounded CONNECT header block + finite tunnel deadline + socket teardown.
    expect(src).toMatch(/export const MAX_CONNECT_HEADER_BYTES = 16 \* 1024/);
    expect(src).toMatch(/FETCH_CONNECT_TIMEOUT_MS/);
    expect(src).toMatch(/socket\.once\("close", onSocketClose\)/);
    expect(src).toMatch(/socket\.unshift\(Buffer\.from\(rest, "latin1"\)\)/);
    // Non-HTTP(S) proxies fail closed before any bytes are written.
    expect(src).toMatch(/SUPPORTED_PROXY_PROTOCOLS = new Set\(\["http:", "https:"\]\)/);
    expect(src).toMatch(/unsupported proxy protocol for pinned tunnel/);
    // Guarded proxy path keeps the ORIGINAL url (Host/SNI stay the hostname).
    expect(src).toMatch(/return originalFetch\(url, \{ \.\.\.options, dispatcher \}\)/);
  });

  it("migrate keeps a durable retry intent for aborted/interrupted legacy imports", () => {
    const src = read("src/lib/db/migrate.js");
    expect(src).toMatch(/LEGACY_IMPORT_PENDING_META = "legacyImportPending"/);
    expect(src).toMatch(/fresh \|\| priorPending/);
    // Armed before stamps, cleared only after success.
    expect(src).toMatch(/if \(willImportLegacy\) setMetaSync\(adapter, LEGACY_IMPORT_PENDING_META, "1"\)/);
    expect(src).toMatch(/setMetaSync\(adapter, LEGACY_IMPORT_PENDING_META, "0"\)/);
    // No leftover sidecar file state.
    expect(src).not.toMatch(/\.legacy-import-pending/);
  });

  it("bunSqliteAdapter removes its named process hooks on close", () => {
    const src = read("src/lib/db/adapters/bunSqliteAdapter.js");
    expect(src).toMatch(/process\.removeListener\("beforeExit", onShutdown\)/);
    expect(src).toMatch(/process\.removeListener\("SIGINT", onSigint\)/);
    expect(src).toMatch(/process\.removeListener\("SIGTERM", onSigterm\)/);
    expect(src).toMatch(/let closed = false/);
  });
});
