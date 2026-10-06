import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/db/repos/connectionsRepo.js";
import { createAccountPool, getAccountPools } from "@/lib/db/repos/settingsRepo.js";

export const dynamic = "force-dynamic";

const NONE_VALUES = new Set(["", "__none__", "null", "undefined"]);

function normalizeProviderIdInput(provider) {
  if (typeof provider !== "string") return "";
  const trimmed = provider.trim();
  if (!trimmed || NONE_VALUES.has(trimmed)) return "";
  return trimmed;
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

// GET /api/account-pools[?provider=openai][&includeUsage=true]
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = normalizeProviderIdInput(searchParams.get("provider"));
    const includeUsage = searchParams.get("includeUsage") === "true";

    if (!provider) {
      const accountPoolsByProvider = await getAccountPools();
      return NextResponse.json({ accountPoolsByProvider });
    }

    const accountPools = await getAccountPools(provider);
    if (!includeUsage) {
      return NextResponse.json({ accountPools });
    }

    // Member counts mirror the proxy-pool usage enrichment.
    const connections = await getProviderConnections({ provider });
    const memberCounts = new Map();
    for (const connection of connections) {
      const poolId = connection?.providerSpecificData?.accountPoolId;
      if (!poolId) continue;
      memberCounts.set(poolId, (memberCounts.get(poolId) || 0) + 1);
    }

    return NextResponse.json({
      accountPools: accountPools.map((pool) => ({
        ...pool,
        memberCount: memberCounts.get(pool.id) || 0,
      })),
    });
  } catch (error) {
    console.log("Error fetching account pools:", error);
    return NextResponse.json({ error: "Failed to fetch account pools" }, { status: 500 });
  }
}

// POST /api/account-pools - Create a pool for one provider
export async function POST(request) {
  try {
    const body = await request.json();
    const provider = normalizeProviderIdInput(body?.provider);
    const name = normalizePoolNameInput(body?.name);

    if (!provider) {
      return NextResponse.json({ error: "Provider is required" }, { status: 400 });
    }
    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const accountPool = await createAccountPool(provider, {
      name,
      models: normalizeModelGroupInput(body?.models),
    });

    return NextResponse.json({ accountPool }, { status: 201 });
  } catch (error) {
    console.log("Error creating account pool:", error);
    return NextResponse.json({ error: "Failed to create account pool" }, { status: 500 });
  }
}
