"use server";

import { NextResponse } from "next/server";
import { resolveCliApiKey } from "../resolveApiKey.js";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { isManagedConfig, assertManagedConfig, readEditableConfig, parseEditableJSONC, configErrorStatus, configConflict } from "../_shared/managedConfig";

const execAsync = promisify(exec);

const getPiModelsJsonPath = () => {
  const agentPath = path.join(os.homedir(), ".pi", "agent", "models.json");
  return agentPath;
};

const getPiDir = () => path.dirname(getPiModelsJsonPath());

const checkPiInstalled = async () => {
  const isWindows = os.platform() === "win32";
  try {
    const command = isWindows ? "where pi" : "which pi";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getPiModelsJsonPath());
      return true;
    } catch {
      try {
        await fs.access(path.join(os.homedir(), ".pi", "models.json"));
        return true;
      } catch {
        return false;
      }
    }
  }
};

const hasSrouterConfig = (settings) => {
  if (!settings || !settings.providers) return false;
  const p = settings.providers["srouter"];
  return isManagedConfig(p);
};

const resolveModelsJsonPath = async () => {
  const agentPath = path.join(os.homedir(), ".pi", "agent", "models.json");
  const rootPath = path.join(os.homedir(), ".pi", "models.json");
  try {
    await fs.access(agentPath);
    return agentPath;
  } catch {
    try {
      await fs.access(rootPath);
      return rootPath;
    } catch {
      return agentPath;
    }
  }
};

const readConfig = async () => {
  try {
    const targetPath = await resolveModelsJsonPath();
    const content = await fs.readFile(targetPath, "utf-8");
    return parseEditableJSONC(content);
  } catch {
    return null;
  }
};

export async function GET() {
  try {
    const installed = await checkPiInstalled();
    if (!installed) {
      return NextResponse.json({
        installed: false,
        config: null,
        message: "Pi CLI is not installed",
      });
    }

    const config = await readConfig();
    const configPath = await resolveModelsJsonPath();

    return NextResponse.json({
      installed: true,
      config,
      hasSrouter: hasSrouterConfig(config),
      configPath,
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

    const configPath = await resolveModelsJsonPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });

    const existing = await readEditableConfig(configPath, parseEditableJSONC);

    if (!existing.providers) existing.providers = {};
    if (typeof existing.providers !== "object" || Array.isArray(existing.providers)) throw configConflict();
    assertManagedConfig(existing.providers.srouter);

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    let modelList = [];
    if (Array.isArray(rawBody.models) && rawBody.models.length > 0) {
      modelList = rawBody.models.map((m) => {
        if (typeof m === "string") {
          return { id: m, name: m, contextWindow: 128000, maxTokens: 16384 };
        }
        return {
          id: m.id || "provider/model-id",
          name: m.name || m.id || "provider/model-id",
          contextWindow: m.contextWindow || 128000,
          maxTokens: m.maxTokens || 16384,
        };
      });
    } else {
      const modelId = model || "provider/model-id";
      modelList = [{ id: modelId, name: modelId, contextWindow: 128000, maxTokens: 16384 }];
    }

    existing.providers["srouter"] = {
      ...existing.providers.srouter,
      baseUrl: normalizedBaseUrl,
      apiKey: await resolveCliApiKey(apiKey || existing.providers.srouter?.apiKey),
      api: existing.providers.srouter?.api || "openai-completions",
      models: modelList,
    };

    await fs.writeFile(configPath, JSON.stringify(existing, null, 2), "utf-8");

    return NextResponse.json({
      success: true,
      message: "Pi settings applied! Use /model in Pi to select the Srouter model.",
      configPath,
    });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: configErrorStatus(err) });
  }
}

export async function DELETE() {
  try {
    const configPath = await resolveModelsJsonPath();
    const existing = await readEditableConfig(configPath, parseEditableJSONC);

    if (existing.providers && existing.providers["srouter"]) {
      assertManagedConfig(existing.providers.srouter);
      delete existing.providers["srouter"];
      if (Object.keys(existing.providers).length === 0) delete existing.providers;
      await fs.writeFile(configPath, JSON.stringify(existing, null, 2), "utf-8");
    }

    return NextResponse.json({ success: true, message: "Srouter removed from Pi" });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: configErrorStatus(err) });
  }
}
