// Snapshot-only UI groups. No prefix/regex matching: future model IDs stay separate.
const GROUPS = [
  { id: "ag-gemini-3.8-flash", name: "Gemini 3.8 Flash", ids: ["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low", "gemini-3.8-flash"] },
  { id: "ag-gemini-3.7-flash", name: "Gemini 3.7 Flash", ids: ["gemini-3.7-flash-high", "gemini-3.7-flash-medium", "gemini-3.7-flash-low"] },
  { id: "ag-gemini-3.6-flash", name: "Gemini 3.6 Flash", ids: ["gemini-3.6-flash-high", "gemini-3.6-flash-medium", "gemini-3.6-flash-low"] },
  { id: "ag-gemini-3.5-flash", name: "Gemini 3.5 Flash", ids: ["gemini-3.5-flash-high", "gemini-3-flash-agent", "gemini-3.5-flash-low", "gemini-3.5-flash-extra-low"] },
  { id: "ag-gemini-3.1-pro", name: "Gemini 3.1 Pro", ids: ["gemini-pro-agent", "gemini-3.1-pro-low"] },
];

export function groupAntigravityModels(providerId, models) {
  if (providerId !== "antigravity") return models.map((model) => ({ id: model.id, models: [model] }));
  const seen = new Set();
  return models.flatMap((model) => {
    const group = GROUPS.find((candidate) => candidate.ids.includes(model.id));
    const members = group && models.filter((candidate) => group.ids.includes(candidate.id));
    if (!group || members.length < 2) return [{ id: model.id, models: [model] }];
    if (seen.has(group.id)) return [];
    seen.add(group.id);
    return [{ id: group.id, name: group.name, models: members }];
  });
}
