import { NextResponse } from "next/server";
import {
  getProviderConnectionById,
  getProxyPoolById,
  updateProviderConnection,
  deleteProviderConnection,
} from "@/models";
import { getAccountPools } from "@/lib/db/repos/settingsRepo.js";
import { isCodexAccountServiceTier } from "open-sse/config/codexServiceTier.js";
import { isGcpProjectProvider, normalizeProjectId } from "@/lib/providers/gcpProjects.js";

function normalizeProxyConfig(body = {}) {
  const hasAnyProxyField =
    Object.prototype.hasOwnProperty.call(body, "connectionProxyEnabled") ||
    Object.prototype.hasOwnProperty.call(body, "connectionProxyUrl") ||
    Object.prototype.hasOwnProperty.call(body, "connectionNoProxy");

  if (!hasAnyProxyField) return { hasAnyProxyField: false };

  const enabled = body?.connectionProxyEnabled === true;
  const url = typeof body?.connectionProxyUrl === "string" ? body.connectionProxyUrl.trim() : "";
  const noProxy = typeof body?.connectionNoProxy === "string" ? body.connectionNoProxy.trim() : "";

  if (enabled && !url) {
    return {
      hasAnyProxyField: true,
      error: "Connection proxy URL is required when connection proxy is enabled",
    };
  }

  return {
    hasAnyProxyField: true,
    connectionProxyEnabled: enabled,
    connectionProxyUrl: url,
    connectionNoProxy: noProxy,
  };
}

async function normalizeProxyPoolUpdate(proxyPoolIdInput) {
  if (proxyPoolIdInput === undefined) {
    return { hasProxyPoolField: false, proxyPoolId: null };
  }

  if (proxyPoolIdInput === null || proxyPoolIdInput === "" || proxyPoolIdInput === "__none__") {
    return { hasProxyPoolField: true, proxyPoolId: null };
  }

  const proxyPoolId = String(proxyPoolIdInput).trim();
  if (!proxyPoolId) {
    return { hasProxyPoolField: true, proxyPoolId: null };
  }

  const proxyPool = await getProxyPoolById(proxyPoolId);
  if (!proxyPool) {
    return { hasProxyPoolField: true, error: "Proxy pool not found" };
  }

  return { hasProxyPoolField: true, proxyPoolId };
}

function shouldMergeProviderSpecificData(existing, incoming, hasLegacyProxy, hasProxyPoolField, hasAccountPoolField = false, hasAssignedModelsField = false) {
  return existing !== undefined || incoming !== undefined || hasLegacyProxy || hasProxyPoolField
    || hasAccountPoolField || hasAssignedModelsField;
}

// Account pool membership lives in providerSpecificData.accountPoolId. The pool
// must exist for the connection's own provider (pools are provider-scoped).
async function normalizeAccountPoolUpdate(accountPoolIdInput, provider) {
  if (accountPoolIdInput === undefined) {
    return { hasAccountPoolField: false, accountPoolId: null };
  }

  if (accountPoolIdInput === null || accountPoolIdInput === "" || accountPoolIdInput === "__none__") {
    return { hasAccountPoolField: true, accountPoolId: null };
  }

  const accountPoolId = String(accountPoolIdInput).trim();
  if (!accountPoolId) {
    return { hasAccountPoolField: true, accountPoolId: null };
  }

  const pools = await getAccountPools(provider);
  if (!pools.some((pool) => pool.id === accountPoolId)) {
    return { hasAccountPoolField: true, error: "Account pool not found" };
  }

  return { hasAccountPoolField: true, accountPoolId };
}

// Optional per-account model pin inside a pool, e.g. ["gpt-5.5", "gpt-5.4-mini"].
function normalizeAssignedModelsUpdate(assignedModelsInput) {
  if (assignedModelsInput === undefined) {
    return { hasAssignedModelsField: false, assignedModels: null };
  }

  if (assignedModelsInput === null || assignedModelsInput === "") {
    return { hasAssignedModelsField: true, assignedModels: null };
  }

  if (!Array.isArray(assignedModelsInput)) {
    return { hasAssignedModelsField: true, error: "assignedModels must be an array" };
  }

  const seen = new Set();
  const assignedModels = [];
  for (const entry of assignedModelsInput) {
    const id = typeof entry === "string" ? entry.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    assignedModels.push(id);
  }

  return {
    hasAssignedModelsField: true,
    assignedModels: assignedModels.length > 0 ? assignedModels : null,
  };
}

// GET /api/providers/[id] - Get single connection
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    // Hide sensitive fields
    const result = { ...connection };
    delete result.apiKey;
    delete result.accessToken;
    delete result.refreshToken;
    delete result.idToken;

    return NextResponse.json({ connection: result });
  } catch (error) {
    console.log("Error fetching connection:", error);
    return NextResponse.json({ error: "Failed to fetch connection" }, { status: 500 });
  }
}

// PUT /api/providers/[id] - Update connection
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const {
      name,
      priority,
      globalPriority,
      defaultModel,
      isActive,
      apiKey,
      testStatus,
      lastError,
      lastErrorAt,
      providerSpecificData,
      projectId,
      isProjectIdManual
    } = body;

    const existing = await getProviderConnectionById(id);
    if (!existing) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    if (existing.provider === "codex" && providerSpecificData !== undefined && (
      providerSpecificData === null || typeof providerSpecificData !== "object" || Array.isArray(providerSpecificData)
    )) {
      return NextResponse.json({ error: "providerSpecificData must be an object" }, { status: 400 });
    }
    const hasServiceTier = Object.prototype.hasOwnProperty.call(body, "serviceTier");
    const hasNestedServiceTier = Object.prototype.hasOwnProperty.call(providerSpecificData || {}, "serviceTier");
    if (hasServiceTier && hasNestedServiceTier && body.serviceTier !== providerSpecificData.serviceTier) {
      return NextResponse.json({ error: "Conflicting serviceTier values" }, { status: 400 });
    }
    const serviceTier = hasServiceTier ? body.serviceTier : providerSpecificData?.serviceTier;
    if ((hasServiceTier || hasNestedServiceTier) && (
      existing.provider !== "codex" || !isCodexAccountServiceTier(serviceTier)
    )) {
      return NextResponse.json({ error: "serviceTier must be null, default, fast, or ultrafast on Codex accounts" }, { status: 400 });
    }

    // GCP project selection is only meaningful for Google OAuth connections
    // (gemini-cli / antigravity). Reject it on any other provider instead of
    // silently storing an inert field, and validate the shape.
    const hasProjectId = Object.prototype.hasOwnProperty.call(body, "projectId");
    const hasIsProjectIdManual = Object.prototype.hasOwnProperty.call(body, "isProjectIdManual");
    if ((hasProjectId || hasIsProjectIdManual) && !isGcpProjectProvider(existing.provider)) {
      return NextResponse.json(
        { error: "projectId is only settable on gemini-cli or antigravity connections" },
        { status: 400 },
      );
    }
    if (hasProjectId && projectId !== null && typeof projectId !== "string") {
      return NextResponse.json({ error: "projectId must be a string" }, { status: 400 });
    }

    const proxyConfig = normalizeProxyConfig(body);
    if (proxyConfig.error) {
      return NextResponse.json({ error: proxyConfig.error }, { status: 400 });
    }

    const proxyPoolResult = await normalizeProxyPoolUpdate(body.proxyPoolId);
    if (proxyPoolResult.error) {
      return NextResponse.json({ error: proxyPoolResult.error }, { status: 400 });
    }

    const accountPoolResult = await normalizeAccountPoolUpdate(body.accountPoolId, existing.provider);
    if (accountPoolResult.error) {
      return NextResponse.json({ error: accountPoolResult.error }, { status: 400 });
    }

    const assignedModelsResult = normalizeAssignedModelsUpdate(body.assignedModels);
    if (assignedModelsResult.error) {
      return NextResponse.json({ error: assignedModelsResult.error }, { status: 400 });
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (priority !== undefined) updateData.priority = priority;
    if (globalPriority !== undefined) updateData.globalPriority = globalPriority;
    if (defaultModel !== undefined) updateData.defaultModel = defaultModel;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (apiKey && existing.authType === "apikey") updateData.apiKey = apiKey;
    if (testStatus !== undefined) updateData.testStatus = testStatus;
    if (lastError !== undefined) updateData.lastError = lastError;
    if (lastErrorAt !== undefined) updateData.lastErrorAt = lastErrorAt;

    // Same semantics as POST /api/providers/[id]/gcp-projects so the canonical
    // PUT and the owned GCP endpoint never disagree.
    if (hasProjectId) {
      const normalizedProjectId = normalizeProjectId(projectId);
      updateData.projectId = normalizedProjectId;
      if (!hasIsProjectIdManual) updateData.isProjectIdManual = normalizedProjectId.length > 0;
    }
    if (hasIsProjectIdManual) updateData.isProjectIdManual = isProjectIdManual === true;

    if (
      hasServiceTier || shouldMergeProviderSpecificData(
        existing.providerSpecificData,
        providerSpecificData,
        proxyConfig.hasAnyProxyField,
        proxyPoolResult.hasProxyPoolField,
        accountPoolResult.hasAccountPoolField,
        assignedModelsResult.hasAssignedModelsField
      )
    ) {
      updateData.providerSpecificData = {
        ...(existing.providerSpecificData || {}),
        ...(providerSpecificData || {}),
      };

      if (hasServiceTier || hasNestedServiceTier) {
        if (serviceTier === null) delete updateData.providerSpecificData.serviceTier;
        else updateData.providerSpecificData.serviceTier = serviceTier;
      }

      if (proxyConfig.hasAnyProxyField) {
        updateData.providerSpecificData.connectionProxyEnabled = proxyConfig.connectionProxyEnabled;
        updateData.providerSpecificData.connectionProxyUrl = proxyConfig.connectionProxyUrl;
        updateData.providerSpecificData.connectionNoProxy = proxyConfig.connectionNoProxy;
      }

      if (proxyPoolResult.hasProxyPoolField) {
        if (proxyPoolResult.proxyPoolId === null) {
          delete updateData.providerSpecificData.proxyPoolId;
        } else {
          updateData.providerSpecificData.proxyPoolId = proxyPoolResult.proxyPoolId;
        }
      }

      if (accountPoolResult.hasAccountPoolField) {
        if (accountPoolResult.accountPoolId === null) {
          delete updateData.providerSpecificData.accountPoolId;
        } else {
          updateData.providerSpecificData.accountPoolId = accountPoolResult.accountPoolId;
        }
      }

      if (assignedModelsResult.hasAssignedModelsField) {
        if (assignedModelsResult.assignedModels === null) {
          delete updateData.providerSpecificData.assignedModels;
        } else {
          updateData.providerSpecificData.assignedModels = assignedModelsResult.assignedModels;
        }
      }
    }

    const updated = await updateProviderConnection(id, updateData);

    // Hide sensitive fields
    const result = { ...updated };
    delete result.apiKey;
    delete result.accessToken;
    delete result.refreshToken;
    delete result.idToken;

    return NextResponse.json({ connection: result });
  } catch (error) {
    console.log("Error updating connection:", error);
    return NextResponse.json({ error: "Failed to update connection" }, { status: 500 });
  }
}

// PATCH uses the same partial-update and providerSpecificData merge contract.
export const PATCH = PUT;

// DELETE /api/providers/[id] - Delete connection
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteProviderConnection(id);
    if (!deleted) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Connection deleted successfully" });
  } catch (error) {
    console.log("Error deleting connection:", error);
    return NextResponse.json({ error: "Failed to delete connection" }, { status: 500 });
  }
}
