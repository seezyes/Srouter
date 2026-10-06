import { readdir, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const STATE_KEY = Symbol.for("srouter.hostedSearch.plugins.v1");
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Only instrumentation initializes this snapshot. A dashboard/API request can
// inspect it, but cannot load code, supply a path, or rescan the directory.
export function initializeHostedSearchPlugins(directory) {
  if (!globalThis[STATE_KEY]) {
    globalThis[STATE_KEY] = loadHostedSearchPlugins(directory);
  }
  return globalThis[STATE_KEY];
}

export async function getHostedSearchPlugins() {
  return globalThis[STATE_KEY] ? await globalThis[STATE_KEY] : new Map();
}

export async function loadHostedSearchPlugins(directory) {
  const plugins = new Map();
  let root;
  let entries;
  try {
    root = await realpath(directory);
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") console.warn("[hosted-search] Cannot read plugin directory");
    return plugins;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
    try {
      const file = path.join(root, entry.name);
      if ((await lstat(file)).isSymbolicLink()) continue;
      const resolved = await realpath(file);
      if (path.dirname(resolved) !== root) continue;
      const imported = await import(/* webpackIgnore: true */ /* @vite-ignore */ pathToFileURL(resolved).href);
      const plugin = imported.default;
      if (!plugin || typeof plugin.id !== "string" || !ID_PATTERN.test(plugin.id) || typeof plugin.name !== "string"
        || !plugin.name.trim() || plugin.name.length > 120 || typeof plugin.search !== "function"
        || !Array.isArray(plugin.providerIds) || !plugin.providerIds.length
        || !plugin.providerIds.every((id) => typeof id === "string" && (id === "*" || ID_PATTERN.test(id)))
        || (plugin.defaultModel !== undefined && plugin.defaultModel !== "")) {
        throw new Error("Invalid manifest");
      }
      const id = `plugin:${plugin.id}`;
      if (plugins.has(id)) throw new Error("Duplicate plugin id");
      plugins.set(id, Object.freeze({
        id, name: plugin.name.trim(), providerIds: Object.freeze([...plugin.providerIds]),
        search: plugin.search,
      }));
    } catch {
      // Do not print thrown plugin errors: a trusted module might put credentials
      // in its exception. One bad plugin must not prevent server startup.
      console.warn(`[hosted-search] Plugin '${entry.name}' was not loaded`);
    }
  }
  return plugins;
}
