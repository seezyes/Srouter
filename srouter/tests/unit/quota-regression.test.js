/**
 * T-0037 quota regression guards.
 *
 * Context: with the dev instance failing to compile its route graph, the quota
 * tracker rendered "No Providers Connected" while the user still had working
 * OAuth accounts. The page could not distinguish a failed API load from a
 * successful response with zero eligible connections.
 *
 * Guards in this file (all offline; fresh owned DATA_DIR; network blocked):
 * 1. the pure view-state helper keeps "load error" distinct from "empty";
 * 2. the quota component really wires that helper to the API error state;
 * 3. /api/providers/client still lists OAuth accounts whose stored credentials
 *    are expired/errored (per-account error, not a dropped list).
 *
 * The companion /api/usage/[connectionId] per-account error path lives in
 * quota-usage-error-regression.test.js because both API suites need their own
 * isolated DB singleton per process.
 *
 * No real credentials, working databases, provider calls or restarts.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getConnectionsViewState } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const OLDER = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
const EXPIRED = new Date(Date.now() - 60 * 60 * 1000).toISOString();

const quotaComponentSource = fs.readFileSync(
  new URL(
    "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js",
    import.meta.url,
  ),
  "utf-8",
);

describe("quota tracker view state never masks a load failure", () => {
  it("reports a load error even when the totals are zero", () => {
    expect(
      getConnectionsViewState({
        loading: false,
        loadError: "Failed to fetch connections (HTTP 500)",
        eligibleConnections: 0,
        visibleConnections: 0,
      }),
    ).toBe("error");
  });

  it("reports the empty state only for a successful zero-eligible response", () => {
    expect(
      getConnectionsViewState({
        loading: false,
        loadError: null,
        eligibleConnections: 0,
        visibleConnections: 0,
      }),
    ).toBe("empty");
  });

  it("prioritizes loading over a stale error", () => {
    expect(
      getConnectionsViewState({
        loading: true,
        loadError: "previous failure",
        eligibleConnections: 0,
      }),
    ).toBe("loading");
  });

  it("distinguishes filtered-out pages from an empty account list", () => {
    expect(
      getConnectionsViewState({ eligibleConnections: 3, visibleConnections: 0 }),
    ).toBe("filtered");
    expect(
      getConnectionsViewState({ eligibleConnections: 3, visibleConnections: 2 }),
    ).toBe("list");
  });

  it("wires the helper and an explicit retry into the quota component", () => {
    expect(quotaComponentSource).toContain("getConnectionsViewState");
    expect(quotaComponentSource).toContain("connectionsError");
    expect(quotaComponentSource).toContain("Couldn&apos;t load providers");
    expect(quotaComponentSource).toContain("Retry");
    // The legitimate empty state must remain for a successful empty response.
    expect(quotaComponentSource).toContain("No Providers Connected");
  });
});

describe("/api/providers/client keeps errored OAuth accounts listed", () => {
  let root = "";
  let db = null;
  let driver = null;
  let fetchSpy = null;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-quota-client-"));
    fetchSpy = vi.fn(async () => {
      throw new Error("network blocked in quota regression test");
    });
    global.fetch = fetchSpy;
    vi.stubEnv("DATA_DIR", root);
    delete process.env.SROUTER_DEV_MIRROR_REFRESH;
    delete process.env.SROUTER_DEV_AUTHORITATIVE_DB;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    driver = await import("@/lib/db/driver.js");
    await db.initDb();

    await db.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      name: "dev-codex",
      accessToken: "dev-access",
      refreshToken: "dev-refresh",
      expiresAt: EXPIRED,
      lastRefreshAt: OLDER,
      testStatus: "error",
      lastError: "Token expired; re-authorize the connection",
      errorCode: "expired",
      providerSpecificData: { chatgptAccountId: "acct-dev" },
      isActive: true,
    });
    await db.createProviderConnection({
      provider: "not-a-usage-provider",
      authType: "oauth",
      name: "other",
      accessToken: "other-access",
      isActive: true,
    });

    global.fetch = fetchSpy;
  });

  afterAll(() => {
    try {
      driver?.getAdapterSync()?.close();
    } catch {
      /* ignore */
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (root) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  async function listConnections(query = "") {
    const route = await import("@/app/api/providers/client/route.js");
    const response = await route.GET(
      new Request(`http://localhost/api/providers/client?${query}`),
    );
    return { response, body: await response.json() };
  }

  it("counts the errored codex OAuth account as eligible and returns its error fields", async () => {
    const { response, body } = await listConnections(
      "page=1&pageSize=20&accountStatus=all&sort=priority",
    );
    expect(response.status).toBe(200);
    expect(body.totals.eligibleConnections).toBe(1);
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]).toMatchObject({
      provider: "codex",
      authType: "oauth",
      testStatus: "error",
      lastError: "Token expired; re-authorize the connection",
      errorCode: "expired",
      expiresAt: EXPIRED,
    });
    expect(body.providerOptions).toEqual(["codex"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the account under the active filter instead of dropping the list", async () => {
    const { body } = await listConnections(
      "page=1&pageSize=20&accountStatus=active&sort=priority",
    );
    expect(body.totals.eligibleConnections).toBe(1);
    expect(body.connections).toHaveLength(1);
  });

  it("does not count providers without usage capability", async () => {
    const { body } = await listConnections("page=1&pageSize=20&provider=all");
    expect(body.connections.every((c) => c.provider !== "not-a-usage-provider")).toBe(true);
  });
});

