function moveAfter(entries, anchorId, movedIds) {
  if (!entries.some(([id]) => id === anchorId)) return entries;
  const moved = movedIds.flatMap(id => entries.filter(([entryId]) => entryId === id));
  const remaining = entries.filter(([id]) => !movedIds.includes(id));
  const anchor = remaining.findIndex(([id]) => id === anchorId);
  return [...remaining.slice(0, anchor + 1), ...moved, ...remaining.slice(anchor + 1)];
}

export function groupHarnessCards(entries) {
  let ordered = moveAfter(entries, "cursor", ["copilot"]);
  ordered = moveAfter(ordered, "droid", ["jcode", "zcode"]);
  const claude = ordered.find(([id]) => id === "claude");
  const cowork = ordered.find(([id]) => id === "cowork");
  return ordered.flatMap(entry => {
    const [id] = entry;
    if (claude && cowork) {
      if (id === "cowork") return [];
      if (id === "claude") return [{ id: "claude-group", name: "Claude", entries: [claude, cowork] }];
    }
    return [{ id, entries: [entry] }];
  });
}
