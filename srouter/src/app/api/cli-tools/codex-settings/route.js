import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { parseTOML, stringifyTOML } from "confbox";
import { readEditableConfig, assertManagedConfig, configConflict, configErrorStatus } from "../_shared/managedConfig.js";

export const dynamic = "force-dynamic";

const execAsync = promisify(exec);

const getCodexDir = () => path.join(os.homedir(), ".codex");
const getCodexConfigPath = () => path.join(getCodexDir(), "config.toml");
const getOwnershipPath = () => path.join(getCodexDir(), ".srouter-dashboard.json");
const ownedPaths = ["model", "model_provider", "model_providers.srouter", "agents.default_subagent_model"];
let mutation = Promise.resolve();
async function serializeMutation(work) {
  const previous = mutation;
  let release;
  mutation = new Promise(resolve => { release = resolve; });
  await previous;
  try { return await work(); } finally { release(); }
}
async function assertRegularPath(file) {
  let cursor = file;
  for (;;) {
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink() || (cursor === file && !stat.isFile())) throw configConflict();
    } catch (error) { if (error.code !== "ENOENT") throw configConflict(); }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
const getField = (config, key) => key.split(".").reduce((value, part) => value?.[part], config);
const captureField = (config, key) => {
  const value = getField(config, key);
  return value === undefined ? { present: false } : { present: true, value };
};
async function readOwnership() {
  await assertRegularPath(getOwnershipPath());
  let record;
  try { record = JSON.parse(await fs.readFile(getOwnershipPath(), "utf8")); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw configConflict();
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) throw configConflict();
  if (record.version !== 1 || record.managedBy !== "srouter" || !record.fields ||
      Object.keys(record.fields).length !== ownedPaths.length ||
      ownedPaths.some(key => ["before", "after"].some(side => {
        const field = record.fields[key]?.[side];
        return !field || typeof field.present !== "boolean" ||
          (field.present && !Object.hasOwn(field, "value"));
      }))) throw configConflict();
  return record;
}
function assertUnchangedOwned(config, record) {
  for (const key of ownedPaths) {
    if (JSON.stringify(captureField(config, key)) !== JSON.stringify(record.fields[key].after)) throw configConflict("Srouter fields changed outside this editor");
  }
}

// Flatten confbox-parsed TOML into a writable object, preserving nested tables
const parsedToWritable = (obj) => obj ?? {};

// Set a nested key from a flat dotted path, creating intermediate objects as needed
const setNestedSection = (obj, dottedKey, value) => {
  const keys = dottedKey.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== "object") {
      cur[keys[i]] = {};
    }
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
};

// Delete a nested key from a flat dotted path
const deleteNestedSection = (obj, dottedKey) => {
  const keys = dottedKey.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    cur = cur?.[keys[i]];
    if (cur == null) return;
  }
  delete cur[keys[keys.length - 1]];
};

// Check if codex CLI is installed (via which/where or config file exists)
const checkCodexInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where codex" : "which codex";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getCodexConfigPath());
      return true;
    } catch {
      return false;
    }
  }
};

// Read current config.toml
const readConfig = async () => {
  try {
    const configPath = getCodexConfigPath();
    const content = await fs.readFile(configPath, "utf-8");
    return content;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

// Check if config has Srouter settings
const hasSrouterConfig = (config) => {
  if (!config) return false;
  return config.includes("model_provider = \"srouter\"") || config.includes("[model_providers.srouter]");
};

// GET - Check codex CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkCodexInstalled();
    
    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        config: null,
        message: "Codex CLI is not installed",
      });
    }

    const config = await readConfig();

    return NextResponse.json({
      installed: true,
      config,
      hasSrouter: hasSrouterConfig(config),
      configPath: getCodexConfigPath(),
    });
  } catch (error) {
    console.log("Error checking codex settings:", error);
    return NextResponse.json({ error: "Failed to check codex settings" }, { status: 500 });
  }
}

// POST - Update Srouter settings (merge with existing config)
export async function POST(request) {
  return serializeMutation(async () => {
  try {
    const { baseUrl, apiKey, model, subagentModel } = await request.json();
    
    if (!baseUrl || !apiKey || !model) {
      return NextResponse.json({ error: "baseUrl, apiKey and model are required" }, { status: 400 });
    }

    const codexDir = getCodexDir();
    const configPath = getCodexConfigPath();

    await assertRegularPath(configPath);
    const parsed = parsedToWritable(await readEditableConfig(configPath, parseTOML));
    for (const key of ["agents", "model_providers"]) {
      if (parsed[key] !== undefined && (!parsed[key] || typeof parsed[key] !== "object" || Array.isArray(parsed[key]))) throw configConflict();
    }
    const prior = await readOwnership();
    if (prior) assertUnchangedOwned(parsed, prior);
    const provider = parsed.model_providers?.srouter;
    if (provider && !prior) assertManagedConfig(provider, provider.base_url);
    const fields = Object.fromEntries(ownedPaths.map(key => [key, {
      before: prior?.fields[key]?.before || captureField(parsed, key),
    }]));
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      return NextResponse.json({ error: "Invalid base URL" }, { status: 400 });
    }

    // Update only Srouter related fields (api_key goes to auth.json, not config.toml)
    parsed.model = model;
    parsed.model_provider = "srouter";

    // Update or create srouter provider section (no api_key - Codex reads from auth.json)
    // Ensure /v1 suffix is added only once
    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    // Custom providers ignore auth.json - the key must travel as a static header
    setNestedSection(parsed, "model_providers.srouter", {
      name: "Srouter",
      base_url: normalizedBaseUrl,
      wire_api: "responses",
      http_headers: { Authorization: `Bearer ${apiKey}` },
    });

    // Subagent model is a scalar under [agents]; agents.<role> now means a custom role
    setNestedSection(parsed, "agents.default_subagent_model", subagentModel || model);

    for (const key of ownedPaths) fields[key].after = captureField(parsed, key);
    // All parsing/ownership checks precede any config write.
    await fs.mkdir(codexDir, { recursive: true });
    const backup = `${configPath}.bak-srouter`;
    await assertRegularPath(backup);
    try { await fs.copyFile(configPath, backup, 1); } catch (error) {
      if (!["ENOENT", "EEXIST"].includes(error.code)) throw error;
    }
    const configContent = stringifyTOML(parsed);
    await fs.writeFile(getOwnershipPath(), JSON.stringify({ version: 1, managedBy: "srouter", fields }), { mode: 0o600 });
    await fs.writeFile(configPath, configContent, { mode: 0o600 });

    return NextResponse.json({
      success: true,
      message: "Codex settings applied successfully!",
      configPath,
    });
  } catch (error) {
    console.log("Error updating codex settings:", error);
    return NextResponse.json({ error: "Cannot safely update codex settings" }, { status: configErrorStatus(error) });
  }
  });
}

// DELETE - Remove Srouter settings only (keep other settings)
export async function DELETE() {
  return serializeMutation(async () => {
  try {
    const configPath = getCodexConfigPath();

    // Read and parse existing config
    await assertRegularPath(configPath);
    let parsed = {};
    try {
      const existingConfig = await fs.readFile(configPath, "utf-8");
      try { parsed = parsedToWritable(parseTOML(existingConfig)); } catch { throw configConflict(); }
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({
          success: true,
          message: "No config file to reset",
        });
      }
      throw error;
    }

    const record = await readOwnership();
    if (record) {
      assertUnchangedOwned(parsed, record);
      for (const key of ownedPaths) {
        const before = record.fields[key].before;
        if (before.present) setNestedSection(parsed, key, before.value);
        else deleteNestedSection(parsed, key);
      }
    } else {
      // Legacy configs have no field ledger. Only the demonstrably managed
      // provider and its active model selector are removable, never auth/agents.
      const provider = parsed.model_providers?.srouter;
      if (provider) assertManagedConfig(provider, provider.base_url);
      if (provider && parsed.model_provider === "srouter") {
        delete parsed.model;
        delete parsed.model_provider;
      }
      if (provider) deleteNestedSection(parsed, "model_providers.srouter");
    }

    // Write updated config
    const configContent = stringifyTOML(parsed);
    await fs.writeFile(configPath, configContent, { mode: 0o600 });
    if (record) await fs.unlink(getOwnershipPath());

    return NextResponse.json({
      success: true,
      message: "Srouter settings removed successfully",
    });
  } catch (error) {
    console.log("Error resetting codex settings:", error);
    return NextResponse.json({ error: "Cannot safely reset codex settings" }, { status: error.code === "CLI_CONFIG_CONFLICT" || error instanceof SyntaxError ? 409 : 500 });
  }
  });
}
