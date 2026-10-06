"use server";

import { NextResponse } from "next/server";
import { resolveCliApiKey } from "../resolveApiKey.js";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { parseTOML, stringifyTOML } from "confbox";
import { assertManagedConfig, configConflict, configErrorStatus, isSrouterEndpoint, readEditableConfig } from "../_shared/managedConfig";

const execAsync = promisify(exec);

const PROVIDER_NAME = "srouter";

const getDeepSeekDir = () => path.join(os.homedir(), ".deepseek");
const getDeepSeekConfigPath = () => path.join(getDeepSeekDir(), "config.toml");

// Preserve the status API's dotted-table field while using a strict TOML parser.
const parseToml = (content) => {
    const config = parseTOML(content);
    return { ...config, "providers.openai": config.providers?.openai };
};

const editableConfig = async () => {
    const config = await readEditableConfig(getDeepSeekConfigPath(), parseTOML);
    for (const value of [config.providers, config.providers?.openai]) {
        if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw configConflict();
    }
    assertManagedConfig(config.providers?.openai);
    return config;
};

const checkDeepSeekInstalled = async () => {
    try {
        const isWindows = os.platform() === "win32";
        const command = isWindows ? "where deepseek" : "which deepseek";
        await execAsync(command, { windowsHide: true });
        return true;
    } catch {
        try {
            await fs.access(getDeepSeekConfigPath());
            return true;
        } catch {
            return false;
        }
    }
};

const readConfigToml = async () => {
    try {
        return await fs.readFile(getDeepSeekConfigPath(), "utf-8");
    } catch (error) {
        if (error.code === "ENOENT") return "";
        throw error;
    }
};

// Detect Srouter by checking if provider is "openai" and base_url points to localhost/127.0.0.1
const hasSrouterConfig = (config) => {
    if (!config) return false;
    const provider = config.provider;
    if (provider !== "openai") return false;
    const openaiSection = config["providers.openai"];
    if (!openaiSection?.base_url) return false;
    return isSrouterEndpoint(openaiSection.base_url);
};

export async function GET() {
    try {
        const installed = await checkDeepSeekInstalled();
        if (!installed) {
            return NextResponse.json({ installed: false, settings: null, message: "DeepSeek TUI is not installed" });
        }
        const toml = await readConfigToml();
        const config = parseToml(toml);
        return NextResponse.json({
            installed: true,
            settings: config,
            hasSrouter: hasSrouterConfig(config),
            configPath: getDeepSeekConfigPath(),
        });
    } catch (error) {
        console.log("Error checking deepseek-tui settings:", error);
        return NextResponse.json({ error: "Failed to check deepseek-tui settings" }, { status: 500 });
    }
}

export async function POST(request) {
    try {
        const { baseUrl, apiKey, model } = await request.json();
        if (!baseUrl || !model) {
            return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
        }

        const dir = getDeepSeekDir();
        const config = await editableConfig();
        await fs.mkdir(dir, { recursive: true });

        config.provider = "openai";
        config.providers ||= {};
        config.providers.openai = {
            ...config.providers.openai,
            base_url: baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`,
            api_key: await resolveCliApiKey(apiKey),
            model,
        };
        await fs.writeFile(getDeepSeekConfigPath(), stringifyTOML(config));

        return NextResponse.json({
            success: true,
            message: "DeepSeek TUI settings applied successfully!",
            configPath: getDeepSeekConfigPath(),
        });
    } catch (error) {
        console.log("Error updating deepseek-tui settings:", error);
        return NextResponse.json({ error: "Failed to update deepseek-tui settings" }, { status: configErrorStatus(error) });
    }
}

export async function DELETE() {
    try {
        const configPath = getDeepSeekConfigPath();
        const config = await editableConfig();
        if (!config.providers?.openai) return NextResponse.json({ success: true, skipped: true });
        delete config.providers.openai;
        if (Object.keys(config.providers).length === 0) delete config.providers;
        if (config.provider === "openai") config.provider = "deepseek";
        await fs.writeFile(configPath, stringifyTOML(config));
        return NextResponse.json({ success: true, message: `${PROVIDER_NAME} config reset to DeepSeek defaults` });
    } catch (error) {
        console.log("Error resetting deepseek-tui settings:", error);
        return NextResponse.json({ error: "Failed to reset deepseek-tui settings" }, { status: configErrorStatus(error) });
    }
}