"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { assertManagedConfig, configConflict, configErrorStatus, isManagedConfig, parseEditableJSONC, readEditableConfig } from "../_shared/managedConfig";

const execAsync = promisify(exec);

const getDroidDir = () => path.join(os.homedir(), ".factory");
const getDroidSettingsPath = () => path.join(getDroidDir(), "settings.json");

// Check if droid CLI is installed (via which/where or config file exists)
const checkDroidInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where droid" : "which droid";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getDroidSettingsPath());
      return true;
    } catch {
      return false;
    }
  }
};

// Read current settings.json
const readSettings = async () => {
  try {
    return await readEditableConfig(getDroidSettingsPath(), parseEditableJSONC);
  } catch (error) {
    return null;
  }
};

// Check if settings has Srouter customModels
const isSrouterModelId = model => typeof model?.id === "string" && /^custom:Srouter(?:-\d+)?$/.test(model.id);
const hasSrouterConfig = settings => Array.isArray(settings?.customModels) &&
  settings.customModels.some(model => isSrouterModelId(model) && isManagedConfig(model));
const editableSettings = async () => {
  const settings = await readEditableConfig(getDroidSettingsPath(), parseEditableJSONC);
  if (settings.customModels !== undefined && (!Array.isArray(settings.customModels) ||
    settings.customModels.some(model => !model || typeof model !== "object" || Array.isArray(model)))) throw configConflict();
  for (const model of settings.customModels || []) {
    if (isSrouterModelId(model)) assertManagedConfig(model);
  }
  return settings;
};

// GET - Check droid CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkDroidInstalled();
    
    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Factory Droid CLI is not installed",
      });
    }

    const settings = await readSettings();

    return NextResponse.json({
      installed: true,
      settings,
      hasSrouter: hasSrouterConfig(settings),
      settingsPath: getDroidSettingsPath(),
    });
  } catch (error) {
    console.log("Error checking droid settings:", error);
    return NextResponse.json({ error: "Failed to check droid settings" }, { status: 500 });
  }
}

// POST - Update Srouter customModels (merge with existing settings)
// Accepts either `model` (string, legacy single-model) or `models` (array of strings, multi-model)
// Also accepts `activeModel` to set which model is active/primary
export async function POST(request) {
  try {
    const { baseUrl, apiKey, model, models, activeModel } = await request.json();
    
    // Accept either `models` (array) or `model` (string, legacy)
    const modelsArray = Array.isArray(models) ? models.slice() : (typeof model === "string" ? [model] : []);
    
    if (!baseUrl || modelsArray.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }

    const droidDir = getDroidDir();
    const settingsPath = getDroidSettingsPath();

    const settings = await editableSettings();
    await fs.mkdir(droidDir, { recursive: true });

    // Ensure customModels array exists
    if (!settings.customModels) {
      settings.customModels = [];
    }

    // Remove all existing Srouter configs
    settings.customModels = settings.customModels.filter(m => !isSrouterModelId(m));
    const managedModels = [];

    // Normalize baseUrl to ensure /v1 suffix
    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const keyToUse = apiKey || "your_api_key";

    // Determine active model: prefer explicit activeModel, else first of modelsArray
    // If activeModel is explicitly empty string, no model will be set as default
    let defaultIndex = 0;
    if (typeof activeModel === "string") {
      if (activeModel === "") {
        defaultIndex = -1; // signal: don't set a default
      } else {
        const idx = modelsArray.indexOf(activeModel);
        defaultIndex = idx >= 0 ? idx : 0;
      }
    }

    // Add entries for all requested models
    // The first one (index 0) will be the default if defaultIndex >= 0
    for (let i = 0; i < modelsArray.length; i++) {
      const m = modelsArray[i];
      if (!m || typeof m !== "string") continue;
      managedModels.push({
        model: m,
        id: `custom:Srouter-${i}`,
        index: i,
        baseUrl: normalizedBaseUrl,
        apiKey: keyToUse,
        displayName: m,
        maxOutputTokens: 131072,
        noImageSupport: false,
        provider: "openai",
      });
    }

    // Set default model if applicable
    if (defaultIndex >= 0 && managedModels[defaultIndex]) {
      // Reorder so the default comes first
      const [defaultEntry] = managedModels.splice(defaultIndex, 1);
      managedModels.unshift(defaultEntry);
    }
    // Reorder only the newly managed entries, never a foreign model at that index.
    managedModels.forEach((entry, index) => { entry.index = settings.customModels.length + index; });
    settings.customModels.push(...managedModels);

    // Write settings
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));

    return NextResponse.json({
      success: true,
      message: "Factory Droid settings applied successfully!",
      settingsPath,
    });
  } catch (error) {
    console.log("Error updating droid settings:", error);
    return NextResponse.json({ error: "Failed to update droid settings" }, { status: configErrorStatus(error) });
  }
}

// DELETE - Remove Srouter customModels only (keep other settings)
export async function DELETE() {
  try {
    const settingsPath = getDroidSettingsPath();

    // Read existing settings
    const settings = await editableSettings();
    if (!hasSrouterConfig(settings)) return NextResponse.json({ success: true, skipped: true });

    // Remove Srouter customModels
    if (settings.customModels) {
      settings.customModels = settings.customModels.filter(m => !isSrouterModelId(m));
      
      // Remove customModels array if empty
      if (settings.customModels.length === 0) {
        delete settings.customModels;
      }
    }

    // Write updated settings
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));

    return NextResponse.json({
      success: true,
      message: "Srouter settings removed successfully",
    });
  } catch (error) {
    console.log("Error resetting droid settings:", error);
    return NextResponse.json({ error: "Failed to reset droid settings" }, { status: configErrorStatus(error) });
  }
}