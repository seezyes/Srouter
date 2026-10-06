// Text families alphabetically, numeric segments newest first (6.1 > 6 > 5.10).
export function compareModelVersions(left, right) {
  const a = String(left).toLowerCase().match(/[0-9]+|[^0-9]+/g) || [];
  const b = String(right).toLowerCase().match(/[0-9]+|[^0-9]+/g) || [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    if (/^[0-9]+$/.test(a[i]) && /^[0-9]+$/.test(b[i])) {
      const order = Number(b[i]) - Number(a[i]);
      if (order) return order;
    } else {
      // A decimal version continues before a suffix: gpt-6.1-sol before gpt-6-sol.
      if (a[i] === "." && b[i].startsWith("-")) return -1;
      if (b[i] === "." && a[i].startsWith("-")) return 1;
      return a[i].localeCompare(b[i], "en");
    }
  }
  return a.length - b.length || String(left).localeCompare(String(right), "en");
}
