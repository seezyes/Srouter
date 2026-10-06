import { pathToFileURL } from "url";
import { getInstallInfo, libraryEntry } from "./install.js";

// Module cache: pxpipe is loaded once per process ("started") and dropped on
// "stop". In library mode start/stop govern the in-process module, not a daemon.
let cached = null; // { module, version, loadedAt }
let loadPromise = null;
let generation = 0;

export function getLoadedInfo() {
  return cached ? { loaded: true, version: cached.version, loadedAt: cached.loadedAt } : { loaded: false };
}

export async function loadPxpipe() {
  if (cached) return cached;
  if (loadPromise) return loadPromise;
  const pending = doLoad(generation).finally(() => {
    if (loadPromise === pending) loadPromise = null;
  });
  loadPromise = pending;
  return loadPromise;
}

async function doLoad(loadGeneration) {
  const info = getInstallInfo();
  if (!info.installed) {
    const err = new Error("PXPIPE is not installed");
    err.code = "NOT_INSTALLED";
    throw err;
  }
  // Cache-bust per version so Repair/upgrade takes effect without a server restart.
  const url = `${pathToFileURL(libraryEntry()).href}?v=${encodeURIComponent(info.version || "0")}`;
  const mod = await import(/* webpackIgnore: true */ url);
  if (typeof mod.transformAnthropicMessages !== "function") {
    throw new Error("installed pxpipe package does not export transformAnthropicMessages");
  }
  const loaded = { module: mod, version: info.version, loadedAt: Date.now() };
  if (generation === loadGeneration) cached = loaded;
  return loaded;
}

export function unloadPxpipe() {
  const wasLoaded = !!cached;
  cached = null;
  generation++;
  loadPromise = null;
  return wasLoaded;
}

// Transform function for the request pipeline; null when unavailable (fail-open).
// autoLoad controls whether a cold cache triggers a load (first request warms it).
export async function getTransform({ autoLoad = true } = {}) {
  try {
    if (!cached && !autoLoad) return null;
    const { module: mod } = await loadPxpipe();
    return mod.transformAnthropicMessages;
  } catch {
    return null;
  }
}

// Health self-test: run a tiny synthetic Claude request through the transformer.
// A healthy module parses it and answers with a machine-readable reason.
export async function selfTest() {
  const startedAt = Date.now();
  const { module: mod } = await loadPxpipe();
  const body = new TextEncoder().encode(JSON.stringify({
    model: "claude-fable-5",
    max_tokens: 16,
    messages: [{ role: "user", content: "ping" }],
  }));
  const result = await mod.transformAnthropicMessages({ body, model: "claude-fable-5" });
  if (!result || typeof result.applied !== "boolean" || !(result.body instanceof Uint8Array)) {
    throw new Error("transform returned an unexpected shape");
  }
  return { ok: true, reason: result.reason, durationMs: Date.now() - startedAt };
}
