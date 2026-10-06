// Preserve the existing groups' order, except BurnGate follows OpenCode Free.
export function orderFreeTierEntries(freeEntries, freeTierEntries) {
  const entries = [...freeEntries, ...freeTierEntries];
  const burngateIndex = entries.findIndex(([id]) => id === "burngate");
  const opencodeIndex = entries.findIndex(([id]) => id === "opencode");
  if (burngateIndex < 0 || opencodeIndex < 0) return entries;
  const [burngate] = entries.splice(burngateIndex, 1);
  const anchor = entries.findIndex(([id]) => id === "opencode");
  entries.splice(anchor + 1, 0, burngate);
  return entries;
}
