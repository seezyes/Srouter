import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

/**
 * Account pools live in settings (`accountPools`), membership lives on each
 * connection's `providerSpecificData.accountPoolId`. These tests exercise the
 * real SQLite/sql.js layer against a temp DATA_DIR plus the route handlers.
 */
async function setup() {
  // The DB adapter is cached on globalThis so it survives Next.js hot reloads —
  // which means it also survives vitest module resets. Each test gets its own
  // temp DATA_DIR, so the previous adapter must be closed and dropped.
  try { globalThis._dbAdapter?.instance?.close?.(); } catch { /* already closed */ }
  delete globalThis._dbAdapter;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-account-pools-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  vi.doMock("next/server", () => ({
    NextResponse: {
      json(body, init = {}) {
        return new Response(JSON.stringify(body), {
          status: init.status || 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  }));

  const settingsRepo = await import("@/lib/db/repos/settingsRepo.js");
  const connectionsRepo = await import("@/lib/db/repos/connectionsRepo.js");
  const poolsRoute = await import("@/app/api/account-pools/route.js");
  const poolRoute = await import("@/app/api/account-pools/[id]/route.js");
  const connectionRoute = await import("@/app/api/providers/[id]/route.js");
  const auth = await import("@/sse/services/auth.js");

  return {
    settingsRepo,
    connectionsRepo,
    poolsRoute,
    poolRoute,
    connectionRoute,
    filterConnectionsForAccountPools: auth.filterConnectionsForAccountPools,
    getProviderCredentials: auth.getProviderCredentials,
    cleanup() {
      try { globalThis._dbAdapter?.instance?.close?.(); } catch { /* already closed */ }
      delete globalThis._dbAdapter;
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function jsonRequest(url, method, body) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function params(id) {
  return { params: Promise.resolve({ id }) };
}

async function createOpenAIConnection(connectionsRepo, name, extra = {}) {
  return await connectionsRepo.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name,
    apiKey: `sk-${name}`,
    providerSpecificData: {},
    ...extra,
  });
}

async function createPool(ctx, provider, name, models) {
  const res = await ctx.poolsRoute.POST(jsonRequest("http://localhost/api/account-pools", "POST", {
    provider,
    name,
    models,
  }));
  const data = await res.json();
  expect(res.status).toBe(201);
  return data.accountPool;
}

describe("account pools API", () => {
  let ctx = null;

  afterEach(() => {
    vi.doUnmock("next/server");
    vi.resetModules();
    vi.clearAllMocks();
    if (ctx) ctx.cleanup();
    ctx = null;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("creates, renames, regroups and deletes a pool, persisted under settings.accountPools", async () => {
    ctx = await setup();

    const created = await createPool(ctx, "openai", "GPT-5 accounts", ["gpt-5.5", "gpt-5.4", "gpt-5.5"]);
    expect(created.id).toBeTruthy();
    expect(created.name).toBe("GPT-5 accounts");
    expect(created.models).toEqual(["gpt-5.5", "gpt-5.4"]); // deduped, order preserved

    // Persisted, not just returned
    const stored = await ctx.settingsRepo.getSettings();
    expect(stored.accountPools.openai).toEqual([
      { id: created.id, name: "GPT-5 accounts", models: ["gpt-5.5", "gpt-5.4"] },
    ]);

    // Provider-scoped listing
    const listRes = await ctx.poolsRoute.GET(new Request("http://localhost/api/account-pools?provider=openai"));
    expect((await listRes.json()).accountPools).toHaveLength(1);

    // Global listing is keyed by provider
    const allRes = await ctx.poolsRoute.GET(new Request("http://localhost/api/account-pools"));
    const { accountPoolsByProvider } = await allRes.json();
    expect(Object.keys(accountPoolsByProvider)).toEqual(["openai"]);

    // Rename + regroup
    const putRes = await ctx.poolRoute.PUT(
      jsonRequest(`http://localhost/api/account-pools/${created.id}?provider=openai`, "PUT", {
        name: "GPT-5.5 only",
        models: ["gpt-5.5"],
      }),
      params(created.id),
    );
    expect(putRes.status).toBe(200);
    expect((await putRes.json()).accountPool).toEqual({
      id: created.id,
      name: "GPT-5.5 only",
      models: ["gpt-5.5"],
    });

    // Deleting removes the provider key entirely once it holds no pools
    const deleteRes = await ctx.poolRoute.DELETE(
      new Request(`http://localhost/api/account-pools/${created.id}?provider=openai`, { method: "DELETE" }),
      params(created.id),
    );
    expect(deleteRes.status).toBe(200);
    expect((await deleteRes.json()).accountPool.id).toBe(created.id);

    const afterDelete = await ctx.settingsRepo.getSettings();
    expect(afterDelete.accountPools.openai).toBeUndefined();
  });

  it("rejects a pool without a name and a rename that looks up a missing pool", async () => {
    ctx = await setup();

    const noName = await ctx.poolsRoute.POST(jsonRequest("http://localhost/api/account-pools", "POST", {
      provider: "openai",
      models: ["gpt-5.5"],
    }));
    expect(noName.status).toBe(400);

    const missing = await ctx.poolRoute.PUT(
      jsonRequest("http://localhost/api/account-pools/does-not-exist?provider=openai", "PUT", { name: "x" }),
      params("does-not-exist"),
    );
    expect(missing.status).toBe(404);
  });

  it("moves one connection between pools and out of every pool", async () => {
    ctx = await setup();

    const poolA = await createPool(ctx, "openai", "Pool A", ["gpt-5.5"]);
    const poolB = await createPool(ctx, "openai", "Pool B", ["gpt-4o-mini"]);
    const connection = await createOpenAIConnection(ctx.connectionsRepo, "acc-a", {
      providerSpecificData: { note: "keep me" },
    });

    const intoA = await ctx.connectionRoute.PUT(
      jsonRequest(`http://localhost/api/providers/${connection.id}`, "PUT", { accountPoolId: poolA.id }),
      params(connection.id),
    );
    expect(intoA.status).toBe(200);
    expect((await ctx.connectionsRepo.getProviderConnectionById(connection.id)).providerSpecificData.accountPoolId)
      .toBe(poolA.id);

    const intoB = await ctx.connectionRoute.PUT(
      jsonRequest(`http://localhost/api/providers/${connection.id}`, "PUT", { accountPoolId: poolB.id }),
      params(connection.id),
    );
    expect(intoB.status).toBe(200);
    const moved = await ctx.connectionsRepo.getProviderConnectionById(connection.id);
    expect(moved.providerSpecificData.accountPoolId).toBe(poolB.id);

    const outOfPool = await ctx.connectionRoute.PUT(
      jsonRequest(`http://localhost/api/providers/${connection.id}`, "PUT", { accountPoolId: null }),
      params(connection.id),
    );
    expect(outOfPool.status).toBe(200);
    const unassigned = await ctx.connectionsRepo.getProviderConnectionById(connection.id);
    expect(unassigned.providerSpecificData).toEqual({ note: "keep me" });
  });

  it("rejects an assignment to a pool that does not exist for the provider", async () => {
    ctx = await setup();

    const connection = await createOpenAIConnection(ctx.connectionsRepo, "acc-a");
    const crossProvider = await createPool(ctx, "codex", "Codex pool", ["gpt-5.5"]);

    const res = await ctx.connectionRoute.PUT(
      jsonRequest(`http://localhost/api/providers/${connection.id}`, "PUT", { accountPoolId: crossProvider.id }),
      params(connection.id),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Account pool not found");
  });

  it("stores a per-account model pin and clears it again", async () => {
    ctx = await setup();

    const connection = await createOpenAIConnection(ctx.connectionsRepo, "acc-a", {
      providerSpecificData: { note: "keep me" },
    });

    await ctx.connectionRoute.PUT(
      jsonRequest(`http://localhost/api/providers/${connection.id}`, "PUT", {
        assignedModels: ["gpt-5.5", " gpt-4o-mini ", "gpt-5.5"],
      }),
      params(connection.id),
    );
    expect((await ctx.connectionsRepo.getProviderConnectionById(connection.id)).providerSpecificData)
      .toEqual({ note: "keep me", assignedModels: ["gpt-5.5", "gpt-4o-mini"] });

    await ctx.connectionRoute.PUT(
      jsonRequest(`http://localhost/api/providers/${connection.id}`, "PUT", { assignedModels: [] }),
      params(connection.id),
    );
    expect((await ctx.connectionsRepo.getProviderConnectionById(connection.id)).providerSpecificData)
      .toEqual({ note: "keep me" });
  });

  it("unassigns members when their pool is deleted", async () => {
    ctx = await setup();

    const pool = await createPool(ctx, "openai", "Pool A", ["gpt-5.5"]);
    const member = await createOpenAIConnection(ctx.connectionsRepo, "acc-member", {
      providerSpecificData: { note: "member" },
    });
    const outsider = await createOpenAIConnection(ctx.connectionsRepo, "acc-outsider", {
      providerSpecificData: { note: "outsider" },
    });

    await ctx.connectionRoute.PUT(
      jsonRequest(`http://localhost/api/providers/${member.id}`, "PUT", {
        accountPoolId: pool.id,
        assignedModels: ["gpt-5.5"],
      }),
      params(member.id),
    );

    const deleteRes = await ctx.poolRoute.DELETE(
      new Request(`http://localhost/api/account-pools/${pool.id}?provider=openai`, { method: "DELETE" }),
      params(pool.id),
    );
    expect((await deleteRes.json()).unassignedConnections).toBe(1);

    // Membership and the pool-scoped pin are dropped, everything else survives.
    const formerMember = await ctx.connectionsRepo.getProviderConnectionById(member.id);
    expect(formerMember.providerSpecificData).toEqual({ note: "member" });
    const survivingOutsider = await ctx.connectionsRepo.getProviderConnectionById(outsider.id);
    expect(survivingOutsider.providerSpecificData).toEqual({ note: "outsider" });
  });

  it("reports member counts when includeUsage=true", async () => {
    ctx = await setup();

    const pool = await createPool(ctx, "openai", "Pool A", ["gpt-5.5"]);
    const member = await createOpenAIConnection(ctx.connectionsRepo, "acc-member");
    await createOpenAIConnection(ctx.connectionsRepo, "acc-other");
    await ctx.connectionRoute.PUT(
      jsonRequest(`http://localhost/api/providers/${member.id}`, "PUT", { accountPoolId: pool.id }),
      params(member.id),
    );

    const res = await ctx.poolsRoute.GET(new Request("http://localhost/api/account-pools?provider=openai&includeUsage=true"));
    const { accountPools } = await res.json();
    expect(accountPools).toEqual([{ id: pool.id, name: "Pool A", models: ["gpt-5.5"], memberCount: 1 }]);
  });
});

describe("account-pool candidate filtering", () => {
  const pools = {
    openai: [
      { id: "pool-fast", name: "Fast", models: ["gpt-5.5", "gpt-5.4"] },
      { id: "pool-mini", name: "Mini", models: ["gpt-4o-mini"] },
    ],
  };

  const connections = [
    { id: "in-fast", providerSpecificData: { accountPoolId: "pool-fast" } },
    { id: "in-mini", providerSpecificData: { accountPoolId: "pool-mini" } },
    { id: "unassigned", providerSpecificData: {} },
    { id: "dangling", providerSpecificData: { accountPoolId: "pool-deleted" } },
  ];

  it("returns the same array when the provider has no pools", async () => {
    const { filterConnectionsForAccountPools } = await import("@/sse/services/auth.js");
    expect(filterConnectionsForAccountPools("openai", connections, "gpt-5.5", {})).toBe(connections);
    expect(filterConnectionsForAccountPools("openai", connections, "gpt-5.5", { accountPools: {} })).toBe(connections);
    expect(filterConnectionsForAccountPools("openai", connections, "gpt-5.5", { accountPools: { codex: [] } })).toBe(connections);
  });

  it("returns the same array when the request has no model", async () => {
    const { filterConnectionsForAccountPools } = await import("@/sse/services/auth.js");
    expect(filterConnectionsForAccountPools("openai", connections, null, { accountPools: pools })).toBe(connections);
    expect(filterConnectionsForAccountPools("openai", connections, "", { accountPools: pools })).toBe(connections);
  });

  it("keeps pool members whose group serves the model plus unassigned accounts as fallback", async () => {
    const { filterConnectionsForAccountPools } = await import("@/sse/services/auth.js");
    expect(filterConnectionsForAccountPools("openai", connections, "gpt-5.5", { accountPools: pools }).map((c) => c.id))
      .toEqual(["in-fast", "unassigned", "dangling"]);
    expect(filterConnectionsForAccountPools("openai", connections, "gpt-4o-mini", { accountPools: pools }).map((c) => c.id))
      .toEqual(["in-mini", "unassigned", "dangling"]);
  });

  it("lets two pools serve disjoint model groups", async () => {
    const { filterConnectionsForAccountPools } = await import("@/sse/services/auth.js");
    const pooled = connections.filter((c) => c.id !== "unassigned" && c.id !== "dangling");
    expect(filterConnectionsForAccountPools("openai", pooled, "gpt-5.4", { accountPools: pools }).map((c) => c.id))
      .toEqual(["in-fast"]);
    expect(filterConnectionsForAccountPools("openai", pooled, "gpt-4o-mini", { accountPools: pools }).map((c) => c.id))
      .toEqual(["in-mini"]);
    expect(filterConnectionsForAccountPools("openai", pooled, "o3", { accountPools: pools })).toEqual([]);
  });

  it("treats an unknown pool id as 'no pool' and leaves other providers untouched", async () => {
    const { filterConnectionsForAccountPools } = await import("@/sse/services/auth.js");
    expect(filterConnectionsForAccountPools("openai", connections, "o3", { accountPools: pools }).map((c) => c.id))
      .toEqual(["unassigned", "dangling"]);
    expect(filterConnectionsForAccountPools("codex", connections, "o3", { accountPools: pools })).toBe(connections);
  });

  it("honours a per-account assignedModels pin inside a pool", async () => {
    const { filterConnectionsForAccountPools } = await import("@/sse/services/auth.js");
    const pinned = [
      { id: "pinned-fast", providerSpecificData: { accountPoolId: "pool-fast", assignedModels: ["gpt-5.5"] } },
      { id: "pinned-any", providerSpecificData: { accountPoolId: "pool-fast", assignedModels: [] } },
    ];
    expect(filterConnectionsForAccountPools("openai", pinned, "gpt-5.5", { accountPools: pools }).map((c) => c.id))
      .toEqual(["pinned-fast", "pinned-any"]);
    expect(filterConnectionsForAccountPools("openai", pinned, "gpt-5.4", { accountPools: pools }).map((c) => c.id))
      .toEqual(["pinned-any"]);
  });
});

describe("getProviderCredentials with account pools", () => {
  let ctx = null;

  afterEach(() => {
    vi.doUnmock("next/server");
    vi.resetModules();
    vi.clearAllMocks();
    if (ctx) ctx.cleanup();
    ctx = null;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("keeps the existing priority order when no pools exist (strict no-op)", async () => {
    ctx = await setup();
    const first = await createOpenAIConnection(ctx.connectionsRepo, "acc-first");
    await createOpenAIConnection(ctx.connectionsRepo, "acc-second");
    await createOpenAIConnection(ctx.connectionsRepo, "acc-third");

    const credentials = await ctx.getProviderCredentials("openai", null, "gpt-5.5");
    expect(credentials.connectionId).toBe(first.id);
    expect(credentials.accountCount).toBe(3);
    expect(credentials.providerSpecificData.accountPoolId).toBeUndefined();
  });

  it("selects the account whose pool serves the requested model", async () => {
    ctx = await setup();
    const poolFast = await createPool(ctx, "openai", "Fast", ["gpt-5.5"]);
    const poolMini = await createPool(ctx, "openai", "Mini", ["gpt-4o-mini"]);

    const fast = await createOpenAIConnection(ctx.connectionsRepo, "acc-fast");
    const mini = await createOpenAIConnection(ctx.connectionsRepo, "acc-mini");
    const fallback = await createOpenAIConnection(ctx.connectionsRepo, "acc-fallback");

    await ctx.connectionRoute.PUT(
      jsonRequest(`http://localhost/api/providers/${fast.id}`, "PUT", { accountPoolId: poolFast.id }),
      params(fast.id),
    );
    await ctx.connectionRoute.PUT(
      jsonRequest(`http://localhost/api/providers/${mini.id}`, "PUT", { accountPoolId: poolMini.id }),
      params(mini.id),
    );

    // Pool-serving account wins for its own model…
    expect((await ctx.getProviderCredentials("openai", null, "gpt-5.5")).connectionId).toBe(fast.id);
    expect((await ctx.getProviderCredentials("openai", null, "gpt-4o-mini")).connectionId).toBe(mini.id);
    expect((await ctx.getProviderCredentials("openai", null, "gpt-5.5")).accountCount).toBe(2);
    const excluded = await ctx.getProviderCredentials("openai", new Set([fast.id]), "gpt-5.5");
    expect(excluded.connectionId).toBe(fallback.id);
    expect(excluded.accountCount).toBe(2);
    // …while an unpooled account still covers models no pool serves.
    expect((await ctx.getProviderCredentials("openai", null, "o3")).connectionId).toBe(fallback.id);

    // Existing selection behavior is preserved when pool filtering removes the
    // member that used to serve the model: the unpooled account covers it again.
    await ctx.connectionsRepo.deleteProviderConnection(mini.id);
    expect((await ctx.getProviderCredentials("openai", null, "gpt-4o-mini")).connectionId).toBe(fallback.id);
  });

  it("returns null when every account is pooled and no pool serves the requested model", async () => {
    ctx = await setup();
    const poolFast = await createPool(ctx, "openai", "Fast", ["gpt-5.5"]);
    const fast = await createOpenAIConnection(ctx.connectionsRepo, "acc-fast");
    await ctx.connectionRoute.PUT(
      jsonRequest(`http://localhost/api/providers/${fast.id}`, "PUT", { accountPoolId: poolFast.id }),
      params(fast.id),
    );

    expect(await ctx.getProviderCredentials("openai", null, "o3")).toBeNull();
    expect((await ctx.getProviderCredentials("openai", null, "gpt-5.5")).connectionId).toBe(fast.id);
  });

  it("excludes pool members that do not serve the requested model", async () => {
    ctx = await setup();
    const poolFast = await createPool(ctx, "openai", "Fast", ["gpt-5.5", "gpt-5.4"]);
    const fast = await createOpenAIConnection(ctx.connectionsRepo, "acc-fast");
    const other = await createOpenAIConnection(ctx.connectionsRepo, "acc-other");

    await ctx.connectionRoute.PUT(
      jsonRequest(`http://localhost/api/providers/${fast.id}`, "PUT", {
        accountPoolId: poolFast.id,
        assignedModels: ["gpt-5.5"],
      }),
      params(fast.id),
    );
    // Same pool, no per-account pin: this one still serves the whole group.
    await ctx.connectionRoute.PUT(
      jsonRequest(`http://localhost/api/providers/${other.id}`, "PUT", { accountPoolId: poolFast.id }),
      params(other.id),
    );

    expect((await ctx.getProviderCredentials("openai", null, "gpt-5.5")).connectionId).toBe(fast.id);
    expect((await ctx.getProviderCredentials("openai", null, "gpt-5.4")).connectionId).toBe(other.id);
  });
});
