// Shared fixtures for the Pass9 API configuration/diagnostics closure tests
// (GCP project selection route + translator console/system log merger).
// Pure builders only — no DB, no network, no env mutation.

export function makeConnection(overrides = {}) {
  return {
    id: "conn-1",
    provider: "gemini-cli",
    authType: "oauth",
    name: "Gemini account",
    accessToken: "access-token-fixture",
    refreshToken: "refresh-token-fixture",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    providerSpecificData: {},
    ...overrides,
  };
}

export function makeProjectPayload(rows = [
  { projectId: "proj-alpha", name: "Alpha Project" },
  { projectId: "proj-beta", name: "Beta Project" },
]) {
  return { projects: rows };
}

export function makeFetchResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

export function makeParams(id) {
  return { params: Promise.resolve({ id }) };
}

export function makeRequest(body) {
  return new Request("http://localhost/api/providers/conn-1/gcp-projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
