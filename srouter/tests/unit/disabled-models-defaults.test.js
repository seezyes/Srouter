// Off-by-default models (T-0050): the provider registry may declare
// `defaultDisabledModels` (BurnGate's three models). They apply only while the
// provider has no stored row, and an explicit store state must always win —
// including "nothing disabled", which needs an explicit empty row so the
// defaults do not come back.
//
// Real SQLite/sql.js layer against a temp DATA_DIR — never the working DB.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDefaultDisabledModels } from "@/shared/constants/disabledModelsDefaults.js";

const originalDataDir = process.env.DATA_DIR;
const BURNGATE_DEFAULTS = getDefaultDisabledModels("burngate");

async function setup() {
  try { globalThis._dbAdapter?.instance?.close?.(); } catch { /* already closed */ }
  delete globalThis._dbAdapter;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-disabled-defaults-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();

  const repo = await import("@/lib/db/repos/disabledModelsRepo.js");
  return {
    ...repo,
    cleanup() {
      try { globalThis._dbAdapter?.instance?.close?.(); } catch { /* already closed */ }
      delete globalThis._dbAdapter;
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

describe("default-disabled models", () => {
  let ctx = null;

  afterEach(() => {
    vi.resetModules();
    if (ctx) ctx.cleanup();
    ctx = null;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("ships the BurnGate defaults from the registry", () => {
    expect(BURNGATE_DEFAULTS).toEqual(["deepseek/deepseek-v4.1-flash", "stealth/space-bunny-alpha", "stealth/pixel-canary"]);
    expect(getDefaultDisabledModels("openai")).toEqual([]);
  });

  it("applies the defaults while the provider has no stored row", async () => {
    ctx = await setup();
    expect(await ctx.getDisabledByProvider("burngate")).toEqual(BURNGATE_DEFAULTS);
    expect((await ctx.getDisabledModels()).burngate).toEqual(BURNGATE_DEFAULTS);
    expect(await ctx.getDisabledByProvider("openai")).toEqual([]);
  });

  it("keeps the stored row authoritative", async () => {
    ctx = await setup();
    await ctx.disableModels("burngate", ["stealth/pixel-canary"]);

    expect(await ctx.getDisabledByProvider("burngate")).toEqual(["stealth/pixel-canary"]);
    expect((await ctx.getDisabledModels()).burngate).toEqual(["stealth/pixel-canary"]);
  });

  it("re-enabling the last disabled model does not resurrect the defaults", async () => {
    ctx = await setup();
    await ctx.disableModels("burngate", ["stealth/pixel-canary"]);
    await ctx.enableModels("burngate", ["stealth/pixel-canary"]);

    expect(await ctx.getDisabledByProvider("burngate")).toEqual([]);
    expect((await ctx.getDisabledModels()).burngate).toEqual([]);
  });

  it("Active All suppresses the defaults too", async () => {
    ctx = await setup();
    await ctx.disableModels("burngate", ["stealth/pixel-canary"]);
    await ctx.enableModels("burngate", []);

    expect(await ctx.getDisabledByProvider("burngate")).toEqual([]);
    expect((await ctx.getDisabledModels()).burngate).toEqual([]);
  });

  it("a newly disabled model still merges with the stored row", async () => {
    ctx = await setup();
    await ctx.enableModels("burngate", []);
    await ctx.disableModels("burngate", ["xiaomi/mimo-v2.6-flash"]);

    expect(await ctx.getDisabledByProvider("burngate")).toEqual(["xiaomi/mimo-v2.6-flash"]);
  });

  it("providers without defaults keep the legacy delete-on-empty behavior", async () => {
    ctx = await setup();
    await ctx.disableModels("openai", ["gpt-4o"]);
    await ctx.enableModels("openai", ["gpt-4o"]);

    expect(await ctx.getDisabledByProvider("openai")).toEqual([]);
    // The map only lists providers with a stored row or code defaults, so an
    // untouched provider without defaults has no key at all.
    expect((await ctx.getDisabledModels()).openai).toBeUndefined();
  });
});
