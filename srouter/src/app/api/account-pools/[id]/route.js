import { NextResponse } from "next/server";
import { getProviderConnections, updateProviderConnection } from "@/lib/db/repos/connectionsRepo.js";
import {
  deleteAccountPool,
  findAccountPoolById,
  getAccountPools,
  updateAccountPool,
} from "@/lib/db/repos/settingsRepo.js";

export const dynamic = "force-dynamic";

function normalizeProviderIdInput(provider) {
  if (typeof provider !== "string") return "";
  const trimmed = provider.trim();
  return trimmed === "__none__" || trimmed === "null" ? "" : trimmed;
}

function normalizePoolNameInput(name) {
  return typeof name === "string" ? name.trim() : "";
}

function normalizeModelGroupInput(models) {
  if (!Array.isArray(models)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of models) {
    const id = typeof entry === "string" ? entry.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Resolve the pool owner. The provider can come from the query string or the
 * body; without it we scan every provider because pool ids are uuids.
 */
async function resolvePool(providerParam, poolId) {
  const provider = normalizeProviderIdInput(providerParam);
  if (provider) {
    const pool = (await getAccountPools(provider)).find((entry) => entry.id === poolId) || null;
    return pool ? { providerId: provider, pool } : null;
  }
  return await findAccountPoolById(poolId);
}

// PUT /api/account-pools/[id][?provider=openai] - Rename a pool / change its model group
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const { searchParams } = new URL(request.url);

    const resolved = await resolvePool(searchParams.get("provider") || body?.provider, id);
    if (!resolved) {
      return NextResponse.json({ error: "Account pool not found" }, { status: 404 });
    }

    const patch = {};
    if (body?.name !== undefined) {
      const name = normalizePoolNameInput(body.name);
      if (!name) {
        return NextResponse.json({ error: "Name is required" }, { status: 400 });
      }
      patch.name = name;
    }
    if (body?.models !== undefined) {
      if (!Array.isArray(body.models)) {
        return NextResponse.json({ error: "models must be an array" }, { status: 400 });
      }
      patch.models = normalizeModelGroupInput(body.models);
    }

    const accountPool = await updateAccountPool(resolved.providerId, id, patch);
    if (!accountPool) {
      return NextResponse.json({ error: "Account pool not found" }, { status: 404 });
    }

    return NextResponse.json({ accountPool });
  } catch (error) {
    console.log("Error updating account pool:", error);
    return NextResponse.json({ error: "Failed to update account pool" }, { status: 500 });
  }
}

// DELETE /api/account-pools/[id][?provider=openai] - Delete a pool and unassign its members
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);

    const resolved = await resolvePool(searchParams.get("provider"), id);
    if (!resolved) {
      return NextResponse.json({ error: "Account pool not found" }, { status: 404 });
    }

    const accountPool = await deleteAccountPool(resolved.providerId, id);
    if (!accountPool) {
      return NextResponse.json({ error: "Account pool not found" }, { status: 404 });
    }

    // Leave no dangling membership: members fall back to "no pool", i.e. they
    // become candidates for every model again (routing fallback behavior). The
    // per-account model pin is pool-scoped, so it is cleared with the pool.
    const connections = await getProviderConnections({ provider: resolved.providerId });
    let unassigned = 0;
    for (const connection of connections) {
      const data = connection?.providerSpecificData;
      if (data?.accountPoolId !== id) continue;
      const nextData = { ...data };
      delete nextData.accountPoolId;
      delete nextData.assignedModels;
      await updateProviderConnection(connection.id, { providerSpecificData: nextData });
      unassigned += 1;
    }

    return NextResponse.json({ accountPool, unassignedConnections: unassigned });
  } catch (error) {
    console.log("Error deleting account pool:", error);
    return NextResponse.json({ error: "Failed to delete account pool" }, { status: 500 });
  }
}
