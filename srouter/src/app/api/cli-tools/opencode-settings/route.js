"use server";

import { NextResponse } from "next/server";
import { resolveCliApiKey } from "../resolveApiKey.js";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { assertManagedConfig, configConflict, configErrorStatus, isManagedConfig, isSrouterEndpoint, parseEditableJSONC, readEditableConfig } from "../_shared/managedConfig";

const execAsync = promisify(exec);

const getConfigDir = () => path.join(os.homedir(), ".config", "opencode");
const getConfigPath = () => path.join(getConfigDir(), "opencode.json");

// Check if opencode CLI is installed (via which/where or config file exists)
const checkOpenCodeInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where opencode" : "which opencode";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getConfigPath());
      return true;
    } catch {
      return false;
    }
  }
};

const readConfig = async () => {
  try {
    return await readEditableConfig(getConfigPath(), parseEditableJSONC);
  } catch {
    return null;
  }
};

// Builds before the fork rename wrote the provider under the sibling-looking
// "9router" key. Only an entry that points at a recognized Srouter endpoint is
// ours; 20128 (the real sibling) never qualifies and is left untouched.
const legacyProvider = (config) => {
  const provider = config?.provider?.["9router"];
  if (!provider || !isSrouterEndpoint(provider.options?.baseURL)) return undefined;
  return provider;
};

const providerKeyOf = (config) =>
  config?.provider?.srouter ? "srouter" : legacyProvider(config) ? "9router" : null;

const hasSrouterConfig = (config) => {
  const provider = config?.provider?.srouter || legacyProvider(config);
  return !!provider && isManagedConfig(provider, provider.options?.baseURL);
};

const editableConfig = async () => {
  const config = await readEditableConfig(getConfigPath(), parseEditableJSONC);
  const legacy = legacyProvider(config);
  for (const value of [config.provider, config.agent, config.provider?.srouter,
    config.provider?.srouter?.options, config.provider?.srouter?.models,
    legacy, legacy?.options, legacy?.models]) {
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw configConflict();
  }
  const provider = config.provider?.srouter;
  assertManagedConfig(provider, provider?.options?.baseURL);
  return config;
};

// GET - Check opencode CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkOpenCodeInstalled();

    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        config: null,
        message: "OpenCode CLI is not installed",
      });
    }

    const config = await readConfig();
    const providerKey = providerKeyOf(config);
    const providerConfig = providerKey ? config.provider[providerKey] : null;
    const modelMap = providerConfig?.models || {};

    return NextResponse.json({
      installed: true,
      config,
      hasSrouter: hasSrouterConfig(config),
      configPath: getConfigPath(),
        opencode: {
          models: Object.keys(modelMap),
          activeModel: providerKey && config?.model?.startsWith(`${providerKey}/`)
            ? config.model.slice(providerKey.length + 1)
            : null,
          baseURL: providerConfig?.options?.baseURL || null,
        },
    });
  } catch (error) {
    console.log("Error checking opencode settings:", error);
    return NextResponse.json({ error: "Failed to check opencode settings" }, { status: 500 });
  }
}

// POST - Apply Srouter as openai-compatible provider (multi-model support)
export async function POST(request) {
  try {
    const { baseUrl, apiKey, model, models, activeModel, subagentModel } = await request.json();

    // Accept either `model` (string, legacy) or `models` (array of strings)
    const modelsArray = Array.isArray(models) ? models.slice() : (typeof model === "string" ? [model] : []);

    if (!baseUrl || modelsArray.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }

    const configDir = getConfigDir();
    const configPath = getConfigPath();

    const config = await editableConfig();
    const routerKey = providerKeyOf(config);
    const explorer = config.agent?.explorer;
    if (explorer && (typeof explorer !== "object" || Array.isArray(explorer) ||
      typeof explorer.model !== "string" || !explorer.model.startsWith(`${routerKey || "srouter"}/`))) throw configConflict();
    await fs.mkdir(configDir, { recursive: true });

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const keyToUse = await resolveCliApiKey(apiKey);
    const effectiveSubagentModel = subagentModel || modelsArray[0];

    // Ensure provider object
    if (!config.provider) config.provider = {};

    // Preserve any existing srouter provider entry and its models; a pre-rebrand
    // "9router" entry that points at Srouter is migrated instead of duplicated.
    const legacy = legacyProvider(config);
    const existingProvider = config.provider["srouter"] || legacy || { npm: "@ai-sdk/openai-compatible", options: {}, models: {} };

    // Merge options (overwrite baseURL/apiKey)
    existingProvider.options = {
      ...existingProvider.options,
      baseURL: normalizedBaseUrl,
      apiKey: keyToUse,
    };

    // Ensure models map exists
    existingProvider.models = existingProvider.models || {};

    // Add or update entries for all requested models
    for (const m of modelsArray) {
      if (!m || typeof m !== "string") continue;
      existingProvider.models[m] = { name: m, modalities: { input: ["text", "image"], output: ["text"] } };
    }

    // Save merged provider back and drop the migrated pre-rebrand key
    config.provider["srouter"] = existingProvider;
    if (legacy) delete config.provider["9router"];

    // Set the active model: prefer explicit activeModel, else first of modelsArray
    // If activeModel is explicitly empty string, clear the model
    if (activeModel === "") {
      config.model = "";
    } else {
      const finalActive = activeModel || modelsArray[0];
      if (finalActive) {
        config.model = `srouter/${finalActive}`;
      }
    }

    // Add subagent configuration
    if (!config.agent) config.agent = {};
    config.agent.explorer = {
      ...config.agent.explorer,
      description: "Fast explorer subagent for codebase exploration",
      mode: "subagent",
      model: `srouter/${effectiveSubagentModel}`,
    };

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: "OpenCode settings applied successfully!",
      configPath,
    });
  } catch (error) {
    console.log("Error applying opencode settings:", error);
    return NextResponse.json({ error: "Failed to apply settings" }, { status: configErrorStatus(error) });
  }
}

// PATCH - Update specific settings (e.g., clear active model)
export async function PATCH(request) {
  try {
    const { clearActiveModel } = await request.json();
    const configPath = getConfigPath();

    const config = await editableConfig();
    if (!hasSrouterConfig(config)) return NextResponse.json({ success: true, skipped: true });
    const routerKey = providerKeyOf(config);

    if (clearActiveModel === true) {
      // Clear active model but keep models in the list
      if (routerKey && config.model?.startsWith(`${routerKey}/`)) {
        config.model = "";
      }
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: "Settings updated",
    });
  } catch (error) {
    console.log("Error patching opencode settings:", error);
    return NextResponse.json({ error: "Failed to patch settings" }, { status: configErrorStatus(error) });
  }
}

// DELETE - Remove Srouter provider or specific models from config
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const modelToRemove = searchParams.get("model");
    const configPath = getConfigPath();

    const config = await editableConfig();
    if (!hasSrouterConfig(config)) return NextResponse.json({ success: true, skipped: true });
    const routerKey = providerKeyOf(config);
    const provider = config.provider[routerKey];
    if (modelToRemove && !Object.hasOwn(provider.models || {}, modelToRemove)) {
      return NextResponse.json({ success: true, skipped: true });
    }

    // If specific model provided, remove just that model
    if (modelToRemove && provider.models) {
      delete provider.models[modelToRemove];
      
      // If no models left, remove the provider
      if (Object.keys(provider.models).length === 0) {
        delete config.provider[routerKey];
        if (legacyProvider(config)) delete config.provider["9router"];
        if (config.model?.startsWith(`${routerKey}/`)) delete config.model;
      } else if (config.model === `${routerKey}/${modelToRemove}`) {
        // If removed model was active, switch to first remaining model
        const remainingModels = Object.keys(provider.models);
        config.model = `${routerKey}/${remainingModels[0]}`;
      }
    } else {
      // No specific model - remove the whole provider, including a migrated
      // pre-rebrand key when it points at Srouter
      if (config.provider) {
        delete config.provider[routerKey];
        if (legacyProvider(config)) delete config.provider["9router"];
      }
      if (config.model?.startsWith(`${routerKey}/`)) delete config.model;
    }

    // Remove subagent configuration
    if (config.agent?.explorer?.model?.startsWith(`${routerKey}/`) &&
      (!modelToRemove || !config.provider?.[routerKey] || config.agent.explorer.model === `${routerKey}/${modelToRemove}`)) {
      delete config.agent.explorer;
      // Clean up empty agent object
      if (Object.keys(config.agent).length === 0) delete config.agent;
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: modelToRemove ? `Model "${modelToRemove}" removed` : "Srouter settings removed from OpenCode",
    });
  } catch (error) {
    console.log("Error resetting opencode settings:", error);
    return NextResponse.json({ error: "Failed to reset opencode settings" }, { status: configErrorStatus(error) });
  }
}
