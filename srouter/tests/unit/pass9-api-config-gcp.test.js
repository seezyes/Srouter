// Pass9 API configuration closure — GCP project picker route.
//
// Route: src/app/api/providers/[id]/gcp-projects/route.js
// Owner write path for the gemini-cli / antigravity Project ID selection.
// The route must: reject unknown/unsupported connections, refresh an expired
// token only through the app-layer policy, list projects through the
// connection proxy (honouring strict proxy), surface upstream failures, and
// persist a normalized projectId. No real network/DB is touched.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeConnection,
  makeFetchResponse,
  makeParams,
  makeProjectPayload,
  makeRequest,
} from "../helpers/pass9-api-config-fixtures.js";

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(),
  updateConnection: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  resolveProxy: vi.fn(),
  proxyAwareFetch: vi.fn(),
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getConnection,
  updateProviderConnection: mocks.updateConnection,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveProxy,
}));
vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

const { GET, POST } = await import("@/app/api/providers/[id]/gcp-projects/route.js");
const { isGcpProjectProvider, mapProjectList, normalizeProjectId } = await import("@/lib/providers/gcpProjects.js");

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolveProxy.mockResolvedValue({ source: "none", strictProxy: false });
  mocks.proxyAwareFetch.mockResolvedValue(makeFetchResponse(makeProjectPayload()));
});

describe("GET /api/providers/[id]/gcp-projects", () => {
  it("404s for an unknown connection", async () => {
    mocks.getConnection.mockResolvedValue(null);
    const res = await GET(new Request("http://localhost"), makeParams("missing"));
    expect(res.status).toBe(404);
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("400s for a non-Google provider", async () => {
    mocks.getConnection.mockResolvedValue(makeConnection({ provider: "openai" }));
    const res = await GET(new Request("http://localhost"), makeParams("conn-1"));
    expect(res.status).toBe(400);
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("returns the mapped project list with the connection token", async () => {
    mocks.getConnection.mockResolvedValue(makeConnection());
    const res = await GET(new Request("http://localhost"), makeParams("conn-1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.projects).toEqual([
      { id: "proj-alpha", name: "Alpha Project" },
      { id: "proj-beta", name: "Beta Project" },
    ]);
    const [url, options] = mocks.proxyAwareFetch.mock.calls[0];
    expect(url).toBe("https://cloudresourcemanager.googleapis.com/v1/projects");
    expect(options.headers.Authorization).toBe("Bearer access-token-fixture");
    expect(mocks.checkAndRefreshToken).not.toHaveBeenCalled();
  });

  it("refreshes an expired token through the app-layer policy", async () => {
    mocks.getConnection.mockResolvedValue(makeConnection({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    mocks.checkAndRefreshToken.mockResolvedValue({ accessToken: "refreshed-token" });
    const res = await GET(new Request("http://localhost"), makeParams("conn-1"));
    expect(res.status).toBe(200);
    expect(mocks.checkAndRefreshToken).toHaveBeenCalledWith(
      "gemini-cli",
      expect.objectContaining({ connectionId: "conn-1" }),
    );
    expect(mocks.proxyAwareFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer refreshed-token");
  });

  it("401s when there is no usable token", async () => {
    mocks.getConnection.mockResolvedValue(makeConnection({
      accessToken: "",
      refreshToken: "",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }));
    const res = await GET(new Request("http://localhost"), makeParams("conn-1"));
    expect(res.status).toBe(401);
  });

  it("propagates an upstream Google API error status", async () => {
    mocks.getConnection.mockResolvedValue(makeConnection());
    mocks.proxyAwareFetch.mockResolvedValue(makeFetchResponse("forbidden", { ok: false, status: 403 }));
    const res = await GET(new Request("http://localhost"), makeParams("conn-1"));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("Google API error: 403");
  });

  it("500s and hides internals when strict proxy refuses a direct call", async () => {
    mocks.getConnection.mockResolvedValue(makeConnection({
      providerSpecificData: { proxyPoolId: "pool-1", strictProxy: true },
    }));
    mocks.resolveProxy.mockResolvedValue({ source: "pool", strictProxy: true });
    mocks.proxyAwareFetch.mockRejectedValue(new Error("Proxy required but none resolved (strictProxy=true)"));
    const res = await GET(new Request("http://localhost"), makeParams("conn-1"));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("strictProxy");
    expect(JSON.parse(text).error).toBe("Failed to fetch GCP projects");
  });

  it("resolves the proxy from the connection data and id", async () => {
    mocks.getConnection.mockResolvedValue(makeConnection({ providerSpecificData: { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:7890" } }));
    await GET(new Request("http://localhost"), makeParams("conn-1"));
    expect(mocks.resolveProxy).toHaveBeenCalledWith(
      { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:7890" },
      "conn-1",
    );
  });
});

describe("POST /api/providers/[id]/gcp-projects", () => {
  it("404s for an unknown connection", async () => {
    mocks.getConnection.mockResolvedValue(null);
    const res = await POST(makeRequest({ projectId: "x" }), makeParams("missing"));
    expect(res.status).toBe(404);
    expect(mocks.updateConnection).not.toHaveBeenCalled();
  });

  it("400s for a non-Google provider", async () => {
    mocks.getConnection.mockResolvedValue(makeConnection({ provider: "codex" }));
    const res = await POST(makeRequest({ projectId: "x" }), makeParams("conn-1"));
    expect(res.status).toBe(400);
    expect(mocks.updateConnection).not.toHaveBeenCalled();
  });

  it("persists a trimmed projectId and marks manual selection", async () => {
    mocks.getConnection.mockResolvedValue(makeConnection());
    mocks.updateConnection.mockResolvedValue({ projectId: "proj-alpha", isProjectIdManual: true });
    const res = await POST(makeRequest({ projectId: "  proj-alpha  " }), makeParams("conn-1"));
    expect(mocks.updateConnection).toHaveBeenCalledWith("conn-1", {
      projectId: "proj-alpha",
      isProjectIdManual: true,
    });
    expect(await res.json()).toEqual({ success: true, projectId: "proj-alpha", isProjectIdManual: true });
  });

  it("clears the manual flag for an empty selection", async () => {
    mocks.getConnection.mockResolvedValue(makeConnection({ provider: "antigravity" }));
    mocks.updateConnection.mockResolvedValue({ projectId: "", isProjectIdManual: false });
    const res = await POST(makeRequest({ projectId: "   " }), makeParams("conn-1"));
    expect(mocks.updateConnection).toHaveBeenCalledWith("conn-1", { projectId: "", isProjectIdManual: false });
    expect((await res.json()).isProjectIdManual).toBe(false);
  });

  it("500s and hides internals when the DB write fails", async () => {
    mocks.getConnection.mockResolvedValue(makeConnection());
    mocks.updateConnection.mockRejectedValue(new Error("fixture-secret-db-error"));
    const res = await POST(makeRequest({ projectId: "proj-alpha" }), makeParams("conn-1"));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("fixture-secret-db-error");
  });
});

describe("gcpProjects helper", () => {
  it("recognises only gemini-cli and antigravity", () => {
    expect(isGcpProjectProvider("gemini-cli")).toBe(true);
    expect(isGcpProjectProvider("antigravity")).toBe(true);
    expect(isGcpProjectProvider("gemini")).toBe(false);
    expect(isGcpProjectProvider("codex")).toBe(false);
  });

  it("normalizes project ids and drops entries without a projectId", () => {
    expect(normalizeProjectId("  p  ")).toBe("p");
    expect(normalizeProjectId(null)).toBe("");
    expect(mapProjectList({ projects: [
      { projectId: "a", name: "A" },
      { projectId: "", name: "no-id" },
      { name: "missing-id" },
    ] })).toEqual([{ id: "a", name: "A" }]);
    expect(mapProjectList({})).toEqual([]);
  });
});
