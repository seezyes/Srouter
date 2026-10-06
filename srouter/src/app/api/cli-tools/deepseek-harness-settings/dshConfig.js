import { parseYAML } from "confbox";
import { isDeepStrictEqual } from "node:util";
import { isSrouterEndpoint } from "../_shared/managedConfig";
import { DSH_REASONING_LEVELS, FALLBACK_REASONING_LEVELS, DSH_INPUT_MODALITIES } from "./reasoningLevels.js";

export const DSH_PROVIDER_ID = "srouter";
export const DSH_KEY_REF = "SROUTER_API_KEY";
export const DSH_ENTRY_ID = "llm-pi-ai";
export const DSH_ENTRY_NAME = "@deepseek-ai/dsh-llm-pi-ai";
export const DSH_DISPLAY_NAME = "Srouter";
export const DSH_API = "openai-completions";
export const FOREIGN_PROVIDER_MESSAGE = "A different 'srouter' provider already exists in DeepSeek Harness. Rename or remove it there first.";

export function dshConfigConflict(message = "DeepSeek Harness configuration cannot be edited safely") {
  return Object.assign(new Error(message), { code: "DSH_CONFIG_CONFLICT" });
}
const mapping = value => value !== null && typeof value === "object" && !Array.isArray(value);
const matches = entry => entry?.id === DSH_ENTRY_ID || entry?.name === DSH_ENTRY_NAME;
const clone = value => JSON.parse(JSON.stringify(value));
export const isOurProvider = provider => provider?.apiKeyEnv === DSH_KEY_REF || isSrouterEndpoint(provider?.baseURL);

// A DSH profile file may legitimately carry cordis `!!js` tags, which the YAML
// parser does not know. Mask only the tag token and retry: validate() then
// compares two documents produced by the same masking, so a structural check
// still catches anything the line surgery broke.
function parseDshYaml(content) {
  try { return parseYAML(content); }
  catch (error) {
    if (!/unknown tag|unresolved tag/i.test(String(error?.message))) throw error;
    return parseYAML(content.replace(/!!js[^\s]*/g, ""));
  }
}
function parse(content, kind) {
  let result;
  try { result = parseDshYaml(content); } catch { throw dshConfigConflict(); }
  if (result == null && !content.replace(/^\s*#.*$/gm, "").trim()) result = kind === "patch" ? [] : {};
  if (kind === "patch") {
    if (!Array.isArray(result) || result.some(entry => !mapping(entry))) throw dshConfigConflict();
    findProviderEntry(result);
  } else {
    if (!mapping(result) || Object.keys(result).some(key => !["version", "refs", "records"].includes(key))
      || ("version" in result && result.version !== 1)
      || ("refs" in result && !mapping(result.refs))
      || ("records" in result && !mapping(result.records))
      || Object.values(result.refs || {}).some(value => typeof value !== "string" || !value)) throw dshConfigConflict();
  }
  return result;
}
export function findProviderEntry(parsed) {
  if (!Array.isArray(parsed)) throw dshConfigConflict();
  const entries = parsed.filter(matches);
  if (entries.length > 1) throw dshConfigConflict();
  if (!entries.length) return null;
  const entry = entries[0];
  if (("config" in entry && !mapping(entry.config))
    || (entry.config && "providers" in entry.config && !mapping(entry.config.providers))) throw dshConfigConflict();
  return { providers: entry.config?.providers || {} };
}
// Read-only lookup used by GET/DELETE so both see the same tolerant parsing.
export function providerFromPatch(content) {
  return findProviderEntry(parse(content, "patch"))?.providers.srouter;
}
function validate(content, expected, kind) {
  if (!isDeepStrictEqual(clone(parse(content, kind)), clone(expected))) throw dshConfigConflict();
  return content;
}
function scalar(value) {
  if (typeof value !== "string" || !value || /[\r\n]/.test(value)) throw dshConfigConflict();
  return /^[A-Za-z0-9][A-Za-z0-9_.\-/]*$/.test(value) && !/^(null|true|false|~|\d+)$/i.test(value)
    ? value : `'${value.replaceAll("'", "''")}'`;
}
export function normalizeModels(models) {
  if (!Array.isArray(models) || models.length < 1 || models.length > 20
    || models.some(model => typeof model !== "string" || /[\u0000-\u001f\u007f-\u009f]/.test(model)
      || !model.trim() || model.trim().length > 200)) throw new Error("Invalid models");
  return [...new Set(models.map(model => model.trim()))];
}
const modelId = model => typeof model === "string" ? model : model?.id;
const reasoningDeclaration = levels => levels === false ? false : Object.fromEntries(levels.map(level => [level, level]));
function sameLevels(declaration, levels) {
  return levels === false ? declaration === false
    : mapping(declaration) && Object.keys(declaration).length === levels.length
      && levels.every(level => Object.hasOwn(declaration, level));
}
function buildReasoningBlock(levels, indent) {
  const pad = " ".repeat(indent);
  return levels === false ? [`${pad}reasoningEfforts: false`]
    : [`${pad}reasoningEfforts:`, ...levels.map(level => `${pad}  ${level}: ${level}`)];
}
const sameInput = (declaration, input) => Array.isArray(declaration)
  && new Set(declaration).size === input.length && input.every(value => declaration.includes(value));
const buildInputLine = (input, indent = 12) => `${" ".repeat(indent)}input: [${input.join(", ")}]`;
function buildModelBlock(id, levels, input, indent = 10) {
  return [`${" ".repeat(indent)}- id: ${scalar(id)}`,
    ...(input ? [buildInputLine(input, indent + 2)] : []), ...buildReasoningBlock(levels, indent + 2)];
}
function buildProviderBlock(baseURL, models, effectiveLevels, effectiveInput, { indent = 6 } = {}) {
  const pad = " ".repeat(indent);
  return [
    `${pad}srouter:`, `${pad}  displayName: Srouter`, `${pad}  apiKeyEnv: SROUTER_API_KEY`,
    `${pad}  api: openai-completions`, `${pad}  baseURL: ${scalar(baseURL)}`, `${pad}  models:`,
    ...models.flatMap(model => buildModelBlock(model, effectiveLevels(model), effectiveInput(model), indent + 4)),
  ];
}
// Retain original line terminators, including mixed-EOL documents.
function document(content) {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) || [];
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  return { lines, eol };
}
const text = line => line.replace(/\r?\n$/, "");
const meaningful = line => text(line).trim() && !text(line).trimStart().startsWith("#");
function endBlock(lines, start, indent, limit = lines.length) {
  let end = start + 1;
  while (end < limit && (!meaningful(lines[end]) || text(lines[end]).search(/\S/) > indent)) end++;
  return end;
}
function keyLine(lines, start, end, key, indent) {
  const pattern = new RegExp(`^ {${indent}}${key}:`);
  return lines.findIndex((line, index) => index >= start && index < end && pattern.test(text(line)));
}
function erase(lines, start, end) {
  // Comments and blank lines are not owned by the removed key.
  lines.splice(start, end - start, ...lines.slice(start, end).filter(line => !meaningful(line)));
}
function insert(lines, index, values, eol) {
  if (index && !lines[index - 1].endsWith("\n")) lines[index - 1] += eol;
  lines.splice(index, 0, ...values.map(line => line + eol));
}
function entryRange(lines, parsed) {
  const starts = lines.flatMap((line, i) => /^- /.test(line) ? [i] : []);
  if (starts.length !== parsed.length) throw dshConfigConflict();
  const index = parsed.findIndex(matches);
  return index < 0 ? null : { start: starts[index], end: starts[index + 1] ?? lines.length, index };
}
function syncModelInput(group, model, input, eol) {
  if (!input) return group;
  const index = keyLine(group, 1, group.length, "input", 12);
  const declared = Object.hasOwn(model, "input");
  if (!declared) {
    if (index >= 0) throw dshConfigConflict();
    const upgraded = [...group];
    insert(upgraded, 1, [buildInputLine(input)], eol);
    return upgraded;
  }
  if (index < 0 || !Array.isArray(model.input)
    || model.input.some(value => typeof value !== "string")) throw dshConfigConflict();
  const header = text(group[index]);
  const flow = /^ {12}input:\s*\[.*\]\s*(?:#.*)?$/.test(header);
  const block = /^ {12}input:\s*(?:#.*)?$/.test(header);
  if (!flow && !block) throw dshConfigConflict();
  let end = endBlock(group, index, 12);
  if (block) {
    // YAML also permits an indentless sequence aligned with its parent key.
    end = index + 1;
    while (end < group.length && (!meaningful(group[end])
      || text(group[end]).search(/\S/) > 12 || /^ {12}- /.test(text(group[end])))) end++;
    if (group.slice(index + 1, end).filter(meaningful)
      .some(line => !/^ {12}(?:  )?- \S.*$/.test(text(line)))) throw dshConfigConflict();
  } else if (group.slice(index + 1, end).some(meaningful)) throw dshConfigConflict();
  if (sameInput(model.input, input)) return group;
  const terminator = group[index].endsWith("\r\n") ? "\r\n" : group[index].endsWith("\n") ? "\n" : eol;
  const comment = /\s+#.*$/.exec(header)?.[0] || "";
  const replacement = [buildInputLine(input) + comment + terminator,
    ...group.slice(index + 1, end).filter(line => !meaningful(line))];
  if (end === group.length && !group.at(-1).endsWith("\n")) replacement[replacement.length - 1] = text(replacement.at(-1));
  const upgraded = [...group];
  upgraded.splice(index, end - index, ...replacement);
  return upgraded;
}
export function applySrouterProvider(content, { baseURL, models, modelLevels = {}, modelInput = {} }) {
  models = normalizeModels(models);
  const effectiveLevels = id => {
    const levels = modelLevels?.[id];
    if (levels === false) return false;
    const supported = Array.isArray(levels) ? DSH_REASONING_LEVELS.filter(level => levels.includes(level)) : [];
    return supported.length ? supported : FALLBACK_REASONING_LEVELS;
  };
  const effectiveInput = id => Object.hasOwn(modelInput || {}, id) && Array.isArray(modelInput[id])
    ? DSH_INPUT_MODALITIES.filter(value => modelInput[id].includes(value)) : undefined;
  const parsed = parse(content, "patch");
  const found = findProviderEntry(parsed);
  if (found && Object.hasOwn(found.providers, "srouter") && found.providers.srouter !== null && !isOurProvider(found.providers.srouter)) throw dshConfigConflict(FOREIGN_PROVIDER_MESSAGE);
  const expected = clone(parsed);
  const { lines, eol } = document(content);
  const range = entryRange(lines, parsed);
  const fields = { displayName: DSH_DISPLAY_NAME, apiKeyEnv: DSH_KEY_REF,
    ...(!Object.hasOwn(found?.providers.srouter || {}, "api") ? { api: DSH_API } : {}), baseURL };
  const oldModels = found?.providers.srouter?.models ?? [];
  if (!Array.isArray(oldModels)) throw dshConfigConflict();
  const selectedModels = models.map(id => {
    const model = oldModels.find(model => modelId(model) === id);
    if (model !== undefined && !mapping(model)) throw dshConfigConflict();
    const levels = effectiveLevels(id);
    const selected = model && Object.hasOwn(model, "reasoningEfforts") && sameLevels(model.reasoningEfforts, levels)
      ? model : { ...(model || { id }), reasoningEfforts: reasoningDeclaration(levels) };
    const input = effectiveInput(id);
    return input && !sameInput(model?.input, input) ? { ...selected, input } : selected;
  });
  const provider = { ...fields, models: selectedModels };
  if (!range) {
    expected.push({ id: DSH_ENTRY_ID, name: DSH_ENTRY_NAME, config: { providers: { srouter: provider } } });
    // Replace the empty-array marker, retaining its surrounding comments.
    if (!parsed.length) {
      for (let index = lines.length - 1; index >= 0; index--) {
        const empty = /^(\s*)\[\](\s*)(#.*)?$/.exec(text(lines[index]));
        if (empty) {
          if (empty[3]) lines[index] = empty[1] + empty[3] + (lines[index].endsWith("\n") ? eol : "");
          else lines.splice(index, 1);
        }
      }
    }
    insert(lines, lines.length, ["- id: llm-pi-ai", `  name: "${DSH_ENTRY_NAME}"`, "  config:", "    providers:", ...buildProviderBlock(baseURL, models, effectiveLevels, effectiveInput)], eol);
  } else {
    const entry = expected[range.index];
    entry.config ||= {};
    entry.config.providers ||= {};
    entry.config.providers.srouter = found.providers.srouter == null ? provider : { ...entry.config.providers.srouter, ...fields, models: selectedModels };
    let config = keyLine(lines, range.start, range.end, "config", 2);
    if (config < 0) insert(lines, range.end, ["  config:", "    providers:", ...buildProviderBlock(baseURL, models, effectiveLevels, effectiveInput)], eol);
    else {
      const providers = keyLine(lines, config + 1, endBlock(lines, config, 2, range.end), "providers", 4);
      if (providers < 0) {
        if (!Object.keys(parsed[range.index].config).length) lines[config] = "  config:" + eol;
        insert(lines, endBlock(lines, config, 2, range.end), ["    providers:", ...buildProviderBlock(baseURL, models, effectiveLevels, effectiveInput)], eol);
      } else {
        const end = endBlock(lines, providers, 4, range.end);
        const own = keyLine(lines, providers + 1, end, "srouter", 6);
        if (own >= 0) {
          if (!/^ {6}srouter:\s*(?:#.*)?$/.test(text(lines[own]))) throw dshConfigConflict();
          const stop = endBlock(lines, own, 6, end);
          if (found.providers.srouter === null) {
            insert(lines, own + 1, buildProviderBlock(baseURL, models, effectiveLevels, effectiveInput).slice(1), eol);
          } else {
            // Keep Harness metadata on selected entries and all unrelated keys.
            let insertion = own + 1;
            const missing = [];
            for (const [key, value] of Object.entries(fields)) {
              const index = keyLine(lines, own + 1, stop, key, 8);
              const rendered = `${key}: ${scalar(value)}`;
              if (index < 0) missing.push(`        ${rendered}`);
              else {
                insertion = Math.max(insertion, index + 1);
                const leading = /^\s*/.exec(text(lines[index]))[0];
                if (text(lines[index]) !== leading + rendered) {
                  const terminator = lines[index].endsWith("\r\n") ? "\r\n" : lines[index].endsWith("\n") ? "\n" : "";
                  lines[index] = leading + rendered + terminator;
                }
              }
            }
            const modelLine = keyLine(lines, own + 1, stop, "models", 8);
            if (modelLine < 0) {
              missing.push("        models:", ...models.flatMap(id => buildModelBlock(id, effectiveLevels(id), effectiveInput(id))));
            } else {
              const header = /^ {8}models:\s*(?:\[\]\s*)?(#.*)?$/.exec(text(lines[modelLine]));
              if (!header) throw dshConfigConflict();
              const modelEnd = endBlock(lines, modelLine, 8, stop);
              const starts = [];
              for (let index = modelLine + 1; index < modelEnd; index++) {
                if (/^ {10}- /.test(text(lines[index]))) starts.push(index);
              }
              if (starts.length !== oldModels.length) throw dshConfigConflict();
              const groups = starts.map((start, index) => lines.slice(start, starts[index + 1] ?? modelEnd));
              const blockHeader = /^ {8}models:\s*(?:#.*)?$/.test(text(lines[modelLine]));
              const replacement = [
                blockHeader ? lines[modelLine] : `        models:${header[1] ? " " + header[1] : ""}${eol}`,
                ...lines.slice(modelLine + 1, starts[0] ?? modelEnd),
                ...models.flatMap(id => {
                  const index = oldModels.findIndex(model => modelId(model) === id);
                  const levels = effectiveLevels(id);
                  if (index < 0) return buildModelBlock(id, levels, effectiveInput(id)).map(line => line + eol);
                  const original = groups[index];
                  const group = syncModelInput(original, oldModels[index], effectiveInput(id), eol);
                  if (!/^ {10}- id:\s+\S/.test(text(group[0]))) throw dshConfigConflict();
                  const upgraded = [...group];
                  const reasoningLine = keyLine(group, 1, group.length, "reasoningEfforts", 12);
                  if (Object.hasOwn(oldModels[index], "reasoningEfforts")) {
                    if (reasoningLine < 0) throw dshConfigConflict();
                    if (sameLevels(oldModels[index].reasoningEfforts, levels)) return group;
                    const reasoningEnd = endBlock(group, reasoningLine, 12);
                    // Retain standalone comments and blanks around the replaced declaration.
                    const comments = group.slice(reasoningLine + 1, reasoningEnd).filter(line => !meaningful(line));
                    const terminator = group[reasoningLine].endsWith("\r\n") ? "\r\n"
                      : group[reasoningLine].endsWith("\n") ? "\n" : eol;
                    const replacement = buildReasoningBlock(levels, 12).map(line => line + terminator);
                    const comment = /\s+#.*$/.exec(text(group[reasoningLine]));
                    if (comment) replacement[0] = text(replacement[0]) + comment[0] + terminator;
                    replacement.push(...comments);
                    if (reasoningEnd === group.length && !group.at(-1).endsWith("\n")) {
                      replacement[replacement.length - 1] = text(replacement.at(-1));
                    }
                    upgraded.splice(reasoningLine, reasoningEnd - reasoningLine, ...replacement);
                  } else {
                    if (reasoningLine >= 0 || group.some(line => /^ {12}(?:'reasoningEfforts'|"reasoningEfforts"):/.test(text(line)))) throw dshConfigConflict();
                    insert(upgraded, upgraded.length, buildReasoningBlock(levels, 12), eol);
                  }
                  return upgraded;
                }),
              ];
              if (replacement.join("") !== lines.slice(modelLine, modelEnd).join("")) {
                // Add a terminator only when a previously final raw entry gains a successor.
                for (let index = 0; index < replacement.length - 1; index++) {
                  if (!replacement[index].endsWith("\n")) replacement[index] += eol;
                }
                lines.splice(modelLine, modelEnd - modelLine, ...replacement);
                if (insertion >= modelEnd) insertion += replacement.length - (modelEnd - modelLine);
              }
            }
            if (missing.length) insert(lines, insertion, missing, eol);
          }
        } else {
          if (!Object.keys(found.providers).length) lines[providers] = "    providers:" + eol;
          insert(lines, end, buildProviderBlock(baseURL, models, effectiveLevels, effectiveInput), eol);
        }
      }
    }
  }
  return validate(lines.join(""), expected, "patch");
}
export function removeSrouterProvider(content) {
  const parsed = parse(content, "patch");
  const found = findProviderEntry(parsed);
  if (!found || !Object.hasOwn(found.providers, "srouter")) return { content, removed: false };
  if (!isOurProvider(found.providers.srouter)) throw dshConfigConflict(FOREIGN_PROVIDER_MESSAGE);
  const expected = clone(parsed);
  const { lines } = document(content);
  const range = entryRange(lines, parsed);
  const entry = expected[range.index];
  delete entry.config.providers.srouter;
  const config = keyLine(lines, range.start, range.end, "config", 2);
  const providers = keyLine(lines, config + 1, range.end, "providers", 4);
  const own = keyLine(lines, providers + 1, range.end, "srouter", 6);
  if (config < 0 || providers < 0 || own < 0) throw dshConfigConflict();
  let start = own, end = endBlock(lines, own, 6, range.end);
  if (!Object.keys(entry.config.providers).length) {
    delete entry.config.providers;
    start = providers; end = endBlock(lines, providers, 4, range.end);
    if (!Object.keys(entry.config).length) {
      expected.splice(range.index, 1);
      start = range.start; end = range.end;
    }
  }
  erase(lines, start, end);
  if (!expected.length) insert(lines, lines.length, ["[]"], content.includes("\r\n") ? "\r\n" : "\n");
  return { content: validate(lines.join(""), expected, "patch"), removed: true };
}
function editRef(content, ref, value, remove) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(ref)) throw dshConfigConflict();
  const expected = clone(parse(content, "credentials"));
  const { lines, eol } = document(content);
  if (remove && !Object.hasOwn(expected.refs || {}, ref)) return content;
  const rendered = remove ? null : scalar(value);
  let refs = keyLine(lines, 0, lines.length, "refs", 0);
  if (remove) delete expected.refs[ref];
  else {
    expected.version ??= 1;
    expected.refs ||= {};
    expected.refs[ref] = value;
    if (keyLine(lines, 0, lines.length, "version", 0) < 0) insert(lines, lines.length, ["version: 1"], eol);
  }
  refs = keyLine(lines, 0, lines.length, "refs", 0);
  if (refs < 0) insert(lines, lines.length, ["refs:", `  ${ref}: ${rendered}`], eol);
  else {
    const end = endBlock(lines, refs, 0);
    const own = keyLine(lines, refs + 1, end, ref, 2);
    if (remove) {
      if (own < 0) throw dshConfigConflict();
      erase(lines, own, endBlock(lines, own, 2, end));
      if (!Object.keys(expected.refs).length) lines[refs] = "refs: {}" + eol;
    } else if (own >= 0) {
      erase(lines, own, endBlock(lines, own, 2, end));
      insert(lines, own, [`  ${ref}: ${rendered}`], eol);
    } else {
      if (Object.keys(expected.refs).length === 1) lines[refs] = "refs:" + eol;
      let insertion = end;
      while (insertion > refs + 1 && !meaningful(lines[insertion - 1])) insertion--;
      insert(lines, insertion, [`  ${ref}: ${rendered}`], eol);
    }
  }
  return validate(lines.join(""), expected, "credentials");
}
export const setCredentialRef = (content, ref, value) => editRef(content, ref, value, false);
export const removeCredentialRef = (content, ref) => editRef(content, ref, undefined, true);
