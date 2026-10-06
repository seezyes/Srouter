import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { developerSettingsAvailable } from "@/lib/developerSettings";
import { getSrouterSearchConnection } from "@/shared/utils/srouterSearchConnection";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
describe("dev UI and release isolation", () => {
  it.each([
    [{}, false],
    [{ NODE_ENV: "development" }, false],
    [{ NODE_ENV: "development", SROUTER_DEV_MIRROR_REFRESH: "1" }, true],
    [{ NODE_ENV: "production", SROUTER_DEV_MIRROR_REFRESH: "1" }, false],
    [{ NODE_ENV: "production" }, false],
  ])("gates developer settings for %j", (env, expected) => {
    expect(developerSettingsAvailable(env)).toBe(expected);
  });
  it("does not honor browser developerMode alone in production UI", () => {
    expect(read("src/shared/components/Sidebar.js")).not.toContain("/dashboard/ui");
    expect(read("src/app/(dashboard)/dashboard/profile/page.js")).toContain("settings.developerSettingsAvailable === true");
    expect(read("src/app/(dashboard)/dashboard/ui/page.js")).toContain('redirect("/dashboard/profile")');
  });
  it("marks only Web Search and VPN with muted WIP badges", () => {
    const sidebar = read("src/shared/components/Sidebar.js");
    expect(sidebar.match(/title="Work in progress">WIP/g)).toHaveLength(2);
    expect(sidebar).toContain('item.href === "/dashboard/vpn"');
    expect(sidebar).toContain("text-text-muted/60");
  });
});
describe("MCP connection instructions", () => {
  it("uses current origin and key placeholder without inventing a transport", () => {
    const result = getSrouterSearchConnection("http://127.0.0.1:20129");
    expect(result.endpoint).toBe("http://127.0.0.1:20129/v1/mcp/search");
    expect(JSON.parse(result.example).mcpServers.SrouterSearch).toEqual({
      type: "http", url: result.endpoint, headers: { Authorization: "Bearer <SROUTER_API_KEY>" },
    });
    expect(result.agentPrompt).toContain("Not legacy SSE or local STDIO");
    expect(result.agentPrompt).toContain("initialize and tools/list");
    expect(result.agentPrompt).toContain("Preserve existing MCP servers");
    expect(result.agentPrompt).toContain("never print it");
    expect(result.agentPrompt).toContain("not an automatic web retrieval");
  });
  it("shows Connect by Save with explicit unsaved draft, no old connection card", () => {
    const page = read("src/shared/components/capability-pages/SrouterSearchPage.js");
    expect(page).toContain(">Connect</Button>");
    expect(page).toContain("Unsaved changes. Click Save settings");
    expect(page).not.toContain("Reloading will discard this draft.");
    expect(page).toContain('className="srouter-search-unsaved-wave"');
    expect(page).toContain("setSavedConfig(saved)");
    expect(page).toContain("Server did not return saved MCP settings");
    expect(page).not.toContain('title="Harness connection"');
    expect(page).toContain("ssr: false");
  });
  it("uses a text highlight wave with reduced-motion and forced-color fallbacks", () => {
    const css = read("src/app/globals.css");
    expect(css).toContain("@keyframes srouterSearchUnsavedWave");
    expect(css).toContain("background-clip: text");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("(forced-colors: active)");
    expect(css).toContain("-webkit-text-fill-color: currentColor");
  });
});
