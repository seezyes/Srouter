"use server";

import { NextResponse } from "next/server";
import { resolveCliApiKey } from "../resolveApiKey.js";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { isManagedConfig, assertManagedConfig, readEditableConfig, configErrorStatus } from "../_shared/managedConfig";

const execAsync = promisify(exec);

const getSmeltConfigPath = () => path.join(os.homedir(), ".smelt", "config.json");
const getSmeltDir = () => path.dirname(getSmeltConfigPath());

const checkSmeltInstalled = async () => {
  const isWindows = os.platform() === "win32";
  try {
    const command = isWindows ? "where smelt" : "which smelt";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getSmeltConfigPath());
      return true;
    } catch {
      return false;
    }
  }
};

const hasSrouterConfig = (settings) => {
  if (!settings) return false;
  return (
    isManagedConfig(settings)
  );
};

const readConfig = async () => {
  try {
    const content = await fs.readFile(getSmeltConfigPath(), "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
};

export async function GET() {
  try {
    const installed = await checkSmeltInstalled();
    if (!installed) {
      return NextResponse.json({
        installed: false,
        config: null,
        message: "Smelt CLI is not installed",
      });
    }

    const config = await readConfig();

    return NextResponse.json({
      installed: true,
      config,
      hasSrouter: hasSrouterConfig(config),
      configPath: getSmeltConfigPath(),
    });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

export async function POST(request) {
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }

  try {
    const { baseUrl, apiKey, model } = rawBody || {};
    if (!baseUrl) {
      return NextResponse.json({ error: { message: "baseUrl is required" } }, { status: 400 });
    }

    const configPath = getSmeltConfigPath();
    await fs.mkdir(getSmeltDir(), { recursive: true });

    const existing = await readEditableConfig(configPath);
    if (existing.baseUrl || existing.apiKey || existing._managedBy) assertManagedConfig(existing);

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const updated = {
      ...existing,
      baseUrl: normalizedBaseUrl,
      apiKey: await resolveCliApiKey(apiKey),
      model: model || existing.model || "provider/model-id",
      _managedBy: "srouter",
    };

    await fs.writeFile(configPath, JSON.stringify(updated, null, 2), "utf-8");

    return NextResponse.json({
      success: true,
      message: "Smelt settings applied successfully!",
      configPath,
    });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: configErrorStatus(err) });
  }
}

export async function DELETE() {
  try {
    const configPath = getSmeltConfigPath();
    const existing = await readEditableConfig(configPath);
    if (!existing.baseUrl && !existing.apiKey && !existing._managedBy) {
      return NextResponse.json({ success: true, message: "No Srouter config to reset" });
    }
    assertManagedConfig(existing);

    delete existing.baseUrl;
    delete existing.apiKey;
    delete existing.model;
    delete existing._managedBy;

    if (Object.keys(existing).length === 0) {
      await fs.rm(configPath, { force: true });
    } else {
      await fs.writeFile(configPath, JSON.stringify(existing, null, 2), "utf-8");
    }

    return NextResponse.json({ success: true, message: "Smelt Srouter settings removed" });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: configErrorStatus(err) });
  }
}
