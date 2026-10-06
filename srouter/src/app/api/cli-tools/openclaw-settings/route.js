"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { assertManagedConfig, configConflict, configErrorStatus, isManagedConfig, parseEditableJSONC, readEditableConfig } from "../_shared/managedConfig";

const execAsync = promisify(exec);

// OpenClaw 2026.5.x writes agents[].model as either a plain string
// (legacy) or as an object `{ primary, fallbacks }`. Normalize to the
// string id so downstream consumers can call `.startsWith()` safely.
const resolveAgentModel = (m) => {
  if (typeof m === "string") return m;
  if (m && typeof m === "object" && typeof m.primary === "string") return m.primary;
  return "";
};

const getOpenClawDir = () => path.join(os.homedir(), ".openclaw");
const getOpenClawSettingsPath = () => path.join(getOpenClawDir(), "openclaw.json");

// Check if openclaw CLI is installed (via which/where or config file exists)
const checkOpenClawInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where openclaw" : "which openclaw";
    // On Windows, inject %APPDATA%\npm into PATH so npm global packages are found
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getOpenClawSettingsPath());
      return true;
    } catch {
      return false;
    }
  }
};

// Read current settings.json
const readSettings = async () => {
  try {
    return await readEditableConfig(getOpenClawSettingsPath(), parseEditableJSONC);
  } catch (error) {
    return null;
  }
};

// Check if settings has Srouter config
const hasSrouterConfig = (settings) => {
  if (!settings || !settings.models || !settings.models.providers) return false;
  return !!settings.models.providers.srouter && isManagedConfig(settings.models.providers.srouter);
};

const assertObject = value => {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw configConflict();
};
const assertModel = model => {
  if (model === undefined || typeof model === "string") return;
  assertObject(model);
  if ((model.primary !== undefined && typeof model.primary !== "string") ||
    (model.fallbacks !== undefined && (!Array.isArray(model.fallbacks) ||
      model.fallbacks.some(value => typeof value !== "string")))) throw configConflict();
};
const editableSettings = async () => {
  const settings = await readEditableConfig(getOpenClawSettingsPath(), parseEditableJSONC);
  for (const value of [settings.models, settings.models?.providers, settings.models?.providers?.srouter,
    settings.agents, settings.agents?.defaults, settings.agents?.defaults?.models]) assertObject(value);
  assertModel(settings.agents?.defaults?.model);
  const agents = settings.agents?.list;
  if (agents !== undefined && (!Array.isArray(agents) || agents.some(agent => !agent ||
    typeof agent !== "object" || Array.isArray(agent) ||
    (agent.agentDir !== undefined && (typeof agent.agentDir !== "string" || !path.isAbsolute(agent.agentDir)))))) throw configConflict();
  for (const agent of agents || []) assertModel(agent.model);
  assertManagedConfig(settings.models?.providers?.srouter);
  return settings;
};
const editableAgentModels = async agentDir => {
  const file = path.join(agentDir, "models.json");
  const config = await readEditableConfig(file, parseEditableJSONC);
  assertObject(config.providers);
  assertObject(config.providers?.srouter);
  assertManagedConfig(config.providers?.srouter);
  return { file, config };
};

// Read per-agent models.json and return current model id (without "srouter/" prefix)
const readAgentModel = async (agentDir) => {
  try {
    const modelsPath = path.join(agentDir, "models.json");
    const content = await fs.readFile(modelsPath, "utf-8");
    const data = JSON.parse(content);
    const models = data?.providers?.["srouter"]?.models;
    return models?.[0]?.id || null;
  } catch {
    return null;
  }
};

// GET - Check openclaw CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkOpenClawInstalled();
    
    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Open Claw CLI is not installed",
      });
    }

    const settings = await readSettings();

    // Enrich agents list with current per-agent model from models.json.
    // Coerce agent.model to its string id when OpenClaw stores it as
    // `{ primary, fallbacks }` so downstream `.startsWith()` calls work.
    const agentList = settings?.agents?.list || [];
    const enrichedAgents = await Promise.all(
      agentList.map(async (agent) => {
        const agentModel = agent.agentDir ? await readAgentModel(agent.agentDir) : null;
        return { ...agent, model: resolveAgentModel(agent.model), currentModel: agentModel };
      })
    );

    return NextResponse.json({
      installed: true,
      settings,
      agents: enrichedAgents,
      hasSrouter: hasSrouterConfig(settings),
      settingsPath: getOpenClawSettingsPath(),
    });
  } catch (error) {
    console.log("Error checking openclaw settings:", error);
    return NextResponse.json({ error: "Failed to check openclaw settings" }, { status: 500 });
  }
}

// POST - Update Srouter settings (merge with existing settings)
export async function POST(request) {
  try {
    // agentModels: { [agentId]: modelId } for per-agent override
    const { baseUrl, apiKey, model, agentModels = {} } = await request.json();
    
    if (!baseUrl || !model) {
      return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
    }
    if (typeof baseUrl !== "string" || typeof model !== "string" || !agentModels ||
      typeof agentModels !== "object" || Array.isArray(agentModels) ||
      Object.values(agentModels).some(value => typeof value !== "string")) {
      return NextResponse.json({ error: "Invalid OpenClaw settings" }, { status: 400 });
    }

    const openclawDir = getOpenClawDir();
    const settingsPath = getOpenClawSettingsPath();

    const settings = await editableSettings();
    // Read and validate every agent file before the first write.
    const agentFiles = await Promise.all((settings.agents?.list || []).filter(agent => agent.agentDir)
      .map(async agent => ({ ...await editableAgentModels(agent.agentDir), model: agentModels[agent.id] || model })));

    if (!settings.agents) settings.agents = {};
    if (!settings.agents.defaults) settings.agents.defaults = {};
    if (typeof settings.agents.defaults.model === "string") {
      settings.agents.defaults.model = { primary: settings.agents.defaults.model };
    } else if (!settings.agents.defaults.model) settings.agents.defaults.model = {};
    if (!settings.agents.defaults.models) settings.agents.defaults.models = {};
    if (!settings.models) settings.models = {};
    if (!settings.models.providers) settings.models.providers = {};

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const fullModelId = `srouter/${model}`;

    // Remove all old srouter/* entries from agents.defaults.models
    Object.keys(settings.agents.defaults.models)
      .filter((k) => k.startsWith("srouter/"))
      .forEach((k) => { delete settings.agents.defaults.models[k]; });

    // Update default model
    settings.agents.defaults.model.primary = fullModelId;

    // Collect all unique models (default + per-agent)
    const allModelIds = new Set([model]);
    Object.values(agentModels).forEach((m) => { if (m) allModelIds.add(m); });

    // Add fresh srouter models to allowlist
    allModelIds.forEach((m) => {
      settings.agents.defaults.models[`srouter/${m}`] = {};
    });

    // Remove old srouter model from each agent in agents.list. The
    // model field may be a plain string or `{ primary, fallbacks }`.
    if (settings.agents.list) {
      settings.agents.list = settings.agents.list.map((agent) => {
        if (resolveAgentModel(agent.model).startsWith("srouter/")) {
          if (typeof agent.model === "object") {
            const { primary: _, ...rest } = agent.model;
            return { ...agent, model: rest };
          }
          const { model: _, ...rest } = agent;
          return rest;
        }
        return agent;
      });
    }

    // Update models.providers.srouter with all models
    settings.models.providers["srouter"] = {
      baseUrl: normalizedBaseUrl,
      apiKey: apiKey || "your_api_key",
      api: "openai-completions",
      models: [...allModelIds].map((m) => ({ id: m, name: m.split("/").pop() || m })),
    };

    // Set per-agent model in agents.list and write models.json
    if (settings.agents.list) {
      settings.agents.list = settings.agents.list.map((agent) => {
        const agentModel = agentModels[agent.id];
        if (agentModel) return { ...agent, model: typeof agent.model === "object"
          ? { ...agent.model, primary: `srouter/${agentModel}` } : `srouter/${agentModel}` };
        return agent;
      });

    }

    for (const entry of agentFiles) {
      entry.config.providers ||= {};
      entry.config.providers.srouter = {
        baseUrl: normalizedBaseUrl, apiKey: apiKey || "your_api_key", api: "openai-completions",
        models: [{ id: entry.model, name: entry.model.split("/").pop() || entry.model }],
      };
    }
    await fs.mkdir(openclawDir, { recursive: true });
    for (const entry of agentFiles) {
      await fs.mkdir(path.dirname(entry.file), { recursive: true });
      await fs.writeFile(entry.file, JSON.stringify(entry.config, null, 2));
    }
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));

    return NextResponse.json({
      success: true,
      message: "Open Claw settings applied successfully!",
      settingsPath,
    });
  } catch (error) {
    console.log("Error updating openclaw settings:", error);
    return NextResponse.json({ error: "Failed to update openclaw settings" }, { status: configErrorStatus(error) });
  }
}

// DELETE - Remove Srouter settings only (keep other settings)
export async function DELETE() {
  try {
    const settingsPath = getOpenClawSettingsPath();

    // Read existing settings
    const settings = await editableSettings();
    if (!hasSrouterConfig(settings)) return NextResponse.json({ success: true, skipped: true });
    const agentFiles = await Promise.all((settings.agents?.list || []).filter(agent => agent.agentDir)
      .map(agent => editableAgentModels(agent.agentDir)));

    // Remove Srouter from models.providers
    if (settings.models && settings.models.providers) {
      delete settings.models.providers["srouter"];
      
      // Remove providers object if empty
      if (Object.keys(settings.models.providers).length === 0) {
        delete settings.models.providers;
      }
    }

    // Remove srouter models from agents.defaults.models allowlist
    if (settings.agents?.defaults?.models) {
      const keysToRemove = Object.keys(settings.agents.defaults.models).filter((k) => k.startsWith("srouter/"));
      for (const key of keysToRemove) {
        delete settings.agents.defaults.models[key];
      }
      if (Object.keys(settings.agents.defaults.models).length === 0) {
        delete settings.agents.defaults.models;
      }
    }

    // Reset agents.defaults.model.primary if it uses srouter
    if (typeof settings.agents?.defaults?.model === "string" && settings.agents.defaults.model.startsWith("srouter/")) {
      delete settings.agents.defaults.model;
    } else if (settings.agents?.defaults?.model?.primary?.startsWith("srouter/")) {
      delete settings.agents.defaults.model.primary;
    }
    for (const agent of settings.agents?.list || []) {
      if (typeof agent.model === "string" && agent.model.startsWith("srouter/")) delete agent.model;
      else if (resolveAgentModel(agent.model).startsWith("srouter/")) delete agent.model.primary;
      if (Array.isArray(agent.model?.fallbacks)) agent.model.fallbacks = agent.model.fallbacks.filter(model => !model.startsWith("srouter/"));
    }
    const fallbacks = settings.agents?.defaults?.model?.fallbacks;
    if (Array.isArray(fallbacks)) settings.agents.defaults.model.fallbacks = fallbacks.filter(model => !model.startsWith("srouter/"));
    for (const entry of agentFiles) {
      if (!entry.config.providers?.srouter) continue;
      delete entry.config.providers.srouter;
      await fs.writeFile(entry.file, JSON.stringify(entry.config, null, 2));
    }

    // Write updated settings
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));

    return NextResponse.json({
      success: true,
      message: "Srouter settings removed successfully",
    });
  } catch (error) {
    console.log("Error resetting openclaw settings:", error);
    return NextResponse.json({ error: "Failed to reset openclaw settings" }, { status: configErrorStatus(error) });
  }
}
