import { parseYAML } from "confbox";
import { assertManagedConfig, configConflict } from "./managedConfig";

// Validate YAML semantically, but edit only the named provider's indentation
// range. A regex stopping at any word key leaves orphaned nested properties.
export function editOmpProvider(content, replacement = "") {
  let settings;
  try { settings = content.trim() ? parseYAML(content) : {}; } catch { throw configConflict(); }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw configConflict();
  const providers = settings.providers;
  if (providers && (typeof providers !== "object" || Array.isArray(providers))) throw configConflict();
  const provider = providers?.srouter;
  assertManagedConfig(provider);
  const lines = content.split(/(?<=\n)/);
  const header = lines.findIndex(line => /^providers:\s*(?:#.*)?(?:\r?\n)?$/.test(line));
  if (providers !== undefined && header < 0) throw configConflict("Unsupported providers YAML layout");
  const nextRoot = lines.findIndex((line, index) => index > header && /^[^\s#]/.test(line));
  const start = !provider || header < 0 ? -1 : lines.findIndex((line, index) =>
    index > header && (nextRoot < 0 || index < nextRoot) && /^ {2}srouter:\s*(?:#.*)?(?:\r?\n)?$/.test(line));
  if (provider && start < 0) throw configConflict("Unsupported Srouter YAML layout; config left unchanged");
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !/^(?:[^\s#]| {1,2}[^\s#])/.test(lines[end])) end++;
    // Comments do not terminate YAML scopes, even at column zero.
    const comments = lines.slice(start, end).filter(line => /^\s*#/.test(line));
    lines.splice(start, end - start, ...comments);
  }
  if (replacement) {
    if (header >= 0) lines.splice(header + 1, 0, `${replacement}\n`);
    else lines.push(`${content && !content.endsWith("\n") ? "\n" : ""}providers:\n${replacement}\n`);
  }
  return { content: lines.join(""), hadProvider: !!provider };
}
