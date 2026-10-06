/** Apply a range to the stable pre-gesture selection; a selected anchor removes. */
export function computeDragSelection(connections, anchorIndex, currentIndex, baseIds = [], select) {
  const base = Array.isArray(baseIds) ? baseIds : [];
  if (!Array.isArray(connections) || connections.length === 0) return base;
  const selectRange = select ?? !base.includes(connections[anchorIndex]?.id);
  const lo = Math.max(0, Math.min(anchorIndex, currentIndex));
  const hi = Math.min(connections.length - 1, Math.max(anchorIndex, currentIndex));
  const ids = [];
  for (let i = lo; i <= hi; i += 1) {
    const id = connections[i]?.id;
    if (id) ids.push(id);
  }
  const rangeIds = new Set(ids);
  return selectRange
    ? Array.from(new Set([...base, ...ids]))
    : Array.from(new Set(base)).filter((id) => !rangeIds.has(id));
}
