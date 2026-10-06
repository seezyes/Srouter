import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { CLI_TOOLS } from "../../src/shared/constants/cliTools.js";
import { groupHarnessCards } from "../../src/app/(dashboard)/dashboard/cli-tools/components/harnessCardGroups.js";

describe("Harness overview order and Claude group", () => {
  const entries = Object.entries(CLI_TOOLS);

  it("places GitHub Copilot immediately after Cursor", () => {
    const ids = groupHarnessCards(entries).map(group => group.id);
    expect(ids[ids.indexOf("cursor") + 1]).toBe("copilot");
  });

  it("places jcode then ZCode immediately after Factory Droid", () => {
    const ids = groupHarnessCards(entries).map(group => group.id);
    expect(ids.slice(ids.indexOf("droid"), ids.indexOf("droid") + 3))
      .toEqual(["droid", "jcode", "zcode"]);
  });

  it("combines Claude Code/Cowork at the original Claude Code position", () => {
    const groups = groupHarnessCards(entries);
    expect(groups[0].id).toBe("claude-group");
    expect(groups[0].name).toBe("Claude");
    expect(groups[0].entries.map(([id]) => id)).toEqual(["claude", "cowork"]);
    expect(groups.some(group => group.id === "cowork")).toBe(false);
  });

  it("preserves every tool, individual identity and relative order of unrelated cards", () => {
    const result = groupHarnessCards(entries);
    const flat = result.flatMap(group => group.entries);
    expect(flat.length).toBe(entries.length);
    expect(new Set(flat.map(([id]) => id))).toEqual(new Set(entries.map(([id]) => id)));
    for (const entry of flat) expect(entries).toContain(entry);
    const moved = ["claude", "cowork", "copilot", "jcode", "zcode"];
    expect(flat.filter(([id]) => !moved.includes(id)))
      .toEqual(entries.filter(([id]) => !moved.includes(id)));
  });

  it("does not mutate the source registry", () => {
    const ids = entries.map(([id]) => id);
    groupHarnessCards(entries);
    expect(entries.map(([id]) => id)).toEqual(ids);
    expect(Object.keys(CLI_TOOLS)).toEqual(ids);
  });

  it("does not hide single Claude variants or tools whose anchors are absent", () => {
    const source = [["cowork", CLI_TOOLS.cowork], ["jcode", CLI_TOOLS.jcode]];
    expect(groupHarnessCards(source).map(group => group.id)).toEqual(["cowork", "jcode"]);
    expect(groupHarnessCards([])).toEqual([]);
  });

  it("starts collapsed and retains individual statuses/links when expanded", () => {
    const component = fs.readFileSync(new URL(
      "../../src/app/(dashboard)/dashboard/cli-tools/components/HarnessToolGroup.js", import.meta.url,
    ), "utf8");
    expect(component).toContain("useState(false)");
    expect(component).toContain("aria-expanded={false}");
    expect(component).toContain("aria-expanded={true}");
    expect(component).toContain("setExpanded(value => !value)");
    expect(component).toContain("status={statuses[toolId]}");
    expect(component).toContain("toolId={toolId}");
    expect(component).toContain("node.focus()");
  });
});
