// Pass9 API configuration closure — provider connection PUT projectId whitelist.
//
// Route: src/app/api/providers/[id]/route.js
// The canonical PUT now owns the top-level projectId / isProjectIdManual for
// gemini-cli / antigravity only, with the same semantics as the owned
// POST /api/providers/[id]/gcp-projects endpoint. No DB/network touched.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(),
  updateConnection: vi.fn(),
  getProxyPoolById: vi.fn(),
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getConnection,
  updateProviderConnection: mocks.updateConnection,
  getProxyPoolById: mocks.getProxyPoolById,
  deleteProviderConnection: vi.fn(),
}));
vi.mock("@/lib/db/repos/settingsRepo.js", () => ({
  getAccountPools: vi.fn(async () => []),
}));

const { PUT } = await import("@/app/api/providers/[id]/route.js");

const params = (id) => ({ params: Promise.resolve({ id }) });
const putRequest = (body) => new Request("http://localhost/api/providers/conn-1", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function connection(overrides = {}) {
  return {
    id: "conn-1",
    provider: "gemini-cli",
    authType: "oauth",
    name: "Gemini",
    priority: 1,
    isActive: true,
    apiKey: "secret-api-key",
    accessToken: "secret-access",
    refreshToken: "secret-refresh",
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getConnection.mockResolvedValue(connection());
  mocks.updateConnection.mockImplementation(async (id, data) => ({ ...connection(), ...data }));
});

describe("PUT /api/providers/[id] projectId whitelist", () => {
  it("persists a trimmed projectId and derives the manual flag (gemini-cli)", async () => {
    const res = await PUT(putRequest({ projectId: "  proj-alpha  " }), params("conn-1"));
    expect(res.status).toBe(200);
    expect(mocks.updateConnection).toHaveBeenCalledWith("conn-1", {
      projectId: "proj-alpha",
      isProjectIdManual: true,
    });
  });

  it("clears projectId and the manual flag for antigravity", async () => {
    mocks.getConnection.mockResolvedValue(connection({ provider: "antigravity" }));
    const res = await PUT(putRequest({ projectId: "" }), params("conn-1"));
    expect(res.status).toBe(200);
    expect(mocks.updateConnection).toHaveBeenCalledWith("conn-1", {
      projectId: "",
      isProjectIdManual: false,
    });
  });

  it("honours an explicit isProjectIdManual", async () => {
    await PUT(putRequest({ projectId: "proj-alpha", isProjectIdManual: false }), params("conn-1"));
    expect(mocks.updateConnection).toHaveBeenCalledWith("conn-1", {
      projectId: "proj-alpha",
      isProjectIdManual: false,
    });
  });

  it("rejects projectId on a non-Google provider without writing", async () => {
    mocks.getConnection.mockResolvedValue(connection({ provider: "openai" }));
    const res = await PUT(putRequest({ projectId: "proj-alpha" }), params("conn-1"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("gemini-cli or antigravity");
    expect(mocks.updateConnection).not.toHaveBeenCalled();
  });

  it("rejects a non-string projectId", async () => {
    const res = await PUT(putRequest({ projectId: 42 }), params("conn-1"));
    expect(res.status).toBe(400);
    expect(mocks.updateConnection).not.toHaveBeenCalled();
  });

  it("ignores isProjectIdManual alone on a non-Google provider", async () => {
    mocks.getConnection.mockResolvedValue(connection({ provider: "codex" }));
    const res = await PUT(putRequest({ isProjectIdManual: true }), params("conn-1"));
    expect(res.status).toBe(400);
    expect(mocks.updateConnection).not.toHaveBeenCalled();
  });

  it("leaves unrelated provider updates untouched (no projectId key)", async () => {
    mocks.getConnection.mockResolvedValue(connection({ provider: "openai" }));
    await PUT(putRequest({ name: "Renamed", priority: 3 }), params("conn-1"));
    const data = mocks.updateConnection.mock.calls[0][1];
    expect(data).toEqual({ name: "Renamed", priority: 3 });
    expect("projectId" in data).toBe(false);
  });

  it("does not leak secrets in the response", async () => {
    const res = await PUT(putRequest({ projectId: "proj-alpha" }), params("conn-1"));
    const body = await res.json();
    expect(body.connection.projectId).toBe("proj-alpha");
    expect(body.connection.apiKey).toBeUndefined();
    expect(body.connection.accessToken).toBeUndefined();
    expect(body.connection.refreshToken).toBeUndefined();
  });
});
