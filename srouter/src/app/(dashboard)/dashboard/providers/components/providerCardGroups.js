// Only variants that already appear in one of the provider grids belong here;
// a family is collapsed only when at least two of its members meet in that
// grid. grok-web is in the disabled Web Cookie section, not a grid.
// xai deliberately has no pair: it moved to the API-key grid, so it can no
// longer sit next to grok-cli (OAuth) — see registry/xai.js.
// Alibaba ships five separate registry entries in the API-key grid (two plain
// "Alibaba": alibaba/alicode, plus Coding, Studio and Token Plan adapters).
const GROUPS = [
  { id: "openai", name: "OpenAI", iconSrc: "/providers/openai.png", providers: ["openai", "azure"] },
  { id: "mistral", name: "Mistral", iconSrc: "/providers/mistral.png", providers: ["mistral", "codestral"] },
  { id: "opencode", name: "OpenCode", providers: ["opencode-go", "opencode-zen"] },
  { id: "alibaba", name: "Alibaba", providers: ["alibaba", "alicode", "alicode-intl", "alims-intl", "alitp-intl"] },
  { id: "cline", name: "Cline", providers: ["cline", "clinepass"] },
  { id: "codebuddy", name: "CodeBuddy", providers: ["codebuddy-intl", "codebuddy-cn"] },
  { id: "qoder", name: "Qoder", providers: ["qoder", "qoder-cn"] },
  { id: "perplexity", name: "Perplexity", providers: ["perplexity", "perplexity-agent"] },
  // GLM spans two grids now: glm + zcode are the international z.ai pair
  // (OAuth section, dual-auth), while glm-cn (Zhipu China, API-key only) sits
  // alone in the API-key grid and therefore never collapses into a family.
  { id: "glm", name: "GLM", providers: ["glm", "zcode"] },
  { id: "minimax", name: "MiniMax", providers: ["minimax", "minimax-cn"] },
];

export function groupProviderCards(entries, filtering = false) {
  const seen = new Set();
  return entries.flatMap((entry) => {
    const group = !filtering && GROUPS.find((g) => g.providers.includes(entry[0]));
    const members = group && entries.filter(([id]) => group.providers.includes(id));
    if (!group || members.length < 2) return [{ id: entry[0], entries: [entry] }];
    if (seen.has(group.id)) return [];
    seen.add(group.id);
    return [{ ...group, entries: members }];
  });
}
