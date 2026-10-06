"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { isSrouterEndpoint, assertManagedConfig, readEditableConfig, parseEditableJSONC, configErrorStatus } from "../_shared/managedConfig";

const execAsync = promisify(exec);

const getDataDir = () => path.join(os.homedir(), ".local", "share", "kilo");
const getAuthPath = () => path.join(getDataDir(), "auth.json");
const getVscodeSettingsPath = () => path.join(os.homedir(), ".config", "Code", "User", "settings.json");

const checkInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where kilo" : "which kilo";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getAuthPath());
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

const hasSrouterConfig = (auth) => {
  if (!auth) return false;
  const entry = auth["openai-compatible"] || auth["srouter"];
  if (!entry) return false;
  const baseUrl = entry.baseUrl || entry.baseURL || "";
  return isSrouterEndpoint(baseUrl);
};

export async function GET() {
  try {
    const installed = await checkInstalled();
    if (!installed) {
      return NextResponse.json({ installed: false, settings: null, message: "Kilo Code CLI is not installed" });
    }
    const auth = await readJson(getAuthPath());
    return NextResponse.json({
      installed: true,
      settings: { auth: auth ? Object.keys(auth) : [] },
      hasSrouter: hasSrouterConfig(auth),
      authPath: getAuthPath(),
    });
  } catch (error) {
    console.log("Error checking kilo settings:", error);
    return NextResponse.json({ error: "Failed to check kilo settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, model } = await request.json();
    if (!baseUrl || !apiKey || !model) {
      return NextResponse.json({ error: "baseUrl, apiKey and model are required" }, { status: 400 });
    }

    await fs.mkdir(getDataDir(), { recursive: true });

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;

    const auth = await readEditableConfig(getAuthPath(), parseEditableJSONC);
    for (const id of ["openai-compatible", "srouter"]) {
      const entry = auth[id];
      assertManagedConfig(entry, entry?.baseUrl || entry?.baseURL);
    }
    const vscode = await readEditableConfig(getVscodeSettingsPath(), parseEditableJSONC);
    const customProvider = vscode["kilocode.customProvider"];
    assertManagedConfig(customProvider, customProvider?.baseURL);
    auth["openai-compatible"] = {
      type: "api-key",
      apiKey,
      baseUrl: normalizedBaseUrl,
      model,
    };
    await fs.writeFile(getAuthPath(), JSON.stringify(auth, null, 2));

    // Best-effort: update VS Code extension settings
    try {
      vscode["kilocode.customProvider"] = { name: "Srouter", baseURL: normalizedBaseUrl, apiKey };
      vscode["kilocode.defaultModel"] = model;
      await fs.writeFile(getVscodeSettingsPath(), JSON.stringify(vscode, null, 2));
    } catch { /* VS Code settings not writable */ }

    return NextResponse.json({ success: true, message: "Kilo Code settings applied successfully!", authPath: getAuthPath() });
  } catch (error) {
    console.log("Error updating kilo settings:", error);
    return NextResponse.json({ error: "Failed to update kilo settings" }, { status: configErrorStatus(error) });
  }
}

export async function DELETE() {
  try {
    const auth = await readEditableConfig(getAuthPath(), parseEditableJSONC);
    if (!auth["openai-compatible"] && !auth.srouter) {
      return NextResponse.json({ success: true, message: "No settings file to reset" });
    }
    for (const id of ["openai-compatible", "srouter"]) {
      const entry = auth[id];
      assertManagedConfig(entry, entry?.baseUrl || entry?.baseURL);
    }
    const vscode = await readEditableConfig(getVscodeSettingsPath(), parseEditableJSONC);
    const customProvider = vscode["kilocode.customProvider"];
    assertManagedConfig(customProvider, customProvider?.baseURL);
    delete auth["openai-compatible"];
    delete auth["srouter"];
    await fs.writeFile(getAuthPath(), JSON.stringify(auth, null, 2));

    try {
      if (customProvider) {
        delete vscode["kilocode.customProvider"];
        delete vscode["kilocode.defaultModel"];
        await fs.writeFile(getVscodeSettingsPath(), JSON.stringify(vscode, null, 2));
      }
    } catch { /* ignore */ }

    return NextResponse.json({ success: true, message: "Srouter settings removed from Kilo Code" });
  } catch (error) {
    console.log("Error resetting kilo settings:", error);
    return NextResponse.json({ error: "Failed to reset kilo settings" }, { status: configErrorStatus(error) });
  }
}
