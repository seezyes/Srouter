import { NextResponse } from "next/server";
import { getProviderConnectionById, updateProviderConnection } from "@/models";
import { checkAndRefreshToken } from "@/sse/services/tokenRefresh.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import {
  GCP_PROJECTS_ENDPOINT,
  isGcpProjectProvider,
  mapProjectList,
  normalizeProjectId,
} from "@/lib/providers/gcpProjects.js";

// Google Cloud project picker for gemini-cli / antigravity OAuth connections.
// The upstream contract is a Cloud Resource Manager project list; Srouter keeps
// its own connection/session contract (credential refresh policy, connection
// proxy / strict proxy, no raw credential disclosure).

async function resolveAccessToken(connection) {
  let accessToken = connection.accessToken;
  const isExpired = connection.expiresAt
    ? new Date(connection.expiresAt).getTime() < Date.now()
    : true;

  if (isExpired && connection.refreshToken) {
    try {
      // Route through the app-layer refresh so the dev mirror-only policy and
      // rotating-token safety (adopt latest DB token) are respected.
      const refreshed = await checkAndRefreshToken(connection.provider, {
        ...connection,
        connectionId: connection.id,
      });
      if (refreshed?.accessToken) accessToken = refreshed.accessToken;
    } catch {
      // Keep the existing token; a missing/invalid one is reported below.
    }
  }

  return accessToken;
}

// GET /api/providers/[id]/gcp-projects - List selectable GCP projects
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    if (!isGcpProjectProvider(connection.provider)) {
      return NextResponse.json({ error: "Provider not supported for GCP projects" }, { status: 400 });
    }

    const accessToken = await resolveAccessToken(connection);
    if (!accessToken) {
      return NextResponse.json({ error: "No valid access token available" }, { status: 401 });
    }

    const effectiveProxy = await resolveConnectionProxyConfig(
      connection.providerSpecificData || {},
      connection.id,
    );

    const res = await proxyAwareFetch(
      GCP_PROJECTS_ENDPOINT,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
      effectiveProxy,
    );

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `Google API error: ${res.status} - ${bodyText}` },
        { status: res.status },
      );
    }

    const data = await res.json();
    return NextResponse.json({ projects: mapProjectList(data) });
  } catch (error) {
    console.error("Error fetching GCP projects:", error);
    return NextResponse.json({ error: "Failed to fetch GCP projects" }, { status: 500 });
  }
}

// POST /api/providers/[id]/gcp-projects - Persist the selected project id.
//
// The canonical connection PUT does not (yet) carry the top-level `projectId`
// / `isProjectIdManual` fields for gemini-cli / antigravity, so the picker
// persists its selection through this owned endpoint. See the pass9-api-config
// closure report for the proposed canonical-PUT follow-up.
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    if (!isGcpProjectProvider(connection.provider)) {
      return NextResponse.json({ error: "Provider not supported for GCP projects" }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const projectId = normalizeProjectId(body?.projectId);

    const updated = await updateProviderConnection(id, {
      projectId,
      isProjectIdManual: projectId.length > 0,
    });

    return NextResponse.json({
      success: true,
      projectId: normalizeProjectId(updated?.projectId),
      isProjectIdManual: updated?.isProjectIdManual === true,
    });
  } catch (error) {
    console.error("Error saving GCP project selection:", error);
    return NextResponse.json({ error: "Failed to save GCP project selection" }, { status: 500 });
  }
}
