"use server";

import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isSrouterEndpoint } from "../_shared/managedConfig";
import { resolveCliApiKey } from "../resolveApiKey.js";
import {
  DSH_KEY_REF, FOREIGN_PROVIDER_MESSAGE, applySrouterProvider, removeSrouterProvider,
  providerFromPatch, isOurProvider, setCredentialRef, removeCredentialRef,
  dshConfigConflict, normalizeModels,
} from "./dshConfig.js";
import { dshModelLevels, dshModelInput, dshModelVision } from "./reasoningLevels.js";

function candidates() {
  const home = os.homedir();
  if (os.platform() === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [
      path.join(local, "Programs", "DeepSeek Harness", "DeepSeek Harness.exe"),
      ...[process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
        .filter(Boolean)
        .map(root => path.join(root, "DeepSeek Harness", "DeepSeek Harness.exe")),
    ];
  }
  if (os.platform() === "darwin") {
    return ["/Applications", path.join(home, "Applications")]
      .map(root => path.join(root, "DeepSeek Harness.app", "Contents", "MacOS", "DeepSeek Harness"));
  }
  return (process.env.PATH || "").split(path.delimiter).filter(Boolean)
    .flatMap(root => ["deepseek-harness", "dsh"].map(name => path.join(root, name)));
}

async function detectInstalled() {
  for (const file of candidates()) {
    try {
      if (!(await fs.stat(file)).isFile()) continue;
      return true;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
  }
  return false;
}

async function profilePaths() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  for (const profile of ["desktop", "web"]) {
    try {
      const directory = path.join(home, "profiles", profile);
      if ((await fs.stat(directory)).isDirectory()) return {
        profile, configPath: path.join(directory, "cordis.patch.yml"),
        credentialsPath: path.join(home, ".credentials.yaml"),
      };
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
  }
  return null;
}
async function readFile(file) {
  try {
    return { content: await fs.readFile(file, "utf8"), mode: (await fs.stat(file)).mode };
  } catch (error) {
    if (error.code === "ENOENT") return { content: "", mode: 0o600 };
    throw error;
  }
}
function providerFrom(content) {
  return providerFromPatch(content);
}
function normalizedUrl(value) {
  if (typeof value !== "string") throw new Error("Invalid base URL");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid base URL");
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.endsWith("/v1") ? pathname : pathname + "/v1";
  return url.toString();
}
// Status never opens the credential store.
export async function GET() {
  let installed;
  try {
    installed = await detectInstalled();
  } catch {
    return NextResponse.json({ error: "Failed to detect DeepSeek Harness installation" }, { status: 500 });
  }
  let paths = null, provider, configReadable = true;
  try {
    paths = await profilePaths();
    if (paths) provider = providerFrom((await readFile(paths.configPath)).content);
  } catch {
    configReadable = false;
  }
  const hasSrouter = configReadable && !!provider && isOurProvider(provider);
  let baseUrl = null;
  if (hasSrouter) {
    try { baseUrl = normalizedUrl(provider.baseURL); } catch { /* Missing/invalid endpoint is not a credential disclosure. */ }
  }
  const models = hasSrouter && Array.isArray(provider.models)
    ? provider.models.map(model => typeof model === "string" ? model : model?.id).filter(id => typeof id === "string") : [];
  return NextResponse.json({
    installed, configurationVerified: hasSrouter, authenticationVerified: false,
    hasSrouter, foreignRoute: configReadable && provider !== undefined && !hasSrouter, baseUrl,
    profile: paths?.profile || null, configPath: paths?.configPath || null, configReadable,
    models, modelLevels: dshModelLevels(models), modelVision: dshModelVision(models),
    api: hasSrouter && typeof provider.api === "string" ? provider.api : null,
    levelsDeclared: hasSrouter && Array.isArray(provider.models)
      && provider.models.every(model => model !== null && typeof model === "object" && Object.hasOwn(model, "reasoningEfforts")),
  });
}

let writeChain = Promise.resolve();
function serialized(operation) {
  const pending = writeChain.then(operation);
  writeChain = pending.catch(() => {});
  return pending;
}
async function atomicWrite(file, content, mode) {
  const temporary = path.join(path.dirname(file), `.srouter-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content, { mode, flag: "wx" });
    await fs.chmod(temporary, mode);
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}
function failure(error) {
  return NextResponse.json({
    error: error.code === "DSH_CONFIG_CONFLICT" ? error.message : "Failed to update DeepSeek Harness configuration",
  }, { status: error.code === "DSH_CONFIG_CONFLICT" ? 409 : 500 });
}
export async function POST(request) {
  let body, baseUrl, models;
  try {
    body = await request.json();
    baseUrl = normalizedUrl(body.baseUrl);
    models = normalizeModels(body.models);
    if (!isSrouterEndpoint(baseUrl) && new URL(baseUrl).origin !== request.headers.get("origin")) throw new Error("Invalid base URL");
    if (body.apiKey != null && typeof body.apiKey !== "string") throw new Error("Invalid API key");
    if (typeof body.apiKey === "string" && /[\r\n]/.test(body.apiKey)) throw new Error("Invalid API key");
  } catch {
    return NextResponse.json({ error: "Invalid DeepSeek Harness settings" }, { status: 400 });
  }
  return serialized(async () => {
    try {
      const apiKey = await resolveCliApiKey(body.apiKey);
      if (!apiKey) return NextResponse.json({ error: "No Srouter API key available" }, { status: 400 });
      const paths = await profilePaths();
      if (!paths) return NextResponse.json({ error: "DeepSeek Harness profile not found. Open DeepSeek Harness once, then retry." }, { status: 409 });
      const patch = await readFile(paths.configPath);
      const credentials = await readFile(paths.credentialsPath);
      const modelLevels = dshModelLevels(models);
      const modelInput = Object.fromEntries(models.flatMap(id => {
        const input = dshModelInput(id);
        return input ? [[id, input]] : [];
      }));
      const configContent = applySrouterProvider(patch.content, { baseURL: baseUrl, models, modelLevels, modelInput });
      const credentialContent = setCredentialRef(credentials.content, DSH_KEY_REF, apiKey);
      await atomicWrite(paths.credentialsPath, credentialContent, credentials.mode);
      await atomicWrite(paths.configPath, configContent, patch.mode);
      return NextResponse.json({
        success: true, profile: paths.profile, configPath: paths.configPath, baseUrl, models,
        message: "Srouter was added to DeepSeek Harness. Restart DeepSeek Harness to see it in Settings → Models.",
      });
    } catch (error) { return failure(error); }
  });
}
export async function DELETE() {
  return serialized(async () => {
    try {
      const paths = await profilePaths();
      if (!paths) return NextResponse.json({ success: true, skipped: true });
      const patch = await readFile(paths.configPath);
      const provider = providerFrom(patch.content);
      if (provider === undefined) return NextResponse.json({ success: true, skipped: true });
      if (!isOurProvider(provider)) throw dshConfigConflict(FOREIGN_PROVIDER_MESSAGE);
      const credentials = await readFile(paths.credentialsPath);
      const configContent = removeSrouterProvider(patch.content).content;
      const credentialContent = removeCredentialRef(credentials.content, DSH_KEY_REF);
      if (credentialContent !== credentials.content) await atomicWrite(paths.credentialsPath, credentialContent, credentials.mode);
      await atomicWrite(paths.configPath, configContent, patch.mode);
      return NextResponse.json({ success: true, profile: paths.profile, message: "Srouter was removed from DeepSeek Harness." });
    } catch (error) { return failure(error); }
  });
}
