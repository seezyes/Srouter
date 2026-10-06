// GCP project selection support for Google OAuth provider connections
// (gemini-cli / antigravity).
//
// Srouter stores the resolved Google Cloud project id as a top-level
// `projectId` field on the provider connection; the gemini-cli / antigravity
// executors read `credentials.projectId` and fall back to a resolved id when it
// is empty. This module holds the provider allow-list and the small pure
// normalizers shared by the gcp-projects route and its tests, so the UI and the
// route agree on what counts as a selectable project.

export const GCP_PROJECT_PROVIDERS = ["gemini-cli", "antigravity"];

export const GCP_PROJECTS_ENDPOINT = "https://cloudresourcemanager.googleapis.com/v1/projects";

/**
 * Whether a provider connection carries a selectable GCP project.
 * @param {string} provider
 * @returns {boolean}
 */
export function isGcpProjectProvider(provider) {
  return GCP_PROJECT_PROVIDERS.includes(provider);
}

/**
 * Normalize a stored/entered project id to a trimmed string.
 * Non-strings are coerced; null/undefined become "".
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeProjectId(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/**
 * Map the Cloud Resource Manager list response into the picker shape.
 * Mirrors the upstream `{ id, name }` contract; drops entries without a
 * projectId so the picker never offers a value that cannot be sent upstream.
 * @param {{ projects?: Array<{ projectId?: string, name?: string }> }} payload
 * @returns {Array<{ id: string, name: string }>}
 */
export function mapProjectList(payload) {
  const projects = Array.isArray(payload?.projects) ? payload.projects : [];
  return projects
    .map((project) => {
      const id = normalizeProjectId(project?.projectId);
      const name = normalizeProjectId(project?.name) || id;
      return { id, name };
    })
    .filter((project) => project.id);
}
