"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { isSrouterEndpoint, readEditableConfig, parseEditableJSONC, configErrorStatus } from "../_shared/managedConfig";

const execAsync = promisify(exec);

const getDataDir = () => path.join(os.homedir(), ".cline", "data");
const getGlobalStatePath = () => path.join(getDataDir(), "globalState.json");
const getSecretsPath = () => path.join(getDataDir(), "secrets.json");

const checkInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where cline" : "which cline";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getGlobalStatePath());
      return true;
    } catch {
      return false;
    }
  }
};

const readJson = async (filePath) => {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    // Tolerate JSONC (trailing commas) and treat unparseable files as "no config"
    // rather than throwing a 500 that the UI misreads as "tool not installed".
    const stripped = content.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch (error) {
    return null;
  }
};

const hasSrouterConfig = (globalState) => {
  if (!globalState) return false;
  const isOpenAi =
    globalState.actModeApiProvider === "openai" || globalState.planModeApiProvider === "openai";
  const baseUrl = globalState.openAiBaseUrl || "";
  return isOpenAi && isSrouterEndpoint(baseUrl);
};

export async function GET() {
  try {
    const installed = await checkInstalled();
    if (!installed) {
      return NextResponse.json({ installed: false, settings: null, message: "Cline CLI is not installed" });
    }
    const globalState = await readJson(getGlobalStatePath());
    return NextResponse.json({
      installed: true,
      settings: {
        actModeApiProvider: globalState?.actModeApiProvider,
        planModeApiProvider: globalState?.planModeApiProvider,
        openAiBaseUrl: globalState?.openAiBaseUrl,
        openAiModelId: globalState?.openAiModelId,
      },
      hasSrouter: hasSrouterConfig(globalState),
      globalStatePath: getGlobalStatePath(),
    });
  } catch (error) {
    console.log("Error checking cline settings:", error);
    return NextResponse.json({ error: "Failed to check cline settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, model } = await request.json();
    if (!baseUrl || !apiKey || !model) {
      return NextResponse.json({ error: "baseUrl, apiKey and model are required" }, { status: 400 });
    }

    await fs.mkdir(getDataDir(), { recursive: true });

    // Cline expects base WITHOUT /v1
    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;

    const globalState = await readEditableConfig(getGlobalStatePath(), parseEditableJSONC);
    const secrets = await readEditableConfig(getSecretsPath(), parseEditableJSONC);

    // Isolation guard: never silently overwrite another router's Cline config.
    const existingBase = globalState.openAiBaseUrl || "";
    if (existingBase && !isSrouterEndpoint(existingBase)) {
      return NextResponse.json(
        { error: "Cline points to another router. Remove its settings before applying Srouter." },
        { status: 409 }
      );
    }

    globalState.actModeApiProvider = "openai";
    globalState.planModeApiProvider = "openai";
    globalState.openAiBaseUrl = normalizedBaseUrl;
    globalState.openAiModelId = model;
    globalState.planModeOpenAiModelId = model;
    await fs.writeFile(getGlobalStatePath(), JSON.stringify(globalState, null, 2));

    secrets.openAiApiKey = apiKey;
    await fs.writeFile(getSecretsPath(), JSON.stringify(secrets, null, 2));

    return NextResponse.json({ success: true, message: "Cline settings applied successfully!", globalStatePath: getGlobalStatePath() });
  } catch (error) {
    console.log("Error updating cline settings:", error);
    return NextResponse.json({ error: "Failed to update cline settings" }, { status: configErrorStatus(error) });
  }
}

export async function DELETE() {
  try {
    const globalState = await readEditableConfig(getGlobalStatePath(), parseEditableJSONC);
    if (Object.keys(globalState).length === 0) {
      return NextResponse.json({ success: true, message: "No settings file to reset" });
    }

    // Only reset if the current config is OURS. A base URL pointing at
    // Unrecognized endpoints belong to another install, leave them alone.
    const base = globalState.openAiBaseUrl || "";
    if (!isSrouterEndpoint(base)) {
      return NextResponse.json({
        success: true,
        message: "Skipped reset — Cline is not configured for a recognized Srouter endpoint.",
        skipped: true,
      });
    }

    const secrets = await readEditableConfig(getSecretsPath(), parseEditableJSONC);
    delete globalState.openAiBaseUrl;
    delete globalState.openAiModelId;
    delete globalState.planModeOpenAiModelId;
    if (globalState.actModeApiProvider === "openai") globalState.actModeApiProvider = "cline";
    if (globalState.planModeApiProvider === "openai") globalState.planModeApiProvider = "cline";
    await fs.writeFile(getGlobalStatePath(), JSON.stringify(globalState, null, 2));

    delete secrets.openAiApiKey;
    await fs.writeFile(getSecretsPath(), JSON.stringify(secrets, null, 2));

    return NextResponse.json({ success: true, message: "Srouter settings removed from Cline" });
  } catch (error) {
    console.log("Error resetting cline settings:", error);
    return NextResponse.json({ error: "Failed to reset cline settings" }, { status: configErrorStatus(error) });
  }
}
