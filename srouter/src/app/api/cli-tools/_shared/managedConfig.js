import fs from "fs/promises";
import { parseJSONC } from "confbox";

export function parseEditableJSONC(content) {
  const errors = [];
  const config = parseJSONC(content, { errors, allowTrailingComma: true });
  if (errors.length) throw configConflict();
  return config;
}

export function configConflict(message = "Config belongs to another router or cannot be read safely") {
  const error = new Error(message);
  error.code = "CLI_CONFIG_CONFLICT";
  return error;
}

export function isSrouterEndpoint(value) {
  if (typeof value !== "string" || !value) return false;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    // 20128 is the sibling 9router, never an ownership signal.
    if (url.port === "20128") return false;
    if (host === "srouter.local") return true;
    const ports = new Set(["20127", "20129", process.env.PORT].filter(port => port && port !== "20128"));
    return ["localhost", "127.0.0.1", "[::1]"].includes(host) && ports.has(url.port);
  } catch {
    return false;
  }
}

export function isManagedConfig(config, baseUrl = config?.baseUrl || config?.base_url) {
  return config?._managedBy === "srouter" || isSrouterEndpoint(baseUrl);
}

export function assertManagedConfig(config, baseUrl, managed = false) {
  if (config && Object.keys(config).length > 0 && !managed && !isManagedConfig(config, baseUrl)) {
    throw configConflict();
  }
}

// Read-only status may tolerate an unreadable file; a writer must never replace it
// with an empty config. Only ENOENT denotes a fresh file.
export async function readEditableConfig(filePath, parse = JSON.parse) {
  try {
    const config = parse(await fs.readFile(filePath, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw configConflict();
    return config;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw configConflict();
  }
}

export function configErrorStatus(error) {
  return error.code === "CLI_CONFIG_CONFLICT" ? 409 : 500;
}
